import { describe, it, expect, vi, beforeEach } from 'vitest'

// #28 spec §14.5 "When it runs": the webhook's sync path asks Jev for suggestions through after(),
// as the Refresh route does. Nothing else in the webhook does.
//
// vi.hoisted for the same reason as tests/unit/remove-item-env.test.ts.
const { afterFns, suggestCategories, storeAccounts, syncAndStore, found } = vi.hoisted(() => ({
  afterFns: [] as (() => unknown)[],
  suggestCategories: vi.fn(),
  storeAccounts: vi.fn(),
  syncAndStore: vi.fn(),
  found: { item: null as Record<string, unknown> | null },
}))

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    afterFns.push(fn)
  },
}))
vi.mock('@/lib/category-suggest', () => ({ suggestCategories }))
vi.mock('@/lib/ingest', () => ({ storeAccounts, syncAndStore }))
vi.mock('@/lib/crypto', () => ({ decrypt: () => 'access-token' }))
vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox' }))
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: found.item }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}))

import { POST } from '@/app/api/plaid/webhook/route'

const ITEM = {
  id: 'item-1',
  household_id: 'hh-7',
  access_token_encrypted: 'cipher',
  cursor: null,
  products: ['transactions'],
  status: 'ok',
  plaid_env: 'sandbox',
}

function hook(body: Record<string, unknown>) {
  return new Request('http://localhost/api/plaid/webhook?key=s3cret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_id: 'plaid-item-1', ...body }),
  })
}

beforeEach(() => {
  vi.stubEnv('PLAID_WEBHOOK_SECRET', 's3cret')
  afterFns.length = 0
  suggestCategories.mockReset().mockResolvedValue({ suggested: 0 })
  storeAccounts.mockReset().mockResolvedValue(undefined)
  syncAndStore.mockReset().mockResolvedValue({ added: 1, modified: 0, removed: 0 })
  found.item = ITEM
})

describe('POST /api/plaid/webhook suggestions (#28 §14.5)', () => {
  it("schedules a suggestion run for the item's household when new transactions are ready", async () => {
    const res = await POST(hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }))
    expect(res.status).toBe(200)
    expect(afterFns).toHaveLength(1)
    await afterFns[0]()
    expect(suggestCategories).toHaveBeenCalledExactlyOnceWith('hh-7', { startedAt: expect.any(Number) })
  })

  // The job's deadline counts from the request, as after() shares the route's max duration.
  // The clock moves a minute between the response and after(), so a time read when after() runs fails.
  it('passes the time the request started as startedAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
      const requested = Date.now()
      await POST(hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }))
      vi.setSystemTime(requested + 60_000)
      await afterFns[0]()
      expect(suggestCategories).toHaveBeenCalledExactlyOnceWith('hh-7', { startedAt: requested })
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows a rejecting suggestion run', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    suggestCategories.mockRejectedValue(new Error('jev down'))
    await POST(hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }))
    await expect(Promise.resolve().then(afterFns[0])).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('[suggest] failed', 'hh-7', 'jev down')
    log.mockRestore()
  })

  it('schedules nothing for an ITEM error', async () => {
    await POST(hook({ webhook_type: 'ITEM', webhook_code: 'ERROR', error: { error_code: 'ITEM_LOGIN_REQUIRED' } }))
    expect(afterFns).toHaveLength(0)
  })

  it('schedules nothing for an unknown item', async () => {
    found.item = null
    await POST(hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }))
    expect(afterFns).toHaveLength(0)
  })
})
