-- ===========================================================================
-- Migration 012 — ROLLBACK
--
-- Removes the recipient's acknowledgement: the policy, the guard trigger and
-- the two columns. 011's payouts_treasurer is untouched, so payouts stay
-- treasurer-only for writes exactly as before 012.
--
-- The columns are DROPPED, so any confirmations already recorded are lost.
-- Take a backup first if that history matters.
--
-- Idempotent, and 012 re-applies cleanly on top of it.
-- ===========================================================================

begin;

drop trigger  if exists payouts_guard on payouts;
drop function if exists pf_payouts_guard();
drop policy   if exists payouts_recipient_ack on payouts;

alter table payouts drop column if exists received_at;
alter table payouts drop column if exists received_note;

commit;
