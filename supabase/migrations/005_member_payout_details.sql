-- ===========================================================================
-- Migration 005 — Member payout details
--
-- WHAT IT DOES
--   Adds five nullable columns to `members` so the treasurer can record where
--   each member's payout should be sent:
--       payout_qr_url        text  -- public URL of that member's receiving QR
--       payout_bank          text  -- "GCash", "Maya", "BPI", ...
--       payout_account_name  text  -- name on the account, for verification
--       payout_account_number text -- account / mobile number, for verification
--       payout_updated_at    timestamptz
--
--   The QR image itself lives in the existing `payment-assets` bucket that
--   migration 003/004 already create — no new bucket is needed.
--
-- WHY
--   Releasing a payout meant reading the destination off a chat message. With
--   these, the release screen can show the recipient's QR and account details
--   side by side, so the treasurer can check the name matches the person
--   before sending ₱30,000.
--
--   account_name and account_number matter as much as the QR: a QR image is
--   opaque, so the typed name is what actually lets a treasurer verify who
--   they are about to pay.
--
-- WHO CAN SET IT
--   The app only exposes this in treasurer mode. Note that this is a UI gate,
--   not enforcement: as documented in README ("Security limitations"), this
--   database is open read/write to anyone holding the site URL, so the columns
--   below are no more protected than any other. Every change is written to the
--   activity log so a swapped QR is at least visible after the fact.
--
-- SAFETY
--   * Only ADDS columns. Drops nothing. Every new column is nullable.
--   * Touches no contribution, cycle, payout or round logic.
--   * Safe to run more than once (add column if not exists).
--
-- HOW TO RUN
--   Supabase dashboard -> SQL Editor -> New query -> paste this file -> Run.
-- ===========================================================================

alter table members add column if not exists payout_qr_url         text;
alter table members add column if not exists payout_bank           text;
alter table members add column if not exists payout_account_name   text;
alter table members add column if not exists payout_account_number text;
alter table members add column if not exists payout_updated_at     timestamptz;

-- The payout QR shares the bucket the payment QR already uses. This block is
-- identical to migration 003/004's and is repeated only so 005 can be run on
-- its own; it is idempotent either way.
insert into storage.buckets (id, name, public)
values ('payment-assets', 'payment-assets', true)
on conflict (id) do update set public = true;

-- ---------------------------------------------------------------------------
-- Check
-- ---------------------------------------------------------------------------
-- select column_name from information_schema.columns
--  where table_name = 'members' and column_name like 'payout_%';
