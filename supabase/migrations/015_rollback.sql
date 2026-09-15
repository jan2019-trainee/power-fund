-- ===========================================================================
-- Migration 015 — ROLLBACK
--
-- Removes push notifications entirely: the trigger, the outbox, the
-- subscription table and the two app_secrets columns.
--
-- WHAT IS LOST: every registered device. Re-applying 015 does NOT bring them
-- back — a Web Push subscription cannot be recreated server-side, so each
-- member has to open the app on each device and turn notifications on again.
-- Worth knowing before running this, so CHECK FIRST:
--
--   select m.name, p.user_agent, p.created_at, p.last_ok_at
--     from push_subscriptions p join members m on m.id = p.member_id
--    order by m.name;
--
-- Nothing here touches contributions, and no payment has ever depended on it.
-- pg_net is deliberately LEFT INSTALLED: dropping an extension other things
-- may be using is not this migration's call, and its presence costs nothing.
--
-- SAFE TO RE-RUN.
-- ===========================================================================

begin;

drop trigger if exists contributions_push on contributions;
drop function if exists pf_queue_payment_push();

drop function if exists pf_unregister_push(text);
drop function if exists pf_register_push(text, text, text, text);

drop table if exists push_outbox;
drop table if exists push_subscriptions;

alter table app_secrets drop column if exists push_secret;
alter table app_secrets drop column if exists push_endpoint_url;

commit;

-- VERIFY — all three should return no rows:
--   select tablename from pg_tables
--    where tablename in ('push_subscriptions','push_outbox');
--   select tgname from pg_trigger where tgname = 'contributions_push';
--   select column_name from information_schema.columns
--    where table_name = 'app_secrets' and column_name like 'push%';
