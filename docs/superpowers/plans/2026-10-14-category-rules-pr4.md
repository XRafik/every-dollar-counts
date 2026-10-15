# Category Learning, PR 4: Jev Suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For spending transactions with no hand pick and no applicable merchant rule, Jev (TypeSafe's System One model) suggests one of the household's own spending categories. A suggestion at or above `SUGGESTION_THRESHOLD` is applied automatically at read time. It never crosses spending, transfers and income, and everything sits behind the switch `CATEGORY_SUGGESTIONS=on`, which starts off.

**Architecture:** A new table, `category_suggestions` (migration 022), holds one row per transaction. It is written only by a server job using the service role and read by pages through an embedded select (`suggestion:category_suggestions(...)`). `resolveCategory` gains step 5, between the rule and the bank. The job, `suggestCategories(householdId)` in `lib/category-suggest.ts`, runs through `after()` once a sync response has been sent, both in the Refresh route and in the webhook. It asks Jev in batches of 20 through `lib/typesafe.ts`, a plain `fetch` wrapper with no new dependency. A catalogue fingerprint makes every suggestion stale as soon as a category is added, renamed or deleted. Turning the switch off makes pages ignore stored suggestions on the next load, so the switch is also the rollback.

**Tech Stack:** Next.js 16 App Router (route handlers, `after` from `next/server`), Supabase (RLS, PostgREST embedded one-to-one select, service-role client), React 19, Vitest + Testing Library, TypeSafe HTTP API `POST https://api.typesafe.ai/v1/systemone` (`model: 'jev-latest'`, Choice questions).

**Spec:** `docs/superpowers/specs/2026-09-11-category-rules-design.md` §14 (all of it), §5.3 step 5, and §11's money property. Read §14 in full, plus §5.1–§5.4, before Task 1. The resolver in `lib/category-rules.ts` is the code this PR extends; read it in full too.

**API reference (read before Task 5):** https://docs.typesafe.ai/api.md. Request: `{ state, model, questions: { <id>: { type: 'choice', instructions, criteria: { <option>: string | null } } } }`. Response: `{ model, answers: { <id>: { type: 'choice', choice, probabilities, confidence } }, usage: { input_tokens, output_tokens } }`. A Choice allows at most 255 options. Question ids are not sent to the model. Option keys are.

## Deviations from the spec's letter (decided here, flag in the PR body)

1. **`SUGGESTION_THRESHOLD` lives in `lib/category-rules.ts`,** not `lib/category-suggest.ts`. `resolveCategory` needs it, and `category-rules.ts` is imported by client components (`CategoryPicker`, `CategoryRulesCard`, `TransactionCard`), so it can't import a `server-only` module.
2. **`catalogFingerprint` is a pure-JS 53-bit hash (cyrb53), not `node:crypto`,** for the same reason. It only detects change and is not a security boundary.
3. **The request builder is `lib/category-suggest-request.ts`** (pure, no `server-only`), so the §14.8 launch-check script can import the exact builder the job uses. `lib/category-suggest.ts` holds the I/O.
4. **The job reads categories and rules through the service role**, using `fetchCategoryDataForHousehold(householdId)` in `lib/category-context.ts`. The webhook has no user session, so `fetchCategoryContext`'s cookie client can't serve it. It is the same file and the same throw-on-failure contract, filtered by `household_id`.
5. **Examples order:** rules first (the household's merchant-level decisions, in `merchant_label` order), then hand picks for merchants with no rule, most recent first, one per merchant, capped at 60. Rules carry no date in `CategoryData`.
6. **Write granularity:** one upsert per batch of 20, checked with `{ count: 'exact' }` against the batch's length. Each row is still one row per transaction (spec §14.4).
7. **No README run order exists** for migrations; 022's header carries the run instructions, as 021's does.
8. **`confidence` stores the Choice answer's `confidence` field**, which matches the column's name. The launch check reports both it and the probability of the chosen option, and the owner picks the threshold on `confidence`.

## Global Constraints

- **Suggestions never write `transactions`,** and in particular never `user_category`. The only new writes go to `category_suggestions`, and only from `lib/category-suggest.ts` (tripwire, Task 6).
- **Resolution order is fixed** (§5.3): pick → card-payment exemption → rule → suggestion → bank. A suggestion applies only when **all** hold:
  - the switch is on;
  - the row's suggestion is non-null and has a non-null `category_id` that is still in the context;
  - its `catalog_fingerprint` equals the context's;
  - `confidence >= SUGGESTION_THRESHOLD`;
  - `ruleFits(suggestedName, bank, ctx)`: the kind of the suggested name equals both Plaid's kind for the row and the kind of the name the row shows.
- **Rows asked about** (§14.2): non-removed, `user_category` null, not `isCardPaymentRow(pfc_detailed)`, and bank kind `'spending'` by both measures (`bank.kind === 'spending' && kindOf(bank.name) === 'spending'`), with no suggestion or a stale fingerprint. Newest first, at most `limit` (default 200) per run.
- **Options** are the household's spending-kind categories, by exact name. Each is described as `"Plaid's default for <PFC_PRIMARY>"`, or `null` when it has no `pfc_primary`. Then add `none`, described as `"None of these categories fits this transaction."`
- **State sent per request:**
  - `household_examples: { merchant, filed_as }[]` (≤ 60, spending kind only);
  - `transactions: { merchant, bank_description, amount_usd, direction, date, bank_category }[]` (≤ 20), where:
    - `merchant` is `merchant_name ?? name`;
    - `bank_description` is `name`;
    - `amount_usd` is `Math.abs(amount)`;
    - `direction` is `'out'` for `amount > 0` and otherwise `'in'` (Plaid's sign);
    - `bank_category` is `pfc_detailed ?? pfc_primary ?? 'UNKNOWN'`.
  - **Nothing else:** no ids, account numbers, balances, institution names or household identifiers. A transaction id is a question key only, and question keys are never sent to the model.
- **Instructions per question, verbatim:** ``Which of this household's budget categories should `transactions[<i>]` be filed under? `household_examples` shows how this household files merchants it has decided; follow its habits.``
- **The job never throws to its caller,** never touches the sync response, its status or `plaid_items`, and logs only:
  - `[suggest] skipped: environment`
  - `[suggest] failed` (with a reason, never a request body)
  - `[suggest] done` with counts
- **Environment-guarded** by `assertEnvMatchesDatabase()`. Local and Preview never call TypeSafe or write suggestions.
- **The switch is `process.env.CATEGORY_SUGGESTIONS === 'on'`.** Unset or any other value means off. It is read in exactly one function, `suggestionsEnabled()`.
- **`TYPESAFE_API_KEY` stays server-only.** It is never `NEXT_PUBLIC_` (`check:secrets` already guards this) and never logged.
- **Copy is exact:**
  - marker: `${category}, suggested by Jev. Pick a category to change it.`
  - Settings line: `For merchants without a rule, Jev suggests a category. ${n} transactions are filed by Jev.` (`1 transaction is` when n = 1)
  - phone card line: `Suggested by Jev.`
- **Run before the PR:** `npx vitest run`, `VITEST_TZ=America/Los_Angeles npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run check:invariants`, `npm run check:secrets`, `npx next build`.
- **Every guard added gets a mutation check** (Task 8 lists them): revert it, watch a named test fail, then restore it.
- **Subagent briefs:** edit with Edit/Write; one command per Bash call; no `cd … &&` chains or heredocs.
- **Out-of-scope findings become GitHub issues** (`.claude/rules/filing-issues.md`), never fixes on this branch.

## Review Focus

These are the five inputs most likely to hurt the household that §14.9 doesn't pin. Each line names the task whose tests cover it.

1. **The embedded select comes back in the wrong shape.** PostgREST returns a one-to-one embed as an object or null, but if it ever returns an array, `row.suggestion.category_id` is `undefined`. Every suggestion would then silently never apply. *(Task 1 runs a live check of the shape on the shared database. Task 2's resolver test: an array-shaped `suggestion` resolves to the bank and does not throw.)*
2. **A household category literally named `none`** (any case) would collide with the "none fits" option. *(Task 4: the builder throws `a spending category is named "none"`. Task 6: the job then logs `[suggest] failed` and writes nothing.)*
3. **Jev answers with an option that isn't in the list** (a renamed category, or the model echoing something), or a confidence outside 0–1. Written blindly, such an answer either violates the DB check, which fails the whole batch, or files under a name the context can't resolve. *(Task 5: `askChoices` rejects a malformed answer. Task 6: an unknown `choice` skips that row, and the batch's other rows are still written.)*
4. **A category is deleted between the job's read and its write** (FK `23503`). The batch fails. The job must log, stop, and leave the sync untouched. *(Task 6: "an upsert error stops the run, logs, and does not throw".)*
5. **The switch is on but the household has no suggestions yet** (the first deploy, or right after a category rename). Every page must render exactly as it does without suggestions, and the Settings line must say `0 transactions are filed by Jev`, not crash or hide. *(Task 3: page test with the switch on and an empty suggestions embed. Task 7: Settings line at n = 0, 1 and 2.)*

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `db/migrations/022_category_suggestions.sql` | Create | Table, RLS, grants; hand-run on the shared DB. |
| `lib/category-rules.ts` | Modify | `SuggestionRef`, `suggestion` on `CategorizableTxn`, `'suggestion'` source, step 5, `changedBySuggestion`, `catalogFingerprint`, `SUGGESTION_THRESHOLD`, `suggestableRow`, `spendingCategories`, `contextFingerprint`. |
| `tests/unit/helpers/category-context.ts` | Modify | `testData(..., { suggestionsOn })`. |
| `tests/unit/category-rules.test.ts`, `tests/unit/category-money.test.ts` | Modify | Step 5 cases; money property with suggestions. |
| `lib/category-context.ts` | Modify | `suggestionsEnabled()`, `suggestionsOn` in `CategoryData`, `fetchCategoryDataForHousehold`, the embed in `readTransactionsForCounts`. |
| `app/(app)/{dashboard,breakdown/[metric],transactions,trends,budgets}/page.tsx` | Modify | Add the embed to every `transactions` select that feeds `resolveCategory`. |
| `lib/category-suggest-request.ts` | Create | Pure request builder: options, examples, state, questions. |
| `lib/typesafe.ts` | Create | `askChoices` over `fetch`, with retries and validation. |
| `lib/category-suggest.ts` | Create | `suggestCategories(householdId, { limit })`, the job. |
| `scripts/check-invariants.mjs` | Modify | Allowlists for the job's reads, plus a new `suggestion-write` check. |
| `app/api/plaid/sync-transactions/route.ts`, `app/api/plaid/webhook/route.ts` | Modify | `after(() => suggestCategories(...))`. |
| `components/ui/icons.tsx`, `components/SuggestedMarker.tsx`, `components/TransactionRow.tsx`, `components/TransactionCard.tsx` | Modify/Create | The marker. |
| `lib/category-views.ts`, `app/(app)/settings/page.tsx`, `components/CategoryRulesCard.tsx` | Modify | The `suggested` count and the Settings line. |
| `.env.example` | Modify | `CATEGORY_SUGGESTIONS=` (empty, so off). |

---

### Task 1: Migration 022, applied to the shared database

**Files:**
- Create: `db/migrations/022_category_suggestions.sql`

**Interfaces:**
- Produces: table `public.category_suggestions(transaction_id uuid pk, household_id uuid, category_id uuid null, confidence real, catalog_fingerprint text, model text, created_at timestamptz)`. `authenticated` gets SELECT only and `service_role` gets S/I/U/D.

- [ ] **Step 1: Write the migration** in 021's shape (header, the table and its RLS in one `do $$` block, idempotent re-asserts, explicit grants, checks to run afterwards):

```sql
-- Jev category suggestions (#28 spec §14). One row per transaction: Jev's pick among the
-- household's spending categories, or null for "none of these fits". Applied only at READ time
-- (lib/category-rules.ts resolveCategory step 5), only when CATEGORY_SUGGESTIONS=on, at or above
-- SUGGESTION_THRESHOLD, and only while catalog_fingerprint matches the household's categories.
-- Nothing on transactions is written.
--
-- Hand-run in the SQL editor and safe to re-run. Creates no rows. Written only by
-- lib/category-suggest.ts through the service role. Emptying it loses nothing a person decided:
--   delete from public.category_suggestions where household_id = '…';
--
-- Never drop it while a deployment built from PR 4 or later is live: five money pages and Settings
-- embed it in their transactions reads. One database serves local, Preview and production.

do $$ begin
  if to_regclass('public.category_suggestions') is null then
    create table public.category_suggestions (
      transaction_id uuid primary key references public.transactions(id) on delete cascade,
      household_id uuid not null references public.households(id) on delete cascade,
      category_id uuid,                                    -- null: Jev answered "none of these fits"
      confidence real not null check (confidence >= 0 and confidence <= 1),
      catalog_fingerprint text not null,
      model text not null,                                 -- the model TypeSafe reports, e.g. jev-1.13.0
      created_at timestamptz not null default now(),
      constraint category_suggestions_category_fk foreign key (household_id, category_id)
        references public.categories (household_id, id) on delete cascade
    );
    alter table public.category_suggestions enable row level security;
    create policy "read your category suggestions" on public.category_suggestions
      for select to authenticated
      using ( household_id in (select private.household_ids()) );
  end if;
end $$;

alter table public.category_suggestions enable row level security;
drop policy if exists "read your category suggestions" on public.category_suggestions;
create policy "read your category suggestions" on public.category_suggestions
  for select to authenticated
  using ( household_id in (select private.household_ids()) );

-- Read by the household; written only by the server job. No anon grant.
revoke insert, update, delete on table public.category_suggestions from authenticated;
grant select on table public.category_suggestions to authenticated;
grant select, insert, update, delete on table public.category_suggestions to service_role;

-- Check after running (expected: t, f, f, f, t):
--   select has_table_privilege('authenticated', 'public.category_suggestions', 'SELECT'),
--          has_table_privilege('authenticated', 'public.category_suggestions', 'INSERT'),
--          has_table_privilege('authenticated', 'public.category_suggestions', 'UPDATE'),
--          has_table_privilege('authenticated', 'public.category_suggestions', 'DELETE'),
--          has_table_privilege('service_role', 'public.category_suggestions', 'INSERT');
--
-- Rollback, only once no deployment built from PR 4 is live: drop table public.category_suggestions;
```

Note the composite FK with a nullable `category_id`: under Postgres's default `MATCH SIMPLE`, a row whose `category_id` is null is not checked. That is exactly what "none" needs.

- [ ] **Step 2: Apply it to the shared database** through the Supabase dashboard SQL editor (as 021 was), then run the check query. Expected: `t, f, f, f, t`. Also run `select count(*) from public.category_suggestions;` and expect 0. The live app is unaffected, because no deployed code reads the table yet.

- [ ] **Step 3: Verify the embed's shape (Review Focus 1).** In the SQL editor, insert one test row for any real transaction, check the embed through PostgREST, then delete the row:
  - in SQL: `insert into public.category_suggestions (transaction_id, household_id, category_id, confidence, catalog_fingerprint, model) select id, household_id, null, 0.5, 'shape-check', 'manual' from public.transactions where removed = false limit 1 returning transaction_id;`
  - with the service-role key from `.env.local` (one Bash command, `curl`): `GET $NEXT_PUBLIC_SUPABASE_URL/rest/v1/transactions?id=eq.<that id>&select=id,suggestion:category_suggestions(category_id,confidence,catalog_fingerprint)` with headers `apikey` and `Authorization: Bearer`. Expected: `"suggestion":{"category_id":null,"confidence":0.5,"catalog_fingerprint":"shape-check"}`, an **object** and not an array.
  - in SQL: `delete from public.category_suggestions where catalog_fingerprint = 'shape-check';`

  If the embed comes back as an array, stop and report it: Task 2's type and every page would need to change.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/022_category_suggestions.sql
git commit -m "Add category_suggestions (migration 022) for Jev suggestions (#28)"
```

---

### Task 2: Resolver step 5 (pure)

**Files:**
- Modify: `lib/category-rules.ts`
- Modify: `tests/unit/helpers/category-context.ts`
- Test: `tests/unit/category-rules.test.ts`, `tests/unit/category-money.test.ts`

**Interfaces:**
- Produces (all exported from `lib/category-rules.ts`):
  - `type SuggestionRef = { category_id: string | null; confidence: number; catalog_fingerprint: string }`
  - `CategorizableTxn` gains **required** `suggestion: SuggestionRef | null`
  - `CategoryData` gains `readonly suggestionsOn: boolean`
  - `ResolvedCategory` gains the variant `{ source: 'suggestion'; name: string; ruleId: null; bankName: string }`
  - `const SUGGESTION_THRESHOLD = 0.9` (provisional; §14.8's launch check replaces it before the switch goes on)
  - `function catalogFingerprint(categories: Category[]): string`
  - `function contextFingerprint(ctx: CategoryContext): string`
  - `function changedBySuggestion(r: ResolvedCategory): boolean`
  - `function suggestableRow(t: CategorizableTxn, k: KindContext): boolean`: §14.2's row gate, without the staleness check
  - `function spendingCategories(categories: Category[], k: KindContext): Category[]`
- Test helper: `testData(categories, rules = [], opts: { suggestionsOn?: boolean } = {})`, which defaults `suggestionsOn` to `true` so step 5 is exercised, and `sug(categoryId: string | null, confidence: number, fingerprint: string): SuggestionRef`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/category-rules.test.ts`, in a new `describe('resolveCategory step 5: suggestions', …)`. Build rows with the existing row helper in that file, adding `suggestion`. Use `const FP = catalogFingerprint(DEFAULTS)`.

```ts
const wholeFoods = (s: SuggestionRef | null, over = {}) =>
  ({ user_category: null, pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_GROCERIES', merchant_name: 'Whole Foods', suggestion: s, ...over })
const ctx = (opts = {}, rules: CategoryRule[] = []) => buildCategoryContext(testData(DEFAULTS, rules, opts))

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
```

Adjust category names to whatever `DEFAULT_CATEGORIES` actually holds (`lib/categories.ts`). Look them up; don't guess. Every existing row literal in this file and in other tests now needs `suggestion: null`, and tsc will list each one.

- [ ] **Step 2: Extend the money property** in `tests/unit/category-money.test.ts`. For every category set the file already loops over (including the ones with a default deleted), give each row in `ROWS` a suggestion pointing at **each** category in the set in turn, at confidence 0.99 and the current fingerprint. Assert that `monthlyFlows` Spent/Income and `spendByCategory`'s total equal the values with no suggestions. Also add one case where every row carries a suggestion to a *transfer* category, and assert Spent is unchanged.

- [ ] **Step 3: Run and watch them fail.** Run: `npx vitest run tests/unit/category-rules.test.ts tests/unit/category-money.test.ts`. Expected: FAIL (`sug`/`catalogFingerprint` are not exported, and `suggestion` is unknown).

- [ ] **Step 4: Implement** in `lib/category-rules.ts`:

```ts
// The row's embedded category_suggestions row (#28 spec §14.3), or null. Pages select it as
// `suggestion:category_suggestions(category_id, confidence, catalog_fingerprint)`.
export type SuggestionRef = { category_id: string | null; confidence: number; catalog_fingerprint: string }

// Provisional until §14.8's launch check; the owner picks the final value from its report.
export const SUGGESTION_THRESHOLD = 0.9
```

- Add `suggestion: SuggestionRef | null` to `CategorizableTxn`, and update its comment ("All five REQUIRED").
- Add `readonly suggestionsOn: boolean` to `CategoryData`.
- `RuleState` gains `fingerprint: string` and `suggestionsOn: boolean`. `buildCategoryContext` sets them from `catalogFingerprint(categories)` (after `withoutCategoryId` filtering) and `data.suggestionsOn`.
- `ResolvedCategory` gains `| { source: 'suggestion'; name: string; ruleId: null; bankName: string }`.

```ts
// cyrb53: a small pure-JS 53-bit string hash. Pure so client bundles can import this file; it
// only detects that the catalogue changed, it is not a security boundary.
function cyrb53(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

// Spec §14.3: changes when a category is added, renamed, deleted or changes kind, so every older
// suggestion stops applying at once. Kind is computed from the whole list, as the totals do.
export function catalogFingerprint(categories: Category[]): string {
  const k = buildKindContext(categories)
  const triples = categories.map((c) => `${c.id}:${c.name}:${kindOf(c.name, k)}`).sort()
  return cyrb53(JSON.stringify(triples))
}

export function contextFingerprint(ctx: CategoryContext): string {
  return ctx[RULE_STATE].fingerprint
}
```

Step 5 in `resolveCategory`, after the rule block and before `return asBank`:

```ts
  // 4. Jev's suggestion (spec §14.3): switched on, current catalogue, confident, same kind. An
  //    array (an embed PostgREST did not treat as one-to-one) is ignored, never half-read.
  const s = t.suggestion
  const st = ctx[RULE_STATE]
  if (st.suggestionsOn && s && !Array.isArray(s) && s.category_id && s.catalog_fingerprint === st.fingerprint &&
      s.confidence >= SUGGESTION_THRESHOLD) {
    const suggested = st.nameById.get(s.category_id)
    if (suggested && ruleFits(suggested, bank, ctx)) {
      return { name: suggested, source: 'suggestion', ruleId: null, bankName: bank.name }
    }
  }
```

Renumber the comment steps to match. Then add:

```ts
export function changedBySuggestion(r: ResolvedCategory): boolean {
  return r.source === 'suggestion' && r.name !== r.bankName
}

// Spec §14.2: the rows Jev is asked about. No pick, not a card payment, and spending by both
// Plaid's kind and the shown name's kind (the same two measures ruleFits checks).
export function suggestableRow(t: CategorizableTxn, k: KindContext): boolean {
  if (t.user_category || isCardPaymentRow(t.pfc_detailed)) return false
  const bank = bankCategory(t, k)
  return bank.kind === 'spending' && kindOf(bank.name, k) === 'spending'
}

export function spendingCategories(categories: Category[], k: KindContext): Category[] {
  return categories.filter((c) => kindOf(c.name, k) === 'spending')
}
```

Update the file's header comment to give the precedence as pick, rule, suggestion, bank. In `tests/unit/helpers/category-context.ts`, give `testData` its `opts` parameter and add `sug`.

- [ ] **Step 5: Run.** `npx vitest run tests/unit/category-rules.test.ts tests/unit/category-money.test.ts` should PASS. Then run `npx tsc --noEmit`, expecting errors **only** where row literals or selects lack `suggestion`, and where a `CategoryData` is built without `suggestionsOn` (in `lib/category-context.ts`). Fix the test-file row literals now by adding `suggestion: null`. Leave the `app/` pages and `lib/category-context.ts` for Task 3, and note in the commit that tsc is red there until Task 3.

- [ ] **Step 6: Commit**

```bash
git add lib/category-rules.ts tests/
git commit -m "Resolve a Jev suggestion between the rule and the bank (#28 PR 4, §5.3 step 5)"
```

---

### Task 3: Pages read the suggestion; the switch

**Files:**
- Modify: `lib/category-context.ts`
- Modify: `app/(app)/dashboard/page.tsx` (two selects), `app/(app)/breakdown/[metric]/page.tsx`, `app/(app)/transactions/page.tsx`, `app/(app)/trends/page.tsx`, `app/(app)/budgets/page.tsx`
- Modify: any type in `lib/dashboard.ts`, `lib/budget.ts`, `lib/transaction-presentation.ts`, `components/TransactionRow.tsx` or `components/TransactionCard.tsx` that tsc says must carry `suggestion`
- Modify: `.env.example`
- Test: `tests/unit/category-context.test.ts`, `tests/unit/transactions-page.test.tsx`, `tests/unit/dashboard-page.test.tsx`, `tests/unit/budgets-page.test.tsx`, `tests/unit/trends-page.test.tsx`, `tests/unit/breakdown-page.test.tsx`

**Interfaces:**
- Consumes: Task 2's types.
- Produces, from `lib/category-context.ts`:
  - `suggestionsEnabled(): boolean`, which reads `process.env.CATEGORY_SUGGESTIONS === 'on'` and is the only reader of that variable;
  - `fetchCategoryContext` returns `suggestionsOn: suggestionsEnabled()`;
  - `fetchCategoryDataForHousehold(householdId: string): Promise<CategoryData>`, the same reads through `supabaseAdmin` with `.eq('household_id', householdId)` on both, the same throws, and `suggestionsOn: suggestionsEnabled()`;
  - `export const SUGGESTION_EMBED = 'suggestion:category_suggestions(category_id, confidence, catalog_fingerprint)'`;
  - `readTransactionsForCounts` adds `, ${SUGGESTION_EMBED}` to its select.

- [ ] **Step 1: Failing tests.**
  - `tests/unit/category-context.test.ts`:
    - `suggestionsEnabled()` is true only for exactly `'on'`. Use `vi.stubEnv` with `'on'`, `'ON'`, `'1'`, `''` and unset.
    - `fetchCategoryContext` carries `suggestionsOn`.
    - `fetchCategoryDataForHousehold` filters both reads by household (assert the `.eq('household_id', 'hh-1')` calls on the admin mock) and throws `could not read category rules: …` on a rules error.
    - `readTransactionsForCounts`'s select string contains `SUGGESTION_EMBED`.
  - Each page test that has a "files Safeway under Grocery through its rule" case gets a sibling. Seed a Whole Foods row with `pfc_primary: 'FOOD_AND_DRINK'`, no rule, and `suggestion: sug(GROCERY.id, 0.99, catalogFingerprint(<that test's categories>))`.
    - With `CATEGORY_SUGGESTIONS=on`, the page files it under Grocery (assert the same way that test asserts the rule case).
    - With the variable unset, it stays under Food & Drink.
  - Also add (Review Focus 5): with the switch on and every row's `suggestion: null`, the page renders exactly what it renders with the switch off. Compare the same assertion values.
  - Each page test must also assert that the select string passed to the mocked `.select(...)` contains `category_suggestions(`. This is the coverage guard (§7.4's pattern).

- [ ] **Step 2: Run them and watch them fail:** `npx vitest run tests/unit/category-context.test.ts tests/unit/*-page.test.tsx`.

- [ ] **Step 3: Implement.**
  - In `lib/category-context.ts`, add the three exports. Import `supabaseAdmin` from `./supabase/admin`.
  - In each page, append `, ${SUGGESTION_EMBED}` to every `transactions` select whose rows reach `resolveCategory`, `effectiveCategory`, `buildSpendContext` or the category views. Import `SUGGESTION_EMBED`. Leave `app/(app)/reimbursements/page.tsx` alone: it doesn't resolve categories.
  - Run `npx tsc --noEmit` and add `suggestion: SuggestionRef | null` to each row type it names, following the same pattern as `merchant_name`.
  - In `.env.example`, under `TYPESAFE_API_KEY`, add:

```
# Jev category suggestions (#28 spec §14.7). "on" enables the job and applies stored suggestions;
# anything else (or unset) is off, and is also the rollback.
CATEGORY_SUGGESTIONS=
```

- [ ] **Step 4: Run.** The tests from Step 1 pass. Run `npx tsc --noEmit`, which is clean, and then the full `npx vitest run`, which must be all green.

- [ ] **Step 5: Commit**

```bash
git commit -am "Pages read each row's Jev suggestion; CATEGORY_SUGGESTIONS switch (#28 PR 4)"
```

---

### Task 4: The request builder (pure)

**Files:**
- Create: `lib/category-suggest-request.ts`
- Test: `tests/unit/category-suggest-request.test.ts`

**Interfaces:**
- Consumes: `spendingCategories`, `buildKindContext`, `kindOf`, `merchantKey`, `isCardPaymentRow` (from `./categories`), and `CategoryData`.
- Produces:

```ts
export const BATCH_SIZE = 20
export const MAX_EXAMPLES = 60
export const NONE = 'none'
export type SuggestRow = {
  id: string; date: string; amount: number; name: string | null; merchant_name: string | null
  pfc_primary: string | null; pfc_detailed: string | null
}
export type PickRow = SuggestRow & { user_category: string | null }
export type Example = { merchant: string; filed_as: string }
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
export function suggestionOptions(data: CategoryData): Record<string, string | null> // throws on a "none" category
export function householdExamples(data: CategoryData, picks: PickRow[]): Example[]
export function buildBatchRequest(rows: SuggestRow[], options: Record<string, string | null>, examples: Example[]):
  { state: { household_examples: Example[]; transactions: object[] }; questions: Record<string, ChoiceQuestion> }
```

Question keys are the transaction ids, which TypeSafe never sends to the model. `ChoiceQuestion` is defined here, and `lib/typesafe.ts` (Task 5) imports it from here, not the other way round, so the launch-check script needs only this file.

- [ ] **Step 1: Failing tests** (`tests/unit/category-suggest-request.test.ts`):

```ts
import { DEFAULTS, GROCERY, rule, testData, cat } from './helpers/category-context'

const row = (over: Partial<SuggestRow> = {}): SuggestRow => ({ id: 't1', date: '2026-10-01', amount: 42.5,
  name: 'WHOLEFDS MKT 10234', merchant_name: 'Whole Foods', pfc_primary: 'FOOD_AND_DRINK',
  pfc_detailed: 'FOOD_AND_DRINK_GROCERIES', ...over })

describe('suggestionOptions', () => {
  it('lists spending categories plus none, described by their Plaid default', () => {
    const o = suggestionOptions(testData(DEFAULTS))
    expect(o.Grocery).toBeNull()
    expect(o['Food & Drink']).toBe("Plaid's default for FOOD_AND_DRINK")
    expect(o[NONE]).toBe('None of these categories fits this transaction.')
    expect(o).not.toHaveProperty('Income')
    expect(o).not.toHaveProperty('Transfer Out')
  })
  it('throws on a spending category named none, in any case (Review Focus 2)', () => {
    expect(() => suggestionOptions(testData([...DEFAULTS, cat('None')]))).toThrow('a spending category is named "none"')
  })
})

describe('householdExamples', () => {
  it('rules first, then picks for merchants without a rule, newest first, one per merchant', () => {
    const data = testData(DEFAULTS, [rule('Safeway', GROCERY.id)])
    const picks = [
      { ...row({ id: 'a', date: '2026-09-01', merchant_name: 'Giant' }), user_category: 'Shopping' },
      { ...row({ id: 'b', date: '2026-10-01', merchant_name: 'Giant' }), user_category: 'Grocery' },
      { ...row({ id: 'c', date: '2026-10-02', merchant_name: 'safeway ' }), user_category: 'Shopping' },
    ]
    expect(householdExamples(data, picks)).toEqual([
      { merchant: 'Safeway', filed_as: 'Grocery' },
      { merchant: 'Giant', filed_as: 'Grocery' },
    ])
  })
  it('skips transfer and income picks and rules, card payments, and merchant-less rows', () => {
    const data = testData(DEFAULTS)
    const picks = [
      { ...row({ id: 'a', merchant_name: 'Venmo' }), user_category: 'Transfer Out' },
      { ...row({ id: 'b', merchant_name: 'Chase', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }), user_category: 'Shopping' },
      { ...row({ id: 'c', merchant_name: null }), user_category: 'Shopping' },
    ]
    expect(householdExamples(data, picks)).toEqual([])
  })
  it('caps at MAX_EXAMPLES', () => {
    const picks = Array.from({ length: 80 }, (_, i) => ({ ...row({ id: `p${i}`, merchant_name: `M${i}` }), user_category: 'Shopping' }))
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
  it('asks one choice per row keyed by id, naming its index', () => {
    const req = buildBatchRequest([row(), row({ id: 't2' })], opts, [])
    expect(Object.keys(req.questions)).toEqual(['t1', 't2'])
    expect(req.questions.t2).toEqual({ type: 'choice', criteria: opts,
      instructions: "Which of this household's budget categories should `transactions[1]` be filed under? `household_examples` shows how this household files merchants it has decided; follow its habits." })
  })
  it('refuses more than BATCH_SIZE rows', () => {
    expect(() => buildBatchRequest(Array.from({ length: 21 }, (_, i) => row({ id: `t${i}` })), opts, [])).toThrow()
  })
})
```

Use the real `DEFAULT_CATEGORIES` names. If `Food & Drink`'s default primary isn't `FOOD_AND_DRINK`, use what `lib/categories.ts` says.

- [ ] **Step 2: Run and watch it fail.** `npx vitest run tests/unit/category-suggest-request.test.ts` should FAIL because the module is missing.
- [ ] **Step 3: Implement** `lib/category-suggest-request.ts`. Give it no `server-only` import and no I/O, and open it with a header comment citing spec §14.2. `householdExamples` keys merchants by `merchantKey`. For a rule, `filed_as` is its category's name, and the rule is skipped if that category is gone or not spending. Picks are sorted by `date` descending, and `id` descending breaks ties.
- [ ] **Step 4: Run.** The tests should PASS.
- [ ] **Step 5: Commit** `git commit -m "Build Jev's request from spending categories and household examples (#28 PR 4, §14.2)"` (add the two files).

---

### Task 5: `lib/typesafe.ts`

**Files:**
- Create: `lib/typesafe.ts`
- Test: `tests/unit/typesafe.test.ts`

**Interfaces:**
- Consumes: `ChoiceQuestion` from `./category-suggest-request`.
- Produces:

```ts
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export type ChoicesResult = { model: string; answers: Record<string, ChoiceAnswer>; usage: { input_tokens: number; output_tokens: number } }
export class TypeSafeError extends Error { constructor(message: string, readonly status: number | null) }
export async function askChoices(
  req: { state: unknown; questions: Record<string, ChoiceQuestion> },
  deps?: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }
): Promise<ChoicesResult>
```

- [ ] **Step 1: Failing tests:**
  - **Request shape.** It sends `POST https://api.typesafe.ai/v1/systemone` with headers `Authorization: Bearer <key>` and `Content-Type: application/json`, and a body of `{ state, model: 'jev-latest', questions }`. Use `vi.stubEnv('TYPESAFE_API_KEY', 'k')` and a fake `fetch`.
  - **Missing key.** With no key, it throws `TypeSafeError('TYPESAFE_API_KEY is not set', null)` and never calls fetch.
  - **Retries.**
    - It retries on 429 and on 529, sleeping between attempts with increasing delays (500, 1000, 2000), and then succeeds.
    - Four consecutive 429s mean three retries and then a throw (`status` 429). The fake fetch is called exactly 4 times.
    - A 400 or a 500 throws at once, with no retry.
  - **Validation.**
    - A missing answer for a question id throws.
    - A `choice` not among that question's criteria keys throws `TypeSafeError`.
    - A `confidence` that isn't a finite number in [0, 1] throws.
    - A non-string `model` throws.
  - **No body in logs.** Spy on `console.error`, `console.warn` and `console.log`. Run a failing call whose state contains `'SECRET-MERCHANT'`, and assert that no logged argument (`JSON.stringify` of each) contains it.
  - **Timeout.** It passes `signal` (an `AbortSignal`) to fetch.

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - Open with `import 'server-only'` and use the global `fetch` (or `deps.fetch`).
  - Set `signal: AbortSignal.timeout(15_000)`.
  - Use a 4-attempt loop and default `sleep` to `setTimeout`.
  - Parse JSON in a try block; a parse failure throws `TypeSafeError('unreadable response', status)`.
  - Error messages carry the status and, for a non-2xx response, at most the first 200 characters of the response body. That is TypeSafe's error text, never ours.
  - Never log inside this module: callers log.
- [ ] **Step 4: Run.** The tests should PASS.
- [ ] **Step 5: Commit** `git commit -m "Add a fetch-based TypeSafe client for Jev choices (#28 PR 4, §14.5)"`.

---

### Task 6: `suggestCategories`, the job, and its tripwires

**Files:**
- Create: `lib/category-suggest.ts`
- Modify: `scripts/check-invariants.mjs` and `tests/unit/check-invariants.test.ts`
- Test: `tests/unit/category-suggest.test.ts`

**Interfaces:**
- Consumes:
  - `fetchCategoryDataForHousehold` and `suggestionsEnabled` and `SUGGESTION_EMBED` (Task 3);
  - `buildCategoryContext`, `contextFingerprint`, `suggestableRow` (Task 2);
  - the Task 4 builder;
  - `askChoices` (Task 5);
  - `assertEnvMatchesDatabase` and `EnvMismatchError`;
  - `readAllRows`;
  - `supabaseAdmin`.
- Produces:

```ts
export type SuggestOutcome =
  | { status: 'off' }
  | { status: 'skipped'; reason: 'environment' }
  | { status: 'done'; asked: number; written: number; inputTokens: number }
  | { status: 'failed'; asked: number; written: number }
export async function suggestCategories(householdId: string, opts?: { limit?: number }): Promise<SuggestOutcome>
```

**It never throws.** The whole body is in one try/catch, and the catch logs `[suggest] failed` with `householdId` and the error's message, never a request body.

- [ ] **Step 1: Failing tests** (`tests/unit/category-suggest.test.ts`). Mock `@/lib/supabase/admin` with a small chainable stand-in, modelled on the stand-in in `tests/unit/categorize-route.test.ts`. It must:
  - record each `.from(table)` chain;
  - return a given set of `transactions` rows (with `suggestion`) for the paged read;
  - record every upsert payload, and return `{ count }` or `{ error }`.

  Also mock `@/lib/app-env`, `@/lib/typesafe` and `@/lib/category-context` (`fetchCategoryDataForHousehold` returns `testData(DEFAULTS, rules)`, `suggestionsEnabled` is controllable, and `SUGGESTION_EMBED` is passed through). The cases:
  - **switch off.** Returns `{status:'off'}`. No env check, no read, no `askChoices`.
  - **environment mismatch.** `assertEnvMatchesDatabase` rejects with an `EnvMismatchError`. Returns `skipped`, logs `[suggest] skipped: environment`, and makes no `askChoices` call and no write.
  - **only §14.2's rows reach the request.** Seed a picked row, a card payment, a `TRANSFER_OUT`, an `INCOME` row, a current-fingerprint suggested row, a stale-fingerprint suggested row and two plain spending rows. The ids sent to `askChoices` (question keys) are exactly the stale row and the two plain rows.
  - **newest first, and `limit`.** With 25 eligible rows and `limit: 21`, two `askChoices` calls are made, with 20 and 1 questions, and the first batch holds the 20 newest by `date` then `id`.
  - **writes.** The upsert payload per row is `{ transaction_id, household_id, category_id, confidence, catalog_fingerprint: contextFingerprint(ctx), model, created_at }`. It uses `onConflict: 'transaction_id'` and `count: 'exact'`, and `none` writes `category_id: null`.
  - **unknown choice (Review Focus 3).** One answer's `choice` is a name not in the context. That row is skipped, and the batch's other rows are written.
  - **a TypeSafe failure.** `askChoices` rejects. The job writes nothing for that batch, returns `failed`, logs `[suggest] failed`, and does not throw.
  - **an upsert error (Review Focus 4).** It has `{ code: '23503' }`. The run stops, returns `failed`, does not throw, and makes no further `askChoices` calls.
  - **a short count.** `count` is less than the batch's rows. Same as the upsert error.
  - **a category named none (Review Focus 2).** Returns `failed`, with no `askChoices` call.
  - **an unreadable transaction read.** The paged read returns an error. Returns `failed`, with no call and no write.
  - **examples.** The state's `household_examples` comes from `householdExamples(data, <picked rows from the same read>)`.

- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement** `lib/category-suggest.ts`, starting with `import 'server-only'`, in the order of spec §14.5:

```ts
export async function suggestCategories(householdId: string, { limit = 200 } = {}): Promise<SuggestOutcome> {
  let asked = 0, written = 0, inputTokens = 0
  try {
    if (!suggestionsEnabled()) return { status: 'off' }
    try { await assertEnvMatchesDatabase() } catch (e) {
      if (e instanceof EnvMismatchError) { console.warn('[suggest] skipped: environment'); return { status: 'skipped', reason: 'environment' } }
      throw e
    }
    const data = await fetchCategoryDataForHousehold(householdId)
    const ctx = buildCategoryContext(data)
    const fingerprint = contextFingerprint(ctx)
    const options = suggestionOptions(data)          // throws on a "none" category
    const read = await readAllRows(() => supabaseAdmin.from('transactions')
      .select(`id, date, amount, name, merchant_name, user_category, pfc_primary, pfc_detailed, ${SUGGESTION_EMBED}`)
      .eq('household_id', householdId).eq('removed', false))
    if (read.error) throw new Error(`could not read transactions: ${read.error.message}`)
    const examples = householdExamples(data, read.data.filter((t) => t.user_category))
    const due = read.data
      .filter((t) => suggestableRow(t, ctx) && (!t.suggestion || t.suggestion.catalog_fingerprint !== fingerprint))
      .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1))
      .slice(0, limit)
    const idByName = new Map(data.categories.map((c) => [c.name, c.id]))
    for (let i = 0; i < due.length; i += BATCH_SIZE) {
      const batch = due.slice(i, i + BATCH_SIZE)
      const res = await askChoices(buildBatchRequest(batch, options, examples))
      asked += batch.length
      inputTokens += res.usage.input_tokens
      const now = new Date().toISOString()
      const rows = batch.flatMap((t) => {
        const a = res.answers[t.id]
        const category_id = a.choice === NONE ? null : idByName.get(a.choice)
        if (category_id === undefined) return []   // not an option we offered: skip the row
        return [{ transaction_id: t.id, household_id: householdId, category_id, confidence: a.confidence,
          catalog_fingerprint: fingerprint, model: res.model, created_at: now }]
      })
      if (rows.length === 0) continue
      const { error, count } = await supabaseAdmin.from('category_suggestions')
        .upsert(rows, { onConflict: 'transaction_id', count: 'exact' })
      if (error) throw new Error(`could not write suggestions: ${error.code ?? ''} ${error.message}`)
      if (count !== rows.length) throw new Error(`wrote ${count} of ${rows.length} suggestions`)
      written += rows.length
    }
    console.log('[suggest] done', { householdId, asked, written, inputTokens })
    return { status: 'done', asked, written, inputTokens }
  } catch (e) {
    console.error('[suggest] failed', householdId, e instanceof Error ? e.message : String(e))
    return { status: 'failed', asked, written }
  }
}
```

Type the read's rows as `PickRow & { user_category: string | null; suggestion: SuggestionRef | null }` (a local type alias), so `suggestableRow` accepts them. Comment the sort: newest first, so the months the person looks at fill first.

- [ ] **Step 4: Tripwires** in `scripts/check-invariants.mjs`, each with a test in `tests/unit/check-invariants.test.ts` that matches the style of the neighbouring tests:
  - Add `lib/category-suggest.ts` to **no** allowlist for `category-read` or `rules-read`: it reads through `fetchCategoryDataForHousehold`, so it needs none. Add `lib/category-context.ts`'s new admin reads to nothing new, because that file is already allowed. Confirm with `npm run check:invariants`.
  - If the `transactions`-read check (#69) flags the job's read, confirm it is satisfied by `readAllRows`. It should be, because the check looks for that helper. If it is not, follow the check's documented escape and don't widen the rule.
  - Add a new `checkSuggestionWrites(files)`. Any `.from('category_suggestions')` chain containing `insert`, `upsert`, `update` or `delete` outside `lib/category-suggest.ts` is flagged with `check: 'suggestion-write'` and the message `'writes category_suggestions outside lib/category-suggest.ts, the one writer (#28 spec §14.9).'` Wire it into the script's main list next to `checkUserCategoryWrites`. The tests cover:
    - a write in `app/api/x/route.ts` is flagged;
    - the same write in `lib/category-suggest.ts` is not;
    - a read (`.select`) anywhere is not flagged.
  - `checkUserCategoryWrites` already scans every file, `lib/category-suggest.ts` included. Add a test that a `.from('transactions').update({ user_category: 'x' })` in `lib/category-suggest.ts` is flagged (§14.9's "tripwire 4 also covers").

- [ ] **Step 5: Run** `npx vitest run tests/unit/category-suggest.test.ts tests/unit/check-invariants.test.ts`, and then `npm run check:invariants`. All should pass.
- [ ] **Step 6: Commit** `git commit -m "Suggest categories with Jev after a sync's rows are stored (#28 PR 4, §14.5)"`.

---

### Task 7: Run after each sync; the marker; the Settings line

**Files:**
- Modify: `app/api/plaid/sync-transactions/route.ts`, `app/api/plaid/webhook/route.ts`
- Create: `components/SuggestedMarker.tsx`
- Modify: `components/ui/icons.tsx`, `components/TransactionRow.tsx`, `components/TransactionCard.tsx`, `lib/category-views.ts`, `app/(app)/settings/page.tsx`, `components/CategoryRulesCard.tsx`
- Test: `tests/unit/sync.test.ts` (or whichever file tests the sync-transactions route; find it with `grep -ln "sync-transactions" tests/unit`), a webhook test (create `tests/unit/webhook-suggest.test.ts` if none exists), `tests/unit/transaction-row.test.tsx`, `tests/unit/transaction-card.test.tsx`, `tests/unit/category-views.test.ts`, `tests/unit/category-rules-card.test.tsx`, `tests/unit/settings-page.test.tsx`

**Interfaces:**
- Consumes: `suggestCategories`, `changedBySuggestion`.
- Produces:
  - `SuggestedMarker({ category })`;
  - `suggestedText(category: string): string`;
  - `RuleCounts` stays as it is; `categoryUsage` returns `suggested: number` alongside `categories` and `rules`;
  - `CategoryRulesCard` gains the prop `suggestedCount: number | null`, where `null` means the switch is off and the line is hidden.

- [ ] **Step 1: Failing tests.**
  - **Sync route.** Mock `next/server`'s `after` to collect callbacks: `vi.mock('next/server', async (orig) => ({ ...(await orig()), after: (fn: () => unknown) => { afterFns.push(fn) } }))`. Mock `@/lib/category-suggest`. Then check:
    - after a normal sync, exactly one `after` callback is scheduled, and running it calls `suggestCategories('hh-1')`;
    - when `suggestCategories` **rejects** (despite its contract), the route's JSON response and status are identical to the case where it resolves, and no `plaid_items` update is attributable to it. Run the callback and `await` it inside `expect(...).resolves`/`.not.toThrow()`; the wrapper must swallow it;
    - when every bank's sync fails, the callback is still scheduled. That is harmless, because it only suggests for stored rows.
  - **Webhook.**
    - A `TRANSACTIONS`/`DEFAULT_UPDATE` webhook for a known item schedules `suggestCategories(item.household_id)`.
    - An `ITEM`/`ERROR` webhook schedules nothing.
    - An unknown item schedules nothing.
  - **Row.** `TransactionRow` with a resolved `{ source: 'suggestion', name: 'Grocery', bankName: 'Food & Drink' }` renders an element with `aria-label` `Grocery, suggested by Jev. Pick a category to change it.` and no link. When `name === bankName`, there is no marker. A rule row still shows the learned marker and no Jev marker.
  - **Card.** `TransactionCard` in the same suggestion case shows `Suggested by Jev.` with the icon.
  - **Views.** `categoryUsage(...).suggested` counts exactly the `changedBySuggestion` rows. Card payments are excluded, as for the category counts.
  - **Card copy.**
    - `suggestedCount={0}` renders `For merchants without a rule, Jev suggests a category. 0 transactions are filed by Jev.`
    - `1` renders `… 1 transaction is filed by Jev.`
    - `2` renders `… 2 transactions are filed by Jev.`
    - `null` renders no such line.
  - **Settings page.** It passes `suggestedCount` as `null` when `suggestionsOn` is false, and as the count when it is true.

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - **Sync route.** After the item loop, and before building the response, add:

```ts
  // Jev suggestions (#28 spec §14.5), once the response is sent. Never reaches this response,
  // its status or any bank's health: suggestCategories does not throw, and the catch is a backstop.
  after(() => suggestCategories(household_id).catch((e) => console.error('[suggest] failed', household_id, e instanceof Error ? e.message : String(e))))
```

  - **Webhook.** The same call, inside the `DATA_READY` branch after its try/catch, with `item.household_id`.
  - **`SuggestedIcon`** goes in `components/ui/icons.tsx`: a small sparkle in the existing icons' SVG style (same `IconProps`, stroke and `currentColor`).
  - **`SuggestedMarker`** goes in `components/SuggestedMarker.tsx`. It mirrors `LearnedMarker`'s sizing (h-[34px], shrink-0, text-faint) as a `<span role="img" title aria-label>` instead of a `Link`, and exports `suggestedText`.
  - **`TransactionRow`:** `{changedBySuggestion(category) && <SuggestedMarker category={category.name} />}` beside the learned marker. At most one of the two shows.
  - **`TransactionCard`:** a `suggested` line parallel to `learned`, `<SuggestedIcon/> Suggested by Jev.`, with `title={suggestedText(category.name)}`.
  - **`categoryUsage`:** count `changedBySuggestion(resolved)` into `suggested`.
  - **Settings page:** pass `suggestedCount={data.suggestionsOn ? counts.suggested : null}` through `CategorySettings`.
  - **`CategoryRulesCard`:** add a second `<p className="text-sm text-muted">` directly under the help text when `suggestedCount !== null`.
- [ ] **Step 4: Run** `npx vitest run`, which should be all green, and then `npx tsc --noEmit`, which should be clean.
- [ ] **Step 5: Commit** `git commit -m "Ask Jev after each sync; show the suggested marker and the Settings line (#28 PR 4, §14.5–§14.6)"`.

---

### Task 8: Gate, mutation checks, PR, Preview phone check

- [ ] **Step 1: Run the full gate**, one command at a time:
  - `npx vitest run`
  - `VITEST_TZ=America/Los_Angeles npx vitest run`
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npm run check:invariants`
  - `npm run check:secrets`
  - `npx next build`

  All must pass.

- [ ] **Step 2: Mutation table.** For each guard: revert it, run the named test file, confirm that a named test fails, then restore it. Record each one in the PR body.

| # | Mutation | Must fail |
| --- | --- | --- |
| 1 | drop `st.suggestionsOn &&` in step 5 | category-rules: "ignores every suggestion with the switch off" |
| 2 | drop the fingerprint comparison | "ignores a stale fingerprint" |
| 3 | `>=` → `>` against the threshold | "applies at exactly the threshold" |
| 4 | drop `ruleFits` in step 5 | "never applies across kinds" + money property |
| 5 | move step 5 before the rule | "a rule beats a suggestion" |
| 6 | drop `!Array.isArray(s)` | "tolerates an array-shaped embed" |
| 7 | `suggestableRow` without the card-payment test | suggestableRow "refuses a card payment" + job "only §14.2's rows" |
| 8 | `suggestionsEnabled` → `!!process.env.CATEGORY_SUGGESTIONS` | category-context "only for exactly 'on'" |
| 9 | job: remove the env guard | job "environment mismatch" |
| 10 | job: remove the `count !== rows.length` check | job "a short count" |
| 11 | job: write a row for an unknown choice | job "unknown choice" |
| 12 | typesafe: drop 529 from the retry set | "retries on 529" |
| 13 | sync route: drop the `.catch` | sync "rejecting suggestCategories" |
| 14 | `suggestionOptions` without the "none" guard | "throws on a spending category named none" |

- [ ] **Step 3: Push the branch and open the PR.**
  - Title: `Category learning, PR 4: Jev suggestions, behind CATEGORY_SUGGESTIONS (#28)`.
  - The body covers:
    - the summary;
    - the deviations list from this plan;
    - the mutation table;
    - test counts;
    - the **launch sequence** below, as a checklist.

- [ ] **Step 4: Preview phone check.** This is a real UI change, so it needs the owner's phone check before merge.
  - Set `CATEGORY_SUGGESTIONS=on` for **Preview only** in Vercel.
  - In the SQL editor, seed three suggestions for real unpicked grocery rows, with the fingerprint computed by `catalogFingerprint` over the live categories (a one-off `npx tsx` script that reads categories with the service role and prints the fingerprint), at confidence 0.95.
  - Production ignores them: its switch is unset and its code doesn't read the table.
  - Hand the Preview URL to the owner. After the check, `delete from public.category_suggestions where model = 'preview-check';` (seed with `model = 'preview-check'`).

**Launch sequence (in the PR body, run after merge):**
1. Deploy with `CATEGORY_SUGGESTIONS` unset in production. Spent, Income and Saved should be unchanged, because nothing is read while the switch is off.
2. **Launch check (§14.8).** Write a throwaway script in the scratchpad, never committed, that imports `lib/category-suggest-request.ts` and calls TypeSafe directly. It is read-only on the database. It reports:
   - agreement with the hand picks, each merchant held out;
   - every unpicked row that would change, with its confidence;
   - batched answers against single answers on 40 rows;
   - the number of rows that would change at 0.80, 0.90 and 0.95;
   - tokens per row, and latency at p50 and p95.

   Send the report to the owner.
3. The owner picks the threshold. A one-line PR sets `SUGGESTION_THRESHOLD`; merge it.
4. Set `CATEGORY_SUGGESTIONS=on` in production, run Refresh once, and confirm `[suggest] done` in the logs. Compare Spent, Income and Saved for all months before and after, to the cent.
5. Rollback is to unset `CATEGORY_SUGGESTIONS` and redeploy.

---

## Self-review notes

- **Spec coverage:**
  - §14.2 → Tasks 2 (`suggestableRow`) and 4.
  - §14.3 → Task 2.
  - §14.4 → Task 1.
  - §14.5 → Tasks 5, 6 and 7.
  - §14.6 → Task 7.
  - §14.7 → Tasks 2, 3 and 6.
  - §14.8 → Task 8's launch sequence.
  - §14.9 → every item has a test in Tasks 2–7. The pages bullet is Task 3, and the invariants bullet is Task 6.
- **Types are consistent:**
  - `SuggestionRef`, `suggestion`, `suggestionsOn` and `SUGGESTION_EMBED` are used identically across Tasks 2, 3 and 6.
  - `ChoiceQuestion` is defined in Task 4 and imported by Task 5.
