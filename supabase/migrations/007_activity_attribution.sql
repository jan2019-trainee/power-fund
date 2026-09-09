-- ===========================================================================
-- Migration 007 — Activity attribution
--
-- WHAT IT DOES
--   Adds two nullable columns to activity_log so a log row can say WHO it was
--   about and WHICH ROUND it belongs to:
--
--        member_id     uuid      -- references members(id), null when not about one member
--        round_number  smallint  -- 1..5, null when the event is not round-scoped
--
-- WHY
--   The approved design's desktop Activity screen (DesktopActivity.dc.html) is
--   a six-column table — Date, Member, Type, Round, Amount, Status — with two
--   dropdown filters, "All members" and a round selector defaulting to the
--   fund's current round.
--
--   Neither column can be built from what activity_log holds today. The table
--   stores a free-text `message` plus, since migration 006, event_type, amount
--   and ref_status. The member's name appears only INSIDE the message, and the
--   round appears there only sometimes ("Payout released — Round 1 (Ana)") and
--   otherwise not at all ("Ana marked cycle 8 as sent").
--
--   Deriving them by matching names in the message text was considered and
--   rejected: those messages snapshot the member's name at the moment they
--   were written, and the app can rename members (Menu -> Edit member names,
--   which itself logs "Name(s) updated: ..."). After a rename, a filter built
--   from CURRENT member names silently stops matching that member's older
--   rows — a filtered view of financial history that quietly omits records.
--   Wrong, and wrong without saying so. Hence real columns.
--
-- WHAT IT DOES NOT DO
--   * Does not change any ROSCA rule. Contribution amount, cycles per round,
--     round count, the 30,000 round goal and the 150,000 target are constants
--     in js/calculations.js and are untouched here.
--   * Does not change how funding is derived. Round funding still comes from
--     CONFIRMED contributions (status 2) in `contributions`. activity_log is
--     an audit trail and is never summed for money.
--   * Does not change RLS. activity_log already carries the open_all policy
--     from schema.sql; new columns inherit it. No policy is added or altered.
--   * Does not backfill. See below — this is deliberate.
--
-- BACKFILL: NONE, ON PURPOSE
--   Existing rows keep null in both columns and the UI renders them as "—".
--   The only way to fill them retroactively is the same name-matching this
--   migration exists to avoid, so a backfill would manufacture attribution
--   that may be wrong for exactly the rows most likely to matter (anything
--   written before a rename). An honest "—" beats a confident guess about who
--   a financial record belongs to.
--
--   Consequence to know about: rows written before this migration will not
--   appear under a member or round filter. The unfiltered view still shows
--   every row, and the count in the header still reflects the whole log.
--
-- SAFETY
--   * Only ADDS columns. Both are nullable with no default, so every existing
--     row stays valid and every existing INSERT keeps working unchanged.
--   * ON DELETE SET NULL on member_id: removing a member must never delete
--     their audit trail, and the roster is read-only mid-fund anyway
--     (canvas.json, gap5 annotation). The log row survives, unattributed.
--   * Re-runnable. Every statement is IF NOT EXISTS / guarded.
--   * The app tolerates this migration being absent: js/database.js retries
--     the insert without the new columns and warns, exactly as it already
--     does for migration 006.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. Who the event was about.
--    Nullable: plenty of events are not about one member (a reset, a PIN
--    change, a QR update, a round start).
-- --------------------------------------------------------------------------
alter table activity_log add column if not exists member_id uuid;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'activity_log_member_id_fkey'
      and table_name = 'activity_log'
  ) then
    alter table activity_log
      add constraint activity_log_member_id_fkey
      foreign key (member_id) references members(id) on delete set null;
  end if;
end $$;

-- --------------------------------------------------------------------------
-- 2. Which round the event belongs to.
--    Nullable: fund-wide admin events (reset, restore, PIN) belong to no
--    round. Constrained to the fund's real round range rather than left open,
--    so a bad write fails loudly instead of creating a filter value that
--    matches nothing.
-- --------------------------------------------------------------------------
alter table activity_log add column if not exists round_number smallint;

do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where constraint_name = 'activity_log_round_number_check'
      and table_name = 'activity_log'
  ) then
    alter table activity_log
      add constraint activity_log_round_number_check
      check (round_number is null or (round_number >= 1 and round_number <= 5));
  end if;
end $$;

-- --------------------------------------------------------------------------
-- 3. Indexes for the two new filters. The log is small today (one row per
--    action for a five-person fund), but both columns exist to be filtered on
--    and these cost nothing at this size.
-- --------------------------------------------------------------------------
create index if not exists activity_log_member_id_idx    on activity_log (member_id);
create index if not exists activity_log_round_number_idx on activity_log (round_number);

-- --------------------------------------------------------------------------
-- VERIFY (paste separately after running the above):
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_name = 'activity_log'
--      and column_name in ('member_id', 'round_number');
--
--   -- expect two rows, both is_nullable = YES
-- --------------------------------------------------------------------------
