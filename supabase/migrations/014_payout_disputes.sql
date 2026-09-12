-- ===========================================================================
-- Migration 014 — PAYOUT DISPUTES ("it never arrived")
--
-- 012 gave the recipient one button: "Yes, I received it". Reported from use:
-- a member looking at a released payout that has NOT arrived has no way to
-- say so. Their only options are to press a button that is untrue, or to stay
-- silent — and silence is indistinguishable from forgetting to tap. The one
-- dispute the app exists to settle was the one thing it could not record.
--
-- A PRODUCT DECISION, taken by the owner: a dispute is FLAGGED LOUDLY AND
-- BLOCKS NOTHING. It goes to the top of the treasurer's attention queue, shows
-- on the round for everyone, and is logged — while the fund keeps collecting.
-- Consistent with 012's recorded decision that the money genuinely left, so
-- this is a report rather than a lock, and one member cannot freeze the group.
--
-- WHAT IT ADDS
--   1. payouts.disputed_at / .disputed_note
--   2. the invariant that received_at and disputed_at can never both be set
--   3. pf_payouts_guard() extended — 012's rules are UNCHANGED
--
-- SAFE TO RE-RUN. Ships with 014_rollback.sql. Requires 012.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) The columns.
-- ---------------------------------------------------------------------------
alter table payouts add column if not exists disputed_at   timestamptz;
alter table payouts add column if not exists disputed_note text;

comment on column payouts.disputed_at is
  'Set by the RECIPIENT to report that a released payout never arrived. '
  'Never both this and received_at — see payout_ack_exclusive. Cleared when '
  'the money turns up (the member confirms receipt) or the member withdraws '
  'the report. Blocks nothing: the fund keeps collecting.';
comment on column payouts.disputed_note is
  'Optional free text from the recipient saying what they are seeing — the '
  'only place the other side of a failed handover gets written down.';

-- ---------------------------------------------------------------------------
-- 2) The invariant, as a CHECK rather than only as trigger logic.
--
-- "Received" and "never arrived" are opposites. A row carrying both is not a
-- state the app should be able to reach through any path, present or future,
-- so it is refused by the table itself and not only by the guard below.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'payouts'::regclass
                    and conname = 'payout_ack_exclusive') then
    alter table payouts add constraint payout_ack_exclusive
      check (not (received_at is not null and disputed_at is not null));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) The guard.
--
-- 012's rules are reproduced VERBATIM and are not relaxed. What is new:
--
--   * setting disputed_at — the recipient only, on a released payout they
--     have not already confirmed, server-stamped
--   * clearing disputed_at — the recipient may withdraw their OWN report, and
--     the treasurer may too. This is deliberately UNLIKE received_at, whose
--     clearing is treasurer-only: a confirmation is a receipt and amending one
--     is a correction, while a dispute is a report of a problem, and problems
--     get resolved. If a dispute were permanent nobody would dare press it.
--   * confirming receipt while disputed — allowed, and it CLEARS the dispute.
--     Money arriving late is the ordinary happy ending here.
-- ---------------------------------------------------------------------------
create or replace function pf_payouts_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare _touching_dispute boolean;
begin
  if auth.uid() is null then
    return new; -- pre-auth behaviour, unchanged
  end if;

  _touching_dispute :=
    new.disputed_at   is distinct from old.disputed_at
    or new.disputed_note is distinct from old.disputed_note;

  -- ---- SETTING a confirmation: the recipient themselves, and nobody else --
  -- (012, unchanged.) This test comes FIRST and applies to the treasurer too:
  -- in a fund this size the treasurer is normally also a member with their own
  -- payout round, so "the treasurer may not confirm" cannot be the rule.
  if new.received_at is not null and old.received_at is null then
    if old.recipient_member_id is distinct from pf_member_id() then
      raise exception 'Only % can confirm receiving this payout',
        coalesce(old.recipient_name, 'the recipient');
    end if;
    if not old.released then
      raise exception 'This payout has not been released yet';
    end if;
    new.received_at := now();
    -- The money turned up after all. Cleared here rather than left to the
    -- client, so the exclusive invariant cannot be violated by a caller that
    -- simply forgot — and so a late arrival ends the dispute rather than
    -- leaving the round flagged forever.
    new.disputed_at := null;
    new.disputed_note := null;
  end if;

  -- ---- SETTING a dispute: likewise the recipient, and nobody else --------
  if new.disputed_at is not null and old.disputed_at is null then
    if old.recipient_member_id is distinct from pf_member_id() then
      raise exception 'Only % can report this payout as not arrived',
        coalesce(old.recipient_name, 'the recipient');
    end if;
    if not old.released then
      raise exception 'This payout has not been released yet';
    end if;
    -- Already on record as received. Taking that back is a CORRECTION, not a
    -- report, and corrections are the treasurer's act (Undo Release).
    if old.received_at is not null then
      raise exception 'This payout is already confirmed received';
    end if;
    new.disputed_at := now(); -- the client does not choose when
  end if;

  -- ---- CLEARING a confirmation: a correction, so the treasurer's act -----
  -- (012, unchanged.)
  if old.received_at is not null
     and new.received_at is null
     and not pf_is_treasurer()
  then
    raise exception 'Only the treasurer can clear a confirmation';
  end if;

  -- ---- CLEARING a dispute: the reporter may withdraw it ------------------
  if old.disputed_at is not null
     and new.disputed_at is null
     and not pf_is_treasurer()
     and old.recipient_member_id is distinct from pf_member_id()
  then
    raise exception 'Only % can withdraw that report',
      coalesce(old.recipient_name, 'the recipient');
  end if;

  -- The treasurer releases, corrects, un-releases and clears. Anything not
  -- refused above is theirs. (012, unchanged.)
  if pf_is_treasurer() then
    return new;
  end if;

  -- ---- An ordinary member may do NOTHING ELSE to a payout row ------------
  -- The acknowledgement is a ONE-SHOT record: amending it, including its note,
  -- is a correction and therefore the treasurer's act. (012, unchanged — but a
  -- member acting on a DISPUTE has not confirmed anything, so that path is
  -- checked separately below rather than caught by this.)
  if old.received_at is not null then
    raise exception 'This payout is already confirmed received';
  end if;
  -- The only things they may be doing here are confirming receipt or filing /
  -- withdrawing a report. 012 raised here whenever received_at was null,
  -- which would refuse every dispute write.
  if new.received_at is null and not _touching_dispute then
    raise exception 'A recipient may only confirm receipt or report a problem';
  end if;
  -- Every other column is pinned, so neither act can smuggle through a change
  -- to the amount, the recipient or the release itself.
  if new.round_number           is distinct from old.round_number
     or new.released            is distinct from old.released
     or new.note                is distinct from old.note
     or new.released_on         is distinct from old.released_on
     or new.started_at          is distinct from old.started_at
     or new.amount              is distinct from old.amount
     or new.recipient_member_id is distinct from old.recipient_member_id
     or new.recipient_name      is distinct from old.recipient_name
     or new.receipt_url         is distinct from old.receipt_url
     or new.released_by         is distinct from old.released_by
  then
    raise exception 'A recipient may only confirm receipt or report a problem';
  end if;

  return new;
end $$;

drop trigger if exists payouts_guard on payouts;
create trigger payouts_guard
  before update on payouts
  for each row execute function pf_payouts_guard();


commit;

-- VERIFY — should list disputed_at and disputed_note:
--   select column_name from information_schema.columns
--    where table_name = 'payouts' and column_name like 'disputed%';
