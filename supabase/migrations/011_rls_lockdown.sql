-- ===========================================================================
-- Migration 011 — RLS lockdown  ***THE POINT OF NO RETURN***
--
-- Replaces every `open_all` policy with real per-member rules. After this,
-- Postgres — not JavaScript being polite — decides who may write what.
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE PASTING
--
--   1. Run 011_preflight.sql first. Every row must say ok = true. This script
--      calls the same check and ABORTS if anything is outstanding, so a
--      mistimed paste cannot lock the group out.
--
--   2. `anon` loses ALL access. The app therefore only works with
--      AUTH_MODE = "required" in js/config.js. Deploy that change and this
--      migration together — either one alone leaves the app broken:
--        * migration without the deploy -> every member sees a load error
--        * deploy without the migration -> the gate is up but nothing is
--          actually protected (harmless, just pointless)
--
--   3. Have 011_rollback.sql open in another tab.
-- ---------------------------------------------------------------------------
--
-- WHAT THE RULES ARE
--
--   Everyone signed in can READ everything. This fund is transparent by
--   design: the whole point of the cycle grid is that all five see who has
--   paid. Reads were never the risk.
--
--   Writes are where it changes:
--     members        own row only (name, photo, payout fields — column rules
--                    live in 010's guard trigger); treasurer may edit anyone
--     contributions  own rows only, and only into status 0/1 with a proof for
--                    1. **Status 2 is treasurer-only** — confirming money is
--                    the treasurer's act and nobody else's. Status 3 likewise.
--     cycles         treasurer only
--     payouts        treasurer only
--     activity_log   insert only, by anyone signed in. NO update policy at
--                    all, ever: an audit trail that can be edited is not one.
--                    Delete is treasurer-only because Reset All Data needs it.
--     app_settings   read all, write treasurer
--
--   That is the same behaviour the app has always had. The difference is that
--   it is now enforced against someone using the anon key directly, which was
--   the entire hole.
--
-- WHAT IT DOES NOT DO
--   * Does not change any ROSCA rule. Contribution amount, cycles per round,
--     round count, the 30,000 round goal and the 150,000 target are constants
--     in js/calculations.js and are untouched.
--   * Does not touch the PIN vault (010) or any table's columns.
--   * Does not change how round funding is derived. Still the sum of confirmed
--     contributions.
--   * Writes no data.
--
-- SAFE TO RE-RUN. Every policy is dropped and recreated.
-- ROLLBACK: supabase/migrations/011_rollback.sql
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0) Preflight. Abort unless the fund is ready.
--
-- To override deliberately — for a fund that is genuinely meant to run with
-- unlinked members — run this first, in the same session:
--
--     select set_config('pf.allow_unready', 'yes', false);
--
-- Do not do that to "get past" the error. The error is the feature.
-- ---------------------------------------------------------------------------
do $$
declare
  problems text;
begin
  if to_regprocedure('public.pf_rls_readiness()') is null then
    raise exception
      'Run 011_preflight.sql first — it creates the readiness check this migration needs.';
  end if;

  select string_agg(check_name || ' (' || detail || ')', '; ')
    into problems
  from pf_rls_readiness() where not ok;

  if problems is not null then
    if coalesce(current_setting('pf.allow_unready', true), '') = 'yes' then
      raise warning 'PREFLIGHT FAILED but pf.allow_unready is set — continuing: %', problems;
    else
      raise exception E'NOT READY — refusing to lock down.\n  %\n\nFix these, or see the override note in this file.', problems;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1) Out with the old. Every table had one policy called "open_all" that said
--    `using (true) with check (true)` to anon and authenticated alike.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['members','cycles','contributions','payouts','activity_log','app_settings']
  loop
    execute format('drop policy if exists "open_all" on %I;', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2) members
--
-- Column-level rules are NOT here — they cannot be. RLS decides rows; 010's
-- members_guard trigger decides columns, and it is what stops a member setting
-- their own is_treasurer or member_order through this very policy.
-- ---------------------------------------------------------------------------
drop policy if exists members_read       on members;
drop policy if exists members_self_write on members;
drop policy if exists members_treasurer  on members;

create policy members_read on members
  for select to authenticated using (true);

create policy members_self_write on members
  for update to authenticated
  using (id = pf_member_id())
  with check (id = pf_member_id());

create policy members_treasurer on members
  for all to authenticated
  using (pf_is_treasurer())
  with check (pf_is_treasurer());

-- ---------------------------------------------------------------------------
-- 3) cycles — the schedule is the treasurer's to set.
-- ---------------------------------------------------------------------------
drop policy if exists cycles_read      on cycles;
drop policy if exists cycles_treasurer on cycles;

create policy cycles_read on cycles
  for select to authenticated using (true);

create policy cycles_treasurer on cycles
  for all to authenticated
  using (pf_is_treasurer())
  with check (pf_is_treasurer());

-- ---------------------------------------------------------------------------
-- 4) contributions — THE MONEY TABLE
--
-- A member may claim ("I've sent this", status 1, proof required) and may
-- resubmit a rejected cycle. A member may NOT confirm their own payment:
-- status 2 is what counts toward a round's funding, and only the treasurer
-- writes it. Status 3 (rejected) is the treasurer's verdict, likewise.
--
-- `using` governs the row as it stands, `with check` the row as it would be —
-- both are needed, or a member could move a CONFIRMED row back to pending.
-- ---------------------------------------------------------------------------
drop policy if exists contributions_read      on contributions;
drop policy if exists contributions_self      on contributions;
drop policy if exists contributions_treasurer on contributions;

create policy contributions_read on contributions
  for select to authenticated using (true);

create policy contributions_self on contributions
  for insert to authenticated
  with check (
    member_id = pf_member_id()
    and status in (0, 1)
    and (status <> 1 or proof_url is not null)
  );

-- A separate policy for update so `using` can exclude status 2: a member may
-- act on their unpaid, pending or rejected row, never on a confirmed one.
drop policy if exists contributions_self_update on contributions;
create policy contributions_self_update on contributions
  for update to authenticated
  using (member_id = pf_member_id() and status in (0, 1, 3))
  with check (
    member_id = pf_member_id()
    and status in (0, 1)
    and (status <> 1 or proof_url is not null)
  );

create policy contributions_treasurer on contributions
  for all to authenticated
  using (pf_is_treasurer())
  with check (pf_is_treasurer());

-- ---------------------------------------------------------------------------
-- 5) payouts — releasing money is treasurer-only, start to finish.
-- ---------------------------------------------------------------------------
drop policy if exists payouts_read      on payouts;
drop policy if exists payouts_treasurer on payouts;

create policy payouts_read on payouts
  for select to authenticated using (true);

create policy payouts_treasurer on payouts
  for all to authenticated
  using (pf_is_treasurer())
  with check (pf_is_treasurer());

-- ---------------------------------------------------------------------------
-- 6) activity_log — append-only.
--
-- There is deliberately NO update policy. Not for the treasurer either: an
-- audit trail somebody can edit is not an audit trail. Delete is granted to
-- the treasurer only because Reset All Data clears the log, and that action
-- already confirms twice in the UI.
-- ---------------------------------------------------------------------------
drop policy if exists activity_read      on activity_log;
drop policy if exists activity_append    on activity_log;
drop policy if exists activity_treasurer on activity_log;

create policy activity_read on activity_log
  for select to authenticated using (true);

create policy activity_append on activity_log
  for insert to authenticated with check (true);

create policy activity_treasurer on activity_log
  for delete to authenticated using (pf_is_treasurer());

-- ---------------------------------------------------------------------------
-- 7) app_settings — the fund name, the payment QR, the QR account details.
--    Readable by everyone (members need the QR); writable by the treasurer.
--    The PINs are not here any more; they are in app_secrets, unreachable.
-- ---------------------------------------------------------------------------
drop policy if exists settings_read      on app_settings;
drop policy if exists settings_treasurer on app_settings;

create policy settings_read on app_settings
  for select to authenticated using (true);

create policy settings_treasurer on app_settings
  for all to authenticated
  using (pf_is_treasurer())
  with check (pf_is_treasurer());

-- ---------------------------------------------------------------------------
-- 8) Storage
--
-- Reads stay open: all three buckets are public, their URLs are already
-- embedded in rows every member can read, and the treasurer has to be able to
-- open a proof image. Writes now need a session.
--
-- Avatars are additionally scoped to the caller's own folder, which works
-- because js/database.js stores them at `<memberId>/<timestamp>.jpg`.
-- ---------------------------------------------------------------------------
drop policy if exists "proofs_write"  on storage.objects;
drop policy if exists "proofs_update" on storage.objects;
drop policy if exists "proofs_delete" on storage.objects;
-- Also the derived spelling an older 011_rollback.sql used to create. Without
-- these drops a rollback-then-reapply left anon with insert/update/delete on
-- payment-proofs, silently undoing the lockdown for that bucket.
drop policy if exists payment_proofs_read   on storage.objects;
drop policy if exists payment_proofs_write  on storage.objects;
drop policy if exists payment_proofs_update on storage.objects;
drop policy if exists payment_proofs_delete on storage.objects;

create policy "proofs_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-proofs');
create policy "proofs_update" on storage.objects for update to authenticated
  using (bucket_id = 'payment-proofs') with check (bucket_id = 'payment-proofs');
-- Archiving a rejected proof moves it; the treasurer's confirm/reject path
-- also tidies old files. Both are treasurer actions.
create policy "proofs_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'payment-proofs' and pf_is_treasurer());

drop policy if exists "payment_assets_write"  on storage.objects;
drop policy if exists "payment_assets_update" on storage.objects;
drop policy if exists "payment_assets_delete" on storage.objects;

-- The payment QR and payout receipts. Treasurer-managed, so treasurer-only.
create policy "payment_assets_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-assets' and pf_is_treasurer());
create policy "payment_assets_update" on storage.objects for update to authenticated
  using (bucket_id = 'payment-assets' and pf_is_treasurer())
  with check (bucket_id = 'payment-assets' and pf_is_treasurer());
create policy "payment_assets_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'payment-assets' and pf_is_treasurer());

drop policy if exists "member_avatars_write"  on storage.objects;
drop policy if exists "member_avatars_update" on storage.objects;
drop policy if exists "member_avatars_delete" on storage.objects;

create policy "member_avatars_write" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'member-avatars'
    and (storage.foldername(name))[1] = pf_member_id()::text
  );
create policy "member_avatars_update" on storage.objects for update to authenticated
  using (
    bucket_id = 'member-avatars'
    and (storage.foldername(name))[1] = pf_member_id()::text
  )
  with check (
    bucket_id = 'member-avatars'
    and (storage.foldername(name))[1] = pf_member_id()::text
  );
create policy "member_avatars_delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'member-avatars'
    and ((storage.foldername(name))[1] = pf_member_id()::text or pf_is_treasurer())
  );


commit;

-- VERIFY — after this, and after deploying AUTH_MODE = "required":
--
--   -- the policies that now exist, per table:
--   select tablename, policyname, cmd, roles
--   from pg_policies where schemaname = 'public'
--   order by tablename, policyname;
--
--   -- and nothing named open_all survives:
--   select count(*) as open_all_left from pg_policies where policyname = 'open_all';
--
-- Then, in the app: sign in as a NON-treasurer and confirm that
--   * the cycle grid still shows everyone's status (reads work)
--   * "I've sent this" still works (own claim, status 1)
--   * treasurer mode's confirm button fails if you force it (status 2 refused)
