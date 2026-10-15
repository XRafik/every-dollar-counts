import 'server-only'
import { cache } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from './supabase/server'
import { supabaseAdmin } from './supabase/admin'
import { readAllById, readAllRows } from './read-all'
import type {
  CategorizableTxn,
  CategoryData,
  CategoryDataFields,
  CategoryRule,
  SuggestionRef,
} from './category-rules'
import type { Category } from './categories'

// Spec §14.7: CATEGORY_SUGGESTIONS=on switches Jev's suggestions on, for both the job and every
// page. Anything else, or unset, is off, which is also the rollback. The only reader of the variable.
export function suggestionsEnabled(): boolean {
  return process.env.CATEGORY_SUGGESTIONS === 'on'
}

// The row's suggestion (spec §14.3), embedded in a transactions select so a page makes no extra
// request. Every transactions select whose rows reach resolveCategory appends it.
export const SUGGESTION_EMBED = 'suggestion:category_suggestions(category_id, confidence, catalog_fingerprint)'

// Every page's rows, and the suggestion job's, go through this once, straight after the read.
// Without generated database types, supabase-js types every embed as an array, but
// category_suggestions' primary key is transaction_id, so PostgREST returns this one as an object or
// null. Should an array ever arrive, its first element (or null) is kept: the job would otherwise see
// no fingerprint and re-ask the row on every sync (resolveCategory still ignores an array, as a
// second guard). Only `suggestion` changes; every other column keeps its inferred type, and a select
// that drops the embed has no `suggestion` and fails here, so §7.4's tsc guard still holds.
export function withSuggestion<T extends { suggestion: unknown }>(
  rows: T[]
): (Omit<T, 'suggestion'> & { suggestion: SuggestionRef | null })[] {
  return rows.map((t) => {
    const s = t.suggestion
    return { ...t, suggestion: (Array.isArray(s) ? (s[0] ?? null) : s) as SuggestionRef | null }
  })
}

// The ONE read of the household's categories and category rules (#28 spec §7.1). Every money page
// and Settings goes through it; tripwire 4 holds every other `.from('categories')` and
// `.from('category_rules')` to a named allowlist.
//
// Cached per render (the lib/household.ts pattern), so a page that asks twice reads once.
//
// It THROWS on either read. A failed rules read rendered as "no rules" would silently revert every
// learned label across the app, which is #46's failure in a new place. Money pages let it reach
// app/(app)/error.tsx; Settings catches it so Banks stays usable.
export const fetchCategoryContext = cache(async (): Promise<CategoryData> => {
  return readCategoryData(await createClient(), null)
})

// The same read for a job with no session (the suggestion job, spec §14.5): the service-role client
// bypasses RLS, so both reads are scoped to the household by hand. The same throws.
export async function fetchCategoryDataForHousehold(householdId: string): Promise<CategoryData> {
  return readCategoryData(supabaseAdmin, householdId)
}

// `householdId` null means "whatever RLS lets this session see", which is one household.
async function readCategoryData(supabase: SupabaseClient, householdId: string | null): Promise<CategoryData> {
  const catQuery = supabase.from('categories').select('id, name, pfc_primary, sort_order')
  const [cats, rules] = await Promise.all([
    (householdId === null ? catQuery : catQuery.eq('household_id', householdId)).order('sort_order'),
    readAllById(() => {
      const q = supabase
        .from('category_rules')
        .select('id, household_id, merchant_key, merchant_label, category_id, origin')
      return householdId === null ? q : q.eq('household_id', householdId)
    }),
  ])
  if (cats.error) throw new Error(`could not read categories: ${withCode(cats.error)}`)
  // Neither data nor error (an empty body) is a failed read, not "no categories" (readAllById
  // treats it the same way).
  if (!cats.data) throw new Error('could not read categories: read returned no data and no error')
  if (rules.error) {
    throw new Error(
      `could not read category rules: ${withCode(rules.error)} ` +
        '(has db/migrations/021, including its grants, been applied?)'
    )
  }
  // The one place outside lib/category-rules.ts that brands CategoryData. `satisfies` checks the
  // fields before the cast adds the brand, so a dropped suggestionsOn fails tsc; it is also tested.
  return {
    categories: cats.data as Category[],
    rules: rules.data as CategoryRule[],
    suggestionsOn: suggestionsEnabled(),
  } satisfies CategoryDataFields as CategoryData
}

// "42501 permission denied", or just the message when there is no code.
function withCode(error: { message: string; code?: string }): string {
  return `${error.code ? error.code + ' ' : ''}${error.message}`
}

export type CountTxn = CategorizableTxn & { id: string; date: string }

// Every non-removed transaction, with exactly the columns resolveCategory needs, for Settings'
// counts and the delete-category dialog. Paged (#69): about 1,400 rows on 2026-10-08, three requests.
export async function readTransactionsForCounts(): Promise<CountTxn[]> {
  const supabase = await createClient()
  const { data, error } = await readAllRows(() =>
    supabase
      .from('transactions')
      .select(`id, date, merchant_name, user_category, pfc_primary, pfc_detailed, ${SUGGESTION_EMBED}`)
      .eq('removed', false)
  )
  if (error) throw new Error(`could not read transactions: ${withCode(error)}`)
  return withSuggestion(data)
}
