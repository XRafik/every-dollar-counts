import { describe, expect, it } from 'vitest'
import {
  BATCH_SIZE,
  MAX_EXAMPLES,
  NONE,
  buildBatchRequest,
  householdExamples,
  suggestionOptions,
  type PickRow,
  type SuggestRow,
} from '@/lib/category-suggest-request'
import { DEFAULTS, GROCERY, cat, rule, testData } from './helpers/category-context'

const row = (over: Partial<SuggestRow> = {}): SuggestRow => ({
  id: 't1',
  date: '2026-10-01',
  amount: 42.5,
  name: 'WHOLEFDS MKT 10234',
  merchant_name: 'Whole Foods',
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: 'FOOD_AND_DRINK_GROCERIES',
  ...over,
})

const pick = (over: Partial<SuggestRow>, user_category: string | null): PickRow => ({ ...row(over), user_category })

describe('suggestionOptions', () => {
  it('lists spending categories plus none, described by their Plaid default', () => {
    const o = suggestionOptions(testData(DEFAULTS))
    expect(o.Grocery).toBeNull()
    expect(o['Food & Drink']).toBe("Plaid's default for FOOD_AND_DRINK")
    expect(o[NONE]).toBe('None of these categories fits this transaction.')
    expect(o).not.toHaveProperty('Income')
    expect(o).not.toHaveProperty('Transfer In')
    expect(o).not.toHaveProperty('Transfer Out')
  })
  it('throws on a spending category named none, in any case (Review Focus 2)', () => {
    expect(() => suggestionOptions(testData([...DEFAULTS, cat('None')]))).toThrow(
      'a spending category is named "none"'
    )
    expect(() => suggestionOptions(testData([...DEFAULTS, cat(' NONE ')]))).toThrow(
      'a spending category is named "none"'
    )
  })
})

describe('householdExamples', () => {
  it('rules first, then picks for merchants without a rule, newest first, one per merchant', () => {
    const data = testData(DEFAULTS, [rule('Safeway', GROCERY.id)])
    const picks = [
      pick({ id: 'a', date: '2026-09-01', merchant_name: 'Giant' }, 'Shopping'),
      pick({ id: 'b', date: '2026-10-01', merchant_name: 'Giant' }, 'Grocery'),
      pick({ id: 'c', date: '2026-10-02', merchant_name: 'safeway ' }, 'Shopping'),
    ]
    expect(householdExamples(data, picks)).toEqual([
      { merchant: 'Safeway', filed_as: 'Grocery' },
      { merchant: 'Giant', filed_as: 'Grocery' },
    ])
  })
  it('breaks a date tie by id, descending', () => {
    const picks = [
      pick({ id: 'a', merchant_name: 'Giant' }, 'Shopping'),
      pick({ id: 'b', merchant_name: 'Giant' }, 'Grocery'),
    ]
    expect(householdExamples(testData(DEFAULTS), picks)).toEqual([{ merchant: 'Giant', filed_as: 'Grocery' }])
  })
  it('skips transfer and income picks and rules, card payments, and merchant-less rows', () => {
    const data = testData(DEFAULTS, [rule('Zelle', 'c-Transfer Out'), rule('Payroll', 'c-Income')])
    const picks = [
      pick({ id: 'a', merchant_name: 'Venmo' }, 'Transfer Out'),
      pick({ id: 'b', merchant_name: 'Chase', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }, 'Shopping'),
      pick({ id: 'c', merchant_name: null }, 'Shopping'),
      pick({ id: 'd', merchant_name: 'Acme' }, 'Income'),
      pick({ id: 'e', merchant_name: 'Target' }, null),
    ]
    expect(householdExamples(data, picks)).toEqual([])
  })
  it("skips a rule whose category is gone, and a pick naming no current category", () => {
    const data = testData(DEFAULTS, [rule('Safeway', 'c-Deleted')])
    const picks = [pick({ id: 'a', merchant_name: 'Giant' }, 'Groceries (old)')]
    expect(householdExamples(data, picks)).toEqual([])
  })
  it('caps at MAX_EXAMPLES', () => {
    const picks = Array.from({ length: 80 }, (_, i) => pick({ id: `p${i}`, merchant_name: `M${i}` }, 'Shopping'))
    expect(householdExamples(testData(DEFAULTS), picks)).toHaveLength(MAX_EXAMPLES)
  })
})

describe('buildBatchRequest', () => {
  const opts = suggestionOptions(testData(DEFAULTS))
  it('sends only the listed fields, with Plaid sign mapped to direction', () => {
    const req = buildBatchRequest([row(), row({ id: 't2', amount: -10, merchant_name: null, pfc_detailed: null })], opts, [])
    expect(req.state.transactions).toEqual([
      { merchant: 'Whole Foods', bank_description: 'WHOLEFDS MKT 10234', amount_usd: 42.5, direction: 'out', date: '2026-10-01', bank_category: 'FOOD_AND_DRINK_GROCERIES' },
      { merchant: 'WHOLEFDS MKT 10234', bank_description: 'WHOLEFDS MKT 10234', amount_usd: 10, direction: 'in', date: '2026-10-01', bank_category: 'FOOD_AND_DRINK' },
    ])
    expect(JSON.stringify(req.state)).not.toContain('t1')
  })
  it('carries the examples in state', () => {
    const ex = [{ merchant: 'Giant', filed_as: 'Grocery' }]
    expect(buildBatchRequest([row()], opts, ex).state.household_examples).toEqual(ex)
  })
  it('asks one choice per row keyed by id, naming its index', () => {
    const req = buildBatchRequest([row(), row({ id: 't2' })], opts, [])
    expect(Object.keys(req.questions)).toEqual(['t1', 't2'])
    expect(req.questions.t2).toEqual({
      type: 'choice',
      criteria: opts,
      instructions:
        "Which of this household's budget categories should `transactions[1]` be filed under? `household_examples` shows how this household files merchants it has decided; follow its habits.",
    })
  })
  it('refuses more than BATCH_SIZE rows', () => {
    expect(BATCH_SIZE).toBe(20)
    expect(() => buildBatchRequest(Array.from({ length: 20 }, (_, i) => row({ id: `t${i}` })), opts, [])).not.toThrow()
    expect(() => buildBatchRequest(Array.from({ length: 21 }, (_, i) => row({ id: `t${i}` })), opts, [])).toThrow()
  })
  it('refuses duplicate ids, which would silently merge two questions', () => {
    expect(() => buildBatchRequest([row(), row()], opts, [])).toThrow()
  })
})
