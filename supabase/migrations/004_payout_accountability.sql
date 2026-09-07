-- ===========================================================================
-- Migration 004 — Payout accountability
--
-- WHAT IT DOES
--   Adds five nullable columns to the existing `payouts` table so a released
--   payout stays historically correct even if members are later renamed,
--   reordered, or removed:
--       amount               numeric(10,2)  -- pesos actually paid out
--       recipient_member_id  uuid           -- link to the member (may become null)
--       recipient_name       text           -- name snapshot, taken at release time
--       receipt_url          text           -- optional receipt / proof image URL
--       released_by          text           -- free-text label (there is no auth here)
--   then backfills rows that are already released from the current member order.
--
--   It also makes sure the `payment-assets` storage bucket exists (an optional
--   payout receipt image is stored there, next to the payment QR). This is the
--   same bucket migration 003 creates — running both is safe.
--
--   The ROSCA rules are UNCHANGED:
--     * each round still targets 30,000 (GOAL_PER_ROUND in js/calculations.js)
--     * round funding is still derived from confirmed contributions only
--     * `amount` here is a historical record and never feeds any calculation
--
-- WHY YOU NEED IT
--   Without it, "Mark payout released" fails with a missing-column error. Until
--   it is run the app falls back to showing the recipient derived from the
--   current member order, and every other feature works normally.
--
-- SAFETY
--   * Only ADDS columns. Drops nothing. Every new column is nullable.
--   * Does not touch contributions, cycles, members, or round/cycle logic.
--   * Keeps every existing released / released_on / note / started_at value.
--   * Safe to run more than once (add column if not exists, guarded backfill).
--
-- HOW TO RUN
--   Supabase dashboard -> SQL Editor -> New query -> paste this file -> Run.
-- ===========================================================================

alter table payouts add column if not exists amount              numeric(10,2);
alter table payouts add column if not exists recipient_member_id uuid references members(id) on delete set null;
alter table payouts add column if not exists recipient_name      text;
alter table payouts add column if not exists receipt_url         text;
alter table payouts add column if not exists released_by         text;

do $$
begin
  alter table payouts add constraint payouts_amount_nonneg check (amount is null or amount >= 0);
exception when duplicate_object then null;
end $$;

-- Backfill rows that are already released (best-effort): the recipient of round N
-- is the member whose member_order = N in the CURRENT order. If members were
-- reordered before this migration was run, the `note` and the activity log are
-- the tiebreakers — from here on the snapshot is taken at release time.
update payouts p
set
  amount = coalesce(p.amount, 30000),
  recipient_member_id = coalesce(
    p.recipient_member_id,
    (select m.id   from members m where m.member_order = p.round_number)
  ),
  recipient_name = coalesce(
    p.recipient_name,
    (select m.name from members m where m.member_order = p.round_number)
  )
where p.released = true;

-- ---------------------------------------------------------------------------
-- Storage bucket for the optional payout receipt image (same bucket the
-- payment QR uses). Idempotent — safe whether or not migration 003 has run.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('payment-assets', 'payment-assets', true)
on conflict (id) do update set public = true;

drop policy if exists "payment_assets_read"   on storage.objects;
drop policy if exists "payment_assets_write"  on storage.objects;
drop policy if exists "payment_assets_update" on storage.objects;
drop policy if exists "payment_assets_delete" on storage.objects;

create policy "payment_assets_read"   on storage.objects for select to anon, authenticated
  using (bucket_id = 'payment-assets');
create policy "payment_assets_write"  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'payment-assets');
create policy "payment_assets_update" on storage.objects for update to anon, authenticated
  using (bucket_id = 'payment-assets') with check (bucket_id = 'payment-assets');
create policy "payment_assets_delete" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'payment-assets');
