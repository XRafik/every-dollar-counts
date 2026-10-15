import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The suggestion job (#28 spec §14.5, §14.9). It never throws: every failure is a `failed`
// outcome and one `[suggest] failed` line that names the household and the error, never a request.
const { db, askChoices, assertEnvMatchesDatabase, fetchCategoryDataForHousehold, suggestionsEnabled } =
  vi.hoisted(() => ({
    db: {
      // The transactions read's stand-in, set per test (a pagedTable's query).
      txnQuery: null as null | (() => Record<string, unknown>),
      // Every `.from(table)` chain, as [method, ...args] calls.
      froms: [] as { table: string; calls: unknown[][] }[],
      // Every upsert, and what each answers in turn (by default `{ count: <rows>, error: null }`).
      upserts: [] as { payload: Record<string, unknown>[]; options: unknown }[],
      upsertResults: [] as ({ count: number | null; error: null } | { count: null; error: { code?: string; message: string } })[],
    },
    askChoices: vi.fn(),
    assertEnvMatchesDatabase: vi.fn(),
    fetchCategoryDataForHousehold: vi.fn(),
    suggestionsEnabled: vi.fn(),
  }))

vi.mock('@/lib/plaid', () => ({ plaidEnv: 'production' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const entry = { table, calls: [] as unknown[][] }
      db.froms.push(entry)
      if (table === 'category_suggestions') {
        return {
          upsert: (payload: Record<string, unknown>[], options: unknown) => {
            entry.calls.push(['upsert', payload, options])
            db.upserts.push({ payload, options })
            const next = db.upsertResults.shift() ?? { count: payload.length, error: null }
            return Promise.resolve(next)
          },
        }
      }
      if (table !== 'transactions' || !db.txnQuery) throw new Error(`unexpected .from('${table}')`)
      // Records each call, then hands it to the paged stand-in.
      const inner = db.txnQuery()
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'or', 'limit']) {
        chain[m] = (...args: unknown[]) => {
          entry.calls.push([m, ...args])
          ;(inner[m] as (...a: unknown[]) => unknown)(...args)
          return chain
        }
      }
      chain.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
        (inner.then as (r: unknown, j: unknown) => unknown)(resolve, reject)
      return chain
    },
  },
}))
vi.mock('@/lib/app-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-env')>()),
  assertEnvMatchesDatabase,
}))
vi.mock('@/lib/typesafe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/typesafe')>()),
  askChoices,
}))
vi.mock('@/lib/category-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/category-context')>()),
  fetchCategoryDataForHousehold,
  suggestionsEnabled,
}))

import { suggestCategories } from '@/lib/category-suggest'
import { EnvMismatchError } from '@/lib/app-env'
import { TypeSafeError } from '@/lib/typesafe'
import { SUGGESTION_EMBED } from '@/lib/category-context'
import { buildCategoryContext, contextFingerprint, type SuggestionRef } from '@/lib/category-rules'
import { householdExamples, type ChoiceQuestion, type PickRow } from '@/lib/category-suggest-request'
import { DEFAULTS, GROCERY, HH, cat, rule, sug, testData } from './helpers/category-context'
import { pagedTable, type PagedTable } from '../stubs/postgrest-pages'

type Txn = PickRow & { suggestion: SuggestionRef | null }
type Req = { state: { household_examples: unknown[]; transactions: unknown[] }; questions: Record<string, ChoiceQuestion> }

const RULES = [rule('Safeway', GROCERY.id)]
const DATA = testData(DEFAULTS, RULES)
const FP = contextFingerprint(buildCategoryContext(DATA))
const NOW = '2026-10-15T12:00:00.000Z'

const txn = (id: string, over: Partial<Txn> = {}): Txn => ({
  id,
  date: '2026-10-01',
  amount: 42.5,
  name: `SECRET DESCRIPTION ${id}`,
  merchant_name: `Secret Merchant ${id}`,
  user_category: null,
  pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: 'FOOD_AND_DRINK_GROCERIES',
  suggestion: null,
  ...over,
})

let table: PagedTable
function seed(rows: Txn[], opts: Parameters<typeof pagedTable>[1] = {}) {
  table = pagedTable(rows as never, opts)
  db.txnQuery = table.query
}

// Jev answers every question with `choice` (Grocery by default) unless `by` names another.
function answering(by: Record<string, string> = {}, choice = 'Grocery') {
  askChoices.mockImplementation(async (req: Req) => ({
    model: 'jev-test',
    answers: Object.fromEntries(
      Object.keys(req.questions).map((id) => [
        id,
        { type: 'choice', choice: by[id] ?? choice, probabilities: {}, confidence: 0.93 },
      ])
    ),
    usage: { input_tokens: 100, output_tokens: 5 },
  }))
}

const asked = () => askChoices.mock.calls.map(([req]) => Object.keys((req as Req).questions))
const logs = (spy: ReturnType<typeof vi.spyOn>) => JSON.stringify(spy.mock.calls)

let errSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  db.froms = []
  db.upserts = []
  db.upsertResults = []
  seed([])
  askChoices.mockReset()
  answering()
  assertEnvMatchesDatabase.mockReset().mockResolvedValue(undefined)
  fetchCategoryDataForHousehold.mockReset().mockResolvedValue(DATA)
  suggestionsEnabled.mockReset().mockReturnValue(true)
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Nothing that left for TypeSafe, and no transaction detail, may reach a log line.
function expectNoDetailsLogged() {
  for (const spy of [errSpy, warnSpy, logSpy]) {
    expect(logs(spy)).not.toMatch(/SECRET|Secret Merchant/)
  }
}

describe('suggestCategories: gates', () => {
  it('switch off: returns off, with no env check, no read and no TypeSafe call', async () => {
    suggestionsEnabled.mockReturnValue(false)
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'off' })
    expect(assertEnvMatchesDatabase).not.toHaveBeenCalled()
    expect(fetchCategoryDataForHousehold).not.toHaveBeenCalled()
    expect(db.froms).toEqual([])
    expect(askChoices).not.toHaveBeenCalled()
  })

  it('environment mismatch: skipped, logged, no TypeSafe call and no write', async () => {
    seed([txn('t1')])
    assertEnvMatchesDatabase.mockRejectedValue(new EnvMismatchError('production', 'sandbox'))
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'skipped', reason: 'environment' })
    expect(warnSpy).toHaveBeenCalledWith('[suggest] skipped: environment')
    expect(askChoices).not.toHaveBeenCalled()
    expect(db.upserts).toEqual([])
  })

  it('an environment check that cannot run is a failure, not a skip', async () => {
    assertEnvMatchesDatabase.mockRejectedValue(new Error('could not read app_env: boom'))
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'failed', asked: 0, written: 0 })
    expect(errSpy).toHaveBeenCalledWith('[suggest] failed', HH, 'could not read app_env: boom')
    expect(askChoices).not.toHaveBeenCalled()
  })
})

describe('suggestCategories: the read and the rows asked about', () => {
  it("reads the household's non-removed transactions with the suggestion embed, through readAllRows", async () => {
    seed([txn('t1')])
    await suggestCategories(HH)
    expect(fetchCategoryDataForHousehold).toHaveBeenCalledWith(HH)
    const read = db.froms.find((f) => f.table === 'transactions')!
    const select = read.calls.find((c) => c[0] === 'select')![1] as string
    expect(select).toContain(SUGGESTION_EMBED)
    for (const col of ['id', 'date', 'amount', 'name', 'merchant_name', 'user_category', 'pfc_primary', 'pfc_detailed']) {
      expect(select.split(',').map((s) => s.trim())).toContain(col)
    }
    expect(read.calls).toContainEqual(['eq', 'household_id', HH])
    expect(read.calls).toContainEqual(['eq', 'removed', false])
    // readAllRows's paging, so a history over 1,000 rows is read whole (#69).
    expect(read.calls).toContainEqual(['order', 'date'])
    expect(read.calls).toContainEqual(['order', 'id'])
  })

  it("only §14.2's rows reach the request: stale and plain spending rows, nothing else", async () => {
    seed([
      txn('picked', { user_category: 'Shopping' }),
      txn('card', { pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
      txn('xfer', { pfc_primary: 'TRANSFER_OUT', pfc_detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' }),
      txn('income', { pfc_primary: 'INCOME', pfc_detailed: 'INCOME_WAGES' }),
      txn('current', { suggestion: sug(GROCERY.id, 0.95, FP) }),
      txn('stale', { suggestion: sug(GROCERY.id, 0.95, 'an-older-catalogue') }),
      txn('plain1'),
      txn('plain2', { pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: null }),
    ])
    const out = await suggestCategories(HH)
    expect(askChoices).toHaveBeenCalledTimes(1)
    expect(asked()[0].sort()).toEqual(['plain1', 'plain2', 'stale'])
    expect(out).toEqual({ status: 'done', asked: 3, written: 3, inputTokens: 100 })
  })

  it('newest first, in batches of 20, up to `limit`', async () => {
    // 25 rows, two a day, so dates tie and the id breaks it.
    const rows = Array.from({ length: 25 }, (_, i) =>
      txn(`t${String(i).padStart(2, '0')}`, { date: `2026-09-${String(1 + Math.floor(i / 2)).padStart(2, '0')}` })
    )
    seed(rows)
    const out = await suggestCategories(HH, { limit: 21 })
    const ids = (from: number, to: number) =>
      Array.from({ length: from - to + 1 }, (_, k) => `t${String(from - k).padStart(2, '0')}`)
    expect(asked()).toEqual([ids(24, 5), ['t04']])
    expect(out).toEqual({ status: 'done', asked: 21, written: 21, inputTokens: 200 })
  })

  it('defaults `limit` to 200', async () => {
    seed(Array.from({ length: 205 }, (_, i) => txn(`t${String(i).padStart(3, '0')}`)))
    const out = await suggestCategories(HH)
    expect(asked().map((q) => q.length)).toEqual([20, 20, 20, 20, 20, 20, 20, 20, 20, 20])
    expect(out).toMatchObject({ status: 'done', asked: 200 })
  })

  it('makes no call when nothing is due', async () => {
    seed([txn('current', { suggestion: sug(GROCERY.id, 0.95, FP) })])
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'done', asked: 0, written: 0, inputTokens: 0 })
    expect(askChoices).not.toHaveBeenCalled()
    expect(db.upserts).toEqual([])
  })

  it("sends the household's examples, built from its rules and the hand picks in the same read", async () => {
    const picked = txn('picked', { merchant_name: 'Giant', user_category: 'Grocery', date: '2026-09-20' })
    seed([picked, txn('plain')])
    await suggestCategories(HH)
    const req = askChoices.mock.calls[0][0] as Req
    expect(req.state.household_examples).toEqual(householdExamples(DATA, [picked]))
    expect(req.state.household_examples).toEqual([
      { merchant: 'Safeway', filed_as: 'Grocery' },
      { merchant: 'Giant', filed_as: 'Grocery' },
    ])
    expect(Object.keys(req.questions)).toEqual(['plain'])
    expect(req.questions.plain.criteria).toHaveProperty('none')
    expect(req.questions.plain.criteria).not.toHaveProperty('Transfer Out')
  })
})

describe('suggestCategories: writes', () => {
  it('upserts one row per answer, keyed on transaction_id, counted exactly; none stores no category', async () => {
    seed([txn('a', { date: '2026-10-02' }), txn('b')])
    answering({ b: 'none' }, 'Grocery')
    const out = await suggestCategories(HH)
    expect(db.upserts).toHaveLength(1)
    expect(db.upserts[0].options).toEqual({ onConflict: 'transaction_id', count: 'exact' })
    expect(db.upserts[0].payload).toEqual([
      { transaction_id: 'a', household_id: HH, category_id: GROCERY.id, confidence: 0.93, catalog_fingerprint: FP, model: 'jev-test', created_at: NOW },
      { transaction_id: 'b', household_id: HH, category_id: null, confidence: 0.93, catalog_fingerprint: FP, model: 'jev-test', created_at: NOW },
    ])
    expect(out).toEqual({ status: 'done', asked: 2, written: 2, inputTokens: 100 })
    expect(logSpy).toHaveBeenCalledWith('[suggest] done', { householdId: HH, asked: 2, written: 2, inputTokens: 100 })
    expectNoDetailsLogged()
  })

  it('skips a row whose answer names no category in the context, and writes the rest (Review Focus 3)', async () => {
    seed([txn('a', { date: '2026-10-02' }), txn('b')])
    answering({ a: 'Groceries (renamed)' })
    const out = await suggestCategories(HH)
    expect(db.upserts).toHaveLength(1)
    expect(db.upserts[0].payload.map((r) => r.transaction_id)).toEqual(['b'])
    expect(out).toEqual({ status: 'done', asked: 2, written: 1, inputTokens: 100 })
  })

  it('makes no write for a batch whose every answer is unknown, and carries on', async () => {
    seed([txn('a')])
    answering({}, 'Not A Category')
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'done', asked: 1, written: 0, inputTokens: 100 })
    expect(db.upserts).toEqual([])
  })
})

describe('suggestCategories: failures never throw', () => {
  it('a TypeSafe failure writes nothing for the batch and returns failed', async () => {
    seed([txn('a')])
    askChoices.mockRejectedValue(new TypeSafeError('TypeSafe request failed: 500', 500))
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'failed', asked: 0, written: 0 })
    expect(db.upserts).toEqual([])
    expect(errSpy).toHaveBeenCalledWith('[suggest] failed', HH, 'TypeSafe request failed: 500')
    expectNoDetailsLogged()
  })

  it('a failure in a later batch keeps the counts of the batches written before it', async () => {
    seed(Array.from({ length: 25 }, (_, i) => txn(`t${String(i).padStart(2, '0')}`)))
    answering()
    askChoices.mockImplementationOnce(askChoices.getMockImplementation()!).mockRejectedValueOnce(new TypeSafeError('x', 529))
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'failed', asked: 20, written: 20 })
    expect(db.upserts).toHaveLength(1)
  })

  it('an upsert error stops the run: failed, and no further TypeSafe call (Review Focus 4)', async () => {
    seed(Array.from({ length: 25 }, (_, i) => txn(`t${String(i).padStart(2, '0')}`)))
    db.upsertResults = [{ count: null, error: { code: '23503', message: 'violates foreign key constraint' } }]
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'failed', asked: 20, written: 0 })
    expect(askChoices).toHaveBeenCalledTimes(1)
    expect(logs(errSpy)).toContain('23503')
    expectNoDetailsLogged()
  })

  it('a short count stops the run the same way', async () => {
    seed(Array.from({ length: 25 }, (_, i) => txn(`t${String(i).padStart(2, '0')}`)))
    db.upsertResults = [{ count: 19, error: null }]
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'failed', asked: 20, written: 0 })
    expect(askChoices).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith('[suggest] failed', HH, 'wrote 19 of 20 suggestions')
  })

  it('a spending category named none fails the run before any call (Review Focus 2)', async () => {
    fetchCategoryDataForHousehold.mockResolvedValue(testData([...DEFAULTS, cat('None')]))
    seed([txn('a')])
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'failed', asked: 0, written: 0 })
    expect(askChoices).not.toHaveBeenCalled()
    expect(db.upserts).toEqual([])
  })

  it('an unreadable category read fails the run before any call', async () => {
    fetchCategoryDataForHousehold.mockRejectedValue(new Error('could not read categories: boom'))
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'failed', asked: 0, written: 0 })
    expect(askChoices).not.toHaveBeenCalled()
  })

  it('an unreadable transaction read fails the run: no call and no write', async () => {
    seed([txn('a')], { failOnRequest: 1, failCode: '57014' })
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'failed', asked: 0, written: 0 })
    expect(askChoices).not.toHaveBeenCalled()
    expect(db.upserts).toEqual([])
    expect(errSpy).toHaveBeenCalledWith('[suggest] failed', HH, 'could not read transactions: boom')
  })

  it('an empty body on the read is a failure too, not "nothing to suggest"', async () => {
    seed([txn('a')], { emptyBodyOnRequest: 1 })
    await expect(suggestCategories(HH)).resolves.toEqual({ status: 'failed', asked: 0, written: 0 })
    expect(askChoices).not.toHaveBeenCalled()
  })
})
