# Migration validation against a real PostgreSQL cluster

The smoke suite mocks the network, so it cannot see an RLS policy at all. Every
migration from 008 on has instead been validated against a real PostgreSQL 16
cluster with Supabase's own `auth.uid()` and `storage.foldername()` stubbed to
their real definitions. That is how four bugs were found that no mocked test
could reach — including one that would have broken every first login.

This directory holds that harness for the **payout-details** rules
(`members.payout_*` and the `payout-qr/<memberId>/` storage folder), because
those decide **where each member's ₱30,000 is sent** and are the only place a
member writes to storage.

## Running it

Needs `postgresql-16` and a non-root user (Postgres refuses to run as root):

```bash
bash tests/sql/run.sh
```

It creates a throwaway cluster in `/tmp`, applies the real policy text
**extracted from `supabase/migrations/`** rather than a copy, runs the
assertions, and tears the cluster down. Extracting rather than duplicating is
deliberate: a copied policy that drifts from the migration proves nothing.

## What it asserts

The one that matters most is `member may NOT write another member's payout QR`
— that is the money-redirect path. The rest exist so the carve-out cannot be
widened by accident:

- a member may write **only** `payout-qr/<their own id>/`, and not a bare
  `payout-qr/` file, the fund's payment QR, or the payout receipts;
- the **old flat path** `payout-qr/<id>-<ts>.ext` is refused even for your own
  id, since `storage.foldername()` cannot see a filename prefix — which is why
  `js/database.js` had to change to a folder;
- a member may set and clear **their own** `payout_*` columns, and still cannot
  touch `member_order`, `is_treasurer` or `email`;
- the **treasurer keeps write access to everything**, deliberately: a member
  who loses their Google account would otherwise have no route to correct where
  their payout goes, and nor would anyone else;
- `anon` and an unrecognised login are refused throughout.

## The failure mode this documents

`member may NOT set another member's payout details` passes by returning
**0 rows with no error**. RLS hides the row rather than raising, so a refused
write looks like a successful one to the client. That is why
`saveMemberPayoutDetails()` in `js/database.js` uses `requireRows()` instead of
`.single()` — before this it would have told a member their new account number
was saved when Postgres had declined it.
