-- ===========================================================================
-- Migration 008 — Member accounts (schema only)
--
-- WHAT IT DOES
--   Adds three nullable-or-defaulted columns to `members` so a roster row can
--   be tied to a real login:
--
--        auth_user_id  uuid     -- the auth.users row that owns this member
--        email         text     -- the address the treasurer expects them to use
--        is_treasurer  boolean  -- the role, in the database rather than a PIN
--
--   ...plus a case-insensitive unique index on email.
--
-- WHY
--   Identity today is `localStorage.pf_my_member_id` (js/app.js) — a per-device
--   display preference with nothing behind it. Treasurer mode is a shared PIN
--   in app_settings that every client reads in plaintext. RLS is a single
--   `open_all` policy. So there are no users to distinguish, which is exactly
--   what schema.sql's own comments say.
--
--   The approved design does not cover this: canvas.json's `forgot-pin-notes`
--   states the limitation outright ("with no server or account to verify
--   identity, anyone with the device can trigger this"). Member accounts are a
--   NEW FEATURE beyond the mockups, taken as a product decision.
--
--   `auth_user_id` is UNIQUE so one login maps to exactly one member — without
--   it, two roster rows could claim the same person and "who am I" would have
--   two answers. `on delete set null` means deleting an auth user unlinks the
--   member and keeps every contribution, payout and log row intact; a cascade
--   here would delete financial history, which must never follow from an
--   account deletion.
--
--   Email uniqueness is on lower(email), not email. Google hands back the
--   address as the user typed it once, so a plain unique constraint would let
--   both 'Ana@gmail.com' and 'ana@gmail.com' sit on the roster and the login
--   match would depend on capitalisation.
--
-- WHAT IT DOES NOT DO
--   * Does not touch RLS. Every table keeps the `open_all` policy from
--     schema.sql, so this migration cannot lock anyone out. Tightening RLS is
--     a later, separate migration with its own rollback.
--   * Does not move the PINs. `app_settings.treasurer_pin` and `master_pin`
--     are still readable by the client. That is a known P0 and the reason the
--     RLS pass exists; it is deliberately not bundled in here.
--   * Does not change any ROSCA rule. Contribution amount, cycles per round,
--     round count, the 30,000 round goal and the 150,000 target are constants
--     in js/calculations.js and are untouched.
--   * Does not create, delete or rename members, and writes no member data.
--   * Does not make anyone a treasurer. is_treasurer defaults to false for
--     everyone, including existing rows — see the one-off below.
--
-- SAFE TO RE-RUN
--   Every statement is `if not exists`. Running it twice changes nothing, and
--   it never overwrites a value that is already set.
-- ===========================================================================

alter table members add column if not exists auth_user_id uuid unique
  references auth.users(id) on delete set null;

alter table members add column if not exists email text;

alter table members add column if not exists is_treasurer boolean not null default false;

-- Case-insensitive, and only over rows that actually have an address, so the
-- four members whose email is still null do not collide with each other.
create unique index if not exists members_email_lower_idx
  on members (lower(email)) where email is not null;

-- ---------------------------------------------------------------------------
-- ONE-OFF, BY HAND — this migration deliberately does not guess either of
-- these. Run them once in the SQL editor, editing the values.
--
-- 1. The five addresses. A login is matched to a member by email, so a member
--    with no email here can never link. Use the exact Google account address.
--
--      update members set email = 'ana@example.com'   where member_order = 1;
--      update members set email = 'ben@example.com'   where member_order = 2;
--      update members set email = 'cathy@example.com' where member_order = 3;
--      update members set email = 'dan@example.com'   where member_order = 4;
--      update members set email = 'elena@example.com' where member_order = 5;
--
-- 2. The treasurer. Nobody holds the role until this is set, and a fund with
--    no treasurer cannot confirm a payment once RLS is tightened later.
--
--      update members set is_treasurer = true where email = 'you@example.com';
--
-- VERIFY — this should list five rows, each with an email, exactly one of them
-- flagged as treasurer, and auth_user_id null until that person first signs in:
--
--      select member_order, name, email, is_treasurer, auth_user_id
--      from members order by member_order;
-- ---------------------------------------------------------------------------
