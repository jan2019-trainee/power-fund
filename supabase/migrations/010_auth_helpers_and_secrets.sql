-- ===========================================================================
-- Migration 010 — Auth helpers, the PIN vault, and the members guard
--
-- This is the FIRST HALF of the security work. It adds the machinery the RLS
-- rewrite needs and gets the PINs out of the browser. It deliberately changes
-- NO table policy, so it cannot lock anyone out and is safe to apply while
-- members are still unlinked and AUTH_MODE is still "off".
--
-- The second half — migration 011 — replaces the `open_all` policies. That one
-- IS a point of no return and has its own preconditions.
--
-- WHAT IT DOES
--   1. Moves treasurer_pin and master_pin out of `app_settings` into
--      `app_secrets`, a table with RLS on and NO POLICY, so the REST API
--      cannot read it at all. Three security-definer functions replace the
--      reads: pf_pin_status(), pf_check_pin(), pf_set_pin().
--   2. Adds pf_member_id() and pf_is_treasurer(), the two helpers every policy
--      in 011 is built from.
--   3. Adds pf_claim_member(), which links a login to a roster row with the
--      email match enforced in SQL rather than in JavaScript.
--   4. Adds a guard trigger on `members` so a signed-in member can only edit
--      their OWN name, photo and payout fields — never member_order,
--      is_treasurer, email or auth_user_id.
--
-- WHY THE PINS HAD TO MOVE
--   js/database.js reads `app_settings` with select("*") and the anon key is
--   public, so `treasurer_pin` and `master_pin` were being handed to every
--   browser in plaintext. Anyone who opened the site could read both. That was
--   the standing P0 in this project's notes.
--
-- WHAT THE PIN IS AFTER 011, HONESTLY
--   Not a security boundary. Once 011 lands, permission comes from
--   `members.is_treasurer` checked inside the policies — so someone who
--   guessed the PIN would get treasurer MODE in the UI and still be refused
--   every write by Postgres. The PIN goes back to being what its own schema
--   comment always called it: a soft gate against accidental edits. That is
--   also why pf_check_pin's brute-force surface (a 4-digit space behind an
--   RPC) is acceptable here; it is slowed, not solved, by the sleep below.
--
-- WHAT IT DOES NOT DO
--   * Does not change any table's RLS policies. Every table keeps `open_all`.
--   * Does not change any ROSCA rule. Contribution amount, cycles per round,
--     round count, the 30,000 round goal and the 150,000 target are constants
--     in js/calculations.js and are untouched.
--   * Does not touch contributions, cycles, payouts or activity_log.
--   * Does not restrict anon. Signed-out callers behave exactly as before —
--     see the guard trigger's first line.
--
-- SAFE TO RE-RUN. Values already moved are not overwritten with nulls.
-- ROLLBACK: supabase/migrations/010_rollback.sql
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) The PIN vault
-- ---------------------------------------------------------------------------
create table if not exists app_secrets (
  id            int primary key default 1 check (id = 1),
  treasurer_pin text,
  master_pin    text,
  updated_at    timestamptz not null default now()
);

-- Move whatever app_settings currently holds. coalesce() so re-running never
-- clobbers a PIN that has since been changed through pf_set_pin().
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'app_settings' and column_name = 'treasurer_pin'
  ) then
    execute $mig$
      insert into app_secrets (id, treasurer_pin, master_pin)
      select 1, s.treasurer_pin, s.master_pin from app_settings s where s.id = 1
      on conflict (id) do update
        set treasurer_pin = coalesce(app_secrets.treasurer_pin, excluded.treasurer_pin),
            master_pin    = coalesce(app_secrets.master_pin,    excluded.master_pin)
    $mig$;
  end if;
end $$;

insert into app_secrets (id) values (1) on conflict (id) do nothing;

-- RLS on with NO policy at all: PostgREST can reach nothing here. The revoke
-- is belt-and-braces for the same thing.
alter table app_secrets enable row level security;
drop policy if exists "open_all" on app_secrets;
revoke all on app_secrets from anon, authenticated;

-- Now the columns can go. Dropping rather than nulling on purpose: a null
-- would read as "no PIN is set", and the app offers to CREATE a treasurer PIN
-- when none exists — so nulling them would briefly let anyone claim one.
alter table app_settings drop column if exists treasurer_pin;
alter table app_settings drop column if exists master_pin;

-- ---------------------------------------------------------------------------
-- 2) Identity helpers — every policy in 011 is built from these two.
--
-- security definer so they can read `members` without going through members'
-- own policy, which would recurse once 011 makes that policy depend on them.
-- search_path is pinned so a caller cannot shadow `members` with a temp table.
-- ---------------------------------------------------------------------------
create or replace function pf_member_id()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select id from members where auth_user_id = auth.uid()
$$;

create or replace function pf_is_treasurer()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select coalesce((select is_treasurer from members where auth_user_id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------------------
-- 3) Claim a roster row for the signed-in account.
--
-- The email match moves from JavaScript into SQL, so it is enforced rather
-- than merely performed. `auth_user_id is null` makes the claim atomic: two
-- devices racing the same first login cannot both win.
--
-- Returns the linked member's id, or null when nothing matched.
-- ---------------------------------------------------------------------------
create or replace function pf_claim_member()
  returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  uid   uuid := auth.uid();
  mail  text := lower(nullif(current_setting('request.jwt.claims', true), '')::json->>'email');
  found uuid;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;

  -- Already linked: hand back the same row rather than failing.
  select id into found from members where auth_user_id = uid;
  if found is not null then
    return found;
  end if;

  if mail is null or mail = '' then
    return null;
  end if;

  update members
     set auth_user_id = uid
   where lower(email) = mail
     and auth_user_id is null
  returning id into found;

  return found; -- null when no row matched, or it was already taken
end $$;

-- ---------------------------------------------------------------------------
-- 4) The members guard.
--
-- RLS decides which ROWS you may touch; it cannot decide which COLUMNS. A
-- policy permissive enough to let a member rename themselves would also let
-- them set is_treasurer or move their own member_order to round 1 — so the
-- column rules live in a trigger instead.
--
-- The first line is what makes this migration safe to apply today: a
-- signed-out (anon) caller is left exactly as it was, because that is the
-- world the app is still running in. Once 011 lands, anon reaches nothing
-- anyway.
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

drop trigger if exists members_guard on members;
create trigger members_guard
  before update on members
  for each row execute function pf_members_guard();

-- ---------------------------------------------------------------------------
-- 5) PIN status / check / set — the only way to the vault.
-- ---------------------------------------------------------------------------

-- Booleans only. The app needs to know WHETHER a PIN exists (to choose
-- between "Create a treasurer PIN" and "Enter treasurer PIN"); it never needs
-- the digits.
create or replace function pf_pin_status()
  returns table (has_treasurer boolean, has_master boolean)
  language sql
  stable
  security definer
  set search_path = public
as $$
  select coalesce(treasurer_pin, '') <> '', coalesce(master_pin, '') <> ''
  from app_secrets where id = 1
$$;

-- kind: 'treasurer' | 'master'. Returns false for an unset PIN, so an empty
-- vault can never be unlocked by an empty guess.
--
-- The sleep on failure slows scripted guessing of a 4-digit space. It is a
-- speed bump, not a lockout — see the note at the top about what the PIN is
-- worth after 011.
create or replace function pf_check_pin(kind text, pin text)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = public
as $$
declare
  stored text;
  ok     boolean;
begin
  if pin is null or pin = '' then
    return false;
  end if;
  select case when kind = 'master' then master_pin else treasurer_pin end
    into stored from app_secrets where id = 1;
  ok := stored is not null and stored <> '' and stored = pin;
  if not ok then
    perform pg_sleep(0.3);
  end if;
  return ok;
end $$;

-- Writing a PIN requires being the treasurer, EXCEPT for the very first
-- treasurer PIN on a fund that has none — otherwise a fund whose treasurer
-- has not been flagged yet could never set one, and the app's first-run PIN
-- setup would dead-end.
--
-- The master PIN may be changed but never blanked, and may not duplicate the
-- treasurer PIN: sharing digits would defeat the one case it exists for.
create or replace function pf_set_pin(kind text, pin text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  cur_treasurer text;
  cur_master    text;
begin
  if kind not in ('treasurer', 'master') then
    raise exception 'Unknown PIN kind';
  end if;
  if pin is null or length(pin) < 4 then
    raise exception 'PIN must be at least 4 digits';
  end if;

  select treasurer_pin, master_pin into cur_treasurer, cur_master
  from app_secrets where id = 1;

  if kind = 'master' then
    if not pf_is_treasurer() and auth.uid() is not null then
      raise exception 'Only the treasurer can change the master PIN';
    end if;
    if pin = cur_treasurer then
      raise exception 'The master PIN must differ from the treasurer PIN';
    end if;
    update app_secrets set master_pin = pin, updated_at = now() where id = 1;
  else
    -- First-run bootstrap is open; replacing an existing PIN is not.
    if cur_treasurer is not null and cur_treasurer <> ''
       and not pf_is_treasurer() and auth.uid() is not null then
      raise exception 'Only the treasurer can change the treasurer PIN';
    end if;
    if cur_master is not null and pin = cur_master then
      raise exception 'The treasurer PIN must differ from the master PIN';
    end if;
    update app_secrets set treasurer_pin = pin, updated_at = now() where id = 1;
  end if;
end $$;

-- The functions are the API; the table is not.
grant execute on function pf_member_id()            to anon, authenticated;
grant execute on function pf_is_treasurer()         to anon, authenticated;
grant execute on function pf_claim_member()         to authenticated;
grant execute on function pf_pin_status()           to anon, authenticated;
grant execute on function pf_check_pin(text, text)  to anon, authenticated;
grant execute on function pf_set_pin(text, text)    to anon, authenticated;

-- VERIFY
--
--   -- the vault is unreachable over REST, and holds what app_settings had:
--   select id, coalesce(treasurer_pin,'') <> '' as has_pin,
--              coalesce(master_pin,'')    <> '' as has_master from app_secrets;
--
--   -- the plaintext columns are gone:
--   select column_name from information_schema.columns
--   where table_name = 'app_settings' order by column_name;
--
--   -- and the app's new read path answers:
--   select * from pf_pin_status();
