-- ===========================================================================
-- Migration 009 — Storage for member profile photos
--
-- WHAT IT DOES
--   Creates the public `member-avatars` bucket and its four policies.
--
-- WHY
--   `members.avatar_url` has existed since migration 006, which reserved it
--   and nothing more — no bucket, no writer, no reader. The approved design
--   has two screens that need it (EditProfile.dc.html taps its avatar to reach
--   ProfilePhotoSheet.dc.html: Take Photo / Choose from Library / Remove
--   Photo), so the column finally gets somewhere to point.
--
--   A separate bucket rather than reusing `payment-assets`: avatars are the one
--   thing here a member uploads about themselves, and keeping them apart means
--   a later RLS pass can scope avatar writes per user without touching the
--   treasurer's QR assets, and clearing all avatars never risks the payment QR.
--
-- WHAT IT DOES NOT DO
--   * Does not change any table. `members.avatar_url` already exists (006).
--   * Does not change RLS on any table. The bucket policies below are as open
--     as every other bucket in this project — see the note on scoping.
--   * Does not change any ROSCA rule. Contribution amount, cycles per round,
--     round count, the 30,000 round goal and the 150,000 target are constants
--     in js/calculations.js and are untouched.
--   * Writes no data and touches no existing object.
--
-- SCOPING, HONESTLY
--   These policies allow any anon or authenticated caller to write and delete
--   in this bucket, exactly like `payment-proofs` and `payment-assets`. So
--   today a member could in principle replace someone else's photo. The app
--   does not offer that — it only ever writes the signed-in member's own
--   avatar — but the app is not the boundary; RLS is, and RLS is still open
--   project-wide. The later RLS migration is where this gets scoped to
--   `auth.uid()`, along with the tables. Called out here so nobody reads these
--   policies as a considered permission model. They are the status quo.
--
-- SAFE TO RE-RUN
--   The bucket upserts; the policies are dropped and recreated.
-- ===========================================================================

insert into storage.buckets (id, name, public)
values ('member-avatars', 'member-avatars', true)
on conflict (id) do update set public = true;

drop policy if exists "member_avatars_read"   on storage.objects;
drop policy if exists "member_avatars_write"  on storage.objects;
drop policy if exists "member_avatars_update" on storage.objects;
drop policy if exists "member_avatars_delete" on storage.objects;

create policy "member_avatars_read"   on storage.objects for select to anon, authenticated
  using (bucket_id = 'member-avatars');
create policy "member_avatars_write"  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'member-avatars');
create policy "member_avatars_update" on storage.objects for update to anon, authenticated
  using (bucket_id = 'member-avatars') with check (bucket_id = 'member-avatars');
create policy "member_avatars_delete" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'member-avatars');

-- VERIFY — should return one row, public = true:
--
--   select id, public from storage.buckets where id = 'member-avatars';
--
-- ...and four policies:
--
--   select policyname from pg_policies
--   where tablename = 'objects' and policyname like 'member_avatars%';
