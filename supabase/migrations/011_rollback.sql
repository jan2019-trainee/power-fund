-- ===========================================================================
-- Migration 011 — ROLLBACK
--
-- Puts back the single `open_all` policy on every table, so the app works
-- again from any browser with the anon key — including one running
-- AUTH_MODE = "off".
--
-- WHAT THIS COSTS
--   Everything 011 bought. After this, anyone with the site URL can read AND
--   WRITE every table again: confirm payments, release payouts, edit the
--   roster, rewrite the activity log. It is the pre-011 status quo, which the
--   README has always described honestly — but do not leave it here longer
--   than it takes to fix whatever went wrong.
--
--   The PIN vault (migration 010) is NOT touched. The PINs stay out of the
--   browser either way; that protection is independent of these policies.
--
-- AFTER RUNNING THIS
--   Set AUTH_MODE back to "off" (or "optional") in js/config.js and redeploy,
--   or members will still be facing a sign-in gate in front of an app that no
--   longer needs one.
--
-- SAFE TO RE-RUN.
-- ===========================================================================

begin;

-- 1) Drop 011's policies. Named individually rather than by a catch-all, so
--    this cannot silently remove a policy somebody adds later.
drop policy if exists members_read            on members;
drop policy if exists members_self_write      on members;
drop policy if exists members_treasurer       on members;

drop policy if exists cycles_read             on cycles;
drop policy if exists cycles_treasurer        on cycles;

drop policy if exists contributions_read        on contributions;
drop policy if exists contributions_self        on contributions;
drop policy if exists contributions_self_update on contributions;
drop policy if exists contributions_treasurer   on contributions;

drop policy if exists payouts_read           on payouts;
drop policy if exists payouts_treasurer      on payouts;

drop policy if exists activity_read          on activity_log;
drop policy if exists activity_append        on activity_log;
drop policy if exists activity_treasurer     on activity_log;

drop policy if exists settings_read          on app_settings;
drop policy if exists settings_treasurer     on app_settings;

-- 2) Restore `open_all`, exactly as schema.sql creates it.
do $$
declare
  t text;
begin
  foreach t in array array['members','cycles','contributions','payouts','activity_log','app_settings']
  loop
    execute format('drop policy if exists "open_all" on %I;', t);
    execute format(
      'create policy "open_all" on %I for all to anon, authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- 3) Storage back to open read/write for anon and authenticated.
--
-- The policy names are NOT derivable from the bucket id: schema.sql calls the
-- payment-proofs ones `proofs_*`, not `payment_proofs_*`. An earlier version
-- of this file derived them, which left a second set of permissive
-- `payment_proofs_*` policies behind that 011 did not know to drop — so after
-- a rollback-then-reapply, anon still had insert/update/delete on that bucket
-- and the lockdown was quietly undone for it. Hence an explicit mapping.
do $$
declare
  spec text[][] := array[
    array['payment-proofs',  'proofs'],
    array['payment-assets',  'payment_assets'],
    array['member-avatars',  'member_avatars']
  ];
  i int;
  b text;
  p text;
begin
  for i in 1 .. array_length(spec, 1) loop
    b := spec[i][1];
    p := spec[i][2];
    execute format('drop policy if exists %I on storage.objects;', p || '_read');
    execute format('drop policy if exists %I on storage.objects;', p || '_write');
    execute format('drop policy if exists %I on storage.objects;', p || '_update');
    execute format('drop policy if exists %I on storage.objects;', p || '_delete');
    execute format(
      'create policy %I on storage.objects for select to anon, authenticated using (bucket_id = %L);',
      p || '_read', b);
    execute format(
      'create policy %I on storage.objects for insert to anon, authenticated with check (bucket_id = %L);',
      p || '_write', b);
    execute format(
      'create policy %I on storage.objects for update to anon, authenticated using (bucket_id = %L) with check (bucket_id = %L);',
      p || '_update', b, b);
    execute format(
      'create policy %I on storage.objects for delete to anon, authenticated using (bucket_id = %L);',
      p || '_delete', b);
  end loop;
end $$;

-- Remove the stale derived spelling, in case an older run of this file created
-- it. Leaving it behind is what caused the bug described above.
drop policy if exists payment_proofs_read   on storage.objects;
drop policy if exists payment_proofs_write  on storage.objects;
drop policy if exists payment_proofs_update on storage.objects;
drop policy if exists payment_proofs_delete on storage.objects;

commit;

-- VERIFY — one open_all per table, and nothing of 011's left:
--
--   select tablename, policyname from pg_policies
--   where schemaname = 'public' order by tablename, policyname;
