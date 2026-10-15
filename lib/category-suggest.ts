import 'server-only'
import { supabaseAdmin } from './supabase/admin'
import { assertEnvMatchesDatabase, EnvMismatchError } from './app-env'
import { readAllRows } from './read-all'
import { askChoices } from './typesafe'
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
  suggestionOptions,
  type PickRow,
} from './category-suggest-request'

// Jev's category suggestions (#28 spec §14.5): the job that asks TypeSafe about a household's
// unsuggested spending rows and stores the answers in category_suggestions. The ONLY writer of that
// table (tripwire `suggestion-write`, scripts/check-invariants.mjs). It never writes transactions.
//
// It NEVER throws. It runs after a sync's response is sent, and nothing here may reach the sync's
// response, its status or the bank's health flag. Every failure is one `[suggest] failed` line with
// the household id and the error's message; no log line carries a request body or transaction
// details, only ids and counts.

export type SuggestOutcome =
  | { status: 'off' }
  | { status: 'skipped'; reason: 'environment' }
  | { status: 'done'; asked: number; written: number; inputTokens: number }
  | { status: 'failed'; asked: number; written: number }

type ReadRow = PickRow & { user_category: string | null; suggestion: SuggestionRef | null }

export async function suggestCategories(
  householdId: string,
  { limit = 200 }: { limit?: number } = {}
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
    for (let i = 0; i < due.length; i += BATCH_SIZE) {
      const batch = due.slice(i, i + BATCH_SIZE)
      const res = await askChoices(buildBatchRequest(batch, options, examples))
      asked += batch.length
      inputTokens += res.usage.input_tokens
      const now = new Date().toISOString()
      const toWrite = batch.flatMap((t) => {
        const a = res.answers[t.id]
        if (!a) return []
        const category_id = a.choice === NONE ? null : idByName.get(a.choice)
        // Not an option we offered (askChoices checks this too, but a category could be renamed
        // between building the options and mapping the answer back): skip the row.
        if (category_id === undefined) return []
        return [
          {
            transaction_id: t.id,
            household_id: householdId,
            category_id,
            confidence: a.confidence,
            catalog_fingerprint: fingerprint,
            model: res.model,
            created_at: now,
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

    console.log('[suggest] done', { householdId, asked, written, inputTokens })
    return { status: 'done', asked, written, inputTokens }
  } catch (e) {
    console.error('[suggest] failed', householdId, e instanceof Error ? e.message : String(e))
    return { status: 'failed', asked, written }
  }
}
