-- ===========================================================================
-- Migration 015 — PUSH NOTIFICATIONS (treasurer, on a member's payment)
--
-- Reported as a want: the treasurer has no idea a payment is waiting until
-- they happen to open the app. Everything else in this fund reaches them by
-- somebody messaging them personally, which is the thing the app exists to
-- replace.
--
-- SUPABASE HAS NO PUSH PRODUCT. This migration builds the TRIGGER half only:
-- a row lands in `push_outbox` and exactly one HTTP call per transaction goes
-- out through pg_net to an Edge Function, which does the Web Push signing and
-- delivery. Applying this WITHOUT that function configured is deliberately
-- harmless — the outbox fills, nothing is sent, and no payment is affected.
--
-- WHAT IT ADDS
--   1. push_subscriptions  — one row per device, SELF-ONLY including select
--   2. pf_register_push / pf_unregister_push / pf_push_status
--   3. push_outbox         — unreachable from PostgREST, like app_secrets
--   4. app_secrets.push_endpoint_url / .push_secret (set by hand, see below)
--   5. pf_queue_payment_push() on contributions
--
-- ONE-OFF AFTER APPLYING, once the Edge Function is deployed (step 2 of the
-- rollout — the app works fine before it):
--
--   update app_secrets
--      set push_endpoint_url = 'https://<project>.functions.supabase.co/notify-payment',
--          push_secret       = '<a long random string>'
--    where id = 1;
--
-- Until push_endpoint_url is set, no HTTP call is made at all.
--
-- SAFE TO RE-RUN. Ships with 015_rollback.sql. Requires 010 (pf_member_id,
-- app_secrets) and assumes 011 is in force.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0) pg_net.
--
-- Supabase ships it; a bare Postgres (the test harness) does not. Its absence
-- must not stop this migration — the subscription table and the outbox are
-- useful on their own, and pf_queue_payment_push() resolves `net.http_post`
-- at RUN time, inside an exception block, so a database without pg_net simply
-- never dispatches.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  else
    raise notice 'pg_net is not available here — the outbox will fill but nothing will be dispatched.';
  end if;
exception when others then
  raise notice 'pg_net could not be installed (%) — the outbox will fill but nothing will be dispatched.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 1) push_subscriptions — one row per DEVICE, not per member.
--
-- A Web Push subscription is per browser profile, the same shape as
-- localStorage.pf_onboarded: enabling it on a laptop tells the phone nothing.
-- The UI has to say so.
--
-- `endpoint` IS A CAPABILITY: anyone holding that URL can push to that device.
-- So this table breaks the app's read-open convention DELIBERATELY — select is
-- self-only, not open to the group. Nobody, treasurer included, has any reason
-- to read another member's endpoint, and the Edge Function reads the table
-- with the service role rather than through PostgREST.
-- ---------------------------------------------------------------------------
create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references members(id) on delete cascade,
  endpoint   text not null unique,   -- unique: re-subscribing replaces, never duplicates
  p256dh     text not null,          -- the device's public key (base64url)
  auth       text not null,          -- the device's auth secret (base64url)
  user_agent text,                   -- so "which device is this?" is answerable
  created_at timestamptz not null default now(),
  last_ok_at timestamptz             -- last successful delivery; null = never yet
);

create index if not exists push_subscriptions_member_idx
  on push_subscriptions (member_id);

alter table push_subscriptions enable row level security;
drop policy if exists "open_all" on push_subscriptions;
drop policy if exists push_self  on push_subscriptions;

-- SELECT ONLY, and only your own. There is deliberately no insert/update/
-- delete policy: both transitions go through the functions below, the same
-- shape as swap_requests. A member reads this to answer "is this device
-- registered, and what else have I registered?" and nothing else.
create policy push_self on push_subscriptions
  for select to authenticated
  using (member_id = pf_member_id());

grant select on push_subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Register / unregister.
--
-- Security definer because of the TAKEOVER case: a device that was signed in
-- as one member and is now signed in as another produces the SAME endpoint,
-- which is already on somebody else's row. A plain upsert would be refused by
-- the policy above and fail silently (RLS hides the row — `[]` and no error),
-- which is the exact bug `requireRows()` exists to catch elsewhere.
--
-- Holding the endpoint is proof of holding the device, so the row moves. The
-- residual risk is a member who somehow learns another's endpoint being able
-- to take their notifications away — they could already push to it if they
-- knew it, and they cannot READ it here. Noted rather than defended against;
-- a five-person fund that shares a PIN is not the threat model.
-- ---------------------------------------------------------------------------
create or replace function pf_register_push(
    p_endpoint   text,
    p_p256dh     text,
    p_auth       text,
    p_user_agent text default null)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare _me uuid; _id uuid;
begin
  _me := pf_member_id();
  -- Not a linked account. Same rule as the payout QR and the receipt
  -- acknowledgement: an unverified per-device preference is never the gate.
  if _me is null then
    raise exception 'Sign in first — notifications are tied to your member account';
  end if;
  if coalesce(p_endpoint, '') = '' or coalesce(p_p256dh, '') = ''
     or coalesce(p_auth, '') = '' then
    raise exception 'Incomplete push subscription';
  end if;

  delete from push_subscriptions where endpoint = p_endpoint;
  insert into push_subscriptions (member_id, endpoint, p256dh, auth, user_agent)
  values (_me, p_endpoint, p_p256dh, p_auth, nullif(p_user_agent, ''))
  returning id into _id;
  return _id;
end $$;

create or replace function pf_unregister_push(p_endpoint text)
  returns int
  language plpgsql
  security definer
  set search_path = public
as $$
declare _n int;
begin
  if pf_member_id() is null then
    raise exception 'Sign in first';
  end if;
  -- By endpoint, not by owner: symmetric with register. Whoever can produce
  -- the endpoint is holding the device, and turning notifications off on a
  -- device you are holding should never be refused.
  delete from push_subscriptions where endpoint = p_endpoint;
  get diagnostics _n = row_count;
  return _n;
end $$;

-- REVOKED FROM PUBLIC FIRST. Postgres grants EXECUTE on a new function to
-- PUBLIC by default, and every role is a member of it — so granting to
-- `authenticated` alone would leave these callable by `anon`, which 011 has
-- otherwise revoked from every table in the fund. The two below refuse an
-- unlinked caller on their own logic; this is the belt to that braces.
revoke execute on function pf_register_push(text, text, text, text) from public;
revoke execute on function pf_unregister_push(text)                 from public;
grant  execute on function pf_register_push(text, text, text, text) to authenticated;
grant  execute on function pf_unregister_push(text)                 to authenticated;

-- ---------------------------------------------------------------------------
-- 3) push_outbox — what happened, waiting to be told.
--
-- WHY AN OUTBOX AND NOT A DIRECT CALL. Two things make the naive per-row
-- dispatch wrong, and both are ordinary use here:
--
--   * A member paying six cycles in one transfer is ONE upsert of six rows.
--     Six dispatches would buzz the treasurer six times for one transfer.
--   * That upsert is `insert ... on conflict do update`. A batch where some
--     cycles already had rows fires the INSERT path for some and the UPDATE
--     path for others — and a statement-level trigger cannot cover both
--     (Postgres: "transition tables are not allowed for triggers with more
--     than one event"), so that route would send twice for one transfer.
--
-- So every row appends here, and ONE dispatch per transaction carries the
-- txid. The Edge Function claims the whole txid and writes one notification.
--
-- RLS on with NO POLICY, like app_secrets: PostgREST cannot reach it. The
-- trigger is security definer; the Edge Function uses the service role.
-- ---------------------------------------------------------------------------
create table if not exists push_outbox (
  id           uuid primary key default gen_random_uuid(),
  txid         bigint not null,            -- the coalescing key
  event_type   text not null,              -- 'payment_pending' today; more later
  member_id    uuid references members(id) on delete set null,  -- who caused it
  cycle_number int,
  -- No round_number. It is ceil(cycle_number / CYCLES_PER_ROUND), and that
  -- constant lives in js/calculations.js — copying it into SQL is how the two
  -- drift. A column that is always null is worse than none: the next writer
  -- assumes it is populated.
  amount       numeric(10,2),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,                -- claimed+sent by the function
  last_error   text
);

-- Unsent rows are the only ones ever looked up, and a row left unsent is the
-- debug trail for "the treasurer's phone stayed quiet".
create index if not exists push_outbox_pending_idx
  on push_outbox (txid) where sent_at is null;

alter table push_outbox enable row level security;
drop policy if exists "open_all" on push_outbox;
revoke all on push_outbox from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Where the dispatch goes. Deployment config, not user data, so it lives
--    in app_secrets — the table with RLS and no policy — and not in
--    app_settings, which every member can read.
-- ---------------------------------------------------------------------------
alter table app_secrets add column if not exists push_endpoint_url text;
alter table app_secrets add column if not exists push_secret       text;

comment on column app_secrets.push_endpoint_url is
  'Edge Function URL that sends the Web Push messages. NULL or empty = no '
  'dispatch at all, which is the state this migration lands in.';
comment on column app_secrets.push_secret is
  'Shared secret sent as x-pf-push-secret. The function endpoint is public, '
  'so this is what stops anyone POSTing it a fabricated notification.';

-- DEFINED HERE, not up with the other two functions, and it has to stay here:
-- a `language sql` body is parsed and validated when the function is CREATED,
-- so it cannot name push_endpoint_url until the column above exists. (plpgsql
-- resolves at run time, which is why pf_register_push could sit earlier.)
-- Is the sending half actually deployed, and how many devices has this member
-- registered? BOOLEANS AND A COUNT ONLY — never the URL and never the secret,
-- the same discipline as pf_pin_status().
--
-- The app needs this to stay honest. Registering a device while no Edge
-- Function exists is a real write with no effect anybody can see, and a
-- screen saying "Notifications are on" about it would be exactly the
-- simulated notification CLAUDE.md rule 4 forbids.
create or replace function pf_push_status()
  returns table (dispatch_configured boolean, my_devices int)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select
    coalesce((select push_endpoint_url from app_secrets where id = 1), '') <> '',
    (select count(*)::int from push_subscriptions where member_id = pf_member_id())
$$;

revoke execute on function pf_push_status() from public;
grant  execute on function pf_push_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 5) The trigger.
--
-- EVERY PATH THROUGH IT IS INSIDE AN EXCEPTION BLOCK, and that is the single
-- most important property in this file: it fires on `contributions`, the
-- money table. A notification that cannot be queued must never roll back a
-- member's payment. Everything here fails quietly, and loudly in the log.
--
-- TWO blocks rather than one, because a plpgsql exception block undoes
-- everything inside it: recording the event and dispatching it have to be
-- able to fail separately, or a dead pg_net would erase the outbox row that
-- exists to explain the silence.
-- ---------------------------------------------------------------------------
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
  -- ---- 1) Decide, and record. ------------------------------------------
  begin
    -- Only a FRESH claim awaiting review. Status 1 is "I've sent this, with
    -- proof"; 0/2/3 are unpaid, confirmed and rejected, none of which is news
    -- for the treasurer to act on. An update that leaves status 1 as status 1
    -- (a note edit, a re-upload) is not a new claim either.
    if new.status <> 1 then return null; end if;
    if tg_op = 'UPDATE' and old.status = 1 then return null; end if;

    -- The treasurer is also a member with a payout round of their own. They do
    -- not need telling about a payment they just made themselves.
    select is_treasurer into _payer_is_treasurer
      from members where id = new.member_id;
    if coalesce(_payer_is_treasurer, false) then return null; end if;

    select cycle_number into _cycle from cycles where id = new.cycle_id;

    insert into push_outbox (txid, event_type, member_id, cycle_number, amount)
    values (txid_current(), 'payment_pending', new.member_id, _cycle, new.amount);

    -- ONE dispatch per transaction, claimed here rather than in the block
    -- below so that a dispatch which throws does not release the claim and
    -- have every remaining row of the batch try again.
    --
    -- Transaction-local, so it cannot leak into the next request on a pooled
    -- connection — the same shape as 013's pf.swap_ok. A browser cannot set
    -- it either: PostgREST exposes only public-schema functions, and
    -- set_config lives in pg_catalog.
    if coalesce(current_setting('pf.push_scheduled', true), '') <> 'yes' then
      perform set_config('pf.push_scheduled', 'yes', true);
      _dispatch := true;
    end if;
  exception when others then
    -- A PAYMENT IS NEVER LOST OVER A NOTIFICATION. This fires on the money
    -- table; anything wrong in here has to end with the contribution written.
    raise warning 'push queue skipped: %', sqlerrm;
    return null;
  end;

  -- ---- 2) Dispatch, in its OWN block. ----------------------------------
  -- Separate so that a dead pg_net or a malformed URL does not roll back the
  -- outbox row recorded above: a plpgsql exception block undoes everything
  -- inside it, and that row is the only trail left for "the treasurer's phone
  -- stayed quiet".
  if _dispatch then
    begin
      select push_endpoint_url, push_secret into _url, _secret
        from app_secrets where id = 1;

      -- Not configured yet: the outbox still filled, which is exactly the
      -- state this migration is designed to land in.
      if coalesce(_url, '') <> '' then
        -- pg_net QUEUES the request and a background worker sends it AFTER
        -- COMMIT, which is what makes this safe: the function can never read
        -- an outbox row from a transaction that then rolled back, and a slow
        -- or dead push endpoint cannot delay the payment write.
        perform net.http_post(
          url     := _url,
          headers := jsonb_build_object(
                       'Content-Type',     'application/json',
                       'x-pf-push-secret', coalesce(_secret, '')),
          body    := jsonb_build_object('txid', txid_current()::text)
        );
      end if;
    exception when others then
      -- pg_net missing, the URL malformed, app_secrets unreadable — all here.
      raise warning 'push dispatch skipped: %', sqlerrm;
    end;
  end if;

  return null;  -- after trigger: the return value is ignored
end $$;

drop trigger if exists contributions_push on contributions;
create trigger contributions_push
  after insert or update on contributions
  for each row execute function pf_queue_payment_push();

commit;

-- VERIFY — the table, the outbox and the trigger:
--   select tablename from pg_tables
--    where tablename in ('push_subscriptions','push_outbox');
--   select tgname from pg_trigger where tgname = 'contributions_push';
--
-- VERIFY the outbox is filling (before the Edge Function exists, sent_at
-- stays null and that is correct):
--   select txid, event_type, cycle_number, created_at, sent_at
--     from push_outbox order by created_at desc limit 10;
