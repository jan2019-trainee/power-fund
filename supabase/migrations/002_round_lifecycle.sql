-- ===========================================================================
-- Migration 002 — "Start next round" support
--
-- WHAT IT DOES
--   Adds ONE nullable column to the existing `payouts` table:
--       started_at  timestamptz
--   and backfills it so nothing changes visually.
--
--   `started_at` records when the treasurer pressed "Start Next Round" for that
--   round. It is the ONLY new state the round workflow needs. Payout release
--   already uses the existing columns `released`, `released_on`, and `note`.
--
-- WHY YOU NEED IT
--   Without this column, clicking "Start Next Round" fails with
--       Could not find the 'started_at' column of 'payouts' in the schema cache
--   Until it is run, the app quietly falls back to the older behaviour (the
--   active round is simply the first one not yet at ₱30,000) and every other
--   feature — including "Mark payout released" — keeps working.
--
-- SAFETY
--   * Does NOT drop or recreate any table.
--   * Does NOT touch contributions, cycles, members, or round totals.
--   * Keeps every existing `released` / `released_on` / `note` value.
--   * Safe to run more than once (`add column if not exists`, idempotent backfill).
--
-- HOW TO RUN
--   Supabase dashboard -> SQL Editor -> New query -> paste this file -> Run.
-- ===========================================================================

alter table payouts add column if not exists started_at timestamptz;

-- Backfill so existing progress keeps displaying correctly:
--   * round 1 is always "started"
--   * any round that already has at least one contribution is "started"
update payouts p
set started_at = coalesce(p.started_at, now())
where p.round_number = 1
   or exists (
     select 1
     from contributions c
     join cycles cy on cy.id = c.cycle_id
     where cy.cycle_number between (p.round_number - 1) * 6 + 1
                              and  p.round_number * 6
   );
