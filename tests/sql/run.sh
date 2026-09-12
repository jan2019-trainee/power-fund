#!/usr/bin/env bash
# Validate the payout-details permission rules against a real PostgreSQL 16
# cluster. See tests/sql/README.md for what and why.
set -uo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
# A free port, not a fixed one: a stale cluster on the same port would be
# silently tested instead of ours, and its leftover schema fails the stub in a
# way that looks like a bug in the migration.
PORT=${PORT:-$(python3 -c "import socket;s=socket.socket();s.bind(('',0));print(s.getsockname()[1]);s.close()")}
DATA=${DATA:-/tmp/pf-sqltest-$$}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
MIG="$REPO/supabase/migrations"
WORK=$(mktemp -d)
FAILED=0

[ -x "$PGBIN/initdb" ] || { echo "postgresql-16 not found at $PGBIN — set PGBIN"; exit 2; }

# Postgres refuses to run as root, so drop to a non-root owner when we are.
AS=""
if [ "$(id -u)" = "0" ]; then
  id postgres >/dev/null 2>&1 || { echo "running as root and no 'postgres' user to drop to"; exit 2; }
  AS="postgres"
fi
sh_as() { if [ -n "$AS" ]; then su "$AS" -c "$1"; else sh -c "$1"; fi; }

cleanup() {
  sh_as "$PGBIN/pg_ctl -D $DATA stop -m immediate" >/dev/null 2>&1
  rm -rf "$DATA" "$WORK"
}
trap cleanup EXIT

mkdir -p "$DATA"; [ -n "$AS" ] && chown "$AS:$AS" "$DATA"; chmod 700 "$DATA"
sh_as "$PGBIN/initdb -D $DATA -U postgres --auth=trust" >/dev/null 2>&1 \
  || { echo "initdb failed"; exit 2; }
sh_as "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/log start" >/dev/null 2>&1
for _ in $(seq 1 20); do
  psql -h /tmp -p "$PORT" -U postgres -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 0.5
done
psql -h /tmp -p "$PORT" -U postgres -tAc 'select 1' >/dev/null 2>&1 \
  || { echo "cluster did not start; see $DATA/log"; exit 2; }

q() { psql -h /tmp -p "$PORT" -U postgres -tA "$@"; }

# ---------------------------------------------------------------------------
# Supabase's shapes, stubbed to their real definitions. The grants matter:
# without USAGE on the auth and storage schemas every policy denies for the
# wrong reason, which is a false pass on the DENY assertions.
# ---------------------------------------------------------------------------
q -q -v ON_ERROR_STOP=1 <<'SQL' || { echo "stub failed"; exit 2; }
create schema auth; create schema storage;
create role anon; create role authenticated;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function storage.foldername(name text) returns text[]
  language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts,1)-1];
end $$;
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null, name text not null, owner uuid);
alter table storage.objects enable row level security;
create table members (
  id uuid primary key default gen_random_uuid(), name text not null,
  -- `unique` MATTERS and was missing here, which is exactly why this harness
  -- could not see that the app's pair swap has never worked: schema.sql
  -- declares it, so the first of two sequential single-row updates always
  -- collides. Declared INLINE (not deferrable) like schema.sql, so 013's
  -- look-up-by-definition rewrite is exercised for real.
  member_order int not null unique, email text, auth_user_id uuid unique,
  is_treasurer boolean not null default false,
  payout_bank text, payout_account_name text, payout_account_number text,
  payout_qr_url text, payout_updated_at timestamptz);
alter table members enable row level security;
create table cycles (
  id uuid primary key default gen_random_uuid(),
  cycle_number int not null unique, due_date date not null);
alter table cycles enable row level security;
create table payouts (
  round_number int primary key,
  released boolean not null default false,
  note text, released_on date, started_at timestamptz,
  amount numeric(10,2), recipient_member_id uuid references members(id),
  recipient_name text, receipt_url text, released_by text,
  -- migration 012. Hand-stubbed like every other column here; the migration's
  -- own `alter table` is what adds them in a real deployment.
  received_at timestamptz, received_note text);
alter table payouts enable row level security;
-- pf_accept_swap() logs the agreement here, inside the same transaction, so a
-- swap can never be unrecorded. Columns as of 006/007.
create table activity_log (
  id uuid primary key default gen_random_uuid(), message text not null,
  created_at timestamptz not null default now(),
  event_type text, amount numeric(10,2), ref_status smallint,
  member_id uuid, round_number int);
alter table activity_log enable row level security;
create or replace function pf_member_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select id from members where auth_user_id = auth.uid() $$;
create or replace function pf_is_treasurer() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select is_treasurer from members where auth_user_id = auth.uid()), false) $$;
grant usage on schema auth, storage, public to anon, authenticated;
grant execute on function auth.uid(), storage.foldername(text) to anon, authenticated;
grant execute on function pf_member_id(), pf_is_treasurer() to anon, authenticated;
grant select, insert, update, delete on storage.objects, members, cycles, payouts, activity_log to anon, authenticated;
insert into members (id, name, member_order, email, auth_user_id, is_treasurer) values
 ('11111111-0000-0000-0000-000000000001','Regine',1,'r@x.com','aaaaaaaa-0000-0000-0000-00000000000a', true),
 ('11111111-0000-0000-0000-000000000002','Sarah', 2,'s@x.com','bbbbbbbb-0000-0000-0000-00000000000b', false),
 ('11111111-0000-0000-0000-000000000003','Verdz', 3,'v@x.com', null, false),
 -- Two LINKED members on UNRELEASED rounds. The swap flow needs them: every
 -- other member here is either on a paid-out round (1, 2) or has never signed
 -- in (Verdz), and both of those are refusals rather than the happy path.
 ('11111111-0000-0000-0000-000000000004','Clara', 4,'c@x.com','dddddddd-0000-0000-0000-00000000000d', false),
 ('11111111-0000-0000-0000-000000000005','Jan',   5,'j@x.com','eeeeeeee-0000-0000-0000-00000000000e', false);
insert into cycles (id, cycle_number, due_date) values
 ('22222222-0000-0000-0000-000000000001', 1, '2026-09-15'),
 ('22222222-0000-0000-0000-000000000002', 2, '2026-09-28');
-- Round 1 -> Regine, who is ALSO THE TREASURER. That combination is the norm
--   in a fund this size and is the case the first cut of the guard broke.
-- Round 2 -> Sarah, an ordinary member: the pure-recipient path, and the one
--   the column pinning has to be tested against (the treasurer may legitimately
--   change an amount, so testing pinning as the treasurer proves nothing).
-- Round 3 -> not released.
insert into payouts (round_number, released, released_on, amount,
                     recipient_member_id, recipient_name, released_by) values
 (1, true, '2026-09-20', 30000,
  '11111111-0000-0000-0000-000000000001', 'Regine', 'Regine'),
 (2, true, '2027-03-20', 30000,
  '11111111-0000-0000-0000-000000000002', 'Sarah', 'Regine'),
 (3, false, null, null, null, null, null),
 (4, false, null, null, null, null, null);
-- Round 5 deliberately has NO payouts row, so pf_round_released()'s
-- coalesce-to-false path is exercised rather than assumed.
SQL

# ---------------------------------------------------------------------------
# The policies under test, EXTRACTED from the migrations rather than copied —
# a duplicate that drifts from the migration proves nothing.
# ---------------------------------------------------------------------------
python3 - "$MIG" "$REPO" "$WORK" <<'PY' || { echo "could not extract policy text"; exit 2; }
import sys, pathlib
mig, repo, work = (pathlib.Path(p) for p in sys.argv[1:4])
lock  = (mig / "011_rls_lockdown.sql").read_text()
guard = (mig / "010_auth_helpers_and_secrets.sql").read_text()
ack   = (mig / "012_payout_receipt_confirmation.sql").read_text()
swap  = (mig / "013_turn_swaps.sql").read_text()
schema = (repo / "supabase" / "schema.sql").read_text()
def cut(s, start, end):
    i = s.index(start); j = s.index(end, i); return s[i:j]
(work / "policy.sql").write_text(
    # The bucket's READ policy comes from schema.sql and 011 deliberately
    # leaves it alone. It has to be here: `UPDATE ... WHERE` applies SELECT
    # policies as well as the UPDATE policy's USING clause, so without it a
    # member replacing their own QR matches 0 rows and the harness reports a
    # policy bug that does not exist in a real deployment.
    cut(schema, 'create policy "payment_assets_read"',
                'create policy "payment_assets_write"')
    + cut(lock, 'drop policy if exists members_read', '-- 3) cycles')
    # The schedule. Menu -> Payment schedule writes these, and the UI gates on
    # members.is_treasurer precisely because this policy does — so the gate is
    # only as real as what this section says.
    + cut(lock, 'drop policy if exists cycles_read', '-- 4) contributions')
    + cut(lock, 'drop policy if exists "payment_assets_write"',
                'drop policy if exists "member_avatars_write"')
    + cut(guard, 'create or replace function pf_members_guard()',
                 'for each row execute function pf_members_guard();')
    + 'for each row execute function pf_members_guard();\n'
    # 012: the recipient's acknowledgement. payouts_treasurer comes from 011
    # and must be here too — permissive policies are OR-ed, so testing the new
    # one alone would not show that the treasurer still has full access.
    + cut(lock, 'drop policy if exists payouts_read', '-- 6) activity_log')
    + cut(ack, 'drop policy if exists payouts_recipient_ack', 'commit;')
    # 013: turn swaps. Taken WHOLE (constraint rewrite, table, policies, the
    # four functions and the amended guard) because the pieces only work
    # together — and its `create or replace` of pf_members_guard deliberately
    # lands AFTER 010's above, which is the real deployment order.
    + cut(swap, '-- 1) The unique constraint', 'commit;'))
# 013 on its own, so the rollback test can re-apply JUST it. Re-applying the
# concatenated file instead fails on schema.sql's payment_assets_read, which
# carries no `drop policy if exists` — a failure that says nothing about 013.
(work / "swap.sql").write_text(cut(swap, '-- 1) The unique constraint', 'commit;'))
PY
q -q -v ON_ERROR_STOP=1 -f "$WORK/policy.sql" >/dev/null 2>&1 \
  || { echo "the extracted policy text does not apply cleanly"; exit 1; }

# run <label> <jwt-sub | -> <OK|DENY> <sql>
run() {
  local label="$1" sub="$2" expect="$3" sql="$4" pre out rows got
  if [ "$sub" != "-" ]; then
    pre="set local role authenticated; select set_config('request.jwt.claim.sub','$sub',true);"
  else pre="set local role anon;"; fi
  out=$(q -c "begin; $pre $sql; rollback;" 2>&1)
  # UPDATE *and* DELETE: RLS refuses both by making the row invisible rather
  # than raising, so each reports "<VERB> 0" with no error. Reading only
  # UPDATE meant every DELETE assertion passed no matter what the policy said.
  rows=$(printf '%s' "$out" | grep -oE '(UPDATE|DELETE) [0-9]+' | tail -1 | awk '{print $2}')
  # A deliberate refusal from a guard trigger counts as DENY. Listed
  # EXPLICITLY rather than treating any ERROR as a denial — that is the
  # dangerous direction, because a typo'd column would then read as
  # "correctly refused". Anything not matched here still lands in ERR: below.
  if printf '%s' "$out" | grep -qiE "violates row-level security|permission denied|Only the treasurer|only edit your own|can confirm receiving|may only confirm receipt|already confirmed received|has not been released yet|can clear a confirmation"; then
    got=DENY
  elif [ "${rows:-x}" = "0" ]; then
    got=DENY   # RLS hides the row: 0 rows and no error. The silent refusal.
  elif printf '%s' "$out" | grep -qiE "ERROR:"; then
    got="ERR:$(printf '%s' "$out" | grep -oiE 'ERROR:.*' | head -1 | cut -c1-70)"
  else got=OK; fi
  if [ "$got" = "$expect" ]; then printf '  ok   %s\n' "$label"
  else printf '  FAIL %s — expected %s, got %s\n' "$label" "$expect" "$got"; FAILED=1; fi
}

TRE=aaaaaaaa-0000-0000-0000-00000000000a   # Regine, the flagged treasurer
MEM=bbbbbbbb-0000-0000-0000-00000000000b   # Sarah, an ordinary member
GHOST=cccccccc-0000-0000-0000-00000000000c # a login on no member row
CLA=dddddddd-0000-0000-0000-00000000000d   # Clara, order 4, round not released
JAN=eeeeeeee-0000-0000-0000-00000000000e   # Jan,   order 5, round not released
CID=11111111-0000-0000-0000-000000000004
JID=11111111-0000-0000-0000-000000000005
VID=11111111-0000-0000-0000-000000000003
RID=11111111-0000-0000-0000-000000000001
SID=11111111-0000-0000-0000-000000000002
P="payout_bank='GCash', payout_account_name='Sarah T', payout_account_number='09171234567', payout_qr_url='https://x/y.png'"

echo "storage — a member's own payout QR folder"
run "member may write payout-qr/<own id>/" $MEM OK \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/$SID/1700.png')"
run "member may replace their own payout QR" $MEM OK \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/$SID/a.png');
   update storage.objects set name='payout-qr/$SID/b.png' where name='payout-qr/$SID/a.png'"
run "member may delete their own payout QR" $MEM OK \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/$SID/c.png');
   delete from storage.objects where name='payout-qr/$SID/c.png'"

echo "storage — somebody else's payout QR (the money-redirect path)"
run "member may NOT write another member's payout QR" $MEM DENY \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/$RID/evil.png')"
run "member may NOT invent a folder for an id nobody holds" $MEM DENY \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/00000000-0000-0000-0000-000000000000/x.png')"

echo "storage — the carve-out must not leak to the rest of the bucket"
run "member may NOT write the fund's payment QR" $MEM DENY \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','treasurer/qr.png')"
run "member may NOT write a payout receipt" $MEM DENY \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','receipts/r1.png')"
run "member may NOT write a bare payout-qr/ file" $MEM DENY \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/loose.png')"
run "the OLD flat path is refused even for your own id" $MEM DENY \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/$SID-1700.png')"

echo "storage — the treasurer keeps the recovery path"
run "treasurer may write the fund's payment QR" $TRE OK \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','treasurer/qr.png')"
run "treasurer may write another member's payout QR" $TRE OK \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/$SID/fix.png')"

echo "storage — anon and an unrecognised login"
run "anon may NOT write a payout QR" - DENY \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/$SID/anon.png')"
run "a login on no member row may NOT write a payout QR" $GHOST DENY \
  "insert into storage.objects (bucket_id,name) values ('payment-assets','payout-qr/$SID/x.png')"

echo "members — a member's own payout columns"
run "member may set their own payout details" $MEM OK "update members set $P where id='$SID'"
run "member may clear their own payout details" $MEM OK \
  "update members set payout_bank=null, payout_qr_url=null where id='$SID'"

echo "members — somebody else's payout columns"
run "member may NOT set another member's payout details" $MEM DENY "update members set $P where id='$RID'"
run "member may NOT redirect the treasurer's own payout" $MEM DENY \
  "update members set payout_account_number='09990000000' where id='$RID'"

echo "members — nothing else loosened by the carve-out"
run "member still may NOT change their own member_order" $MEM DENY \
  "update members set member_order=1 where id='$SID'"
run "member still may NOT grant themselves treasurer" $MEM DENY \
  "update members set is_treasurer=true where id='$SID'"
run "member still may NOT change their own email" $MEM DENY \
  "update members set email='new@x.com' where id='$SID'"
run "member may still rename themselves" $MEM OK \
  "update members set name='Sarah R' where id='$SID'"

echo "members — treasurer and anon"
run "treasurer may set any member's payout details" $TRE OK "update members set $P where id='$SID'"
run "anon may NOT touch payout details" - DENY "update members set $P where id='$SID'"

echo "payouts — the recipient's acknowledgement (migration 012)"
# THE CASE THE FIRST CUT OF THE GUARD BROKE. Regine is the treasurer AND
# round 1's recipient, which is normal in a five-person fund. A rule of "the
# treasurer may not confirm" would stop them acknowledging their own ₱30,000.
run "the treasurer may confirm their OWN payout" $TRE OK \
  "update payouts set received_at = now() where round_number = 1"
# The ordinary recipient path.
run "a member may confirm their own payout" $MEM OK \
  "update payouts set received_at = now(), received_note = 'GCash, thanks'
     where round_number = 2"
# The integrity property: the confirmation belongs to whoever the money went to.
run "a member may NOT confirm somebody else's payout" $MEM DENY \
  "update payouts set received_at = now() where round_number = 1"
run "the TREASURER may not confirm on a member's behalf" $TRE DENY \
  "update payouts set received_at = now() where round_number = 2"
run "a login on no member row may not confirm anything" $GHOST DENY \
  "update payouts set received_at = now() where round_number = 2"
# Pinned columns, tested as the ORDINARY recipient — the treasurer may
# legitimately change an amount, so testing this as them proves nothing.
run "a recipient may NOT change the amount while confirming" $MEM DENY \
  "update payouts set received_at = now(), amount = 99999 where round_number = 2"
run "a recipient may NOT redirect the payout while confirming" $MEM DENY \
  "update payouts set received_at = now(), recipient_member_id = '$RID'
     where round_number = 2"
run "a recipient may NOT un-release it while confirming" $MEM DENY \
  "update payouts set received_at = now(), released = false where round_number = 2"
run "a recipient may NOT touch a payout without confirming it" $MEM DENY \
  "update payouts set note = 'hello' where round_number = 2"
# Once only. Undoing is a correction, which is the treasurer's act.
run "a confirmation may not be given twice" $MEM DENY \
  "update payouts set received_at = now() where round_number = 2;
   update payouts set received_at = now(), received_note = 'again'
     where round_number = 2"
run "a member may NOT clear their own confirmation" $MEM DENY \
  "update payouts set received_at = now() where round_number = 2;
   update payouts set received_at = null where round_number = 2"
# ...but the treasurer must be able to, or Undo Release would leave a stale
# confirmation on a payout that is no longer released.
run "the treasurer MAY clear a confirmation" $TRE OK \
  "update payouts set received_at = now() where round_number = 1;
   update payouts set received_at = null, released = false where round_number = 1"
# Nothing to receive yet.
run "an unreleased payout cannot be confirmed" $TRE DENY \
  "update payouts set recipient_member_id = pf_member_id() where round_number = 3;
   update payouts set received_at = now() where round_number = 3"
run "anon may NOT confirm anything" - DENY \
  "update payouts set received_at = now() where round_number = 2"

echo "cycles — the payment schedule (Menu -> Payment schedule)"
CY=22222222-0000-0000-0000-000000000001
run "treasurer may move a due date" $TRE OK \
  "update cycles set due_date='2026-09-29' where id='$CY'"
# The UI hides the row from anyone who is not the flagged treasurer, but the
# treasurer PIN is shared with all five members and the handlers are exported
# on PowerFund. This is the guard that actually holds.
run "member may NOT move a due date" $MEM DENY \
  "update cycles set due_date='2026-09-29' where id='$CY'"
run "member may NOT invent a cycle" $MEM DENY \
  "insert into cycles (cycle_number, due_date) values (99, '2027-01-01')"
run "member may NOT delete a cycle" $MEM DENY \
  "delete from cycles where id='$CY'"
run "anon may NOT move a due date" - DENY \
  "update cycles set due_date='2026-09-29' where id='$CY'"
# Reads stay open: the schedule is what every member's overdue chip is drawn
# from, so a member who could not read it would see no due dates at all. A read
# is not an OK/DENY write, so it is counted rather than run through run().
seen=$(q -tAc "begin; set local role authenticated;
  select set_config('request.jwt.claim.sub','$MEM',true);
  select count(*) from cycles; rollback;" 2>&1 | grep -oE '^[0-9]+$' | head -1)
if [ "${seen:-0}" -ge 2 ]; then printf '  ok   a member may still READ the schedule\n'
else printf '  FAIL a member may still READ the schedule — saw %s row(s)\n' "${seen:-0}"; FAILED=1; fi


# ===========================================================================
# Turn swaps — *palit ng turno* (migration 013)
#
# `member_order` is UNIQUE, so a pair swap written as two sequential single-row
# updates always collides on the first one. 013 makes the constraint DEFERRABLE
# and moves the swap into a function. That is why the success cases below need
# their own helper: a DEFERRED constraint is checked at COMMIT, and run()'s
# rollback would never reach that check — a swap that left two members at the
# same position would read as a pass.
# ===========================================================================

# swapq <label> <sub> <OK|ERR-substring> <sql>  — COMMITS, unlike run().
swapq() {
  local label="$1" sub="$2" expect="$3" sql="$4" out
  out=$(q -c "begin; set local role authenticated;
    select set_config('request.jwt.claim.sub','$sub',true); $sql; commit;" 2>&1)
  if [ "$expect" = "OK" ]; then
    if printf '%s' "$out" | grep -qiE "ERROR:"; then
      printf '  FAIL %s — %s\n' "$label" "$(printf '%s' "$out" | grep -oiE 'ERROR:.*' | head -1 | cut -c1-90)"
      FAILED=1
    else printf '  ok   %s\n' "$label"; fi
  else
    if printf '%s' "$out" | grep -qi "$expect"; then printf '  ok   %s\n' "$label"
    else
      printf '  FAIL %s — expected /%s/, got %s\n' "$label" "$expect" \
        "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-110)"
      FAILED=1
    fi
  fi
}

# state <label> <expected> <sql>
state() {
  local got; got=$(q -tAc "$3" 2>&1 | tr -d ' ' | tr '\n' ',' | sed 's/,$//')
  if [ "$got" = "$2" ]; then printf '  ok   %s\n' "$1"
  else printf '  FAIL %s — expected %s, got %s\n' "$1" "$2" "$got"; FAILED=1; fi
}

echo "turn swaps — the constraint that made this a migration"
state "member_order's unique constraint is now DEFERRABLE" "t" \
  "select condeferrable from pg_constraint where conrelid='members'::regclass
     and contype='u' and conkey = array[(select attnum from pg_attribute
       where attrelid='members'::regclass and attname='member_order')]"
# THE ORIGINAL BUG, asserted so it can never come back as a "simplification":
# whatever the app does, it must not be two sequential single-row updates.
swapq "two sequential single-row updates still collide (why the RPC exists)" $TRE \
  "duplicate key" \
  "update members set member_order=5 where id='$CID';
   update members set member_order=4 where id='$JID'"

echo "turn swaps — who may ask"
swapq "a member may ask another member for a swap" $CLA OK \
  "select pf_request_swap('$JID','need mine early, hospital bill')"
swapq "a member may NOT ask themselves" $CLA "cannot swap turns with yourself" \
  "select pf_request_swap('$CID')"
swapq "a login on no member row may NOT ask" $GHOST "signed-in member" \
  "select pf_request_swap('$JID')"
# RELEASED is the refusal, BOTH directions — a member whose round is paid out
# would otherwise be moved to a later round and paid a second time.
swapq "a member on a PAID-OUT round may NOT ask" $MEM "already been paid out" \
  "select pf_request_swap('$JID')"
swapq "a member may NOT ask for a PAID-OUT round" $CLA "already been paid out" \
  "select pf_request_swap('$RID')"
swapq "a member may NOT file a request in somebody else's name" $CLA \
  "row-level security" \
  "insert into swap_requests (from_member_id,to_member_id,from_round,to_round)
     values ('$JID','$CID',5,4)"
swapq "a member may NOT file a request already marked accepted" $CLA \
  "row-level security" \
  "insert into swap_requests (from_member_id,to_member_id,from_round,to_round,status)
     values ('$CID','$JID',4,5,'accepted')"

echo "turn swaps — who may answer"
REQ=$(q -tAc "select id from swap_requests where status='pending' limit 1" | tr -d ' ')
swapq "the REQUESTER may not accept their own request" $CLA "who was asked" \
  "select pf_accept_swap('$REQ')"
# The whole point of the flow: a swap neither member agreed to is what it
# exists to prevent, so the treasurer is not a shortcut past the agreement.
swapq "the TREASURER may not accept on the members' behalf" $TRE "who was asked" \
  "select pf_accept_swap('$REQ')"
swapq "a third member may not accept" $MEM "who was asked" \
  "select pf_accept_swap('$REQ')"
swapq "a third member may not decline it either" $MEM "who was asked" \
  "select pf_decline_swap('$REQ')"
swapq "the counterparty may not CANCEL (that is the asker's)" $JAN "who asked" \
  "select pf_cancel_swap('$REQ')"
swapq "nobody may edit a request row directly" $JAN "0" \
  "update swap_requests set status='accepted' where id='$REQ'"

echo "turn swaps — the accept, which is the only thing that moves the order"
swapq "the member who was asked may accept" $JAN OK "select pf_accept_swap('$REQ')"
state "both positions actually moved" "Clara5,Jan4" \
  "select name || member_order from members where id in ('$CID','$JID') order by name"
state "and nobody else moved" "Regine1,Sarah2,Verdz3" \
  "select name || member_order from members where member_order <= 3 order by member_order"
state "the agreement is logged, naming both and both rounds" "1" \
  "select count(*) from activity_log
    where message like '%Clara and Jan swapped turns%'
      and message like '%Round 4 %Round 5%' and message like '%both agreed%'"
swapq "the same request cannot be accepted twice" $JAN "already accepted" \
  "select pf_accept_swap('$REQ')"

echo "turn swaps — a request the order has outrun"
# Asked at 5<->4, then the treasurer moves one of them. Accepting now would
# trade different rounds than the two members agreed to.
swapq "set up: Clara asks Jan again" $CLA OK "select pf_request_swap('$JID')"
REQ2=$(q -tAc "select id from swap_requests where status='pending' limit 1" | tr -d ' ')
swapq "set up: the treasurer reorders underneath it" $TRE OK \
  "select pf_swap_order('$JID','$VID')"
# It answers with the row marked `stale` rather than raising — a raise would
# roll back the marking it had just written. Both halves are asserted: the
# reply says stale, AND the row is still stale on the next read.
swapq "a request the order has outrun answers 'stale'" $JAN "stale" \
  "select status from pf_accept_swap('$REQ2')"
state "...and the marking PERSISTED (a raise would have rolled it back)" "stale" \
  "select status from swap_requests where id='$REQ2'"
# Jan3/Verdz4 is the state the treasurer's reorder above left: Jan was at 4
# after the accepted swap, Verdz at 3. The point is that the STALE accept
# changed nothing further.
state "...and the stale accept moved nothing" "Jan3,Verdz4" \
  "select name || member_order from members where id in ('$JID','$VID') order by name"

echo "turn swaps — the treasurer's own reorder (the same broken write)"
swapq "the treasurer may swap two members directly" $TRE OK \
  "select pf_swap_order('$CID','$VID')"
swapq "a member may NOT call the treasurer's reorder" $CLA \
  "Only the treasurer can change the payout order" \
  "select pf_swap_order('$CID','$JID')"
swapq "not even for a released round, as treasurer" $TRE "already been paid out" \
  "select pf_swap_order('$RID','$CID')"

echo "turn swaps — nothing the swap flag loosened"
# The GUC exemption in pf_members_guard() must move member_order and NOTHING
# else, and only from inside pf_accept_swap.
run "a member still may NOT move their own member_order" $CLA DENY \
  "update members set member_order=1 where id='$CID'"
run "a member still may NOT move anybody else's" $CLA DENY \
  "update members set member_order=1 where id='$JID'"
run "a member still may NOT grant themselves treasurer" $CLA DENY \
  "update members set is_treasurer=true where id='$CID'"
run "anon may NOT request a swap" - DENY "select pf_request_swap('$JID')"
# The flag is transaction-local, so it cannot be left set for the next request
# on a pooled connection.
state "the swap flag does not survive the transaction" "" \
  "select current_setting('pf.swap_ok', true)"

echo "turn swaps — the rollback (011's did not actually run)"
# LAST, because it tears the flow down. 011's rollback was a syntax error that
# nobody noticed, so a rollback is asserted to RUN, to be idempotent, and to
# leave 010's guard rules intact — a rollback that half-runs is worse than none.
if q -q -v ON_ERROR_STOP=1 -f "$MIG/013_rollback.sql" >/dev/null 2>&1; then
  printf '  ok   013_rollback.sql applies cleanly\n'
else
  printf '  FAIL 013_rollback.sql does not apply\n'; FAILED=1
fi
state "swap_requests is gone" "0" \
  "select count(*) from information_schema.tables where table_name='swap_requests'"
state "every swap function is gone" "0" \
  "select count(*) from pg_proc where proname in
     ('pf_request_swap','pf_accept_swap','pf_decline_swap','pf_cancel_swap','pf_swap_order')"
# The guard is RESTORED, not left carrying a dead exemption — and it still
# refuses the thing 010 wrote it for.
run "a member still may NOT move their own order after rollback" $CLA DENY \
  "update members set member_order=1 where id='$CID'"
state "the accepted swap's log entry SURVIVES the rollback" "1" \
  "select count(*) from activity_log where message like '%swapped turns%'"
if q -q -v ON_ERROR_STOP=1 -f "$MIG/013_rollback.sql" >/dev/null 2>&1; then
  printf '  ok   013_rollback.sql is idempotent\n'
else printf '  FAIL 013_rollback.sql is not re-runnable\n'; FAILED=1; fi
reapply=$(q -q -v ON_ERROR_STOP=1 -f "$WORK/swap.sql" 2>&1)
if [ -z "$(printf '%s' "$reapply" | grep -i ERROR)" ]; then
  printf '  ok   013 re-applies on top of its own rollback\n'
else
  printf '  FAIL 013 does not re-apply after rollback — %s\n' \
    "$(printf '%s' "$reapply" | grep -i ERROR | head -1 | cut -c1-110)"; FAILED=1
fi

echo
if [ "$FAILED" = "0" ]; then echo "all payout-permission checks passed"; else echo "SOME CHECKS FAILED"; fi
exit $FAILED
