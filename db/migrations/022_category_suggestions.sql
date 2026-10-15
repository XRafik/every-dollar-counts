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
