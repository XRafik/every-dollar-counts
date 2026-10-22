// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { TAP_TARGETS_ALLOWED } from '../../scripts/check-invariants.mjs'

// The tripwire for #69, run against a scratch tree so each case is one file and nothing else.
// The script scans app/, lib/ and components/ under its working directory.
//
// Both paths are found from this file, not from the working directory: run from another checkout,
// a path resolved from the working directory runs that checkout's script, and its tests pass or
// fail on the wrong code (#201). Not `new URL(…, import.meta.url)`, which Vite rewrites in tests.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO, 'scripts', 'check-invariants.mjs')
let dir: string

// The scratch tree holds the page under test, and a copy of each file tripwire 5's allowlist names
// (#122): the script reads the whole tree, so an entry for a file not in it fails as stale.
function check(source: string, { allowlisted = true } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'invariants-'))
  for (const d of ['app/(app)/x', 'lib', 'components']) mkdirSync(join(dir, d), { recursive: true })
  if (allowlisted) {
    for (const { file } of TAP_TARGETS_ALLOWED) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      copyFileSync(join(REPO, file), join(dir, file))
    }
  }
  writeFileSync(join(dir, 'app/(app)/x/page.tsx'), source)
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' })
  return { ok: run.status === 0, out: run.stdout + run.stderr }
}

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const read = (chain: string) => `
export default async function Page() {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, amount, date')
${chain}
  if (error) throw error
}
`

describe('check-invariants: transaction reads (#69)', () => {
  it('fails an unbounded read', () => {
    const r = check(read(`    .eq('removed', false)`))
    expect(r.ok).toBe(false)
    expect(r.out).toContain('unbounded-txn-read')
  })

  // Ordering makes the truncated set stable; it is still truncated. This is the case the earlier
  // version of the check let through.
  it('fails a read that is ordered but not bounded', () => {
    const r = check(read(`    .order('date')`))
    expect(r.ok).toBe(false)
    expect(r.out).toContain('unbounded-txn-read')
  })

  it.each([
    [`    .limit(6)`],
    [`    .range(0, 199)`],
    [`    .eq('id', id)\n    .maybeSingle()`],
  ])('passes a bounded read: %s', (chain) => {
    expect(check(read(chain)).ok).toBe(true)
  })

  // The transactions page spreads its select list over several lines; the bound comes after it.
  it('reads through a multi-line argument to find the bound', () => {
    const r = check(`
let query = supabase
  .from('transactions')
  .select(
    'id, name, amount, date',
    { count: 'exact' }
  )
  .order('date')
  .range(from, from + 199)
`)
    expect(r.ok).toBe(true)
  })

  it('passes a count-only read', () => {
    const r = check(`
const { count, error } = await supabase
  .from('transactions')
  .select('id', { count: 'exact', head: true })
  .eq('removed', false)
`)
    expect(r.ok).toBe(true)
  })

  it('passes a read that goes through readAllRows', () => {
    const r = check(`
const { data, error } = await readAllRows(() =>
  supabase
    .from('transactions')
    .select('id, amount, date')
    .eq('removed', false)
)
`)
    expect(r.ok).toBe(true)
  })

  // The exemption is for a read INSIDE readAllRows, not one near it. Each of these was confirmed
  // to pass the line-based version of the check.
  describe('does not exempt an unbounded read that only sits near something bounded', () => {
    it.each([
      [
        'a readAllRows call on the line above',
        `const a = await readAllRows(() => supabase.from('accounts').select('id, date'))
const b = await supabase.from('transactions').select('id').eq('removed', false)`,
      ],
      [
        'a sibling in Promise.all',
        `const [a, b] = await Promise.all([
  readAllRows(() => supabase.from('accounts').select('id, date')),
  supabase.from('transactions').select('id').eq('removed', false),
])`,
      ],
      [
        'a comment mentioning readAllRows',
        `// readAllRows() is not needed here
const { data, error } = await supabase.from('transactions').select('id').eq('removed', false)`,
      ],
      [
        'a comment in the chain mentioning .limit()',
        `const { data, error } = await supabase
  .from('transactions')
  // deliberately no .limit() here
  .select('id')
  .eq('removed', false)`,
      ],
      [
        'a bounded read in the next statement',
        `await Promise.all([supabase.from('transactions').select('id').eq('removed', false),
  supabase.from('accounts').select('id').limit(5)])`,
      ],
      [
        'an unbalanced paren inside a string',
        `const { data, error } = await supabase.from('transactions').select('id').ilike('name', '%(%')
const x = await supabase.from('accounts').select('id').limit(5)`,
      ],
      [
        'head: true outside the select',
        `const { data, error } = await supabase
  .from('transactions')
  .select('id')
  .filter('meta', 'cs', JSON.stringify({ head: true }))`,
      ],
      [
        '.range( inside an argument',
        `const { data, error } = await supabase
  .from('transactions')
  .select('id')
  .in('id', ids.slice(0).range(0, 9))`,
      ],
    ])('%s', (_, source) => {
      const r = check(source)
      expect(r.ok, r.out).toBe(false)
      expect(r.out).toContain('unbounded-txn-read')
    })
  })

  // PostgREST caps the response whatever the request asked for, so a literal bound over 1,000 is
  // not a bound.
  it.each([[`    .limit(5000)`], [`    .range(0, 4999)`]])('fails a bound above the cap: %s', (chain) => {
    const r = check(read(chain))
    expect(r.ok).toBe(false)
    expect(r.out).toContain('unbounded-txn-read')
  })

  it('passes readAllRows however the call is laid out', () => {
    const r = check(`
const { data, error } = await readAllRows(
  () =>
    supabase
      .from('transactions')
      .select('id, date')
      .eq('removed', false)
)
`)
    expect(r.ok, r.out).toBe(true)
  })

  it('ignores writes', () => {
    expect(check(`await supabase.from('transactions').update({ x: 1 }).eq('id', id)`).ok).toBe(true)
  })
})

// Tripwire 5 (#122) is called directly in check-invariants.test.ts; this is the script running it.
describe('check-invariants: tap targets (#122)', () => {
  it('fails a page with a text link that has no 44px rule, and passes it with one', () => {
    const page = (classes: string) =>
      `export default function Page() {\n  return <p>Use <a href="/settings" className={${classes}}>Settings</a>.</p>\n}\n`
    const bare = check(page(`'text-emerald'`))
    expect(bare.ok).toBe(false)
    expect(bare.out).toContain('app/(app)/x/page.tsx:2')
    expect(bare.out).toContain('[tap-target]')
    rmSync(dir, { recursive: true, force: true })
    expect(check(page('`${tapTargetClass} text-emerald`')).ok).toBe(true)
  })

  // The script reads the whole tree, so an allowlist entry for a file that is not in it names a file
  // deleted or renamed since, and fails rather than outliving its control.
  it('fails when a file the allowlist names is not in the tree', () => {
    const r = check(`export const ok = true\n`, { allowlisted: false })
    expect(r.ok).toBe(false)
    for (const { file } of TAP_TARGETS_ALLOWED) expect(r.out).toContain(`${file}:1`)
    expect(r.out).toContain('no such file')
  })
})

// main() walks scripts/ only when it exists (these scratch trees have none). Any other failure to
// read it must stop the check, not pass it with scripts/ unscanned.
describe('check-invariants: the scripts/ walk', () => {
  it('fails, rather than passing unscanned, when scripts/ cannot be read', () => {
    dir = mkdtempSync(join(tmpdir(), 'invariants-'))
    for (const d of ['app', 'lib', 'components']) mkdirSync(join(dir, d), { recursive: true })
    // A file where the directory should be: readdirSync throws ENOTDIR.
    writeFileSync(join(dir, 'scripts'), '')
    const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(run.stdout).not.toContain('invariants ok')
    expect(run.stderr).toContain('ENOTDIR')
  })
})
