import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// #28 spec §7.1: the one server read of categories and rules. A failed rules read must never
// render as "no rules": that would silently revert every learned label (#46).
const { tables, adminTables, fromCalls } = vi.hoisted(() => ({
  tables: {} as Record<string, () => Record<string, unknown>>,
  // The service-role client, for the background job's read (fetchCategoryDataForHousehold).
  adminTables: {} as Record<string, () => Record<string, unknown>>,
  // Which client each `.from()` went through, so a test can tell the two reads apart.
  fromCalls: [] as string[],
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      fromCalls.push(`server:${table}`)
      return tables[table]()
    },
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      fromCalls.push(`admin:${table}`)
      return adminTables[table]()
    },
  },
}))

import {
  fetchCategoryContext,
  fetchCategoryDataForHousehold,
  readTransactionsForCounts,
  suggestionsEnabled,
  SUGGESTION_EMBED,
  withSuggestion,
} from '@/lib/category-context'
import { readAllRows } from '@/lib/read-all'
import { idPagedTable, pagedTable, ruleRows, txnRows } from '../stubs/postgrest-pages'
import type { CategorizableTxn } from '@/lib/category-rules'

// Wraps a stub query so every `.select()` and `.eq()` it receives is recorded, then passed on.
function recording(
  query: () => Record<string, unknown>,
  log: { selects: string[]; eqs: [string, unknown][] }
) {
  return () => {
    const chain = query()
    const select = chain.select as (cols: string) => unknown
    const eq = chain.eq as (col: string, v: unknown) => unknown
    chain.select = (cols: string) => {
      log.selects.push(cols)
      return select(cols)
    }
    chain.eq = (col: string, v: unknown) => {
      log.eqs.push([col, v])
      return eq(col, v)
    }
    return chain
  }
}

// Records what each categories read asked for, so a test can pin the columns and the order.
const catReads: { select: string | null; order: string | null }[] = []
const categoriesRead =
  (result: { data: unknown; error: { message: string; code?: string } | null }) => () => {
  const read: { select: string | null; order: string | null } = { select: null, order: null }
  catReads.push(read)
  const chain: Record<string, unknown> = {}
  chain.select = (cols: string) => {
    read.select = cols
    return chain
  }
  chain.eq = () => chain
  chain.order = (col: string) => {
    read.order = col
    return chain
  }
  chain.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}
const CATS = [{ id: 'c1', name: 'Grocery', pfc_primary: null, sort_order: 0 }]

beforeEach(() => {
  catReads.length = 0
  fromCalls.length = 0
  vi.unstubAllEnvs()
  tables.categories = categoriesRead({ data: CATS, error: null })
  tables.category_rules = idPagedTable([]).query
  tables.transactions = pagedTable([]).query
  adminTables.categories = categoriesRead({ data: CATS, error: null })
  adminTables.category_rules = idPagedTable([]).query
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// Spec §14.7: "on" switches suggestions on; anything else, or unset, is off and is the rollback.
describe('suggestionsEnabled', () => {
  it('is true for exactly "on"', () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
    expect(suggestionsEnabled()).toBe(true)
  })

  it.each(['ON', '1', ''])('is false for %j', (value) => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', value)
    expect(suggestionsEnabled()).toBe(false)
  })

  it('is false when unset', () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
    expect(suggestionsEnabled()).toBe(false)
  })
})

describe('fetchCategoryContext', () => {
  it('returns the categories in order and every rule', async () => {
    const rules = idPagedTable(ruleRows(1001))
    tables.category_rules = rules.query
    const data = await fetchCategoryContext()
    expect(data.categories).toEqual(CATS)
    expect(data.rules).toHaveLength(1001)
    expect(rules.requests.map((r) => r.after)).toEqual([null, 'r00999', 'r01000'])
  })

  it('throws when the categories read fails', async () => {
    tables.categories = categoriesRead({ data: null, error: { message: 'permission denied' } })
    await expect(fetchCategoryContext()).rejects.toThrow(/^could not read categories: permission denied$/)
  })

  it('names the error code when the categories read fails with one', async () => {
    tables.categories = categoriesRead({ data: null, error: { message: 'permission denied', code: '42501' } })
    await expect(fetchCategoryContext()).rejects.toThrow(/^could not read categories: 42501 permission denied$/)
  })

  // A response with neither data nor error (an empty body) is not "no categories": that would drop
  // every name, show every row as Uncategorized and count income as spending.
  it('throws when the categories read returns neither data nor error', async () => {
    tables.categories = categoriesRead({ data: null, error: null })
    await expect(fetchCategoryContext()).rejects.toThrow(
      /^could not read categories: read returned no data and no error$/
    )
  })

  // The casts in fetchCategoryContext mean a dropped column passes tsc; this pins the lists.
  it('reads exactly the columns the resolver and Settings need, categories in sort order', async () => {
    const rules = idPagedTable(ruleRows(3))
    tables.category_rules = rules.query
    await fetchCategoryContext()
    expect(catReads).toEqual([{ select: 'id, name, pfc_primary, sort_order', order: 'sort_order' }])
    // Every page asks for the same columns.
    expect([...new Set(rules.selects)]).toEqual(['id, household_id, merchant_key, merchant_label, category_id, origin'])
  })

  it('throws, naming the migration, when the rules read fails on any page', async () => {
    tables.category_rules = idPagedTable(ruleRows(1500), { failOnRequest: 2 }).query
    await expect(fetchCategoryContext()).rejects.toThrow(
      'could not read category rules: XX000 boom (has db/migrations/021, including its grants, been applied?)'
    )
  })

  // The result is built with a cast, so tsc would not notice a dropped suggestionsOn; these do.
  it('carries suggestionsOn: true when CATEGORY_SUGGESTIONS is on', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
    expect((await fetchCategoryContext()).suggestionsOn).toBe(true)
  })

  it('carries suggestionsOn: false when CATEGORY_SUGGESTIONS is unset', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
    expect((await fetchCategoryContext()).suggestionsOn).toBe(false)
  })
})

// The background job's read (spec §14.5): no session, so the service-role client, scoped by hand.
describe('fetchCategoryDataForHousehold', () => {
  it('reads both tables through the admin client, filtered to the household', async () => {
    const catLog = { selects: [] as string[], eqs: [] as [string, unknown][] }
    const ruleLog = { selects: [] as string[], eqs: [] as [string, unknown][] }
    adminTables.categories = recording(categoriesRead({ data: CATS, error: null }), catLog)
    const rules = idPagedTable(ruleRows(1001))
    adminTables.category_rules = recording(rules.query, ruleLog)
    const data = await fetchCategoryDataForHousehold('hh-1')
    expect(data.categories).toEqual(CATS)
    expect(data.rules).toHaveLength(1001)
    expect(fromCalls.every((c) => c.startsWith('admin:'))).toBe(true)
    expect(catLog.eqs).toEqual([['household_id', 'hh-1']])
    expect(catLog.selects).toEqual(['id, name, pfc_primary, sort_order'])
    expect(catReads.map((r) => r.order)).toEqual(['sort_order'])
    // Every page of the rules read is scoped, not just the first.
    expect(ruleLog.eqs).toEqual([
      ['household_id', 'hh-1'],
      ['household_id', 'hh-1'],
      ['household_id', 'hh-1'],
    ])
    expect([...new Set(ruleLog.selects)]).toEqual(['id, household_id, merchant_key, merchant_label, category_id, origin'])
  })

  it('throws when the categories read fails', async () => {
    adminTables.categories = categoriesRead({ data: null, error: { message: 'permission denied', code: '42501' } })
    await expect(fetchCategoryDataForHousehold('hh-1')).rejects.toThrow(
      /^could not read categories: 42501 permission denied$/
    )
  })

  it('throws when the categories read returns neither data nor error', async () => {
    adminTables.categories = categoriesRead({ data: null, error: null })
    await expect(fetchCategoryDataForHousehold('hh-1')).rejects.toThrow(
      /^could not read categories: read returned no data and no error$/
    )
  })

  it('throws, naming the migration, when the rules read fails', async () => {
    adminTables.category_rules = idPagedTable(ruleRows(1500), { failOnRequest: 2 }).query
    await expect(fetchCategoryDataForHousehold('hh-1')).rejects.toThrow(
      'could not read category rules: XX000 boom (has db/migrations/021, including its grants, been applied?)'
    )
  })

  it('carries suggestionsOn: true when CATEGORY_SUGGESTIONS is on', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', 'on')
    expect((await fetchCategoryDataForHousehold('hh-1')).suggestionsOn).toBe(true)
  })

  it('carries suggestionsOn: false when CATEGORY_SUGGESTIONS is unset', async () => {
    vi.stubEnv('CATEGORY_SUGGESTIONS', undefined)
    expect((await fetchCategoryDataForHousehold('hh-1')).suggestionsOn).toBe(false)
  })
})

describe('SUGGESTION_EMBED', () => {
  it('embeds the row\'s suggestion as `suggestion`, with the three columns resolveCategory reads', () => {
    expect(SUGGESTION_EMBED).toBe('suggestion:category_suggestions(category_id, confidence, catalog_fingerprint)')
  })
})

// The type says object or null; a PostgREST that ever returned the embed as an array would make the
// job treat every row as due and re-ask it on every sync, so the rows are normalised, not just retyped.
describe('withSuggestion', () => {
  const S = { category_id: 'c1', confidence: 0.9, catalog_fingerprint: 'fp' }

  it('turns a one-element array into its element', () => {
    expect(withSuggestion([{ id: 'a', suggestion: [S] }])).toEqual([{ id: 'a', suggestion: S }])
  })

  it('turns an empty array into null', () => {
    expect(withSuggestion([{ id: 'a', suggestion: [] }])).toEqual([{ id: 'a', suggestion: null }])
  })

  it('passes an object or null through, and keeps every other column', () => {
    expect(
      withSuggestion([
        { id: 'a', merchant_name: 'M', suggestion: S },
        { id: 'b', merchant_name: null, suggestion: null },
      ])
    ).toEqual([
      { id: 'a', merchant_name: 'M', suggestion: S },
      { id: 'b', merchant_name: null, suggestion: null },
    ])
  })
})

describe('readTransactionsForCounts', () => {
  // Settings' counts resolve every row, so each must carry its suggestion (spec §14.3).
  it('selects each row\'s suggestion', async () => {
    const log = { selects: [] as string[], eqs: [] as [string, unknown][] }
    tables.transactions = recording(pagedTable(txnRows(3)).query, log)
    await readTransactionsForCounts()
    expect(log.selects.length).toBeGreaterThan(0)
    for (const s of log.selects) expect(s).toContain(SUGGESTION_EMBED)
  })

  it('reads 1,238 rows in pages of 1,000 and 238, then an empty page', async () => {
    const t = pagedTable(txnRows(1238, '2025-10-01', { merchant_name: null, user_category: null, pfc_primary: null, pfc_detailed: null }))
    tables.transactions = t.query
    expect(await readTransactionsForCounts()).toHaveLength(1238)
    expect(t.requests).toHaveLength(3)
  })

  it('returns every row when the server caps pages at 500', async () => {
    tables.transactions = pagedTable(txnRows(1238), { serverCap: 500 }).query
    expect(await readTransactionsForCounts()).toHaveLength(1238)
  })

  it('throws when the second page fails', async () => {
    tables.transactions = pagedTable(txnRows(1238), { failOnRequest: 2 }).query
    await expect(readTransactionsForCounts()).rejects.toThrow(/^could not read transactions: boom$/)
  })

  it('names the error code when the read fails with one', async () => {
    tables.transactions = pagedTable(txnRows(1238), { failOnRequest: 2, failCode: '57014' }).query
    await expect(readTransactionsForCounts()).rejects.toThrow(/^could not read transactions: 57014 boom$/)
  })
})

// Spec §7.4 layer 2: a read that drops a column the resolver needs must fail tsc. This function is
// never called; `npx tsc --noEmit` is the test.
async function _missingMerchantName(): Promise<(CategorizableTxn & { id: string; date: string })[]> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  const { data } = await readAllRows(() =>
    supabase.from('transactions').select('id, date, user_category, pfc_primary, pfc_detailed').eq('removed', false)
  )
  // @ts-expect-error merchant_name is not selected
  return data ?? []
}
void _missingMerchantName
