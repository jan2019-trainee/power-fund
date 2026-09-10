-- ===========================================================================
-- Migration 011 — PREFLIGHT CHECK (read-only, safe to run any time)
--
-- Run this BEFORE 011_rls_lockdown.sql. It creates pf_rls_readiness() and
-- shows you what is still missing. It changes no policy and no data.
--
-- 011 replaces every `open_all` policy with real per-member rules keyed off
-- `members.auth_user_id`. A member with no email can never link, and an
-- unlinked member is denied everything once those policies are live — so this
-- exists to make "am I ready?" a question with a definite answer instead of a
-- guess.
--
-- The lockdown migration calls this same function and REFUSES to run while
-- anything is outstanding, so a mistimed paste cannot lock the group out.
-- ===========================================================================

create or replace function pf_rls_readiness()
  returns table (
    check_name text,
    ok         boolean,
    detail     text
  )
  language sql
  stable
  security definer
  set search_path = public
as $$
  -- Every member needs an address, or they can never link.
  select
    'every member has an email',
    count(*) filter (where coalesce(email, '') = '') = 0,
    case when count(*) filter (where coalesce(email, '') = '') = 0
         then count(*)::text || ' of ' || count(*)::text || ' have one'
         else 'missing: ' || coalesce(
                string_agg(name, ', ') filter (where coalesce(email, '') = ''), '')
    end
  from members

  union all

  -- Exactly one treasurer. Zero means nobody can confirm a payment or release
  -- a payout ever again; more than one is probably a mistake worth seeing.
  select
    'exactly one treasurer',
    count(*) filter (where is_treasurer) = 1,
    case count(*) filter (where is_treasurer)
      when 0 then 'nobody is flagged is_treasurer'
      when 1 then 'treasurer: ' || coalesce(
                    string_agg(name, ', ') filter (where is_treasurer), '')
      else count(*) filter (where is_treasurer)::text || ' treasurers: ' ||
           coalesce(string_agg(name, ', ') filter (where is_treasurer), '')
    end
  from members

  union all

  -- Everyone has signed in at least once. This is the one people forget: the
  -- emails can all be set and the links still absent, and a link is what the
  -- policies actually read.
  select
    'every member has signed in at least once',
    count(*) filter (where auth_user_id is null) = 0,
    case when count(*) filter (where auth_user_id is null) = 0
         then 'all ' || count(*)::text || ' linked'
         else 'not yet signed in: ' || coalesce(
                string_agg(name, ', ') filter (where auth_user_id is null), '')
    end
  from members

  union all

  -- 010 must be in place: 011's policies are built entirely from its helpers.
  select
    'migration 010 applied',
    to_regprocedure('public.pf_is_treasurer()') is not null
      and to_regprocedure('public.pf_member_id()') is not null,
    case when to_regprocedure('public.pf_is_treasurer()') is not null
         then 'pf_is_treasurer() and pf_member_id() exist'
         else 'run 010_auth_helpers_and_secrets.sql first'
    end
$$;

grant execute on function pf_rls_readiness() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The answer. Every row must say `ok = true` before 011 will run.
-- ---------------------------------------------------------------------------
select * from pf_rls_readiness();

-- Useful alongside it — who is still missing what:
--
--   select member_order, name, coalesce(email,'(none)') as email,
--          is_treasurer, auth_user_id is not null as signed_in_once
--   from members order by member_order;
