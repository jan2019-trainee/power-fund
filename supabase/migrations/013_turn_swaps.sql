-- ===========================================================================
-- Migration 013 — TURN SWAPS (*palit ng turno*)
--
-- Two members agree to trade payout positions. A member requests, the
-- counterparty accepts, and the swap applies — the two people whose money
-- moves are the two who decide. A PRODUCT DECISION, taken by the owner; the
-- design has no swap flow at all and scopes post-setup member actions to
-- EditMemberNames + ReorderPayout (canvas.json, gap5-no-member-changes-notes).
--
-- WHY THIS IS A MIGRATION AND NOT A UI TASK
--
--   `members.member_order` is `not null unique` (schema.sql). The app's
--   existing swap writes the pair as TWO sequential single-row updates, and
--   the first one ALWAYS collides:
--
--     update members set member_order = 2 where id = <A>;
--     ERROR: duplicate key value violates unique constraint
--
--   A single `case` statement fails identically — Postgres checks a
--   non-deferrable unique constraint per ROW, not per statement. So "Reorder
--   payout order" has never worked against a real database; the smoke harness
--   mocks the network, so ~500 checks never saw it. This migration makes the
--   constraint DEFERRABLE and moves the swap into one atomic function.
--
-- WHAT IT ADDS
--   1. members.member_order becomes `unique ... deferrable initially immediate`
--   2. table `swap_requests` + its RLS
--   3. pf_request_swap / pf_accept_swap / pf_decline_swap / pf_cancel_swap,
--      and pf_swap_order for the treasurer's own (also broken) reorder
--   4. pf_members_guard() learns the mutual-swap exemption
--
-- SAFE TO RE-RUN. Ships with 013_rollback.sql.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1) The unique constraint, made deferrable.
--
-- Looked up by DEFINITION rather than assumed to be called
-- `members_member_order_key`: schema.sql declares it inline, so the name is
-- Postgres's own choice and a hand-built database may differ. Dropping the
-- wrong constraint here would be silent and bad.
-- ---------------------------------------------------------------------------
do $$
declare _name text; _deferrable boolean;
begin
  select conname, condeferrable into _name, _deferrable
    from pg_constraint
   where conrelid = 'members'::regclass
     and contype = 'u'
     and conkey = array[(select attnum from pg_attribute
                          where attrelid = 'members'::regclass
                            and attname = 'member_order')]
   limit 1;

  if _name is null then
    -- No unique constraint at all (a database built before it existed).
    -- Adding it is still right: two members at the same position means one
    -- round pays nobody.
    alter table members
      add constraint members_member_order_key
      unique (member_order) deferrable initially immediate;
  elsif not _deferrable then
    execute format('alter table members drop constraint %I', _name);
    execute format(
      'alter table members add constraint %I unique (member_order) '
      'deferrable initially immediate', _name);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) swap_requests
--
-- from_round / to_round are stored AS THEY WERE WHEN ASKED, and re-checked on
-- accept. The order can change between request and accept (another swap
-- lands, or the treasurer reorders), and a request that then applied would
-- move a different pair of rounds than the one both people agreed to. That
-- request is STALE and is refused, not silently re-pointed.
-- ---------------------------------------------------------------------------
create table if not exists swap_requests (
  id             uuid primary key default gen_random_uuid(),
  from_member_id uuid not null references members(id) on delete cascade,
  to_member_id   uuid not null references members(id) on delete cascade,
  from_round     int  not null,
  to_round       int  not null,
  status         text not null default 'pending',
  note           text,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  constraint swap_not_self   check (from_member_id <> to_member_id),
  constraint swap_not_same   check (from_round <> to_round),
  constraint swap_status_ok  check (status in ('pending','accepted','declined','cancelled','stale'))
);

-- One live request per requester. Without this, a member could stack five
-- pending asks and whichever counterparty tapped first would win a race the
-- other four never knew they were in.
create unique index if not exists swap_one_pending_per_requester
  on swap_requests (from_member_id) where status = 'pending';

alter table swap_requests enable row level security;

drop policy if exists swap_read      on swap_requests;
drop policy if exists swap_request   on swap_requests;
drop policy if exists swap_treasurer on swap_requests;

-- Readable by anyone signed in: this fund is transparent by design, and a
-- swap changes who receives ₱30,000 — the other three should be able to see
-- that it happened without asking.
create policy swap_read on swap_requests
  for select to authenticated using (true);

-- You may only ask on your OWN behalf, and only for a pending row. Every
-- transition out of pending goes through a function instead (see 3), so there
-- is deliberately NO update policy — the same shape as activity_log being
-- append-only.
create policy swap_request on swap_requests
  for insert to authenticated
  with check (from_member_id = pf_member_id() and status = 'pending');

-- The treasurer may clear the table out (a stale row from a member who has
-- left the group chat, say). Not a route to APPLYING one: the order only ever
-- moves inside pf_accept_swap.
create policy swap_treasurer on swap_requests
  for delete to authenticated using (pf_is_treasurer());

grant select, insert on swap_requests to authenticated;
grant delete on swap_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 3) The transitions.
--
-- All three are security definer, because accepting has to write the OTHER
-- member's row — which 011's members_self_write policy and 010's guard both
-- (correctly) refuse to an ordinary member. The permission lives here, in one
-- validated function, rather than in a policy loose enough to be misused.
-- ---------------------------------------------------------------------------

-- Is this round's money already gone? The one irreversible case.
create or replace function pf_round_released(_round int)
  returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select released from payouts where round_number = _round), false)
$$;

create or replace function pf_request_swap(_to_member uuid, _note text default null)
  returns swap_requests
  language plpgsql security definer set search_path = public
as $$
declare _me uuid; _mine int; _theirs int; _row swap_requests;
begin
  _me := pf_member_id();
  if _me is null then
    raise exception 'Only a signed-in member can ask for a swap';
  end if;
  if _to_member = _me then
    raise exception 'You cannot swap turns with yourself';
  end if;

  select member_order into _mine   from members where id = _me;
  select member_order into _theirs from members where id = _to_member;
  if _theirs is null then
    raise exception 'That member is not on the roster';
  end if;

  -- RELEASED is the refusal, both directions. A member whose round is paid
  -- out has had their ₱30,000; moving them to a later round would pay them
  -- twice and leave the other member with nothing.
  if pf_round_released(_mine) then
    raise exception 'Your Round % has already been paid out', _mine;
  end if;
  if pf_round_released(_theirs) then
    raise exception 'Round % has already been paid out', _theirs;
  end if;

  -- Supersede your own previous ask rather than colliding with the partial
  -- index: changing your mind about WHO to ask is ordinary, and leaving the
  -- old one pending would let either counterparty accept.
  update swap_requests
     set status = 'cancelled', resolved_at = now()
   where from_member_id = _me and status = 'pending';

  insert into swap_requests (from_member_id, to_member_id, from_round, to_round, note)
  values (_me, _to_member, _mine, _theirs, nullif(btrim(coalesce(_note,'')), ''))
  returning * into _row;
  return _row;
end $$;

create or replace function pf_accept_swap(_request uuid)
  returns swap_requests
  language plpgsql security definer set search_path = public
as $$
declare _me uuid; _r swap_requests; _a int; _b int; _an text; _bn text;
begin
  _me := pf_member_id();
  if _me is null then
    raise exception 'Only a signed-in member can accept a swap';
  end if;

  select * into _r from swap_requests where id = _request for update;
  if _r.id is null then
    raise exception 'That swap request no longer exists';
  end if;
  -- ONLY THE COUNTERPARTY. Not the requester (that would make "agreement"
  -- one person's decision) and not the treasurer (a swap the two members did
  -- not both agree to is the thing this whole flow exists to prevent).
  if _r.to_member_id <> _me then
    raise exception 'Only the member who was asked can accept this swap';
  end if;
  if _r.status <> 'pending' then
    raise exception 'That swap request was already %', _r.status;
  end if;

  select member_order, name into _a, _an from members where id = _r.from_member_id;
  select member_order, name into _b, _bn from members where id = _r.to_member_id;

  -- STALE: the positions moved since this was asked, so accepting would trade
  -- different rounds than the ones agreed. Marked, not silently re-pointed.
  --
  -- This RETURNS rather than raising, and that is the whole point: a raise
  -- would roll back the very row it had just marked, leaving the request
  -- `pending` with an Accept button that can never work and the partial
  -- unique index still occupied. It is the one refusal here that has to
  -- PERSIST something, so it cannot be an exception. The caller checks
  -- `status` — anything but 'accepted' means nothing moved.
  if _a is distinct from _r.from_round or _b is distinct from _r.to_round then
    update swap_requests set status = 'stale', resolved_at = now() where id = _r.id
    returning * into _r;
    return _r;
  end if;

  -- Re-checked at accept time, not only at request time: a round can be
  -- released in between, and that is the one change that must not be undone
  -- by a swap.
  if pf_round_released(_a) then raise exception 'Round % has already been paid out', _a; end if;
  if pf_round_released(_b) then raise exception 'Round % has already been paid out', _b; end if;

  -- The swap itself. One statement, with the unique constraint deferred to
  -- commit — see the header for why neither sequential updates nor a plain
  -- single statement can work.
  --
  -- `true` makes the flag TRANSACTION-LOCAL: it is gone by the time PostgREST
  -- serves the next request, so it cannot leak into an unrelated write on a
  -- pooled connection. Set immediately before the update and nowhere else.
  perform set_config('pf.swap_ok', 'yes', true);
  set constraints all deferred;
  update members
     set member_order = case id when _r.from_member_id then _b else _a end
   where id in (_r.from_member_id, _r.to_member_id);
  perform set_config('pf.swap_ok', '', true);

  update swap_requests set status = 'accepted', resolved_at = now() where id = _r.id
  returning * into _r;

  -- Logged HERE rather than by the app, so a swap can never be unrecorded.
  -- It is the one write that moves everybody's turn, and the log is the only
  -- place the group can see that it was mutual.
  insert into activity_log (message, event_type, member_id, round_number)
  values (
    format('%s and %s swapped turns — Round %s ↔ Round %s (both agreed)',
           _an, _bn, _a, _b),
    'admin', _r.from_member_id, least(_a, _b)
  );

  return _r;
end $$;

-- The TREASURER's own reorder (Menu -> Group -> Reorder payout order). It
-- needs to be a function for the same reason the mutual swap does: two
-- sequential single-row updates collide on the unique constraint, so that
-- screen has never worked either. No GUC here — the guard already returns
-- early for pf_is_treasurer().
create or replace function pf_swap_order(_a uuid, _b uuid)
  returns setof members
  language plpgsql security definer set search_path = public
as $$
declare _ao int; _bo int; _an text; _bn text;
begin
  if not pf_is_treasurer() then
    raise exception 'Only the treasurer can change the payout order';
  end if;
  if _a = _b then
    raise exception 'Pick two different members';
  end if;
  select member_order, name into _ao, _an from members where id = _a;
  select member_order, name into _bo, _bn from members where id = _b;
  if _ao is null or _bo is null then
    raise exception 'That member is not on the roster';
  end if;

  -- REFUSED for a released round, for the treasurer too. Not a new rule: the
  -- Reorder screen's own note already promises "rounds already paid out keep
  -- their recipient". The record does keep it (payouts.recipient_member_id is
  -- stamped at release) but almost every SCREEN derives the recipient from
  -- member_order, so moving a paid-out position shows one member as having
  -- received a ₱30,000 they never got and the real recipient as still owed.
  if pf_round_released(_ao) then raise exception 'Round % has already been paid out', _ao; end if;
  if pf_round_released(_bo) then raise exception 'Round % has already been paid out', _bo; end if;

  set constraints all deferred;
  update members set member_order = case id when _a then _bo else _ao end
   where id in (_a, _b);

  insert into activity_log (message, event_type, member_id, round_number)
  values (format('Payout order: %s swapped positions with %s (Round %s <-> Round %s)',
                 _an, _bn, _ao, _bo),
          'admin', _a, least(_ao, _bo));

  return query select * from members order by member_order;
end $$;

create or replace function pf_decline_swap(_request uuid)
  returns swap_requests
  language plpgsql security definer set search_path = public
as $$
declare _me uuid; _r swap_requests;
begin
  _me := pf_member_id();
  select * into _r from swap_requests where id = _request for update;
  if _r.id is null then raise exception 'That swap request no longer exists'; end if;
  if _r.to_member_id is distinct from _me then
    raise exception 'Only the member who was asked can decline this swap';
  end if;
  if _r.status <> 'pending' then
    raise exception 'That swap request was already %', _r.status;
  end if;
  update swap_requests set status = 'declined', resolved_at = now() where id = _r.id
  returning * into _r;
  return _r;
end $$;

create or replace function pf_cancel_swap(_request uuid)
  returns swap_requests
  language plpgsql security definer set search_path = public
as $$
declare _me uuid; _r swap_requests;
begin
  _me := pf_member_id();
  select * into _r from swap_requests where id = _request for update;
  if _r.id is null then raise exception 'That swap request no longer exists'; end if;
  if _r.from_member_id is distinct from _me then
    raise exception 'Only the member who asked can cancel this swap';
  end if;
  if _r.status <> 'pending' then
    raise exception 'That swap request was already %', _r.status;
  end if;
  update swap_requests set status = 'cancelled', resolved_at = now() where id = _r.id
  returning * into _r;
  return _r;
end $$;

revoke all on function pf_request_swap(uuid, text) from public;
revoke all on function pf_accept_swap(uuid)  from public;
revoke all on function pf_decline_swap(uuid) from public;
revoke all on function pf_cancel_swap(uuid)  from public;
revoke all on function pf_swap_order(uuid, uuid) from public;
revoke all on function pf_round_released(int) from public;
grant execute on function pf_request_swap(uuid, text) to authenticated;
grant execute on function pf_accept_swap(uuid)  to authenticated;
grant execute on function pf_decline_swap(uuid) to authenticated;
grant execute on function pf_cancel_swap(uuid)  to authenticated;
grant execute on function pf_swap_order(uuid, uuid) to authenticated;
grant execute on function pf_round_released(int) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) pf_members_guard() learns the mutual-swap exemption.
--
-- The trigger fires even for a security-definer caller, and `pf_is_treasurer()`
-- inside it reads the CALLER's auth.uid() — so without this, pf_accept_swap
-- would be refused 'Only the treasurer can change the payout order' for the
-- ordinary member it exists to serve.
--
-- Signalled by a TRANSACTION-LOCAL GUC that only pf_accept_swap sets. A
-- browser cannot set it: PostgREST exposes only functions in the public
-- schema, and `set_config` lives in pg_catalog. Every other column is pinned
-- here, exactly like the claim exemption above it, so the flag can move a
-- position and nothing else.
--
-- The rest of the function is UNCHANGED from 010.
-- ---------------------------------------------------------------------------
create or replace function pf_members_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if auth.uid() is null then
    return new; -- pre-auth behaviour, unchanged
  end if;
  if pf_is_treasurer() then
    return new; -- the treasurer may reorder, flag and re-address anyone
  end if;

  -- A MUTUAL SWAP, applied by pf_accept_swap after both members agreed. Only
  -- member_order may move; the flag cannot smuggle anything else through.
  if current_setting('pf.swap_ok', true) = 'yes'
     and new.id            is not distinct from old.id
     and new.name          is not distinct from old.name
     and new.is_treasurer  is not distinct from old.is_treasurer
     and new.email         is not distinct from old.email
     and new.auth_user_id  is not distinct from old.auth_user_id
  then
    return new;
  end if;

  -- A CLAIM: an unlinked row being attached to the caller, changing nothing
  -- else. This has to come before the ownership test below, because at claim
  -- time the caller owns no row yet — pf_member_id() is still null, so the
  -- ownership test would reject the very update that establishes ownership,
  -- and no first login could ever link. Every other column is pinned here so
  -- this exemption cannot be used to smuggle through anything but the link.
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
  -- Claiming an unclaimed row is allowed (that is pf_claim_member's update);
  -- moving or clearing an existing link is not.
  if old.auth_user_id is not null and new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'Only the treasurer can unlink an account';
  end if;

  return new;
end $$;


commit;

-- VERIFY:
--   select conname, condeferrable from pg_constraint
--    where conrelid = 'members'::regclass and contype = 'u';   -- t
--   select proname from pg_proc where proname like 'pf_%swap%';
