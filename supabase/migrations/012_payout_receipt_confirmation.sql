-- ===========================================================================
-- Migration 012 — the recipient confirms their payout ("Received ✓")
--
-- WHY
--   The payout record is entirely one-sided. `released`, `amount`,
--   `recipient_name`, `receipt_url` and `released_by` are all written by the
--   treasurer. Nothing records that the member actually RECEIVED the money.
--
--   Compare the other direction: a member's ₱1,000 contribution needs a proof
--   screenshot AND the treasurer's confirmation — two people, two sides. The
--   ₱30,000 payout, the single largest transaction in the fund, had one side.
--   If a member later says "I never got my round", the only evidence is a
--   screenshot the treasurer uploaded themselves.
--
--   This protects the TREASURER most: they carry ₱150,000 of other people's
--   money across five rounds.
--
-- SAFE TO RUN
--   Additive. Two nullable columns, one NEW policy and one trigger. It changes
--   no existing policy, so it cannot lock anyone out. Ships with
--   012_rollback.sql.
--
-- DESIGN DECISIONS WORTH NOT UNDOING — see CLAUDE.md for the full reasoning.
--
--   * There is NO `received_by` column. The acknowledger is always
--     `recipient_member_id` by construction and the policy enforces it; a
--     second column would only create the possibility of the two disagreeing.
--     Its absence is the integrity property.
--   * `received_at` is stamped SERVER-SIDE with now(), ignoring whatever the
--     client sends. A client-chosen timestamp on a financial acknowledgement
--     is worthless as evidence.
--   * NOBODY may confirm a payout that is not their own — the treasurer
--     included. A treasurer-recorded "received" proves nothing, which is the
--     whole point. But the rule is "only the recipient", NOT "not the
--     treasurer": in a fund this size the treasurer is normally also a member
--     with their own payout round, and they must be able to acknowledge their
--     own ₱30,000. Getting this backwards was caught by tests/sql/run.sh.
--     (The treasurer may still CLEAR one: that is a correction, and the
--     recovery path — Undo Release depends on it.)
--   * A member may acknowledge ONCE and may not un-acknowledge. Undoing is a
--     correction, which is the treasurer's act.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) The columns.
-- ---------------------------------------------------------------------------
alter table payouts add column if not exists received_at   timestamptz;
alter table payouts add column if not exists received_note  text;

comment on column payouts.received_at is
  'When the RECIPIENT confirmed receiving this payout. Stamped server-side by '
  'pf_payouts_guard(); never set by the treasurer on a member''s behalf.';
comment on column payouts.received_note is
  'Optional free text from the recipient — the only place their side of the '
  'handover gets written down.';

-- ---------------------------------------------------------------------------
-- 2) The policy: a recipient may update THEIR OWN released payout row.
--
-- Permissive policies are OR-ed, so this sits alongside 011's
-- payouts_treasurer rather than replacing it. It grants UPDATE on one row;
-- the trigger below is what restricts it to two columns, because RLS cannot
-- express a column list.
-- ---------------------------------------------------------------------------
drop policy if exists payouts_recipient_ack on payouts;

create policy payouts_recipient_ack on payouts
  for update to authenticated
  using (released and recipient_member_id = pf_member_id())
  with check (released and recipient_member_id = pf_member_id());

-- ---------------------------------------------------------------------------
-- 3) The guard: same shape as 010's pf_members_guard(). Pins every column a
--    recipient must not touch, and stamps the timestamp itself.
-- ---------------------------------------------------------------------------
create or replace function pf_payouts_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if auth.uid() is null then
    return new; -- pre-auth behaviour, unchanged
  end if;

  -- ---- SETTING a confirmation: the recipient themselves, and nobody else --
  --
  -- This test comes FIRST and applies to the treasurer too. In a fund this
  -- size the treasurer is normally also a member with their own payout round,
  -- so "the treasurer may not confirm" cannot be the rule — it would stop them
  -- ever acknowledging their own ₱30,000. The rule is that the confirmation
  -- belongs to whoever the money went to, whatever else they are.
  --
  -- NULL -> NOT NULL, not `is distinct from`: inside one transaction now()
  -- returns the SAME value every time, so a second confirm produced
  -- new.received_at = old.received_at, skipped this branch entirely and slipped
  -- past the once-only rule. Caught by tests/sql/run.sh.
  if new.received_at is not null and old.received_at is null then
    if old.recipient_member_id is distinct from pf_member_id() then
      raise exception 'Only % can confirm receiving this payout',
        coalesce(old.recipient_name, 'the recipient');
    end if;
    if not old.released then
      raise exception 'This payout has not been released yet';
    end if;
    -- The client does not get to choose when it happened.
    new.received_at := now();
  end if;

  -- ---- CLEARING one: a correction, so the treasurer's act ----------------
  if old.received_at is not null
     and new.received_at is null
     and not pf_is_treasurer()
  then
    raise exception 'Only the treasurer can clear a confirmation';
  end if;

  -- The treasurer releases, corrects, un-releases and clears. Anything not
  -- refused above is theirs.
  if pf_is_treasurer() then
    return new;
  end if;

  -- ---- An ordinary member may do NOTHING ELSE to a payout row ------------
  -- The acknowledgement is a ONE-SHOT record: amending it, including its note,
  -- is a correction and therefore the treasurer's act.
  if old.received_at is not null then
    raise exception 'This payout is already confirmed received';
  end if;
  -- The only thing they may be doing here is confirming.
  if new.received_at is null then
    raise exception 'A recipient may only confirm receipt, nothing else';
  end if;
  -- Every other column is pinned, so the acknowledgement cannot smuggle
  -- through a change to the amount, the recipient or the release itself.
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
    raise exception 'A recipient may only confirm receipt, nothing else';
  end if;

  return new;
end $$;

drop trigger if exists payouts_guard on payouts;
create trigger payouts_guard
  before update on payouts
  for each row execute function pf_payouts_guard();

commit;

-- VERIFY — should list received_at and received_note:
--   select column_name from information_schema.columns
--    where table_name = 'payouts' and column_name like 'received%';
