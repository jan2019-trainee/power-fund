-- ===========================================================================
-- Migration 001 — Require proof of payment for pending contributions
--
-- Run this in the Supabase SQL editor if your database was created BEFORE this
-- change (i.e. you already ran the old schema.sql). Fresh installs get the
-- constraint straight from schema.sql and do not need this file.
--
-- Behaviour:
--   status 0 = unpaid          -> not constrained
--   status 1 = pending review  -> MUST have a proof_url  (this migration)
--   status 2 = confirmed paid  -> not constrained (treasurer cash payments OK)
--
-- Existing confirmed payments and their stored screenshots are untouched.
-- ===========================================================================

-- 1) Clean up any old pending claims that have no proof — they would violate
--    the new rule. Those members simply re-submit with a screenshot.
--    Comment this line out if you would rather keep them and fix them by hand.
delete from contributions where status = 1 and proof_url is null;

-- 2) Add the constraint.
alter table contributions
  drop constraint if exists contributions_pending_requires_proof;

alter table contributions
  add constraint contributions_pending_requires_proof
  check (status <> 1 or proof_url is not null);
