import { describe, it, expect } from 'vitest'
import {
  merchantKey,
  kindOf,
  buildKindContext,
  buildCategoryContext,
  resolveCategory,
  changedByRule,
  learnableRule,
  catalogFingerprint,
  contextFingerprint,
  changedBySuggestion,
  suggestableRow,
  spendingCategories,
  SUGGESTION_THRESHOLD,
  type CategorizableTxn,
  type CategoryContext,
  type CategoryData,
  type CategoryRule,
  type SuggestionRef,
} from '@/lib/category-rules'
import { DEFAULTS, GROCERY, HH, cat, rule, sug, testCtx, testData } from './helpers/category-context'

// #28 spec §5.3: resolveCategory is the only code that turns a row into a category name. Pick, then
// rule, then suggestion, then bank; card payments never take a rule or a suggestion; neither ever
// crosses spending/transfer/income.
const row = (over: Partial<CategorizableTxn> = {}): CategorizableTxn => ({
  user_category: null,
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: null,
  merchant_name: 'Safeway',
  suggestion: null,
  ...over,
})
const without = (name: string) => DEFAULTS.filter((c) => c.name !== name)
const safewayToGrocery = rule('Safeway', GROCERY.id)

describe('merchantKey', () => {
  it('is null for null, empty and whitespace', () => {
    expect(merchantKey(null)).toBeNull()
    expect(merchantKey('')).toBeNull()
    expect(merchantKey('   ')).toBeNull()
  })
  it('trims and lowercases, and nothing more', () => {
    expect(merchantKey(' SAFEWAY ')).toBe('safeway')
    expect(merchantKey('Walmart+')).toBe('walmart+')
  })
})

describe("kindOf and the bank's category", () => {
  const k = buildKindContext(DEFAULTS)
  const bank = (pfc_primary: string | null, ctx: CategoryContext = testCtx()) =>
    resolveCategory(row({ pfc_primary, merchant_name: null }), ctx)
  it('names transfers first, then income, and everything else spending', () => {
    expect(kindOf('Transfer In', k)).toBe('transfer')
    expect(kindOf('Income', k)).toBe('income')
    expect(kindOf('Grocery', k)).toBe('spending')
    expect(kindOf('Uncategorized', k)).toBe('spending')
    expect(kindOf('No such category', k)).toBe('spending')
  })
  it('maps a primary to its category and kind', () => {
    expect(bank('FOOD_AND_DRINK')).toEqual({ name: 'Food & Drink', source: 'bank', ruleId: null, bankName: 'Food & Drink' })
    expect(kindOf(bank('FOOD_AND_DRINK').bankName, k)).toBe('spending')
    expect(bank('TRANSFER_OUT').bankName).toBe('Transfer Out')
    expect(kindOf(bank('TRANSFER_OUT').bankName, k)).toBe('transfer')
  })
  // An unmapped row shows as Uncategorized, but its kind is Plaid's: a spending rule applies only
  // where Plaid's tag is itself spending.
  it("takes an unmapped row's kind from Plaid's tag", () => {
    const spendingRule = (pfc_primary: string | null, categories = DEFAULTS) =>
      resolveCategory(row({ pfc_primary }), testCtx(categories, [safewayToGrocery]))
    expect(spendingRule('TRANSFER_OUT', without('Transfer Out'))).toMatchObject({ source: 'bank', bankName: 'Uncategorized' })
    expect(spendingRule('INCOME', without('Income'))).toMatchObject({ source: 'bank', bankName: 'Uncategorized' })
    expect(spendingRule('LOAN_DISBURSEMENTS')).toMatchObject({ source: 'rule', bankName: 'Uncategorized' })
    expect(spendingRule(null)).toMatchObject({ source: 'rule', bankName: 'Uncategorized' })
  })
  it('is last-wins when two categories share a primary, like pfcToName', () => {
    const ctx2 = testCtx([...DEFAULTS, cat('Groceries & Dining', 'FOOD_AND_DRINK', 200)])
    expect(bank('FOOD_AND_DRINK', ctx2).bankName).toBe('Groceries & Dining')
  })
})

describe('resolveCategory', () => {
  const ctx = testCtx(DEFAULTS, [safewayToGrocery])

  it('applies a rule when there is no pick', () => {
    expect(resolveCategory(row(), ctx)).toEqual({ name: 'Grocery', source: 'rule', ruleId: safewayToGrocery.id, bankName: 'Food & Drink' })
  })
  it('lets a hand pick beat a rule', () => {
    expect(resolveCategory(row({ user_category: 'Travel' }), ctx)).toEqual({ name: 'Travel', source: 'pick', ruleId: null, bankName: 'Food & Drink' })
  })
  it('never applies a rule to a card payment, but keeps its pick', () => {
    const card = row({ pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(resolveCategory(card, ctx)).toEqual({ name: 'Loan Payments', source: 'bank', ruleId: null, bankName: 'Loan Payments' })
    expect(resolveCategory({ ...card, user_category: 'Shopping' }, ctx).source).toBe('pick')
  })
  it.each([null, '', '  '])('never matches merchant %j', (merchant_name) => {
    expect(resolveCategory(row({ merchant_name }), ctx).source).toBe('bank')
  })
  it('matches across case and surrounding space, and nothing looser', () => {
    expect(resolveCategory(row({ merchant_name: ' SAFEWAY ' }), ctx).name).toBe('Grocery')
    const walmart = testCtx(DEFAULTS, [rule('Walmart', GROCERY.id)])
    expect(resolveCategory(row({ merchant_name: 'Walmart+' }), walmart).source).toBe('bank')
  })
  it('does not apply a spending rule to a transfer row', () => {
    expect(resolveCategory(row({ pfc_primary: 'TRANSFER_OUT' }), ctx)).toMatchObject({ name: 'Transfer Out', source: 'bank' })
  })
  // Rules work within every kind, not only spending.
  it('applies a transfer rule to a transfer row', () => {
    const transfer = testCtx(DEFAULTS, [rule('Savings', 'c-Transfer In')])
    const t = row({ merchant_name: 'Savings', pfc_primary: 'TRANSFER_OUT' })
    expect(resolveCategory(t, transfer)).toMatchObject({ name: 'Transfer In', source: 'rule', bankName: 'Transfer Out' })
  })
  // Salary comes first so that pfcToName, which is last-wins, still maps INCOME to Income.
  const withSalary = [cat('Salary', 'INCOME', -1), ...DEFAULTS]
  it('applies an income rule to an income row', () => {
    const income = testCtx(withSalary, [rule('Acme Payroll', 'c-Salary')])
    const t = row({ merchant_name: 'Acme Payroll', pfc_primary: 'INCOME' })
    expect(resolveCategory(t, income)).toMatchObject({ name: 'Salary', source: 'rule', bankName: 'Income' })
  })
  it('does not apply an income rule to a spending row', () => {
    const income = testCtx(withSalary, [rule('Safeway', 'c-Salary')])
    expect(resolveCategory(row(), income)).toMatchObject({ name: 'Food & Drink', source: 'bank' })
  })
  it('applies a spending rule to an Uncategorized row with a spending primary', () => {
    expect(resolveCategory(row({ pfc_primary: 'LOAN_DISBURSEMENTS' }), ctx)).toMatchObject({ name: 'Grocery', source: 'rule', bankName: 'Uncategorized' })
  })
  it('after "Transfer Out" is deleted, applies neither a spending nor a transfer rule to a TRANSFER_OUT row', () => {
    const cats = without('Transfer Out')
    const spending = testCtx(cats, [safewayToGrocery])
    const transfer = testCtx(cats, [rule('Safeway', 'c-Transfer In')])
    const t = row({ pfc_primary: 'TRANSFER_OUT' })
    expect(resolveCategory(t, spending)).toMatchObject({ name: 'Uncategorized', source: 'bank' })
    expect(resolveCategory(t, transfer)).toMatchObject({ name: 'Uncategorized', source: 'bank' })
  })
  it('after "Income" is deleted, does not apply a spending rule to an INCOME row', () => {
    const t = row({ pfc_primary: 'INCOME' })
    expect(resolveCategory(t, testCtx(without('Income'), [safewayToGrocery]))).toMatchObject({ name: 'Uncategorized', source: 'bank' })
  })
  it("gives the bank category when the rule's category is missing from the context", () => {
    const dangling = testCtx(DEFAULTS, [rule('Safeway', 'c-gone')])
    expect(resolveCategory(row(), dangling)).toMatchObject({ name: 'Food & Drink', source: 'bank' })
  })
  // Rules point at an id, so a rename moves every row at once.
  it('follows a renamed category', () => {
    const renamed = DEFAULTS.map((c) => (c.id === GROCERY.id ? { ...c, name: 'Groceries' } : c))
    expect(resolveCategory(row(), testCtx(renamed, [safewayToGrocery])).name).toBe('Groceries')
  })
  it('reports the bank name, and changedByRule only when the rule changed it', () => {
    const r = resolveCategory(row(), ctx)
    expect(r.bankName).toBe('Food & Drink')
    expect(changedByRule(r)).toBe(true)
    const same = resolveCategory(row(), testCtx(DEFAULTS, [rule('Safeway', 'c-Food & Drink')]))
    expect(same.source).toBe('rule')
    expect(changedByRule(same)).toBe(false)
    expect(changedByRule(resolveCategory(row({ user_category: 'Travel' }), ctx))).toBe(false)
  })
})

describe('buildCategoryContext', () => {
  it('can build as if a category and its rules were gone', () => {
    const data = testData(DEFAULTS, [safewayToGrocery])
    const gone = buildCategoryContext(data, { withoutCategoryId: GROCERY.id })
    expect(resolveCategory(row(), gone)).toMatchObject({ name: 'Food & Drink', source: 'bank' })
    const foodGone = buildCategoryContext(data, { withoutCategoryId: 'c-Food & Drink' })
    expect(resolveCategory(row({ merchant_name: 'Other' }), foodGone).name).toBe('Uncategorized')
  })
  it('throws on rules from more than one household', () => {
    const data = testData(DEFAULTS, [safewayToGrocery, rule('Giant', GROCERY.id, { household_id: 'hh-2' })])
    expect(() => buildCategoryContext(data)).toThrow('category rules span more than one household')
  })
  it('accepts a CategoryContext wherever a KindContext is', () => {
    const ctx: CategoryContext = testCtx()
    expect(kindOf('Income', ctx)).toBe('income')
  })
  it('refuses hand-built contexts and data at compile time', () => {
    // @ts-expect-error a literal is not a CategoryContext
    const literal: CategoryContext = {}
    // @ts-expect-error data must come from fetchCategoryContext
    const data: CategoryData = { categories: DEFAULTS, rules: [] }
    expect([literal, data, HH]).toBeTruthy()
  })
})

// #28 spec §6.1 step 8: whether a pick teaches. The gate is resolveCategory's own for a rule
// (§5.3 steps 3–4) plus "the pick isn't the bank's category", so a learned rule always relabels the
// row it was learned from (decision 4, §2.1).
describe('learnableRule', () => {
  const k = buildKindContext(DEFAULTS)
  // learnableRule never looks at user_category: a re-pick teaches like a first pick.
  const txn = row

  it('teaches a same-kind pick that differs from the bank', () => {
    expect(learnableRule(txn(), 'Grocery', k)).toEqual({ merchantKey: 'safeway', merchantLabel: 'Safeway' })
  })

  it('trims the label and lowercases the key', () => {
    expect(learnableRule(txn({ merchant_name: '  SAFEWAY ' }), 'Grocery', k)).toEqual({
      merchantKey: 'safeway',
      merchantLabel: 'SAFEWAY',
    })
  })

  it.each([null, '', '   '])('teaches nothing without a merchant name (%j)', (merchant_name) => {
    expect(learnableRule(txn({ merchant_name }), 'Grocery', k)).toBeNull()
  })

  it('teaches nothing when the pick equals the bank category', () => {
    expect(learnableRule(txn(), 'Food & Drink', k)).toBeNull()
  })

  it('teaches nothing across the line', () => {
    expect(learnableRule(txn(), 'Income', k)).toBeNull()
    expect(learnableRule(txn(), 'Transfer Out', k)).toBeNull()
    expect(learnableRule(txn({ pfc_primary: 'TRANSFER_OUT' }), 'Grocery', k)).toBeNull()
  })

  it('teaches nothing on a card payment, even with a merchant name', () => {
    expect(
      learnableRule(txn({ pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }), 'Grocery', k)
    ).toBeNull()
  })

  it('teaches nothing on a TRANSFER_OUT row after "Transfer Out" is deleted', () => {
    const k2 = buildKindContext(without('Transfer Out'))
    // Plaid's kind is transfer; the row shows Uncategorized, which counts as spending.
    expect(learnableRule(txn({ pfc_primary: 'TRANSFER_OUT' }), 'Grocery', k2)).toBeNull()
    expect(learnableRule(txn({ pfc_primary: 'TRANSFER_OUT' }), 'Transfer In', k2)).toBeNull()
  })

  it('teaches nothing on an INCOME row after "Income" is deleted', () => {
    expect(learnableRule(txn({ pfc_primary: 'INCOME' }), 'Grocery', buildKindContext(without('Income')))).toBeNull()
  })

  it('teaches a spending pick on an unmapped spending row', () => {
    expect(learnableRule(txn({ pfc_primary: 'LOAN_DISBURSEMENTS' }), 'Grocery', k)).toEqual({
      merchantKey: 'safeway',
      merchantLabel: 'Safeway',
    })
  })

  it('teaches a same-kind pick within transfers', () => {
    expect(learnableRule(txn({ pfc_primary: 'TRANSFER_OUT' }), 'Transfer In', k)).not.toBeNull()
  })

  // The property that keeps the gate and the resolver from drifting apart: a pick teaches exactly
  // when the rule it would create relabels that same row once the pick is gone.
  it('agrees with resolveCategory on every row, pick and category set', () => {
    const sets = [DEFAULTS, without('Income'), without('Transfer In'), without('Transfer Out'),
      [...DEFAULTS, cat('Uncategorized', null, 200)],
      [...without('Income'), cat('Uncategorized', 'INCOME', 200)]]
    const primaries = ['FOOD_AND_DRINK', 'INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS',
      'LOAN_DISBURSEMENTS', null]
    const details = [null, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT']
    let taught = 0
    for (const cats of sets) {
      const kc = buildKindContext(cats)
      for (const pfc_primary of primaries) for (const pfc_detailed of details) for (const picked of cats) {
        const t = txn({ pfc_primary, pfc_detailed })
        const learned = learnableRule(t, picked.name, kc)
        const resolved = resolveCategory({ ...t, user_category: null },
          testCtx(cats, [rule('Safeway', picked.id)]))
        expect({ pfc_primary, pfc_detailed, picked: picked.name, learned: learned !== null })
          .toEqual({ pfc_primary, pfc_detailed, picked: picked.name, learned: changedByRule(resolved) })
        if (learned) taught++
      }
    }
    expect(taught).toBeGreaterThan(0) // the property must not hold vacuously
  })
})

// #28 spec §5.3 step 5 and §14.3: Jev's suggestion sits between the rule and the bank, applies only
// when switched on, current, confident and same-kind, and never on a card payment.
const FP = catalogFingerprint(DEFAULTS)
const wholeFoods = (s: SuggestionRef | null, over: Partial<CategorizableTxn> = {}) =>
  row({ pfc_detailed: 'FOOD_AND_DRINK_GROCERIES', merchant_name: 'Whole Foods', suggestion: s, ...over })

describe('resolveCategory step 5: suggestions', () => {
  const ctx = (opts: { suggestionsOn?: boolean } = {}, rules: CategoryRule[] = []) =>
    buildCategoryContext(testData(DEFAULTS, rules, opts))

  it('applies a current, confident, same-kind suggestion', () => {
    expect(resolveCategory(wholeFoods(sug(GROCERY.id, 0.95, FP)), ctx())).toEqual(
      { name: 'Grocery', source: 'suggestion', ruleId: null, bankName: 'Food & Drink' })
  })
  it('applies at exactly the threshold', () => {
    expect(resolveCategory(wholeFoods(sug(GROCERY.id, SUGGESTION_THRESHOLD, FP)), ctx()).source).toBe('suggestion')
  })
  it('ignores one below the threshold', () => {
    expect(resolveCategory(wholeFoods(sug(GROCERY.id, SUGGESTION_THRESHOLD - 0.01, FP)), ctx()).source).toBe('bank')
  })
  it('ignores a stale fingerprint', () => {
    expect(resolveCategory(wholeFoods(sug(GROCERY.id, 0.99, 'old')), ctx()).source).toBe('bank')
  })
  it('ignores one whose category is gone', () => {
    expect(resolveCategory(wholeFoods(sug('c-deleted', 0.99, FP)), ctx()).source).toBe('bank')
  })
  it('ignores every suggestion with the switch off', () => {
    expect(resolveCategory(wholeFoods(sug(GROCERY.id, 0.99, FP)), ctx({ suggestionsOn: false })).source).toBe('bank')
  })
  it('resolves "none" (a null category) to the bank', () => {
    expect(resolveCategory(wholeFoods(sug(null, 0.99, FP)), ctx()).source).toBe('bank')
  })
  it('a hand pick beats a suggestion', () => {
    expect(resolveCategory(wholeFoods(sug(GROCERY.id, 0.99, FP), { user_category: 'Travel' }), ctx()).source).toBe('pick')
  })
  it('a rule beats a suggestion', () => {
    const r = resolveCategory(wholeFoods(sug(GROCERY.id, 0.99, FP)), ctx({}, [rule('Whole Foods', cat('Shopping').id)]))
    expect(r).toMatchObject({ source: 'rule', name: 'Shopping' })
  })
  it('never applies across kinds (a spending row suggested into Transfer Out)', () => {
    const transferOut = DEFAULTS.find((c) => c.name === 'Transfer Out')!
    expect(resolveCategory(wholeFoods(sug(transferOut.id, 0.99, FP)), ctx()).source).toBe('bank')
  })
  it('never applies to a card payment', () => {
    const row = wholeFoods(sug(GROCERY.id, 0.99, FP), { pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(resolveCategory(row, ctx()).source).toBe('bank')
  })
  it('tolerates an array-shaped embed by ignoring it (Review Focus 1)', () => {
    const row = wholeFoods([sug(GROCERY.id, 0.99, FP)] as unknown as SuggestionRef)
    expect(resolveCategory(row, ctx()).source).toBe('bank')
  })
  it('changedBySuggestion is false when the suggestion agrees with the bank', () => {
    const fd = DEFAULTS.find((c) => c.name === 'Food & Drink')!
    const r = resolveCategory(wholeFoods(sug(fd.id, 0.99, FP)), ctx())
    expect(r.source).toBe('suggestion')
    expect(changedBySuggestion(r)).toBe(false)
  })
  it('changedBySuggestion is true when the suggestion relabels the row, and false for a rule', () => {
    expect(changedBySuggestion(resolveCategory(wholeFoods(sug(GROCERY.id, 0.99, FP)), ctx()))).toBe(true)
    expect(changedBySuggestion(resolveCategory(row(), testCtx(DEFAULTS, [rule('Safeway', GROCERY.id)])))).toBe(false)
  })

  describe('catalogFingerprint', () => {
    it('ignores order', () => expect(catalogFingerprint([...DEFAULTS].reverse())).toBe(FP))
    it('changes on a rename', () =>
      expect(catalogFingerprint(DEFAULTS.map((c) => (c === GROCERY ? { ...c, name: 'Groceries' } : c)))).not.toBe(FP))
    it('changes on an add and on a delete', () => {
      expect(catalogFingerprint([...DEFAULTS, cat('Pets')])).not.toBe(FP)
      expect(catalogFingerprint(DEFAULTS.filter((c) => c !== GROCERY))).not.toBe(FP)
    })
    it('changes when a category changes kind (its pfc_primary)', () =>
      expect(catalogFingerprint(DEFAULTS.map((c) => (c === GROCERY ? { ...c, pfc_primary: 'INCOME' } : c)))).not.toBe(FP))
    it('contextFingerprint equals catalogFingerprint of the context categories', () =>
      expect(contextFingerprint(ctx())).toBe(FP))
  })

  describe('suggestableRow', () => {
    const k = buildKindContext(DEFAULTS)
    it('admits an unpicked spending row', () => expect(suggestableRow(wholeFoods(null), k)).toBe(true))
    it('refuses a picked row', () => expect(suggestableRow(wholeFoods(null, { user_category: 'Grocery' }), k)).toBe(false))
    it('refuses a card payment', () =>
      expect(suggestableRow(wholeFoods(null, { pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }), k)).toBe(false))
    it('refuses transfers and income', () => {
      expect(suggestableRow(wholeFoods(null, { pfc_primary: 'TRANSFER_OUT', pfc_detailed: null }), k)).toBe(false)
      expect(suggestableRow(wholeFoods(null, { pfc_primary: 'INCOME', pfc_detailed: null }), k)).toBe(false)
    })
    it('refuses an unmapped transfer whose shown name is Uncategorized', () => {
      const noTransferOut = buildKindContext(DEFAULTS.filter((c) => c.name !== 'Transfer Out'))
      expect(suggestableRow(wholeFoods(null, { pfc_primary: 'TRANSFER_OUT', pfc_detailed: null }), noTransferOut)).toBe(false)
    })
  })

  it('spendingCategories excludes income and transfer categories', () => {
    const names = spendingCategories(DEFAULTS, buildKindContext(DEFAULTS)).map((c) => c.name)
    expect(names).toContain('Grocery')
    expect(names).not.toContain('Income')
    expect(names).not.toContain('Transfer Out')
  })
})
