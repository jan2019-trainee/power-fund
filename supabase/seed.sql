-- ===========================================================================
-- Power Fund — seed data
--
-- Run AFTER schema.sql. Safe to re-run: uses "on conflict do nothing", so it
-- fills in anything missing without touching existing rows or contributions.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Members  (names are placeholders — change them any time, in the app or here)
-- ---------------------------------------------------------------------------
insert into members (name, member_order) values
  ('Regine', 1),
  ('Sarah',  2),
  ('Jan',    3),
  ('Clara',  4),
  ('Verdz',  5)
on conflict (member_order) do nothing;

-- ---------------------------------------------------------------------------
-- 2) Cycles — 30 cycles, 2 per month.
--
--    Cycle 1 falls on FIRST_CYCLE_DATE. Odd cycles land on the 15th, even
--    cycles on the last day of that same month, advancing one month every
--    2 cycles. To shift the whole schedule, change the date on the next line.
--    To tweak one date, just edit that row in the "cycles" table afterwards.
-- ---------------------------------------------------------------------------
with params as (
  select date '2026-09-15' as first_cycle_date   -- <== EDIT ME to move the schedule
),
gen as (
  select
    n as cycle_number,
    case
      when (n - 1) % 2 = 0
        then ( (select first_cycle_date from params) + (((n - 1) / 2) || ' months')::interval )::date
      else (
        date_trunc(
          'month',
          (select first_cycle_date from params) + (((n - 1) / 2) || ' months')::interval
        ) + interval '1 month' - interval '1 day'
      )::date
    end as due_date
  from generate_series(1, 30) as n
)
insert into cycles (cycle_number, due_date)
select cycle_number, due_date from gen
on conflict (cycle_number) do nothing;

-- ---------------------------------------------------------------------------
-- 3) Payout rows — one per round (member whose member_order = round gets paid).
--    Round 1 starts active; the treasurer starts rounds 2-5 from the app.
-- ---------------------------------------------------------------------------
insert into payouts (round_number, started_at) values
  (1, now()),
  (2, null),
  (3, null),
  (4, null),
  (5, null)
on conflict (round_number) do nothing;

-- ---------------------------------------------------------------------------
-- 4) Settings — single row, PIN starts empty (set it in the app on first unlock)
-- ---------------------------------------------------------------------------
insert into app_settings (id, treasurer_pin) values (1, null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Check
-- ---------------------------------------------------------------------------
-- select 'members' t, count(*) from members
-- union all select 'cycles',  count(*) from cycles
-- union all select 'payouts', count(*) from payouts;
