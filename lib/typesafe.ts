import 'server-only'

// A typed wrapper over TypeSafe's System One endpoint for Jev Choice questions (#28 spec §14.5).
// Plain fetch, no SDK. Retries 429 and 529 (and nothing else) up to three times with backoff.
//
// This module NEVER logs: callers log. The request body holds transaction details, so it must not
// reach a log line or an error message. Errors carry the status only, never TypeSafe's response
// body, which can echo request content (a 422 names the offending field).
import type { BatchRequest, ChoiceQuestion } from './category-suggest-request'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const MODEL = 'jev-latest'
const TIMEOUT_MS = 15_000
const RETRY_STATUSES = new Set([429, 529])
const RETRY_DELAYS_MS = [500, 1000, 2000] // so 4 attempts in all

export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export type ChoicesResult = {
  model: string
  answers: Record<string, ChoiceAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

// `status` is the HTTP status; 'invalid' when the response arrived but validate() rejected it; null
// when no response came (no key, network error, timeout). The job reads it to tell a failure that
// belongs to one batch (400, 422, 'invalid') from one that would hit every batch.
export class TypeSafeError extends Error {
  constructor(
    message: string,
    readonly status: number | 'invalid' | null
  ) {
    super(message)
    this.name = 'TypeSafeError'
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function askChoices(
  req: BatchRequest,
  deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}
): Promise<ChoicesResult> {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) throw new TypeSafeError('TYPESAFE_API_KEY is not set', null)
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const body = JSON.stringify({ state: req.state, model: MODEL, questions: req.questions })

  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      // Network error or timeout: not retried. Only the error's name (TypeError, TimeoutError) is
      // kept, so nothing a message or `cause` might echo can reach the caller's log.
      throw new TypeSafeError(`TypeSafe request failed (${e instanceof Error ? e.name : 'unknown'})`, null)
    }

    if (RETRY_STATUSES.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await res.body?.cancel().catch(() => {})
      await sleep(RETRY_DELAYS_MS[attempt])
      continue
    }
    if (!res.ok) {
      // Status only, never the body: a 422 details the offending field and can echo a merchant.
      await res.body?.cancel().catch(() => {})
      throw new TypeSafeError(`TypeSafe request failed: ${res.status}`, res.status)
    }

    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      throw new TypeSafeError('unreadable response', res.status)
    }
    return validate(parsed, req.questions)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

// Checks the response against the questions actually asked, and returns only their answers. A
// choice must be one of that question's own criteria keys, so nothing downstream can store a
// category the household was never offered.
function validate(body: unknown, questions: Record<string, ChoiceQuestion>): ChoicesResult {
  const bad = (what: string) => new TypeSafeError(`invalid response: ${what}`, 'invalid')
  if (!isRecord(body)) throw bad('not an object')
  if (typeof body.model !== 'string') throw bad('model is not a string')
  const usage = body.usage
  if (!isRecord(usage) || !isFiniteNumber(usage.input_tokens) || !isFiniteNumber(usage.output_tokens)) {
    throw bad('usage is malformed')
  }
  if (!isRecord(body.answers)) throw bad('answers is not an object')

  const answers: Record<string, ChoiceAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const a = Object.hasOwn(body.answers, id) ? body.answers[id] : undefined
    if (!isRecord(a)) throw bad(`no answer for question ${id}`)
    if (a.type !== 'choice') throw bad(`answer ${id} is not a choice`)
    if (typeof a.choice !== 'string' || !Object.hasOwn(question.criteria, a.choice)) {
      throw bad(`answer ${id} chose an option it was not offered`)
    }
    if (!isFiniteNumber(a.confidence) || a.confidence < 0 || a.confidence > 1) {
      throw bad(`answer ${id} has a confidence outside [0, 1]`)
    }
    const p = a.probabilities
    if (!isRecord(p) || !Object.values(p).every(isFiniteNumber)) throw bad(`answer ${id} has malformed probabilities`)
    answers[id] = {
      type: 'choice',
      choice: a.choice,
      probabilities: p as Record<string, number>,
      confidence: a.confidence,
    }
  }
  return {
    model: body.model,
    answers,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
  }
}
