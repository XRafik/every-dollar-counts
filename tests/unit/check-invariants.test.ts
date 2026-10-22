// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  checkUncheckedReads,
  checkCategoryReads,
  checkRulesReads,
  checkUserCategoryWrites,
  checkSuggestionWrites,
  checkBrandCasts,
  checkTapTargets,
  TAP_TARGETS_ALLOWED,
} from '../../scripts/check-invariants.mjs'

// Tripwires 1, 4 and 5, called directly. Fixtures are inline; none lives under app/, lib/ or
// components/.
const file = (path: string, text: string) => [{ path, text }]
const checks = (r: { check: string }[]) => r.map((f) => f.check)
const lines = (r: { line: number }[]) => r.map((f) => f.line)

// Tripwire 1 (#46, widened in #91): a destructured read that binds `data` or `count` and not
// `error`, so a failed read renders the same as no data. Most fixtures below are a shape the
// line-based version could not see, or one it must not fire on.
describe('unchecked-read', () => {
  const PAGE = 'app/(app)/x/page.tsx'

  it('fires on a page that destructures data without error', () => {
    expect(checks(checkUncheckedReads(file(PAGE, `const { data: goals } = await supabase.from('goals').select('id')`)))).toEqual(['unchecked-read'])
  })

  it('passes a page that binds error', () => {
    expect(checkUncheckedReads(file(PAGE, `const { data: goals, error } = await supabase.from('goals').select('id')`))).toEqual([])
  })

  // #91: lib/manual-assets.ts and lib/plaid-items.ts each swallowed their own read, and the pages
  // that called them could not tell the empty list from none.
  it('fires in lib/, on the line the destructure starts', () => {
    const src = `export async function listManualAssets(householdId) {
  const { data } = await supabaseAdmin
    .from('manual_assets')
    .select('id, name, value, updated_at')
    .eq('household_id', householdId)
  return data ?? []
}`
    const found = checkUncheckedReads(file('lib/manual-assets.ts', src))
    expect(found.map((f) => [f.check, f.file, f.line])).toEqual([['unchecked-read', 'lib/manual-assets.ts', 2]])
  })

  it('reads a destructure whole, however many lines it spans', () => {
    const unchecked = `const {
  data: goals,
} = await supabase.from('goals').select('id')`
    const checked = `const {
  data: goals,
  error: goalsError,
} = await supabase.from('goals').select('id')`
    expect(checks(checkUncheckedReads(file(PAGE, unchecked)))).toEqual(['unchecked-read'])
    expect(checkUncheckedReads(file(PAGE, checked))).toEqual([])
  })

  // #91: Settings read transactions and budgets as const [{ data: catTxns }, { data: budgetRows }].
  // Each read in the array is its own read: one that binds error does not cover its neighbour.
  it('fires on an array destructure for each read in it that binds data without error', () => {
    const src = `const [{ data: catTxns }, { data: budgetRows, error: budgetsError }, { data: goals }] = await Promise.all([
  supabase.from('transactions').select('id'),
  supabase.from('budgets').select('category'),
  supabase.from('goals').select('id'),
])`
    const found = checkUncheckedReads(file(PAGE, src))
    expect(checks(found)).toEqual(['unchecked-read', 'unchecked-read'])
    expect(found.map((f) => f.message)).toEqual([
      expect.stringContaining('destructures `data` without `error`'),
      expect.stringContaining('destructures `data` without `error`'),
    ])
  })

  it('passes an array destructure whose every read binds error', () => {
    const src = `const [{ data: a, error: aError }, { data: b, error: bError }] = await Promise.all([x, y])`
    expect(checkUncheckedReads(file(PAGE, src))).toEqual([])
  })

  it('does not take a bare name in an array pattern for a read', () => {
    expect(checkUncheckedReads(file('lib/crypto.ts', `const [iv, tag, data] = payload.split(':')`))).toEqual([])
  })

  // #91: Settings' const { count } printed "No banks connected yet." when the read failed.
  it.each([
    [`const { count } = await supabase.from('accounts').select('id', { count: 'exact', head: true })`],
    [`const { count: n } = await supabase.from('accounts').select('id', { count: 'exact', head: true })`],
  ])('fires on a count without error: %s', (src) => {
    const found = checkUncheckedReads(file(PAGE, src))
    expect(checks(found)).toEqual(['unchecked-read'])
    expect(found[0].message).toContain('destructures `count` without `error`')
  })

  it('passes a count that binds error', () => {
    const src = `const { count, error } = await supabase.from('accounts').select('id', { count: 'exact', head: true })`
    expect(checkUncheckedReads(file(PAGE, src))).toEqual([])
  })

  // A failed auth check reads as signed out, which is a different defect (#143), not a wrong number.
  it.each([
    ['on one line', 'const { data: { user } } = await supabase.auth.getUser()'],
    ['across lines', 'const {\n  data: { user },\n} = await supabase\n  .auth\n  .getUser()'],
  ])('leaves out an auth.getUser() destructure %s', (_name, src) => {
    expect(checkUncheckedReads(file(PAGE, src))).toEqual([])
  })

  it('still fires on a read right after an auth.getUser() destructure', () => {
    const src = `const { data: { user } } = await supabase.auth.getUser()
const { data: goals } = await supabase.from('goals').select('id')`
    expect(lines(checkUncheckedReads(file(PAGE, src)))).toEqual([2])
  })

  it('ignores a destructure in a comment or a string', () => {
    const src = `// const { data } = await supabase.from('goals').select('id')
const sql = 'const { data } = await supabase.from(goals)'`
    expect(checkUncheckedReads(file(PAGE, src))).toEqual([])
  })

  it("allows the layout's display-name read, and lib/sync.ts's Plaid response", () => {
    expect(checkUncheckedReads(file('app/(app)/layout.tsx', `const { data: households } = await supabase.from('households').select('id, name').limit(1)`))).toEqual([])
    expect(checkUncheckedReads(file('lib/sync.ts', `const { data } = await plaidClient.transactionsSync({ access_token, cursor: next })`))).toEqual([])
  })
})

// Tripwire 4 (#28 spec §7.4): a page that reads categories or rules on its own, a write of
// user_category outside the two routes allowed it, or a cast that fakes a branded context.
describe('category-read', () => {
  it('fires on a page reading categories itself', () => {
    expect(checks(checkCategoryReads(file('app/(app)/x/page.tsx', `supabase.from('categories').select('id')`)))).toEqual(['category-read'])
  })
  it('fires on pfcToName outside lib/categories.ts and lib/category-rules.ts', () => {
    expect(checks(checkCategoryReads(file('lib/x.ts', 'const m = pfcToName(cats)')))).toEqual(['category-read'])
  })
  it('allows the helper and the three routes', () => {
    for (const p of ['lib/category-context.ts', 'app/api/categories/route.ts', 'app/api/transactions/categorize/route.ts', 'app/api/category-rules/route.ts']) {
      expect(checkCategoryReads(file(p, `supabase.from('categories').select('id')`))).toEqual([])
    }
    expect(checkCategoryReads(file('lib/category-rules.ts', 'pfcToName(categories)'))).toEqual([])
  })
  it('ignores a mention in a comment', () => {
    expect(checkCategoryReads(file('lib/x.ts', `// never call .from('categories') here`))).toEqual([])
  })
})

describe('rules-read', () => {
  it('fires outside the helper and the two routes', () => {
    expect(checks(checkRulesReads(file('app/(app)/x/page.tsx', `supabase.from('category_rules').select('id')`)))).toEqual(['rules-read'])
  })
  it('allows the helper and the two routes', () => {
    for (const p of ['lib/category-context.ts', 'app/api/transactions/categorize/route.ts', 'app/api/category-rules/route.ts']) {
      expect(checkRulesReads(file(p, `supabase.from('category_rules').select('id')`))).toEqual([])
    }
  })
})

describe('user-category-write', () => {
  it('fires on clearing picks outside the allowed routes', () => {
    expect(checks(checkUserCategoryWrites(file('lib/x.ts', `await supabase.from('transactions').update({ user_category: null }).eq('id', id)`)))).toEqual(['user-category-write'])
  })
  it('fires on a multi-line update whose third key is user_category', () => {
    const src = `await supabase
      .from('transactions')
      .update({
        removed: false,
        reimbursable_note: null,
        user_category: 'Grocery',
      })
      .eq('id', id)`
    expect(checks(checkUserCategoryWrites(file('app/api/x/route.ts', src)))).toEqual(['user-category-write'])
  })
  it('fires on a payload held in a variable, and on a spread', () => {
    expect(checks(checkUserCategoryWrites(file('lib/x.ts', `await supabase.from('transactions').update(patch).eq('id', id)`)))).toEqual(['user-category-write'])
    expect(checks(checkUserCategoryWrites(file('lib/x.ts', `await supabase.from('transactions').update({ ...patch }).eq('id', id)`)))).toEqual(['user-category-write'])
  })
  it('fires in a scripts/ .mjs file', () => {
    expect(checks(checkUserCategoryWrites(file('scripts/fix.mjs', `await db.from('transactions').update({ user_category: 'x' })`)))).toEqual(['user-category-write'])
  })
  it('does not fire on the isCreditCardPayment argument shape, or a select naming the column', () => {
    expect(checkUserCategoryWrites(file('components/X.tsx', `isCreditCardPayment({ pfc_detailed: p, user_category: c })`))).toEqual([])
    expect(checkUserCategoryWrites(file('lib/x.ts', `supabase.from('transactions').select('id, user_category').eq('removed', false)`))).toEqual([])
  })
  it('allows the categorize and categories routes, and variable payloads in ingest and the sandbox seed', () => {
    expect(checkUserCategoryWrites(file('app/api/transactions/categorize/route.ts', `supabase.from('transactions').update({ user_category: picked.name }, { count: 'exact' })`))).toEqual([])
    expect(checkUserCategoryWrites(file('app/api/categories/route.ts', `supabase.from('transactions').update({ user_category: null }).eq('user_category', name)`))).toEqual([])
    expect(checkUserCategoryWrites(file('lib/ingest.ts', `supabase.from('transactions').upsert(upserts, { onConflict: 'plaid_transaction_id' })`))).toEqual([])
    expect(checkUserCategoryWrites(file('scripts/seed-sandbox-bank.mjs', `db.from('transactions').insert(rows)`))).toEqual([])
  })
  it('passes an inline write that does not touch user_category', () => {
    expect(checkUserCategoryWrites(file('app/api/reimbursable/route.ts', `supabase.from('transactions').update({ reimbursable_amount: 5 }, { count: 'exact' })`))).toEqual([])
  })
  it('covers the suggestion job too (#28 spec §14.9)', () => {
    expect(checks(checkUserCategoryWrites(file('lib/category-suggest.ts', `await supabaseAdmin.from('transactions').update({ user_category: 'x' })`)))).toEqual(['user-category-write'])
  })
})

describe('suggestion-write', () => {
  it.each(['insert', 'upsert', 'update', 'delete'])('fires on .%s() outside lib/category-suggest.ts', (method) => {
    const src = `await supabaseAdmin.from('category_suggestions').${method}(rows, { count: 'exact' })`
    const found = checkSuggestionWrites(file('app/api/x/route.ts', src))
    expect(checks(found)).toEqual(['suggestion-write'])
    expect(found[0].message).toBe('writes category_suggestions outside lib/category-suggest.ts, the one writer (#28 spec §14.9).')
  })
  it('fires on a multi-line chain with a filter before the write', () => {
    const src = `await supabase
      .from("category_suggestions")
      .delete()
      .eq('household_id', id)`
    expect(checks(checkSuggestionWrites(file('lib/x.ts', src)))).toEqual(['suggestion-write'])
  })
  it('allows the job itself', () => {
    expect(checkSuggestionWrites(file('lib/category-suggest.ts', `await supabaseAdmin.from('category_suggestions').upsert(rows, { onConflict: 'transaction_id', count: 'exact' })`))).toEqual([])
  })
  it('does not fire on a read, anywhere', () => {
    expect(checkSuggestionWrites(file('app/(app)/x/page.tsx', `supabase.from('category_suggestions').select('transaction_id', { count: 'exact', head: true })`))).toEqual([])
  })
  it('ignores a mention in a comment', () => {
    expect(checkSuggestionWrites(file('lib/x.ts', `// never .from('category_suggestions').delete() here`))).toEqual([])
  })
})

describe('brand-cast', () => {
  it.each(['as CategoryData', 'as unknown as CategoryContext', 'as KindContext', 'as SpendContext'])('fires on `%s` outside the producers', (cast) => {
    expect(checks(checkBrandCasts(file('app/(app)/x/page.tsx', `const c = x ${cast}`)))).toEqual(['brand-cast'])
  })
  it('allows the three producers', () => {
    for (const p of ['lib/category-rules.ts', 'lib/category-context.ts', 'lib/spend-context.ts']) {
      expect(checkBrandCasts(file(p, 'return x as CategoryData'))).toEqual([])
    }
  })
})

// Tripwire 5 (#122): a raw <a>, <Link> or <button> whose classes carry no 44px rule. Stage 5 of the
// phone pass raised the shared control classes, and eight controls with classes of their own stayed
// 16-20px tall on a phone. Each fixture passes its own allowlist, empty unless the test is about one.
describe('tap-target', () => {
  const C = 'components/X.tsx'
  const LINK = `import Link from 'next/link'\n`
  type Entry = { file: string; classes: string; reason: string }
  const tap = (src: string, allowed: Entry[] = []) => checkTapTargets(file(C, src), allowed)

  it('fires on a text link with classes of its own, on the line its tag opens', () => {
    const src = `export function X() {
  return (
    <p className="text-sm">
      To rename one, use <a href="/settings" className="text-emerald">Settings</a>.
    </p>
  )
}`
    expect(tap(src).map((f) => [f.check, f.file, f.line])).toEqual([['tap-target', C, 4]])
  })

  // Why it parses rather than matches: an attribute can hold `=>`, and a pattern that reads a tag to
  // its first `>` stops inside the onClick, before the classes.
  it('reads past a `=>` in an attribute to the classes after it', () => {
    expect(checks(tap('<button type="button" onClick={() => setOpen((v) => !v)} className="text-sm text-emerald">Show all</button>'))).toEqual(['tap-target'])
    expect(tap('<button type="button" onClick={() => setOpen((v) => !v)} className={`${tapTargetClass} text-sm text-emerald`}>Show all</button>')).toEqual([])
  })

  it("fires on next/link's Link, under whatever name it is imported as", () => {
    expect(checks(tap(`${LINK}const v = <Link href="/transactions" className="text-xs">View all</Link>`))).toEqual(['tap-target'])
    expect(checks(tap(`import NextLink from 'next/link'\nconst v = <NextLink href="/transactions">View all</NextLink>`))).toEqual(['tap-target'])
  })

  it('leaves alone a component that is not a control', () => {
    expect(tap('<Card className="p-5"><span className="text-xs">Learned</span></Card>')).toEqual([])
  })

  it.each([
    ['tapTargetClass, in a template', '<a href="/x" className={`${tapTargetClass} text-sm`}>x</a>'],
    ['tapTargetClass, alone', '<a href="/x" className={tapTargetClass}>x</a>'],
    ['buttonClass', `<a href="/x" className={buttonClass('secondary', 'md')}>x</a>`],
    ['buttonClass, in a template', '<button className={`${buttonClass("ghost", "sm")} w-full`}>x</button>'],
    ['min-h-[44px] of its own', '<button className="inline-flex min-h-[44px] min-w-[44px] md:min-h-0 md:h-6">⋮</button>'],
    ['min-h-[44px] in the text of a template', "<a href=\"/x\" className={`${active ? 'text-emerald' : 'text-faint'} inline-flex min-h-[44px] md:min-h-0`}>x</a>"],
  ])('passes a control with %s', (_name, src) => {
    expect(tap(src)).toEqual([])
  })

  it.each([
    ['no classes at all', '<a href="/x">x</a>'],
    ['44px only under a condition', `<a href="/x" className={open ? 'min-h-[44px]' : ''}>x</a>`],
    ['44px only from md', '<a href="/x" className="md:min-h-[44px]">x</a>'],
    ['classes from a prop', '<button className={className}>x</button>'],
  ])('fires on a control with %s', (_name, src) => {
    expect(checks(tap(src))).toEqual(['tap-target'])
  })

  // Controls shown only from md up are not a phone's, and §7's 44px is a phone rule.
  it('passes a control under an element hidden below md', () => {
    const sidebar = `${LINK}<aside className="fixed inset-y-0 hidden w-64 md:flex">
  <nav>{NAV.map((n) => <Link key={n} href={n} className="px-3 py-2 text-sm">{n}</Link>)}</nav>
</aside>`
    expect(tap(sidebar)).toEqual([])
    expect(tap('<td className="hidden md:table-cell"><button className="text-xs">x</button></td>')).toEqual([])
    expect(tap('<a href="/x" className="hidden text-xs md:inline">x</a>')).toEqual([])
  })

  it('still fires under an element hidden from md up, shown from sm, or hidden only under a condition', () => {
    expect(checks(tap('<div className="md:hidden"><button className="text-sm">Show all</button></div>'))).toEqual(['tap-target'])
    expect(checks(tap('<div className="hidden sm:block"><button className="text-sm">x</button></div>'))).toEqual(['tap-target'])
    expect(checks(tap(`<div className={open ? 'contents' : 'hidden md:contents'}><button className="text-sm">x</button></div>`))).toEqual(['tap-target'])
  })

  it('passes a control the allowlist names by its file and classes, and no other', () => {
    const allowed = [{ file: C, classes: 'block px-4 py-3 text-sm', reason: '46px tall' }]
    expect(tap('<a href="/x" className="block px-4 py-3 text-sm">x</a>', allowed)).toEqual([])
    // However the class string is spaced or broken over lines.
    expect(tap('<a href="/x" className={`block px-4\n      py-3  text-sm`}>x</a>', allowed)).toEqual([])
    expect(checks(checkTapTargets(file('components/Y.tsx', '<a href="/x" className="block px-4 py-3 text-sm">x</a>'), allowed))).toEqual(['tap-target'])
  })

  // The allowlist names a template's expressions `${…}`, and a class from a prop by its expression.
  it('names a control whose classes are not one string', () => {
    const allowed = [
      { file: C, classes: 'flex flex-col py-2 ${…}', reason: '53px tall' },
      { file: C, classes: '{className}', reason: "the caller's" },
    ]
    const src = `<nav>
  <a href="/x" className={\`flex flex-col py-2 \${active ? 'text-emerald' : 'text-faint'}\`}>x</a>
  <button className={className}>y</button>
</nav>`
    expect(tap(src, allowed)).toEqual([])
  })

  // Changing an allowlisted control's classes asks the question again, and the entry for the old
  // classes fails too, so the list cannot go on naming a control that is gone.
  it('fires on a changed control, and on the entry that named it before', () => {
    const allowed = [{ file: C, classes: 'block px-4 py-3 text-sm', reason: '46px tall' }]
    const found = tap('<a href="/x" className="block px-4 py-2 text-sm">x</a>', allowed)
    expect(checks(found)).toEqual(['tap-target', 'tap-target'])
    expect(found[1].message).toContain('"block px-4 py-3 text-sm"')
  })

  it('does not call an entry stale when its file was not read', () => {
    const allowed = [{ file: 'components/Other.tsx', classes: 'block', reason: 'tall' }]
    expect(tap('<a href="/x" className={tapTargetClass}>x</a>', allowed)).toEqual([])
  })

  it('reads .tsx files in app/ and components/ only', () => {
    expect(checkTapTargets(file('lib/x.tsx', '<a href="/x">x</a>'), [])).toEqual([])
    expect(checkTapTargets(file('components/x.ts', 'export const a = 1'), [])).toEqual([])
    expect(checks(checkTapTargets(file('app/(app)/x/page.tsx', '<a href="/x">x</a>'), []))).toEqual(['tap-target'])
  })

  it('gives every entry on the real allowlist a reason', () => {
    expect(TAP_TARGETS_ALLOWED.length).toBeGreaterThan(0)
    for (const e of TAP_TARGETS_ALLOWED) {
      expect(e.file).toMatch(/^(app|components)\/.+\.tsx$/)
      expect(e.reason.length).toBeGreaterThan(20)
    }
  })
})
