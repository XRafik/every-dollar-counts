import 'server-only'
import { supabaseAdmin } from './supabase/admin'
import { assertEnvMatchesDatabase, EnvMismatchError } from './app-env'
import { readAllRows } from './read-all'
import { askChoices, TypeSafeError, type ChoicesResult } from './typesafe'
import {
  fetchCategoryDataForHousehold,
  suggestionsEnabled,
  SUGGESTION_EMBED,
  withSuggestion,
} from './category-context'
import { buildCategoryContext, contextFingerprint, suggestableRow, type SuggestionRef } from './category-rules'
import {
  BATCH_SIZE,
  NONE,
  buildBatchRequest,
  householdExamples,
  questionKey,
  suggestionOptions,
  type PickRow,
} from './category-suggest-request'

// Jev's category suggestions (#28 spec §14.5): the job that asks TypeSafe about a household's
// spending rows with no current suggestion and stores the answers in category_suggestions. The ONLY
// writer of that table (tripwire `suggestion-write`, scripts/check-invariants.mjs). It never writes
// transactions.
//
// It NEVER throws. It runs after a sync's response is sent, and nothing here may reach the sync's
// response, its status or the bank's health flag. A failure that ends the run is one
// `[suggest] failed` line with the household id, the counts so far and the error's message; a batch
// skipped for its own failure is one `[suggest] batch failed` line with its status. No log line
// carries a request body or transaction details, only ids, counts and statuses.

export type SuggestOutcome =
  | { status: 'off' }
  | { status: 'skipped'; reason: 'environment' }
  | { status: 'done'; asked: number; written: number; inputTokens: number }
  | { status: 'failed'; asked: number; written: number }

type ReadRow = PickRow & { user_category: string | null; suggestion: SuggestionRef | null }

// No new batch starts once this long has passed since the REQUEST began (the route passes
// `startedAt`). The job runs in the route's after(), which shares the route's max duration
// (Vercel's default is 300s), and that clock starts with the request, not with the job. A run
// killed by the platform would leave no log line. The worst batch is about 63.5s (four 15s attempts
// plus 3.5s of backoff), so a batch started just before 200s still ends before 300s. Rows not
// reached are still due, so the next sync picks them up.
export const RUN_DEADLINE_MS = 200_000

// A TypeSafe failure that belongs to the batch, not the run: TypeSafe refused this request (400,
// 422) or answered it in a way validate() rejects. Everything else (401/403, no key, network or
// timeout, 429/529 after retries, 5xx, a body that is not JSON) would fail every batch, so it ends
// the run.
const PER_BATCH = new Set<TypeSafeError['status']>([400, 422, 'invalid'])

export async function suggestCategories(
  householdId: string,
  {
    limit = 200,
    now = Date.now,
    startedAt = now(),
  }: { limit?: number; now?: () => number; startedAt?: number } = {}
): Promise<SuggestOutcome> {
  let asked = 0
  let written = 0
  let inputTokens = 0
  try {
    if (!suggestionsEnabled()) return { status: 'off' }
    try {
      await assertEnvMatchesDatabase()
    } catch (e) {
      if (e instanceof EnvMismatchError) {
        console.warn('[suggest] skipped: environment')
        return { status: 'skipped', reason: 'environment' }
      }
      throw e
    }

    const data = await fetchCategoryDataForHousehold(householdId)
    const ctx = buildCategoryContext(data)
    const fingerprint = contextFingerprint(ctx)
    const options = suggestionOptions(data) // throws on a spending category named "none"

    const read = await readAllRows(() =>
      supabaseAdmin
        .from('transactions')
        .select(
          `id, date, amount, name, merchant_name, user_category, pfc_primary, pfc_detailed, ${SUGGESTION_EMBED}`
        )
        .eq('household_id', householdId)
        .eq('removed', false)
    )
    if (read.error) throw new Error(`could not read transactions: ${read.error.message}`)
    const rows: ReadRow[] = withSuggestion(read.data)

    const examples = householdExamples(data, rows.filter((t) => t.user_category))
    const due = rows
      .filter((t) => suggestableRow(t, ctx) && (!t.suggestion || t.suggestion.catalog_fingerprint !== fingerprint))
      // Newest first (date, then id, descending), so the months the person looks at fill first.
      .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1))
      .slice(0, limit)

    const idByName = new Map(data.categories.map((c) => [c.name, c.id]))
    let stoppedAtDeadline = false
    for (let i = 0; i < due.length; i += BATCH_SIZE) {
      if (now() - startedAt >= RUN_DEADLINE_MS) {
        stoppedAtDeadline = true
        break
      }
      const batch = due.slice(i, i + BATCH_SIZE)
      let res: ChoicesResult
      try {
        res = await askChoices(buildBatchRequest(batch, options, examples))
      } catch (e) {
        // Rows are asked newest first, so a batch that always fails would be first on every sync
        // and block every row behind it. Skip it; its rows stay due. Status only, never a body.
        if (!(e instanceof TypeSafeError) || !PER_BATCH.has(e.status)) throw e
        console.error('[suggest] batch failed', {
          householdId,
          batch: i / BATCH_SIZE,
          rows: batch.length,
          status: e.status,
        })
        continue
      }
      asked += batch.length
      inputTokens += res.usage.input_tokens
      const writtenAt = new Date().toISOString()
      // Answers are keyed by batch position, never by transaction id (spec §14.2).
      const toWrite = batch.flatMap((t, j) => {
        const a = res.answers[questionKey(j)]
        if (!a) return []
        const category_id = a.choice === NONE ? null : idByName.get(a.choice)
        // Defensive only: options and idByName come from the same snapshot, and askChoices already
        // rejects an option we did not offer. A category deleted during the run fails the upsert's
        // foreign key and ends the run; the next sync retries.
        if (category_id === undefined) return []
        return [
          {
            transaction_id: t.id,
            household_id: householdId,
            category_id,
            confidence: a.confidence,
            catalog_fingerprint: fingerprint,
            model: res.model,
            created_at: writtenAt,
          },
        ]
      })
      if (toWrite.length === 0) continue
      const { error, count } = await supabaseAdmin
        .from('category_suggestions')
        .upsert(toWrite, { onConflict: 'transaction_id', count: 'exact' })
      if (error) throw new Error(`could not write suggestions: ${error.code ?? ''} ${error.message}`)
      if (count !== toWrite.length) throw new Error(`wrote ${count} of ${toWrite.length} suggestions`)
      written += toWrite.length
    }

    console.log(
      '[suggest] done',
      stoppedAtDeadline
        ? { householdId, asked, written, inputTokens, stoppedAtDeadline: true }
        : { householdId, asked, written, inputTokens }
    )
    return { status: 'done', asked, written, inputTokens }
  } catch (e) {
    console.error('[suggest] failed', {
      householdId,
      asked,
      written,
      error: e instanceof Error ? e.message : String(e),
    })
    return { status: 'failed', asked, written }
  }
}
