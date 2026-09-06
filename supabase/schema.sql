-- ===========================================================================
-- Power Fund — database schema
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: it drops and recreates the tables. RE-RUNNING DELETES DATA,
-- so only re-run on a fresh project or when you intend to wipe everything.
--
-- After this, run seed.sql to create the 5 members, 30 cycles and 5 payout rows.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
drop table if exists contributions cascade;
drop table if exists cycles       cascade;
drop table if exists payouts      cascade;
drop table if exists activity_log cascade;
drop table if exists app_settings cascade;
drop table if exists members      cascade;

create table members (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  member_order int  not null unique,          -- 1..5, drives the payout rotation
  created_at   timestamptz not null default now()
);

create table cycles (
  id           uuid primary key default gen_random_uuid(),
  cycle_number int  not null unique,          -- 1..30
  due_date     date not null,                 -- edit freely; the app reads these
  created_at   timestamptz not null default now()
);

create table contributions (
  id         uuid primary key default gen_random_uuid(),
  cycle_id   uuid not null references cycles(id)  on delete cascade,
  member_id  uuid not null references members(id) on delete cascade,
  amount     numeric(10,2) not null default 1000 check (amount >= 0),  -- money: never float
  status     smallint not null default 0 check (status in (0, 1, 2)),  -- 0 unpaid / 1 pending / 2 paid
  proof_url  text,                             -- public URL of the screenshot in Storage
  notes      text,
  paid_at    timestamptz,
  created_at timestamptz not null default now(),
  -- one contribution row per member per cycle (enforced by the database, not just JS)
  unique (cycle_id, member_id),
  -- a "pending review" claim (status 1) must carry a proof-of-payment URL.
  -- status 0 (unpaid) and status 2 (treasurer-recorded / confirmed) are not
  -- constrained, so cash payments and existing data keep working.
  constraint contributions_pending_requires_proof
    check (status <> 1 or proof_url is not null)
);

create index contributions_cycle_idx  on contributions (cycle_id);
create index contributions_member_idx on contributions (member_id);

create table payouts (
  round_number  int primary key check (round_number between 1 and 5),
  released      boolean not null default false,  -- payout released => round COMPLETED
  note          text,                            -- optional payout note ("Bought BLUETTI…")
  released_on   date,                             -- when the payout was released
  started_at    timestamptz,                      -- when the treasurer started this round (round 1 seeded)
  created_at    timestamptz not null default now()
);
-- Round status is derived, not stored:
--   released = true                     -> COMPLETED  (payout released)
--   confirmed contributions >= 30,000   -> PAYOUT PENDING
--   started_at is not null              -> COLLECTING
--   otherwise                           -> not started
-- The "current" round = the highest round_number whose started_at is set.
-- "Mark payout released" and "Start next round" are independent actions.

create table activity_log (
  id         uuid primary key default gen_random_uuid(),
  message    text not null,
  created_at timestamptz not null default now()
);

create index activity_log_created_idx on activity_log (created_at desc);

create table app_settings (
  id            int primary key default 1 check (id = 1),  -- single-row table
  treasurer_pin text,                                      -- soft UI gate, NOT security
  qr_code_url   text,                                      -- public URL of the current payment QR (Storage)
  qr_updated_at timestamptz,                               -- when the QR was last replaced
  qr_updated_by text,                                      -- free-text label ("treasurer"); no auth here
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- There is NO authentication in this app. It is "private by URL": anyone who
-- has the site URL can read the anon key from js/config.js and then read and
-- write everything below. These policies exist only because Supabase blocks
-- all access to an RLS-enabled table that has no policy — they do NOT provide
-- user-level security, because there are no users. See README.
-- ---------------------------------------------------------------------------
alter table members       enable row level security;
alter table cycles        enable row level security;
alter table contributions enable row level security;
alter table payouts       enable row level security;
alter table activity_log  enable row level security;
alter table app_settings  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['members','cycles','contributions','payouts','activity_log','app_settings']
  loop
    execute format('drop policy if exists "open_all" on %I;', t);
    execute format(
      'create policy "open_all" on %I for all to anon, authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime — let the browser subscribe to changes
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table contributions;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table payouts;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table members;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table activity_log;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table app_settings;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Storage bucket for payment screenshots
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('payment-proofs', 'payment-proofs', true)
on conflict (id) do update set public = true;

drop policy if exists "proofs_read"   on storage.objects;
drop policy if exists "proofs_write"  on storage.objects;
drop policy if exists "proofs_update" on storage.objects;
drop policy if exists "proofs_delete" on storage.objects;

create policy "proofs_read"   on storage.objects for select to anon, authenticated
  using (bucket_id = 'payment-proofs');
create policy "proofs_write"  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'payment-proofs');
create policy "proofs_update" on storage.objects for update to anon, authenticated
  using (bucket_id = 'payment-proofs') with check (bucket_id = 'payment-proofs');
create policy "proofs_delete" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'payment-proofs');

-- ---------------------------------------------------------------------------
-- Storage bucket for treasurer-managed assets (the payment QR code)
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
