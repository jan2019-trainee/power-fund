-- ===========================================================================
-- Migration 016 — ROLLBACK
--
-- Returns notifications to 015's behaviour: the treasurer is told about
-- incoming payments, and members are told nothing.
--
-- WHAT IS LOST: nothing anybody can see. Registered devices are untouched, and
-- push_outbox is a notification log, not a ledger. Undelivered member events
-- simply stop being delivered — check first if you care:
--
--   select event_type, count(*) from push_outbox
--    where sent_at is null group by event_type;
--
-- SAFE TO RE-RUN.
-- ===========================================================================

begin;

drop trigger if exists payouts_push on payouts;
drop function if exists pf_queue_payout_push();

-- 015's contribution trigger, restored verbatim.
create or replace function pf_queue_payment_push()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  _url text; _secret text; _cycle int;
  _payer_is_treasurer boolean;
  _dispatch boolean := false;
begin
  begin
    if new.status <> 1 then return null; end if;
    if tg_op = 'UPDATE' and old.status = 1 then return null; end if;
    select is_treasurer into _payer_is_treasurer
      from members where id = new.member_id;
    if coalesce(_payer_is_treasurer, false) then return null; end if;
    select cycle_number into _cycle from cycles where id = new.cycle_id;
    insert into push_outbox (txid, event_type, member_id, cycle_number, amount)
    values (txid_current(), 'payment_pending', new.member_id, _cycle, new.amount);
    if coalesce(current_setting('pf.push_scheduled', true), '') <> 'yes' then
      perform set_config('pf.push_scheduled', 'yes', true);
      _dispatch := true;
    end if;
  exception when others then
    raise warning 'push queue skipped: %', sqlerrm;
    return null;
  end;

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
  return null;
end $$;

drop trigger if exists contributions_push on contributions;
create trigger contributions_push
  after insert or update on contributions
  for each row execute function pf_queue_payment_push();

drop function if exists pf_queue_contribution_push();
drop function if exists pf_push_enqueue(text, uuid, uuid, int, int, numeric, text);

alter table push_outbox drop column if exists note;
alter table push_outbox drop column if exists round_number;
alter table push_outbox drop column if exists recipient_member_id;

commit;

-- VERIFY — should return no rows:
--   select column_name from information_schema.columns
--    where table_name = 'push_outbox' and column_name = 'recipient_member_id';
