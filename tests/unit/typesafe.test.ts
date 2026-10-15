// @vitest-environment node
// lib/typesafe.ts is server-only; the node environment gives it the real fetch/Response/AbortSignal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askChoices, TypeSafeError } from '@/lib/typesafe'
import type { ChoiceQuestion } from '@/lib/category-suggest-request'

const criteria = { Grocery: null, 'Food & Drink': "Plaid's default for FOOD_AND_DRINK", none: 'None fits.' }
const q = (): ChoiceQuestion => ({ type: 'choice', instructions: 'Which?', criteria })
const req = { state: { transactions: [{ merchant: 'SECRET-MERCHANT' }] }, questions: { t1: q(), t2: q() } }

const answer = (choice = 'Grocery', confidence = 0.93) => ({
  type: 'choice',
  choice,
  probabilities: { Grocery: 0.95, 'Food & Drink': 0.04, none: 0.01 },
  confidence,
})
const okBody = (over: Record<string, unknown> = {}) => ({
  model: 'jev-1.13.0',
  answers: { t1: answer(), t2: answer('none', 0.5) },
  usage: { input_tokens: 1300, output_tokens: 40 },
  ...over,
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const text = (body: string, status: number) => new Response(body, { status })

const noSleep = () => vi.fn(async (ms: number) => void ms)

async function rejection(p: Promise<unknown>): Promise<TypeSafeError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(TypeSafeError)
    return e as TypeSafeError
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('askChoices: request', () => {
  it('POSTs state, jev-latest and the questions with the bearer key and a timeout signal', async () => {
    const fetch = vi.fn(async () => json(okBody()))
    const result = await askChoices(req, { fetch, sleep: noSleep() })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Authorization: 'Bearer k', 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ state: req.state, model: 'jev-latest', questions: req.questions })
    expect(init.signal).toBeInstanceOf(AbortSignal)

    expect(result).toEqual(okBody())
  })

  it('throws without calling fetch when TYPESAFE_API_KEY is not set', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '')
    const fetch = vi.fn(async () => json(okBody()))
    const e = await rejection(askChoices(req, { fetch, sleep: noSleep() }))
    expect(e.message).toBe('TYPESAFE_API_KEY is not set')
    expect(e.status).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('askChoices: retries', () => {
  it('retries 429 and 529 with increasing delays, then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(text('slow down', 429))
      .mockResolvedValueOnce(text('overloaded', 529))
      .mockResolvedValueOnce(text('slow down', 429))
      .mockResolvedValueOnce(json(okBody()))
    const sleep = noSleep()
    const result = await askChoices(req, { fetch, sleep })
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000, 2000])
    expect(result.model).toBe('jev-1.13.0')
  })

  it('gives up after four 429s: three retries, then a throw carrying the status', async () => {
    const fetch = vi.fn(async () => text('rate limited', 429))
    const sleep = noSleep()
    const e = await rejection(askChoices(req, { fetch, sleep }))
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledTimes(3)
    expect(e.status).toBe(429)
    expect(e.message).toContain('429')
  })

  it.each([400, 401, 422, 500])('throws %i at once, without retrying', async (status) => {
    const fetch = vi.fn(async () => text('x'.repeat(500), status))
    const sleep = noSleep()
    const e = await rejection(askChoices(req, { fetch, sleep }))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(e.status).toBe(status)
    expect(e.message).toBe(`TypeSafe request failed: ${status}`)
  })

  it("keeps TypeSafe's error body out of the message: a 422 can echo a merchant", async () => {
    const fetch = vi.fn(async () =>
      json({ error: 'invalid field state.transactions[0].merchant: SECRET-MERCHANT' }, 422)
    )
    const e = await rejection(askChoices(req, { fetch, sleep: noSleep() }))
    expect(e.status).toBe(422)
    expect(e.message).toBe('TypeSafe request failed: 422')
    expect(e.message).not.toContain('SECRET-MERCHANT')
  })

  it('wraps a network failure without retrying', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const e = await rejection(askChoices(req, { fetch, sleep: noSleep() }))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(e.status).toBeNull()
  })
})

describe('askChoices: validation', () => {
  const run = (body: unknown) => askChoices(req, { fetch: vi.fn(async () => json(body)), sleep: noSleep() })

  it('throws on an unreadable body', async () => {
    const e = await rejection(askChoices(req, { fetch: vi.fn(async () => text('<html>', 200)), sleep: noSleep() }))
    expect(e.message).toBe('unreadable response')
    expect(e.status).toBe(200)
  })
  it('throws when an answer is missing for a question', async () => {
    await rejection(run(okBody({ answers: { t1: answer() } })))
  })
  it('throws when a choice is not one of the criteria keys', async () => {
    await rejection(run(okBody({ answers: { t1: answer('Groceries'), t2: answer() } })))
    await rejection(run(okBody({ answers: { t1: answer('toString'), t2: answer() } })))
  })
  it.each([1.2, -0.1, Number.NaN, '0.9', null])('throws on confidence %s', async (confidence) => {
    await rejection(run(okBody({ answers: { t1: { ...answer(), confidence }, t2: answer() } })))
  })
  it('throws on a non-string model', async () => {
    await rejection(run(okBody({ model: 7 })))
  })
  it('throws on an answer of another type, or bad probabilities or usage', async () => {
    await rejection(run(okBody({ answers: { t1: { ...answer(), type: 'noul' }, t2: answer() } })))
    await rejection(run(okBody({ answers: { t1: { ...answer(), probabilities: null }, t2: answer() } })))
    await rejection(run(okBody({ usage: { input_tokens: '1' } })))
    await rejection(run([]))
  })
})

describe('askChoices: logging', () => {
  it('never logs, and never puts the request body in an error', async () => {
    const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')]
    for (const s of spies) s.mockImplementation(() => {})
    const failures = [
      vi.fn(async () => text('bad request', 400)),
      vi.fn(async () => text('rate limited', 429)),
      vi.fn(async () => json(okBody({ answers: {} }))),
      vi.fn(async () => {
        throw new Error('boom')
      }),
    ]
    for (const fetch of failures) {
      const e = await rejection(askChoices(req, { fetch, sleep: noSleep() }))
      expect(e.message).not.toContain('SECRET-MERCHANT')
    }
    for (const s of spies) {
      for (const call of s.mock.calls) {
        for (const arg of call) expect(JSON.stringify(arg) ?? '').not.toContain('SECRET-MERCHANT')
      }
    }
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true)
  })
})
