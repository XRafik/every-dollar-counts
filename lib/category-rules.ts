// Category rules (#28): turning a transaction into a category NAME. Pure, no I/O.
//
// resolveCategory is the ONLY code that does this (card payments display their pick or 'Card
// payment' directly). Every page, count and filter goes through it, so precedence (a hand pick,
// then the merchant's rule, then Jev's suggestion, then the bank's category), the card-payment
// exemption and the kind gate live in one place. A rule's or a suggestion's effect exists only
// here, at read time: nothing is written to transactions, so changing or removing a rule, or
// switching suggestions off, moves every row with it.
import {
  isCardPaymentRow,
  nonSpendingNames,
  pfcToName,
  transferNames,
  TRANSFER_PFC,
  type Category,
} from './categories'

// The row's embedded category_suggestions row (#28 spec §14.3), or null. Pages select it as
// `suggestion:category_suggestions(category_id, confidence, catalog_fingerprint)`.
export type SuggestionRef = { category_id: string | null; confidence: number; catalog_fingerprint: string }

// Picked by the owner from §14.8's launch check (2026-10-15): on held-out hand picks, every answer at
// or above it that differed from the bank matched the pick.
export const SUGGESTION_THRESHOLD = 0.9

// All five REQUIRED, so a page whose select drops one fails tsc instead of resolving wrongly.
export type CategorizableTxn = {
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
  merchant_name: string | null
  suggestion: SuggestionRef | null
}

export type CategoryRule = {
  id: string
  household_id: string
  merchant_key: string
  merchant_label: string
  category_id: string
  origin: 'seeded' | 'learned'
}

export type Kind = 'spending' | 'transfer' | 'income'

// Keyed on `source`, so only a rule can carry a ruleId. bankName is what the bank mapping alone
// would show.
export type ResolvedCategory = Readonly<
  | { source: 'pick'; name: string; ruleId: null; bankName: string }
  | { source: 'rule'; name: string; ruleId: string; bankName: string }
  | { source: 'suggestion'; name: string; ruleId: null; bankName: string }
  | { source: 'bank'; name: string; ruleId: null; bankName: string }
>

// Brands. A page that forgets the rules must not compile: CategoryData comes only from
// fetchCategoryContext (lib/category-context.ts), and the two contexts only from the builders
// below. A hand-built `{ categories, rules: [] }` lacks the brand and fails tsc. The state lives
// under non-exported symbol keys (not a WeakMap or #private) so buildSpendContext can spread a
// context. Tripwire 4 (scripts/check-invariants.mjs) rejects `as CategoryData` and friends outside
// this file, lib/category-context.ts and lib/spend-context.ts. The brand stops a page that never
// touched the rules; spreading CategoryData keeps the brand, so it does not stop a page that
// deliberately edits the rules list.
declare const DATA_BRAND: unique symbol
const KIND_STATE = Symbol('kind-context')
const RULE_STATE = Symbol('category-context')

export type CategoryData = {
  readonly categories: Category[]
  readonly rules: CategoryRule[]
  readonly suggestionsOn: boolean // CATEGORY_SUGGESTIONS=on (spec §14.7); off ignores every suggestion
  readonly [DATA_BRAND]: true
}

// CategoryData without its brand. Every literal that is branded `as CategoryData` first
// `satisfies` this, so a dropped or misspelled field (suggestionsOn) fails tsc despite the cast.
export type CategoryDataFields = Omit<CategoryData, typeof DATA_BRAND>

type KindState = {
  pfcMap: Record<string, string> // Plaid primary -> category name (last wins, as pfcToName)
  transfers: Set<string> // the exact sets the totals branch on
  nonSpending: Set<string>
}
type RuleState = {
  byKey: Map<string, CategoryRule>
  nameById: Map<string, string>
  fingerprint: string // catalogFingerprint of the context's categories
  suggestionsOn: boolean
}

export type KindContext = { readonly [KIND_STATE]: KindState }
export type CategoryContext = KindContext & { readonly [RULE_STATE]: RuleState }

// null for null, '' or whitespace; otherwise trimmed and lowercased. Matches the seed's
// `lower(regexp_replace(merchant_name, '^\s+|\s+$', '', 'g'))` — not `lower(trim())`: on ASCII, JS
// trim() and Postgres `\s` strip the same six whitespace characters. Launch check 3a confirms every
// merchant name is ASCII when the seed runs.
export function merchantKey(s: string | null): string | null {
  const k = (s ?? '').trim().toLowerCase()
  return k || null
}

export function buildKindContext(categories: Category[]): KindContext {
  return {
    [KIND_STATE]: {
      pfcMap: pfcToName(categories),
      transfers: transferNames(categories),
      nonSpending: nonSpendingNames(categories),
    },
  }
}

// `withoutCategoryId` builds the context as if that category, and every rule pointing at it, were
// already deleted: deleteImpact (lib/category-views.ts) uses it to say what a delete would move.
export function buildCategoryContext(
  data: CategoryData,
  opts: { withoutCategoryId?: string } = {}
): CategoryContext {
  // The app assumes one household per user (memberships are read with `.limit(1)`). Make that fail
  // loudly for rules rather than silently applying another household's.
  if (new Set(data.rules.map((r) => r.household_id)).size > 1) {
    throw new Error('category rules span more than one household')
  }
  const gone = opts.withoutCategoryId
  const categories = gone ? data.categories.filter((c) => c.id !== gone) : data.categories
  const rules = gone ? data.rules.filter((r) => r.category_id !== gone) : data.rules
  const byKey = new Map<string, CategoryRule>()
  for (const r of rules) byKey.set(r.merchant_key, r)
  return {
    ...buildKindContext(categories),
    [RULE_STATE]: {
      byKey,
      nameById: new Map(categories.map((c) => [c.id, c.name])),
      fingerprint: catalogFingerprint(categories),
      suggestionsOn: data.suggestionsOn,
    },
  }
}

// cyrb53: a small pure-JS 53-bit string hash. Pure so client bundles can import this file; it
// only detects that the catalogue changed, it is not a security boundary.
function cyrb53(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

// Spec §14.3: changes when a category is added, renamed, deleted or changes kind, so every older
// suggestion stops applying at once. Kind is computed from the whole list, as the totals do.
export function catalogFingerprint(categories: Category[]): string {
  const k = buildKindContext(categories)
  const triples = categories.map((c) => `${c.id}:${c.name}:${kindOf(c.name, k)}`).sort()
  return cyrb53(JSON.stringify(triples))
}

export function contextFingerprint(ctx: CategoryContext): string {
  return ctx[RULE_STATE].fingerprint
}

// How the totals count a category name. Transfers first, because the non-spending set contains
// them. Any name no category holds is in neither, so it counts as spending. So does
// 'Uncategorized', unless a household category of that name maps to an income or transfer primary
// (a renamed default).
export function kindOf(name: string, k: KindContext): Kind {
  const s = k[KIND_STATE]
  if (s.transfers.has(name)) return 'transfer'
  if (s.nonSpending.has(name)) return 'income'
  return 'spending'
}

function plaidKind(pfcPrimary: string | null): Kind {
  if (pfcPrimary && TRANSFER_PFC.has(pfcPrimary)) return 'transfer'
  if (pfcPrimary === 'INCOME') return 'income'
  return 'spending'
}

// The category the bank's tag maps to, and its kind. When the primary maps to no household
// category (its default was deleted, or Plaid sent one with no default), the row SHOWS as
// 'Uncategorized' but its kind comes from Plaid's own tag, so the two can differ; see resolveCategory.
function bankCategory(t: { pfc_primary: string | null }, k: KindContext): { name: string; kind: Kind } {
  const mapped = t.pfc_primary ? k[KIND_STATE].pfcMap[t.pfc_primary] : undefined
  if (mapped) return { name: mapped, kind: kindOf(mapped, k) }
  return { name: 'Uncategorized', kind: plaidKind(t.pfc_primary) }
}

export function resolveCategory(t: CategorizableTxn, ctx: CategoryContext): ResolvedCategory {
  const bank = bankCategory(t, ctx)
  const asBank: ResolvedCategory = { name: bank.name, source: 'bank', ruleId: null, bankName: bank.name }
  // 1. A hand pick wins, even on a card payment (the existing "user override wins" contract).
  if (t.user_category) return { name: t.user_category, source: 'pick', ruleId: null, bankName: bank.name }
  // 2. Card payments never take a rule: any category on one re-enters it into every total (#59).
  //    pfc_detailed alone, never isCreditCardPayment.
  if (isCardPaymentRow(t.pfc_detailed)) return asBank
  // 3. The merchant's rule, only within one kind. The rule's kind must equal BOTH Plaid's kind for
  //    the row and the kind of the name the totals would otherwise count it under. For a mapped
  //    row those agree; for an unmapped one they can differ, and the row then takes no rule and
  //    stays counted exactly as it is today. So no set of rules moves Spent, Income or Saved.
  const key = merchantKey(t.merchant_name)
  const rule = key ? ctx[RULE_STATE].byKey.get(key) : undefined
  const name = rule ? ctx[RULE_STATE].nameById.get(rule.category_id) : undefined
  if (rule && name && ruleFits(name, bank, ctx)) {
    return { name, source: 'rule', ruleId: rule.id, bankName: bank.name }
  }
  // 4. Jev's suggestion (spec §14.3): switched on, current catalogue, confident, same kind. An
  //    array (an embed PostgREST did not treat as one-to-one) is ignored, never half-read.
  const s = t.suggestion
  const st = ctx[RULE_STATE]
  if (st.suggestionsOn && s && !Array.isArray(s) && s.category_id && s.catalog_fingerprint === st.fingerprint &&
      s.confidence >= SUGGESTION_THRESHOLD) {
    const suggested = st.nameById.get(s.category_id)
    if (suggested && ruleFits(suggested, bank, ctx)) {
      return { name: suggested, source: 'suggestion', ruleId: null, bankName: bank.name }
    }
  }
  // 5. Otherwise, the bank's category.
  return asBank
}

// resolveCategory's kind gate for a rule (step 3) and a suggestion (step 4), shared with
// learnableRule so they cannot drift. suggestableRow applies the same two measures to 'spending'
// itself; keep them in step. A category naming `name` applies only when that name's kind equals
// both Plaid's kind for the row and the kind of the name the row otherwise shows.
function ruleFits(name: string, bank: { name: string; kind: Kind }, k: KindContext): boolean {
  const kind = kindOf(name, k)
  return kind === bank.kind && kind === kindOf(bank.name, k)
}

// A rule that relabelled the row, as opposed to one that agrees with the bank. Drives the learned
// marker and the Settings counts.
export function changedByRule(r: ResolvedCategory): boolean {
  return r.source === 'rule' && r.name !== r.bankName
}

// A suggestion that relabelled the row, as opposed to one that agrees with the bank. Drives the
// suggested marker (spec §14.6).
export function changedBySuggestion(r: ResolvedCategory): boolean {
  return r.source === 'suggestion' && r.name !== r.bankName
}

// Spec §14.2: the rows Jev is asked about. No pick, not a card payment, and spending by both
// Plaid's kind and the shown name's kind (the same two measures ruleFits checks).
export function suggestableRow(t: CategorizableTxn, k: KindContext): boolean {
  if (t.user_category || isCardPaymentRow(t.pfc_detailed)) return false
  const bank = bankCategory(t, k)
  return bank.kind === 'spending' && kindOf(bank.name, k) === 'spending'
}

export function spendingCategories(categories: Category[], k: KindContext): Category[] {
  return categories.filter((c) => kindOf(c.name, k) === 'spending')
}

export type LearnableRule = { merchantKey: string; merchantLabel: string }

// Whether a hand pick teaches a merchant rule (spec §6.1 step 8), and if so its key and display
// spelling. The gate is resolveCategory's own for a rule (spec §5.3 steps 3–4: never on a card
// payment, and ruleFits: the pick's kind must equal both Plaid's kind for the row and the kind of the
// name the row shows), plus "the pick isn't the bank's own category". So a learned rule always
// relabels the row it was learned from: a pick that agrees with the bank would pin the merchant to a
// rule that changes nothing (§2.1). `k` must be built from the household's WHOLE category list.
export function learnableRule(
  row: { merchant_name: string | null; pfc_primary: string | null; pfc_detailed: string | null },
  pickedName: string,
  k: KindContext
): LearnableRule | null {
  const key = merchantKey(row.merchant_name)
  if (!key || isCardPaymentRow(row.pfc_detailed)) return null
  const bank = bankCategory(row, k)
  if (!ruleFits(pickedName, bank, k) || pickedName === bank.name) return null
  return { merchantKey: key, merchantLabel: (row.merchant_name ?? '').trim() }
}
