-- ===========================================================================
-- Migration 010 — ROLLBACK
--
-- Puts the PINs back into `app_settings` as plaintext columns and removes the
-- helpers, the claim RPC and the members guard.
--
-- WHEN TO RUN THIS
--   Only if 010 broke the live app and you need it working in minutes. It
--   REINSTATES THE PLAINTEXT PIN EXPOSURE that 010 exists to close: after this,
--   `select("*")` on app_settings serves treasurer_pin and master_pin to every
--   browser again. Treat it as an emergency measure, not a resting state, and
--   re-apply 010 once the app is on the matching code.
--
-- If 011 has already been applied, run 011_rollback.sql FIRST — the policies
-- there depend on pf_member_id() and pf_is_treasurer(), which this drops.
--
-- SAFE TO RE-RUN.
-- ===========================================================================

begin;

-- 1) Columns back, values back. app_secrets is the source of truth right now,
--    so copy from it rather than trusting anything left in app_settings.
alter table app_settings add column if not exists treasurer_pin text;
alter table app_settings add column if not exists master_pin    text;

do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'app_secrets') then
    execute $roll$
      update app_settings s
         set treasurer_pin = k.treasurer_pin,
             master_pin    = k.master_pin
        from app_secrets k
       where s.id = 1 and k.id = 1
    $roll$;
  end if;
end $$;

-- 2) The guard trigger and its function.
drop trigger if exists members_guard on members;
drop function if exists pf_members_guard();

-- 3) The PIN API.
drop function if exists pf_set_pin(text, text);
drop function if exists pf_check_pin(text, text);
drop function if exists pf_pin_status();

-- 4) The claim RPC and the identity helpers. Dropped last: 3's functions do
--    not depend on them, but 011's policies do, hence the warning above.
drop function if exists pf_claim_member();
drop function if exists pf_is_treasurer();
drop function if exists pf_member_id();

-- 5) The vault. Kept by default — dropping it is the one irreversible step
--    here, and the PINs have just been copied out of it, so there is nothing
--    to gain by rushing. Uncomment only once app_settings is verified correct.
--
--   drop table if exists app_secrets;


commit;

-- VERIFY — both columns present again and populated:
--
--   select coalesce(treasurer_pin,'') <> '' as has_pin,
--          coalesce(master_pin,'')    <> '' as has_master
--   from app_settings where id = 1;
--
-- ...and the helpers gone:
--
--   select proname from pg_proc where proname like 'pf\_%';
