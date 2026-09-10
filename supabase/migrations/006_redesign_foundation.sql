-- ===========================================================================
-- Migration 006 — Redesign foundation
--
-- WHAT IT DOES
--   One migration carrying every column the approved redesign needs, so the
--   database is opened once rather than five times. Six independent changes:
--
--   1. REJECTED PAYMENTS  (contributions)
--        status now allows 3 = rejected
--        rejection_note  text         -- the treasurer's reason, shown to the member
--        rejected_at     timestamptz  -- when it was rejected
--      Today a rejection DELETES the contribution row. The redesign keeps the
--      record and shows the member why, with a Resubmit action.
--
--   2. MASTER PIN  (app_settings)
--        master_pin      text         -- static recovery PIN, set once by hand
--      A forgotten treasurer PIN currently has no recovery: the reset that
--      would fix it is reachable only from Menu, which requires being
--      unlocked, and it preserves the PIN anyway. See "MASTER PIN" below.
--
--   3. FUND NAME  (app_settings)
--        fund_name       text         -- e.g. "ViTAMiN Fund 2027"
--      The header hardcodes "Power Fund"; every artboard shows a named fund.
--
--   4. TREASURER QR ACCOUNT DETAILS  (app_settings)
--        qr_bank            text      -- "GCash", "Maya", "BPI", ...
--        qr_account_number  text
--        qr_account_name    text
--      The design splits the single free-text account label into the three
--      fields a real GCash/bank QR actually carries — the same trio migration
--      005 already added to `members` for member payout QRs.
--
--   5. TYPED ACTIVITY EVENTS  (activity_log)
--        event_type      text          -- "payment" | "payout" | "admin" | ...
--        amount          numeric(10,2) -- signed peso amount, when one applies
--        ref_status      smallint      -- resulting contribution status, when one applies
--      The Activity screen shows an amount column and a status chip per row.
--      Neither is recoverable from the free-text `message`, which the app
--      currently regex-matches to infer a category (js/app.js activityCategory).
--
--   6. RESERVED: MEMBER AVATAR  (members)
--        avatar_url      text
--      Profile photos are OUT of the current scope. The column is added now
--      because it is free to add here and awkward to add later. Nothing reads
--      or writes it yet.
--
-- WHAT IT DOES NOT DO
--   * Does not change any ROSCA rule. Contribution amount, cycles per round,
--     round count, the 30,000 round goal and the 150,000 target are constants
--     in js/calculations.js and are untouched.
--   * Does not change how funding is derived. Round funding still comes from
--     CONFIRMED contributions only (status 2). See "STATUS 3" below.
--   * Does not change RLS. Every table already carries the open_all policy
--     from schema.sql; new columns inherit it. No policy is added or altered.
--   * Does not seed master_pin. That is a manual step — see below.
--   * Does not fix the stale-payout-data bug in resetAll() (js/database.js).
--     That is application code, handled separately.
--
-- SAFETY
--   * Only ADDS columns. Every new column is nullable with no default.
--   * The one constraint it replaces is WIDENED (status gains the value 3),
--     so no existing row can be rejected by it.
--   * Safe to run more than once.
--   * No data is deleted, rewritten or backfilled.
--
-- HOW TO RUN
--   Supabase dashboard -> SQL Editor -> New query -> paste this file -> Run.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Rejected payments
-- ---------------------------------------------------------------------------
-- STATUS 3 — the contract the application must honour:
--   0 unpaid    -> owed, nothing submitted
--   1 pending   -> submitted, awaiting the treasurer  (must carry a proof)
--   2 paid      -> confirmed by the treasurer         (the ONLY status that is money)
--   3 rejected  -> submitted and refused              (must carry a proof)
--
-- Status 3 is NOT money. Every calculation that sums or counts collected
-- pesos must treat it exactly as it treats status 0 — totalCollected,
-- roundCollected, cycleTotal, paidCountForCycle, progressPercent*,
-- isRoundFunded. A rejected cycle also remains OVERDUE if past its due date:
-- rejecting a claim must never quietly excuse the member from paying it.

-- The status check is created inline by schema.sql, so its name is whatever
-- Postgres auto-generated. Drop whichever check constrains `status` values,
-- while leaving the pending-requires-proof rule (it names proof_url) intact.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
     where rel.relname = 'contributions'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%status%'
       and pg_get_constraintdef(con.oid) not ilike '%proof_url%'
  loop
    execute format('alter table contributions drop constraint %I;', c.conname);
  end loop;
end $$;

alter table contributions
  add constraint contributions_status_check
  check (status in (0, 1, 2, 3));

alter table contributions add column if not exists rejection_note text;
alter table contributions add column if not exists rejected_at    timestamptz;

-- A rejected claim always descends from a pending one, and a pending one
-- always carries a screenshot — so a rejected row must keep its proof too.
-- The member and the treasurer need to be looking at the same image when
-- they discuss it.
--
-- IMPLEMENTATION NOTE: preserveProof() in js/app.js currently MOVES the
-- screenshot to archive/ on rejection and does not update proof_url, which is
-- harmless today only because the row is being deleted. Once the row
-- survives, archiving on reject would leave proof_url pointing at a file that
-- has moved. Rejection must keep the screenshot where it is.
alter table contributions
  drop constraint if exists contributions_pending_requires_proof;

alter table contributions
  add constraint contributions_pending_requires_proof
  check (status not in (1, 3) or proof_url is not null);


-- ---------------------------------------------------------------------------
-- 2. Master PIN
-- ---------------------------------------------------------------------------
-- WHY
--   If everyone who knows the treasurer PIN forgets it, treasurer mode is
--   currently unreachable forever: no confirming payments, no releasing
--   payouts, no exports. The master PIN is a static second PIN that always
--   unlocks treasurer mode, so the group can then set a new treasurer_pin
--   through the normal Change PIN flow.
--
-- WHAT IT IS NOT
--   Not a security control, and neither is treasurer_pin. This database is
--   open read/write to anyone holding the site URL and the anon key, and both
--   are published in the repository (js/config.js). Anyone determined can
--   already read either PIN, or skip the UI and write to these tables
--   directly. These PINs prevent accidents, not attackers — see README
--   "Security limitations". Adding this column does not change that posture.
--
-- SET IT BY HAND, ONCE
--   Choose a value, write it down somewhere outside the app, and run the
--   statement below with your own digits. It is deliberately left commented
--   out so that no real PIN is ever committed to a public repository.
--
--     update app_settings set master_pin = '<your-digits>' where id = 1;
--
--   Rotate it the same way at any time. Leave it null to opt out entirely —
--   the app treats a null master_pin as "no master PIN configured" and the
--   lockout risk simply remains as it is today.
--
-- APPLICATION NOTES
--   * The unlock must remember WHICH pin was used. Change PIN is a three-step
--     wizard beginning with "enter your current PIN" — precisely what a
--     locked-out treasurer does not have — so that first step must be skipped
--     when entry was via the master PIN. Otherwise this column solves nothing.
--   * Every master-PIN unlock should be written to activity_log, the same way
--     migration 005 makes payout-QR changes visible after the fact.
--   * The master PIN is never displayed, changed or removed from inside the
--     app. The app only ever compares against it.
alter table app_settings add column if not exists master_pin text;


-- ---------------------------------------------------------------------------
-- 3. Fund name
-- ---------------------------------------------------------------------------
-- Null falls back to the current hardcoded title, so the app is correct
-- before and after this is set.
--     update app_settings set fund_name = 'ViTAMiN Fund 2027' where id = 1;
alter table app_settings add column if not exists fund_name text;


-- ---------------------------------------------------------------------------
-- 4. Treasurer payment-QR account details
-- ---------------------------------------------------------------------------
-- Mirrors the payout_bank / payout_account_number / payout_account_name trio
-- migration 005 added to `members`. A QR image is opaque; the typed account
-- name is what actually lets a member verify they are paying the right person.
alter table app_settings add column if not exists qr_bank           text;
alter table app_settings add column if not exists qr_account_number text;
alter table app_settings add column if not exists qr_account_name   text;


-- ---------------------------------------------------------------------------
-- 5. Typed activity events
-- ---------------------------------------------------------------------------
-- All nullable on purpose: rows written before this migration have no typed
-- data, and the Activity view must degrade to message-only for them rather
-- than rendering an empty amount column. New writes should populate these at
-- every logActivity() call site, which then retires the message-regex in
-- activityCategory().
--
-- amount is SIGNED — a confirmation is +1000, a reverted confirmation -1000,
-- a payout 30000 — and is a display value only. It never feeds any funding
-- calculation; those read the contributions table.
alter table activity_log add column if not exists event_type text;
alter table activity_log add column if not exists amount     numeric(10,2);
alter table activity_log add column if not exists ref_status smallint;


-- ---------------------------------------------------------------------------
-- 6. Reserved — member avatar
-- ---------------------------------------------------------------------------
-- Out of scope for the current redesign. Added now only because adding a
-- nullable column later is more disruptive than adding it here. If profile
-- photos are ever built they reuse the existing public `payment-assets`
-- bucket, as the payout QRs already do.
alter table members add column if not exists avatar_url text;


-- ---------------------------------------------------------------------------
-- Check
-- ---------------------------------------------------------------------------
-- Columns:
--   select table_name, column_name, data_type
--     from information_schema.columns
--    where (table_name = 'contributions' and column_name in ('rejection_note','rejected_at'))
--       or (table_name = 'app_settings'  and column_name in ('master_pin','fund_name','qr_bank','qr_account_number','qr_account_name'))
--       or (table_name = 'activity_log'  and column_name in ('event_type','amount','ref_status'))
--       or (table_name = 'members'       and column_name = 'avatar_url')
--    order by table_name, column_name;
--
-- Constraints (expect status in (0,1,2,3) and the widened proof rule):
--   select con.conname, pg_get_constraintdef(con.oid)
--     from pg_constraint con
--     join pg_class rel on rel.oid = con.conrelid
--    where rel.relname = 'contributions' and con.contype = 'c';
--
-- Nothing was rejected by the widened status check (expect 0 rows changed and
-- the same totals as before):
--   select status, count(*) from contributions group by status order by status;
