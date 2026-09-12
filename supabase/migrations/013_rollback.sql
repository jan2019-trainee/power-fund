-- ===========================================================================
-- Migration 013 — ROLLBACK
--
-- Removes the turn-swap flow and restores 010's members guard verbatim.
--
-- WHAT IT DOES NOT UNDO: `members.member_order` is left DEFERRABLE. Making a
-- unique constraint deferrable takes nothing away — it still refuses two
-- members at the same position, it just checks at commit instead of per row —
-- and reverting it would re-break the plain two-write swap that 013 exists to
-- fix. If you genuinely need the old non-deferrable form back, the statement
-- is at the bottom of this file, commented out.
--
-- Any swap_requests rows are DROPPED with the table. Accepted swaps are not
-- lost: each one wrote an activity_log entry, which this does not touch.
--
-- SAFE TO RE-RUN.
-- ===========================================================================

begin;

drop function if exists pf_request_swap(uuid, text);
drop function if exists pf_accept_swap(uuid);
drop function if exists pf_decline_swap(uuid);
drop function if exists pf_cancel_swap(uuid);
drop function if exists pf_swap_order(uuid, uuid);
drop function if exists pf_round_released(int);

drop table if exists swap_requests;

-- 010's guard, exactly as it was before 013 amended it. Restored rather than
-- left in place: the swap exemption reads a GUC nothing sets any more, so it
-- would be dead code in the one function where dead code is least welcome.
create or replace function pf_members_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if pf_is_treasurer() then
    return new;
  end if;

  if old.auth_user_id is null
     and new.auth_user_id = auth.uid()
     and new.id is not distinct from old.id
     and new.name is not distinct from old.name
     and new.member_order is not distinct from old.member_order
     and new.is_treasurer is not distinct from old.is_treasurer
     and new.email is not distinct from old.email
  then
    return new;
  end if;

  if new.id is distinct from pf_member_id() then
    raise exception 'You can only edit your own profile';
  end if;
  if new.member_order is distinct from old.member_order then
    raise exception 'Only the treasurer can change the payout order';
  end if;
  if new.is_treasurer is distinct from old.is_treasurer then
    raise exception 'Only the treasurer can grant treasurer access';
  end if;
  if new.email is distinct from old.email then
    raise exception 'Only the treasurer can change a member''s email';
  end if;
  if old.auth_user_id is not null and new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'Only the treasurer can unlink an account';
  end if;

  return new;
end $$;

commit;

-- To restore the non-deferrable constraint as well — NOT recommended, it
-- re-breaks any pair swap that is not a single deferred statement:
--
--   alter table members drop constraint members_member_order_key;
--   alter table members add  constraint members_member_order_key
--     unique (member_order);
