-- ===========================================================================
-- Migration 016 — MEMBER NOTIFICATIONS
--
-- 015 tells the treasurer when a payment arrives. This tells the MEMBER what
-- happened to it — and tells a recipient that their payout went out.
--
-- The three events, all chosen because the member has ALREADY ACTED and is
-- waiting for an answer. A notification is at its best when it closes a loop
-- somebody is holding open:
--
--   payment_confirmed   1 -> 2   "you sent it, the treasurer approved it"
--   payment_recorded    0 -> 2   "the treasurer logged the cash you handed over"
--   payment_rejected    1 -> 3   "send it again, and here is why"
--   payout_released     released "your ₱30,000 has gone out"
--
-- The rejection is the one that matters most: today it is INVISIBLE until the
-- member happens to open the app, and unlike a confirmation it needs action.
--
-- SAFE TO RE-RUN. Ships with 016_rollback.sql. Requires 015.
--
-- ORDER MATTERS, unlike 015. DEPLOY THE EDGE FUNCTION FIRST. The 015 function
-- ignores recipient_member_id and sends everything to the treasurer, so
-- applying this first would put every member's confirmation on the
-- treasurer's phone.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) The outbox learns who a notification is FOR.
--
-- 015 had no recipient at all — the function hardcoded "whoever is flagged
-- treasurer". Each row now says who it is for, and NULL keeps its 015 meaning
-- as a diagnostic: the trigger could not resolve a treasurer, and the function
-- records "no treasurer is flagged" rather than dropping it silently.
-- ---------------------------------------------------------------------------
alter table push_outbox
  add column if not exists recipient_member_id uuid references members(id) on delete set null;

-- round_number comes BACK. 015 removed it on the grounds that a column which
-- is always null is worse than none — true then, because ceil(cycle/6) lives
-- in js/calculations.js and copying that constant into SQL is how the two
-- drift. A payout event carries a real round number and no cycle, so there is
-- now something honest to put in it.
alter table push_outbox add column if not exists round_number int;

-- The treasurer's rejection reason. A rejection without one is worse than
-- useless on a lock screen: "send it again" with nothing to act on.
alter table push_outbox add column if not exists note text;

comment on column push_outbox.recipient_member_id is
  'Who to notify. NULL means the trigger could not resolve one (no treasurer '
  'flagged) — the function records that as last_error rather than guessing.';

-- ---------------------------------------------------------------------------
-- 2) One enqueue path for every event.
--
-- THE SUPPRESSION RULE IS GENERAL NOW: never notify somebody about something
-- they just did themselves. 015 spelled this as "is the payer the treasurer";
-- `recipient = pf_member_id()` says the same thing and extends to a treasurer
-- confirming their own cash payment or releasing a payout to themselves.
--
-- (pf_member_id() is null for a service-role caller, so nothing is suppressed
-- there. That is correct: a script acting on the fund is not the member.)
-- ---------------------------------------------------------------------------
create or replace function pf_push_enqueue(
    p_event     text,
    p_recipient uuid,
    p_subject   uuid,     -- who the event is ABOUT; often the same person
    p_cycle     int,
    p_round     int,
    p_amount    numeric,
    p_note      text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare _url text; _secret text; _dispatch boolean := false;
begin
  if p_recipient is not null and p_recipient = pf_member_id() then
    return;
  end if;

  -- ---- Record. ----------------------------------------------------------
  begin
    insert into push_outbox (txid, event_type, recipient_member_id, member_id,
                             cycle_number, round_number, amount, note)
    values (txid_current(), p_event, p_recipient, p_subject,
            p_cycle, p_round, p_amount, left(nullif(btrim(p_note), ''), 200));

    -- ONE dispatch per transaction, claimed here rather than below so a
    -- dispatch that throws does not release the claim and have every
    -- remaining row of a batch try again. Transaction-local, so it cannot
    -- leak into the next request on a pooled connection.
    if coalesce(current_setting('pf.push_scheduled', true), '') <> 'yes' then
      perform set_config('pf.push_scheduled', 'yes', true);
      _dispatch := true;
    end if;
  exception when others then
    -- A PAYMENT IS NEVER LOST OVER A NOTIFICATION.
    raise warning 'push queue skipped: %', sqlerrm;
    return;
  end;

  -- ---- Dispatch, in its OWN block. --------------------------------------
  -- Separate so a dead pg_net cannot roll back the outbox row recorded above:
  -- a plpgsql exception block undoes everything inside it, and that row is the
  -- only trail left for "the phone stayed quiet".
  if _dispatch then
    begin
      select push_endpoint_url, push_secret into _url, _secret
        from app_secrets where id = 1;
      if coalesce(_url, '') <> '' then
        perform net.http_post(
          url     := _url,
          headers := jsonb_build_object(
                       'Content-Type',     'application/json',
                       'x-pf-push-secret', coalesce(_secret, '')),
          body    := jsonb_build_object('txid', txid_current()::text)
        );
      end if;
    exception when others then
      raise warning 'push dispatch skipped: %', sqlerrm;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Contributions: one trigger, four outcomes.
--
-- `_was` is read from OLD ONCE, guarded by tg_op, rather than written as
-- `tg_op = 'INSERT' or old.status ...`. SQL does not promise to evaluate a
-- boolean left to right, and touching OLD in an INSERT trigger raises.
-- ---------------------------------------------------------------------------
create or replace function pf_queue_contribution_push()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare _was int; _cycle int; _treasurer uuid;
begin
  begin
    if tg_op = 'INSERT' then _was := -1; else _was := old.status; end if;
    if new.status = _was then return null; end if;  -- nothing changed state

    select cycle_number into _cycle from cycles where id = new.cycle_id;

    if new.status = 1 then
      -- A fresh claim awaiting review. 015's event, unchanged in meaning —
      -- but the recipient is now written down rather than assumed.
      select id into _treasurer
        from members where is_treasurer order by member_order limit 1;
      perform pf_push_enqueue('payment_pending', _treasurer, new.member_id,
                              _cycle, null, new.amount, null);

    elsif new.status = 2 then
      -- TWO DIFFERENT FACTS, and the member deserves the right one. From
      -- status 1 the member sent proof and it was approved; from 0 the
      -- treasurer logged cash that changed hands in person.
      perform pf_push_enqueue(
        case when _was = 1 then 'payment_confirmed' else 'payment_recorded' end,
        new.member_id, new.member_id, _cycle, null, new.amount, null);

    elsif new.status = 3 then
      perform pf_push_enqueue('payment_rejected', new.member_id, new.member_id,
                              _cycle, null, new.amount, new.rejection_note);
    end if;
  exception when others then
    raise warning 'push trigger skipped: %', sqlerrm;
  end;
  return null;  -- after trigger: the return value is ignored
end $$;

drop trigger if exists contributions_push on contributions;
create trigger contributions_push
  after insert or update on contributions
  for each row execute function pf_queue_contribution_push();

-- 015's function is now unreachable. Dropped rather than left behind, so
-- nobody re-points a trigger at the half of the logic that no longer knows
-- about recipients.
drop function if exists pf_queue_payment_push();

-- ---------------------------------------------------------------------------
-- 4) Payouts: the recipient's ₱30,000 has gone out.
--
-- Keyed on recipient_member_id — the RECORD, not the payout position. The
-- roster can be reordered or swapped after a release, which is exactly when
-- the two disagree, and telling the wrong person their payout arrived is the
-- worst available outcome here.
-- ---------------------------------------------------------------------------
create or replace function pf_queue_payout_push()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare _was boolean;
begin
  begin
    if tg_op = 'INSERT' then _was := false; else _was := coalesce(old.released, false); end if;
    if new.released and not _was and new.recipient_member_id is not null then
      perform pf_push_enqueue('payout_released', new.recipient_member_id,
                              new.recipient_member_id, null, new.round_number,
                              new.amount, null);
    end if;
  exception when others then
    raise warning 'push trigger skipped: %', sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists payouts_push on payouts;
create trigger payouts_push
  after insert or update on payouts
  for each row execute function pf_queue_payout_push();

commit;

-- VERIFY — three columns and two triggers:
--   select column_name from information_schema.columns
--    where table_name = 'push_outbox'
--      and column_name in ('recipient_member_id','round_number','note');
--   select tgname from pg_trigger
--    where tgname in ('contributions_push','payouts_push');
