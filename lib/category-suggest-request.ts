// The question Jev is asked (#28 spec §14.2): options, household examples and one batch's
// request body. Pure, no I/O, and deliberately NOT server-only: the launch check (§14.8) is a
// throwaway script that imports this file to build exactly the requests production sends.
//
// Nothing here may add a field to what leaves the app. The request carries only the household's
// spending category names, its examples and, per row, the six fields buildBatchRequest lists: no
// account numbers, balances, institution names or household identifiers. Transaction ids are the
// question keys, which TypeSafe never sends to the model.
import { isCardPaymentRow } from './categories'
import { buildKindContext, kindOf, merchantKey, spendingCategories, type CategoryData } from './category-rules'

export const BATCH_SIZE = 20
export const MAX_EXAMPLES = 60
export const NONE = 'none'

export type SuggestRow = {
  id: string
  date: string
  amount: number
  name: string | null
  merchant_name: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
}
export type PickRow = SuggestRow & { user_category: string | null }
export type Example = { merchant: string; filed_as: string }
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string | null> }

type SentTransaction = {
  merchant: string | null
  bank_description: string | null
  amount_usd: number
  direction: 'out' | 'in'
  date: string
  bank_category: string
}

function spendingNames(data: CategoryData): Map<string, string> {
  const spending = spendingCategories(data.categories, buildKindContext(data.categories))
  return new Map(spending.map((c) => [c.id, c.name]))
}

// The household's spending-kind categories by name, each described by the Plaid primary that maps
// to it by default (null when none does), plus `none`. A spending category named "none" (in any
// case or spacing) would be indistinguishable from the "none of these fits" option, so it throws:
// the caller logs and skips the run rather than storing an ambiguous answer.
export function suggestionOptions(data: CategoryData): Record<string, string | null> {
  const k = buildKindContext(data.categories)
  const options: Record<string, string | null> = {}
  for (const c of spendingCategories(data.categories, k)) {
    if (c.name.trim().toLowerCase() === NONE) throw new Error('a spending category is named "none"')
    options[c.name] = c.pfc_primary ? `Plaid's default for ${c.pfc_primary}` : null
  }
  options[NONE] = 'None of these categories fits this transaction.'
  return options
}

// One { merchant, filed_as } per merchant the household has decided: its rules first, then its
// hand picks for merchants without a rule, newest pick first (id descending breaks a date tie).
// Spending kind only, never a card payment, capped at MAX_EXAMPLES. A rule whose category is gone
// or not spending is skipped; so is a pick whose name is not a current spending category, since
// Jev could not answer with it.
export function householdExamples(data: CategoryData, picks: PickRow[]): Example[] {
  const k = buildKindContext(data.categories)
  const byId = spendingNames(data)
  const current = new Set(byId.values())
  const seen = new Set<string>()
  const out: Example[] = []

  for (const r of data.rules) {
    const name = byId.get(r.category_id)
    if (!name || seen.has(r.merchant_key)) continue
    seen.add(r.merchant_key)
    out.push({ merchant: r.merchant_label, filed_as: name })
  }

  const newestFirst = [...picks].sort((a, b) =>
    a.date === b.date ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.date < b.date ? 1 : -1
  )
  for (const p of newestFirst) {
    const key = merchantKey(p.merchant_name)
    const name = p.user_category
    if (!key || !name || seen.has(key) || isCardPaymentRow(p.pfc_detailed)) continue
    if (!current.has(name) || kindOf(name, k) !== 'spending') continue
    seen.add(key)
    out.push({ merchant: (p.merchant_name ?? '').trim(), filed_as: name })
  }

  return out.slice(0, MAX_EXAMPLES)
}

// One request for up to BATCH_SIZE rows: the examples once, then one Choice per row keyed by the
// row's id. Plaid's sign convention is positive = money out, so only a positive amount is 'out'.
export function buildBatchRequest(
  rows: SuggestRow[],
  options: Record<string, string | null>,
  examples: Example[]
): {
  state: { household_examples: Example[]; transactions: SentTransaction[] }
  questions: Record<string, ChoiceQuestion>
} {
  if (rows.length > BATCH_SIZE) throw new Error(`a batch holds at most ${BATCH_SIZE} rows, got ${rows.length}`)
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('a batch repeats a transaction id')

  const transactions = rows.map(
    (r): SentTransaction => ({
      merchant: r.merchant_name ?? r.name,
      bank_description: r.name,
      amount_usd: Math.abs(r.amount),
      direction: r.amount > 0 ? 'out' : 'in',
      date: r.date,
      bank_category: r.pfc_detailed ?? r.pfc_primary ?? 'UNKNOWN',
    })
  )
  const questions: Record<string, ChoiceQuestion> = {}
  rows.forEach((r, i) => {
    questions[r.id] = {
      type: 'choice',
      instructions:
        `Which of this household's budget categories should \`transactions[${i}]\` be filed under? ` +
        "`household_examples` shows how this household files merchants it has decided; follow its habits.",
      criteria: options,
    }
  })
  return { state: { household_examples: examples, transactions }, questions }
}
