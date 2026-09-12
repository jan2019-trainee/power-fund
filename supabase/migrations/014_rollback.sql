-- ===========================================================================
-- Migration 014 — ROLLBACK
--
-- Removes the dispute columns and restores 012's guard verbatim.
--
-- WHAT IS LOST: any open dispute. A member's report that their ₱30,000 never
-- arrived is exactly the kind of thing not to drop silently, so CHECK FIRST:
--
--   select round_number, recipient_name, disputed_at, disputed_note
--     from payouts where disputed_at is not null;
--
-- Confirmed receipts are untouched, and every dispute also wrote an
-- activity_log entry, which this does not remove.
--
-- SAFE TO RE-RUN.
-- ===========================================================================

begin;

-- 012's guard, exactly as it was before 014 extended it. Restored rather than
-- left in place: it would otherwise reference columns that no longer exist.
create or replace function pf_payouts_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.received_at is not null and old.received_at is null then
    if old.recipient_member_id is distinct from pf_member_id() then
      raise exception 'Only % can confirm receiving this payout',
        coalesce(old.recipient_name, 'the recipient');
    end if;
    if not old.released then
      raise exception 'This payout has not been released yet';
    end if;
    new.received_at := now();
  end if;

  if old.received_at is not null
     and new.received_at is null
     and not pf_is_treasurer()
  then
    raise exception 'Only the treasurer can clear a confirmation';
  end if;

  if pf_is_treasurer() then
    return new;
  end if;

  if old.received_at is not null then
    raise exception 'This payout is already confirmed received';
  end if;
  if new.received_at is null then
    raise exception 'A recipient may only confirm receipt, nothing else';
  end if;
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

alter table payouts drop constraint if exists payout_ack_exclusive;
alter table payouts drop column if exists disputed_note;
alter table payouts drop column if exists disputed_at;

commit;

-- VERIFY — should return no rows:
--   select column_name from information_schema.columns
--    where table_name = 'payouts' and column_name like 'disputed%';
