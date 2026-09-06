-- ===========================================================================
-- Migration 003 — Treasurer-uploadable payment QR code
--
-- WHAT IT DOES
--   1. Adds three nullable columns to the existing single-row `app_settings`:
--          qr_code_url    text          -- public URL of the current QR image
--          qr_updated_at  timestamptz   -- when it was last replaced
--          qr_updated_by  text          -- free-text label (no auth in this app)
--   2. Creates a public Storage bucket `payment-assets` for the QR image
--      (kept separate from `payment-proofs` so "Reset all data" never touches it).
--   3. Adds open read/write/delete policies on that bucket (same posture as the
--      rest of this no-auth app — see the security note in README).
--   4. Adds `app_settings` to the realtime publication so a QR change on one
--      device reaches the others without a manual refresh.
--
-- WHY YOU NEED IT
--   Without it, "Payment QR -> Upload" fails with a missing-column or
--   missing-bucket error. Until it is run the app keeps showing the QR bundled
--   at assets/gcash-qr.jpg and every other feature works normally.
--
-- SAFETY
--   * Only ADDS columns / a bucket / policies. Drops nothing.
--   * Does not touch contributions, cycles, members, payouts, or the PIN.
--   * Safe to run more than once (idempotent).
--
-- HOW TO RUN
--   Supabase dashboard -> SQL Editor -> New query -> paste this file -> Run.
-- ===========================================================================

alter table app_settings add column if not exists qr_code_url   text;
alter table app_settings add column if not exists qr_updated_at timestamptz;
alter table app_settings add column if not exists qr_updated_by text;

-- Storage bucket for the QR image
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

-- Realtime: push QR changes to other open devices
do $$
begin
  alter publication supabase_realtime add table app_settings;
exception when duplicate_object then null;
end $$;
