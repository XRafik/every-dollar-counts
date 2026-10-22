#!/usr/bin/env node
// Tripwires for the defect classes this repo has shipped, and one (4) it measured before it could.
//
// These are greps, not proofs. They cannot understand the code — they can only notice a shape that
// has been wrong before. That is deliberate: each one exists because a real bug reached production
// and a person had to find it by reading. A tripwire that catches the next instance of a defect we
// have already paid for is worth more than a clever analysis of one we have not.
//
// Every known violation is ALLOWED BY NAME below, with a reason and an issue number. The allowlist
// is the outstanding debt, written down. Adding to it should feel like a decision; removing from it
// is how the debt gets paid.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

// ---------------------------------------------------------------------------
// 1. Every read on a page, and in the lib/ helpers pages call, checks `error`.
//
// #46, and again in #68, and again in #77. A Supabase read that fails sets `data` to null, and
// `?? []` turns that into an empty array — so "the query failed" and "you have no data" render
// identically. On the dashboard that was not even an empty state: with the categories read failing,
// income stopped being excluded from spending and the tiles read -$1,796.70 and +$1,796.70 against
// a truth of $3,929.35 and $1,796.70. A number the reader would act on.
//
// #91 found six unchecked reads this check could not see while it matched `const { data` one line at
// a time in app/(app)/ only: two lib/ helpers whose empty lists dropped the house from net worth and
// hid the "isn't syncing" banner, an array destructure of two reads in a Promise.all, and a
// `const { count }`. A destructure split across lines was invisible to it too. So it reads code, not
// lines. Comments and strings are blanked first (views(), under check 3), and each destructure is
// read whole, however many lines it spans. It fires when an object pattern binds `data` or `count`
// and not `error`: `const { data } = …`, or each object of an array pattern on its own, as in
// `const [{ data: a }, { data: b }] = await Promise.all(…)`.
//
// Scanned: app/(app)/ and lib/. Not app/api/: its unchecked lookups mostly degrade into a 403 or 404
// rather than a wrong number (0cfdef1), and have not been audited one by one (#91). Not counted: a
// destructure of `auth.getUser()`. A failed auth check reads as signed out, a different defect (#143).
// ---------------------------------------------------------------------------
const READS_ALLOWED = new Map([
  [
    'app/(app)/layout.tsx',
    'Sits ABOVE app/(app)/error.tsx, so throwing takes down the whole shell rather than one ' +
      'section. Needs only a display name, and has a fallback for it.',
  ],
  [
    'lib/sync.ts',
    "Destructures Plaid's transactions/sync response, not a Supabase read. Plaid's client rejects a " +
      'failed call, so there is no `error` to check: the failure reaches the caller as a throw (#91).',
  ],
])
const READ_SCOPES = ['app/(app)/', 'lib/']

// Index of the bracket that closes the one opening at `open`, in blanked source.
function closeBracket(code, open) {
  let depth = 0
  for (let k = open; k < code.length; k++) {
    if ('{[('.includes(code[k])) depth++
    else if ('}])'.includes(code[k]) && --depth === 0) return k
  }
  return code.length
}

// The top-level, comma-separated parts of a pattern's inside, e.g. `data: a, error` -> two parts.
function parts(inside) {
  const out = []
  let depth = 0
  let from = 0
  for (let k = 0; k < inside.length; k++) {
    if ('{[('.includes(inside[k])) depth++
    else if ('}])'.includes(inside[k])) depth--
    else if (inside[k] === ',' && depth === 0) {
      out.push(inside.slice(from, k))
      from = k + 1
    }
  }
  out.push(inside.slice(from))
  return out.map((p) => p.trim()).filter(Boolean)
}

// What an object pattern leaves unchecked: `data` or `count` bound without `error`, else null.
function uncheckedIn(pattern) {
  const keys = new Set(parts(pattern.slice(1, -1)).map((p) => /^[A-Za-z_$][\w$]*/.exec(p)?.[0]))
  if (keys.has('error')) return null
  return ['data', 'count'].find((k) => keys.has(k)) ?? null
}

export function checkUncheckedReads(files) {
  const out = []
  for (const { path, text } of files) {
    if (!READ_SCOPES.some((scope) => path.startsWith(scope))) continue
    if (READS_ALLOWED.has(path)) continue
    const { code } = views(text)
    for (const at of findAll(/\bconst\s*[{[]/g, code)) {
      const open = at + code.slice(at).search(/[{[]/)
      const close = closeBracket(code, open)
      // `= await supabase.auth.getUser()`, the awaited call named up to its first parenthesis.
      const callee = /^\s*=\s*await\s+([^(;]*)\(/.exec(code.slice(close + 1))?.[1] ?? ''
      if (/\bauth\s*\.\s*getUser\s*$/.test(callee)) continue
      const pattern = code.slice(open, close + 1)
      const objects = pattern[0] === '{' ? [pattern] : parts(pattern.slice(1, -1)).filter((p) => p[0] === '{')
      for (const object of objects) {
        const name = uncheckedIn(object)
        if (!name) continue
        out.push({
          check: 'unchecked-read',
          file: path,
          line: lineOf(text, at),
          message:
            `destructures \`${name}\` without \`error\`. A failed read must not render identically to no ` +
            'data (#46, #91) — check `error` and throw, so app/(app)/error.tsx can show a retryable message.',
        })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 2. No calendar value is read off the runtime clock.
//
// #73. `new Date()` on the server is UTC on Vercel while the household is in US Eastern, so for
// about 18% of the year the server's calendar day is not the household's — the app said "Good
// morning" at 8pm, and for four hours at every month end the money tiles reported the wrong month.
//
// getUTC* paired with a Date.UTC construction is fine: the two cancel and no local zone is involved.
// ---------------------------------------------------------------------------
const CLOCK_ALLOWED = new Map([])

export function checkRuntimeClock(files) {
  const out = []
  for (const { path, text } of files) {
    if (CLOCK_ALLOWED.has(path)) continue
    text.split('\n').forEach((line, i) => {
      const match = line.match(/\.get(Hours|Month|FullYear|Date|Day)\(\)/)
      if (!match || /getUTC/.test(line)) return
      out.push({
        check: 'runtime-clock',
        file: path,
        line: i + 1,
        message:
          `reads .get${match[1]}() off the runtime clock, which is UTC on Vercel and not the ` +
          "household's zone (#73). Resolve the day through lib/clock.ts, or construct with Date.UTC " +
          'and read it back with getUTC*.',
      })
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 3. Every `transactions` read is bounded, or reads every page.
//
// #69. PostgREST truncates each response at the project's max-rows (1,000) with a 200 OK and no
// error, so a read that matches more renders the first 1,000 as though they were all of it. On
// 2026-10-05 Settings counted 1,000 of 1,366 transactions, and the dashboard's six-month window
// held 908, set to pass 1,000 around the 20th of the month.
//
// A read passes if it goes through lib/read-all.ts's readAllRows, which pages past the cap, or if
// it bounds itself at or under the cap: .limit(n) or .range(a, b) (a literal over 1,000 is no
// bound, since the server caps it anyway), .single()/.maybeSingle(), or a count-only select
// (`head: true` in the .select() options). .order() alone does not pass: it makes the truncated
// set the same on every request, and it is still truncated.
//
// This reads code, not lines. Comments and string contents are blanked out first, the query chain
// is followed by matching its own parentheses, and the readAllRows exemption applies only to a read
// INSIDE that call's parentheses. A line-based version passed reads that merely sat near a bounded
// call, or under a comment that mentioned one.
// ---------------------------------------------------------------------------
const TXN_READS_ALLOWED = new Map([
  [
    'app/(app)/reimbursements/page.tsx',
    'Reads marked rows only (reimbursable_amount not null), all-time because the FIFO allocation ' +
      'needs every one. They accumulate at a handful a month, so 1,000 is years away. Not paged, ' +
      'and not protected by its .order(): wrap it in readAllRows if the marked count nears the cap.',
  ],
  ['lib/receivable.ts', 'The same marked-rows read as reimbursements/page.tsx, for the same reason.'],
  ['lib/ingest.ts', 'Writes and cursor-driven pulls, not a page read.'],
])
const PAGE_CAP = 1000

// Two views of the source, each the same length with newlines kept, so an index into either is an
// index into the original:
// - `text`: comments blanked out, strings intact (to find `.from('transactions')` and read args);
// - `code`: string contents blanked too, so a parenthesis inside a string cannot unbalance anything.
function views(src) {
  const text = src.split('')
  const code = src.split('')
  const blank = (arr, from, to) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const line = src[i + 1] === '/'
      const end = src.indexOf(line ? '\n' : '*/', i + 2)
      const stop = end === -1 ? src.length : line ? end : end + 2
      blank(text, i, stop)
      blank(code, i, stop)
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      blank(code, i + 1, j)
      i = j + 1
    } else i++
  }
  return { text: text.join(''), code: code.join('') }
}

// Index of the parenthesis that closes the one opening at `open`, in blanked source.
function closeOf(code, open) {
  let depth = 0
  for (let k = open; k < code.length; k++) {
    if (code[k] === '(') depth++
    else if (code[k] === ')' && --depth === 0) return k
  }
  return code.length
}

// The calls chained onto `.from(...)`, in order: [{ name, args, codeArgs, close }], with `args`
// taken from the comment-free source so string arguments survive, `codeArgs` from the blanked
// source, and `close` the index of the call's closing parenthesis.
function chainAfter(code, text, from) {
  const calls = []
  let k = closeOf(code, code.indexOf('(', from)) + 1
  for (;;) {
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(k))
    if (!m) return calls
    const open = k + m[0].length - 1
    const close = closeOf(code, open)
    calls.push({ name: m[1], args: text.slice(open + 1, close), codeArgs: code.slice(open + 1, close), close })
    k = close + 1
  }
}

// True if the index sits inside the parentheses of a readAllRows( call.
function insideReadAllRows(code, at) {
  let depth = 0
  for (let k = at - 1; k >= 0; k--) {
    if (code[k] === ')') depth++
    else if (code[k] === '(') {
      if (depth > 0) depth--
      else if (/readAllRows\s*$/.test(code.slice(Math.max(0, k - 40), k))) return true
    }
  }
  return false
}

const lineOf = (text, at) => text.slice(0, at).split('\n').length

const literalInts = (args) => args.split(',').map((a) => (/^\s*\d+\s*$/.test(a) ? Number(a) : null))

function boundsItself(calls) {
  return calls.some(({ name, args }) => {
    if (name === 'single' || name === 'maybeSingle') return true
    if (name === 'select') return /\bhead\s*:\s*true\b/.test(args)
    if (name === 'limit') {
      const [n] = literalInts(args)
      return n === null || n <= PAGE_CAP
    }
    if (name === 'range') {
      const [a, b] = literalInts(args)
      return a === null || b === null || b - a + 1 <= PAGE_CAP
    }
    return false
  })
}

export function checkTxnReads(files) {
  const out = []
  for (const { path, text } of files) {
    if (TXN_READS_ALLOWED.has(path)) continue
    const { text: commentFree, code } = views(text)
    const fromRe = /\.from\(\s*(['"])transactions\1\s*\)/g
    let match
    while ((match = fromRe.exec(commentFree))) {
      const at = match.index
      if (insideReadAllRows(code, at)) continue
      const calls = chainAfter(code, commentFree, at)
      const names = calls.map((c) => c.name)
      const reads = names.includes('select') && !names.some((n) => /^(update|upsert|insert|delete)$/.test(n))
      if (!reads || boundsItself(calls)) continue
      out.push({
        check: 'unbounded-txn-read',
        file: path,
        line: lineOf(text, at),
        message:
          'reads transactions with no bound at or under 1,000 rows. PostgREST truncates at 1,000 with ' +
          'a 200 OK and no error, and .order() alone does not stop that (#69). Wrap the query in ' +
          'readAllRows (lib/read-all.ts), or bound it.',
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 4. Categories and rules are read in one place, and only two routes write user_category.
//
// #28. A category name comes from resolveCategory (lib/category-rules.ts), over a context only
// fetchCategoryContext (lib/category-context.ts) can produce. A page that read categories itself
// and built its own map would compile, ignore every rule, and show Safeway under Food & Drink on
// one page and Grocery on the next. And a rule must never write user_category: any value there on
// a card payment re-enters it into every total. Measured in #59 against a real $7,866.69 autopay,
// one pick would take September's spending from $3,949.16 to -$3,917.53.
// ---------------------------------------------------------------------------
const CATEGORY_READS_ALLOWED = new Map([
  ['lib/category-context.ts', 'The one read every page goes through.'],
  ['app/api/categories/route.ts', 'Manages categories.'],
  ['app/api/transactions/categorize/route.ts', 'Validates a pick against the whole category list, and builds the kind gate for learning from it.'],
  ['app/api/category-rules/route.ts', 'Validates a Change: the target must count the same way.'],
])
const PFC_TO_NAME_ALLOWED = new Set(['lib/categories.ts', 'lib/category-rules.ts'])
const RULES_READS_ALLOWED = new Map([
  ['lib/category-context.ts', 'The one read every page goes through.'],
  ['app/api/transactions/categorize/route.ts', 'Learns a rule from a first pick (spec §6.1 step 8).'],
  ['app/api/category-rules/route.ts', 'Change and Remove.'],
])
const USER_CATEGORY_WRITERS = new Map([
  ['app/api/transactions/categorize/route.ts', 'Sets a pick on one transaction, with guards (spec §6.1).'],
  ['app/api/categories/route.ts', 'Rename and delete cascade a category name onto picks (#100).'],
])
const VARIABLE_PAYLOADS_ALLOWED = new Map([
  ['lib/ingest.ts', 'Its upserts come from transactionUpsertRow, which never carries user_category (tests/unit/ingest-reimbursable.test.ts).'],
  ['scripts/seed-sandbox-bank.mjs', 'Sandbox rows, never a user_category.'],
])
const BRAND_PRODUCERS = new Set(['lib/category-rules.ts', 'lib/category-context.ts', 'lib/spend-context.ts'])

function findAll(re, src) {
  const at = []
  let m
  while ((m = re.exec(src))) at.push(m.index)
  return at
}

export function checkCategoryReads(files) {
  const out = []
  for (const { path, text } of files) {
    const { text: commentFree, code } = views(text)
    if (!CATEGORY_READS_ALLOWED.has(path)) {
      for (const at of findAll(/\.from\(\s*(['"])categories\1\s*\)/g, commentFree)) {
        out.push({ check: 'category-read', file: path, line: lineOf(text, at), message:
          'reads categories directly. Use fetchCategoryContext (lib/category-context.ts), so rules apply (#28).' })
      }
    }
    if (!PFC_TO_NAME_ALLOWED.has(path)) {
      for (const at of findAll(/\bpfcToName\s*\(/g, code)) {
        out.push({ check: 'category-read', file: path, line: lineOf(text, at), message:
          'builds its own Plaid-to-name map, which ignores rules. Resolve through resolveCategory (#28).' })
      }
    }
  }
  return out
}

export function checkRulesReads(files) {
  const out = []
  for (const { path, text } of files) {
    if (RULES_READS_ALLOWED.has(path)) continue
    for (const at of findAll(/\.from\(\s*(['"])category_rules\1\s*\)/g, views(text).text)) {
      out.push({ check: 'rules-read', file: path, line: lineOf(text, at), message:
        'reads category_rules outside lib/category-context.ts and the two routes allowed to (#28).' })
    }
  }
  return out
}

// The first top-level argument of a call, from its blanked source.
function firstArg(codeArgs) {
  let depth = 0
  for (let k = 0; k < codeArgs.length; k++) {
    const c = codeArgs[k]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) return codeArgs.slice(0, k)
  }
  return codeArgs
}

export function checkUserCategoryWrites(files) {
  const out = []
  for (const { path, text } of files) {
    const { text: commentFree, code } = views(text)
    for (const at of findAll(/\.from\(\s*(['"])transactions\1\s*\)/g, commentFree)) {
      const calls = chainAfter(code, commentFree, at)
      const write = calls.find((c) => /^(update|upsert|insert)$/.test(c.name))
      if (!write) continue
      const line = lineOf(text, at)
      const chain = commentFree.slice(at, calls[calls.length - 1].close + 1)
      if (/\buser_category\b/.test(chain) && !USER_CATEGORY_WRITERS.has(path)) {
        out.push({ check: 'user-category-write', file: path, line, message:
          'writes user_category outside the categorize and categories routes. A rule must never write it, ' +
          'and any value on a card payment re-enters it into every total (#28, #59).' })
        continue
      }
      const payload = firstArg(write.codeArgs).trim()
      if ((!payload.startsWith('{') || payload.includes('...')) && !VARIABLE_PAYLOADS_ALLOWED.has(path)) {
        out.push({ check: 'user-category-write', file: path, line, message:
          'writes transactions with a payload this check cannot read (a variable or a spread), so it cannot ' +
          'tell whether user_category is in it. Write an inline object literal, or allowlist the file with a reason (#28).' })
      }
    }
  }
  return out
}

// Jev's suggestions (#28 spec §14.9) have one writer, the job in lib/category-suggest.ts, which
// stamps every row with the catalogue fingerprint and the model. A write from anywhere else could
// store a suggestion no gate checked; reads are free, since every page embeds them.
const SUGGESTION_WRITER = 'lib/category-suggest.ts'

export function checkSuggestionWrites(files) {
  const out = []
  for (const { path, text } of files) {
    if (path === SUGGESTION_WRITER) continue
    const { text: commentFree, code } = views(text)
    for (const at of findAll(/\.from\(\s*(['"])category_suggestions\1\s*\)/g, commentFree)) {
      const calls = chainAfter(code, commentFree, at)
      if (!calls.some((c) => /^(insert|upsert|update|delete)$/.test(c.name))) continue
      out.push({ check: 'suggestion-write', file: path, line: lineOf(text, at), message:
        'writes category_suggestions outside lib/category-suggest.ts, the one writer (#28 spec §14.9).' })
    }
  }
  return out
}

export function checkBrandCasts(files) {
  const out = []
  for (const { path, text } of files) {
    if (BRAND_PRODUCERS.has(path)) continue
    for (const at of findAll(/\bas\s+(CategoryData|KindContext|CategoryContext|SpendContext)\b/g, views(text).code)) {
      out.push({ check: 'brand-cast', file: path, line: lineOf(text, at), message:
        'casts to a branded category type. Build it through its producer, so the rules cannot be left out (#28).' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 5. A control shown on a phone is a 44px tap target.
//
// #122. Spec §7 asks for a 44px minimum tap height on a phone. Stage 5 of the phone pass met it by
// raising the shared control classes, which reach only the controls that use them: eight text links
// and text buttons with classes of their own stayed 16-20px tall on a phone, two of them added by the
// pass itself, for phones. The phone header's sign-out was a ninth, at 36px (#121). So every raw <a>,
// <button> and next/link <Link> in app/ and components/ carries a 44px rule in its classes:
// tapTargetClass, buttonClass(…), or min-h-[44px] itself, written so it always applies (not in one
// branch of a condition, not only from a breakpoint).
//
// It parses the TSX with the TypeScript compiler, because an attribute can hold `=>` and a pattern
// that reads a tag to its first `>` stops inside the onClick. A file that does not parse fails:
// the parser recovers and goes on, so the controls it finds in such a file cannot be trusted.
// Components that hand their className straight to a raw control (PASS_THROUGH below) are checked
// where they are rendered, by the classes written there. A control under an element whose own
// classes hide it below `md` passes: `hidden`, with only an md: or wider variant to show it again.
// §7 is a phone rule.
//
// A control that is tall enough from its padding and content still carries the rule itself, so a
// change to its padding cannot take it under 44px unnoticed. Anything else that cannot carry it is
// named below, by its file and its classes, with why it is fine. The classes are the name, so
// changing them asks the question again. An entry that names no control in its file fails, and so,
// when the whole tree is read (main(), below), does one whose file is gone: the list cannot outlive
// its controls. In a name, a template's expressions are written `${…}`, and classes that are one
// expression are written as that expression in braces.
// ---------------------------------------------------------------------------
export const TAP_TARGETS_ALLOWED = [
  {
    file: 'components/SignOutButton.tsx',
    classes: '{className}',
    reason: "Its classes are its caller's: each place it is rendered is checked, by the classes written there.",
  },
]

// Components whose className goes straight to a raw control, by the module path they are imported
// from and the name they are exported under.
const PASS_THROUGH = [{ from: /(^|\/)SignOutButton$/, name: 'SignOutButton' }]

// Values that carry the 44px rule below md: components/ui/styles.ts's classes, and buttonClass(…).
const TAP_RULE_CLASSES = new Set(['tapTargetClass', 'inputClass', 'selectClass'])
const carriesTapRule = (e) =>
  (ts.isIdentifier(e) && TAP_RULE_CLASSES.has(e.text)) ||
  (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'buttonClass')

// Tailwind's display utilities: under a variant below md, any of them shows what `hidden` hides.
const DISPLAYS = new Set(
  'block inline-block inline flex inline-flex grid inline-grid contents flow-root list-item table inline-table table-caption table-cell table-column table-column-group table-footer-group table-header-group table-row-group table-row'.split(' ')
)

const words = (s) => s.split(/\s+/).filter(Boolean)
const SLOT = '\u0000'

// An element's className, read three ways: `name`, to match the allowlist by; `tokens`, the classes
// it has whatever the state (a string's text, never a branch of a condition; a token a template
// expression runs into keeps the SLOT, so it matches no class); and `rule`, whether they carry the
// 44px rule.
function classesOf(opening, sf) {
  const attr = opening.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'className')
  const e = attr?.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr?.initializer
  if (!e) return { name: '', tokens: [], rule: false }
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    const tokens = words(e.text)
    return { name: tokens.join(' '), tokens, rule: tokens.includes('min-h-[44px]') }
  }
  if (ts.isTemplateExpression(e)) {
    const raw = [e.head.text, ...e.templateSpans.map((s) => SLOT + s.literal.text)].join('')
    const tokens = words(raw)
    return {
      name: words(raw.replaceAll(SLOT, '${…}')).join(' '),
      tokens,
      rule: tokens.includes('min-h-[44px]') || e.templateSpans.some((s) => carriesTapRule(s.expression)),
    }
  }
  return { name: `{${words(e.getText(sf)).join(' ')}}`, tokens: [], rule: carriesTapRule(e) }
}

// Whether classes hide their element below `md` in every state: `hidden`, and no display utility
// under a variant other than md: or wider. `hidden sm:block` shows from 640px, and a state variant
// such as `group-open:block` shows it on a tap.
function hiddenBelowMd(tokens) {
  if (!tokens.includes('hidden')) return false
  return !tokens.some((t) => {
    const at = t.lastIndexOf(':')
    return at > 0 && DISPLAYS.has(t.slice(at + 1)) && !/^(md|lg|xl|2xl):/.test(t)
  })
}

// `wholeTree`: `files` is every file under app/ and components/, as main() reads them, so an entry
// whose file is not among them names a file deleted or renamed. A caller passing some of the files
// leaves it false, and such an entry is not reported.
export function checkTapTargets(files, allowed = TAP_TARGETS_ALLOWED, { wholeTree = false } = {}) {
  const out = []
  const read = new Set()
  const unparsed = new Set()
  const named = new Set()
  for (const { path, text } of files) {
    if (!/^(app|components)\/.+\.tsx$/.test(path)) continue
    read.add(path)
    const [syntax] = ts.transpileModule(text, {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.Preserve },
    }).diagnostics
    if (syntax) {
      unparsed.add(path)
      out.push({
        check: 'tap-target',
        file: path,
        line: lineOf(text, syntax.start ?? 0),
        message:
          `does not parse as TSX (${ts.flattenDiagnosticMessageText(syntax.messageText, ' ')}), so its ` +
          'controls cannot be checked for a 44px tap target (#122).',
      })
      continue
    }
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    // <a> and <button>; next/link's Link under whatever name this file imports it as; and each
    // PASS_THROUGH component, under whatever name it is imported as.
    const controls = new Set(['a', 'button'])
    for (const s of sf.statements) {
      if (!ts.isImportDeclaration(s) || !s.importClause) continue
      const from = s.moduleSpecifier.text
      if (from === 'next/link' && s.importClause.name) controls.add(s.importClause.name.text)
      const bindings = s.importClause.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const el of bindings.elements) {
        const exported = (el.propertyName ?? el.name).text
        if (PASS_THROUGH.some((p) => p.name === exported && p.from.test(from))) controls.add(el.name.text)
      }
    }
    const visit = (node, hidden) => {
      const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null
      if (opening) {
        const classes = classesOf(opening, sf)
        hidden = hidden || hiddenBelowMd(classes.tokens)
        const tag = opening.tagName.getText(sf)
        if (controls.has(tag) && !hidden && !classes.rule) {
          const entry = allowed.find((a) => a.file === path && a.classes === classes.name)
          if (entry) named.add(entry)
          else {
            out.push({
              check: 'tap-target',
              file: path,
              line: lineOf(text, opening.getStart(sf)),
              message:
                `<${tag}> has no 44px rule in its classes. On a phone §7 asks for 44px, and controls with ` +
                'classes of their own were left 16-20px tall (#122). Give it tapTargetClass (a text link or ' +
                'text button) or buttonClass, or min-h-[44px] and md:min-h-0. If it is 44px tall already, ' +
                'or never shown below md, name it in TAP_TARGETS_ALLOWED with why.',
            })
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, hidden))
    }
    visit(sf, false)
  }
  for (const entry of allowed) {
    if (named.has(entry) || unparsed.has(entry.file)) continue
    if (!read.has(entry.file)) {
      if (!wholeTree) continue
      out.push({
        check: 'tap-target',
        file: entry.file,
        line: 1,
        message:
          'TAP_TARGETS_ALLOWED names this file, and there is no such file under app/ or components/. ' +
          'Remove the entry, or, if the file moved, check its control is still 44px tall on a phone and ' +
          'name it by its new path (#122).',
      })
      continue
    }
    out.push({
      check: 'tap-target',
      file: entry.file,
      line: 1,
      message:
        `TAP_TARGETS_ALLOWED names a control here with the classes "${entry.classes}", and no control ` +
        'in this file without a 44px rule has them. Remove the entry, or, if the classes changed, check ' +
        'the control is still 44px tall on a phone and name it by its new ones (#122).',
    })
  }
  return out
}

// ---------------------------------------------------------------------------

function walk(dir, out = [], ext = /\.tsx?$/) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out, ext)
    else if (ext.test(full)) out.push(full)
  }
  return out
}

function main() {
  const ROOT = process.cwd()
  const read = (f) => ({ path: relative(ROOT, f), text: readFileSync(f, 'utf8') })
  const files = ['app', 'lib', 'components'].flatMap((d) => walk(join(ROOT, d))).map(read)
  // No scripts/ directory in the scratch trees of tests/unit/check-invariants-txn-reads.test.ts.
  // Any other failure to read it throws: passing with scripts/ unscanned would be a false "ok".
  const scripts = existsSync(join(ROOT, 'scripts'))
    ? walk(join(ROOT, 'scripts'), [], /\.mjs$/)
        .map(read)
        .filter((f) => f.path !== 'scripts/check-invariants.mjs')
    : []
  const failures = [
    ...checkUncheckedReads(files),
    ...checkRuntimeClock(files),
    ...checkTxnReads(files),
    ...checkCategoryReads(files),
    ...checkRulesReads(files),
    ...checkUserCategoryWrites([...files, ...scripts]),
    ...checkSuggestionWrites([...files, ...scripts]),
    ...checkBrandCasts(files),
    // Every file under app/ and components/ is in `files`, so an entry for one that is not is stale.
    ...checkTapTargets(files, TAP_TARGETS_ALLOWED, { wholeTree: true }),
  ]
  if (failures.length) {
    console.error(`\ncheck:invariants — ${failures.length} problem(s):\n`)
    console.error(failures.map((f) => `  ${f.file}:${f.line}\n      [${f.check}] ${f.message}`).join('\n\n'))
    console.error(
      '\nEach of these is a shape that has shipped a real bug here. Fix it, or add the file to the ' +
        'matching allowlist in scripts/check-invariants.mjs with a reason and an issue number.\n'
    )
    process.exit(1)
  }
  console.log('invariants ok')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
