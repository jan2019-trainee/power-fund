# ⚡ Power Fund

A shared **rotating savings fund** tracker (a.k.a. *paluwagan*) for a small group.
Five members each contribute a fixed amount twice a month; every round the pooled
money is paid out to one member in turn. This app records contributions and payouts —
**it does not move any money**. All payments happen outside the app (GCash / InstaPay
to the treasurer); the app is just the shared ledger.

- 5 members (names editable)
- ₱1,000 per member per cycle
- 30 cycles — the 15th and last day of each month, ~15 months
- 5 rounds of 6 cycles; each round pools ₱30,000 and pays out to one member.
  Each round has its own independent ₱30,000 target. A round moves through
  **🟢 Collecting → 🟡 Payout Pending → ✅ Completed**. Reaching ₱30,000 does
  **not** auto-advance — the treasurer clicks **Start Next Round** to begin the
  next one, and can do so while the previous round's payout is still pending.
  The main progress bar always shows only the active round; after round 5 it
  reads **All 5 Rounds Completed**
- Payment states: **unpaid → pending review → confirmed paid**. A member must
  attach a proof-of-payment screenshot to submit a contribution
- The treasurer works a **Pending review** queue at the top of the dashboard —
  each pending payment (or advance batch) can be reviewed or confirmed in one tap;
  rejecting stays behind a confirmation step. Rejected / reverted screenshots are
  **moved to an archive**, never deleted
- When a payout is released the treasurer records the **recipient, amount, date
  and (optionally) a receipt image**; that record stays correct even if members
  are later renamed or reordered. `amount` is a historical record and never
  affects the ₱30,000 funding target. Needs migration `004` (see setup step 2)
- Tap the payment QR code or any proof/receipt screenshot to view it enlarged
- A treasurer PIN gates review/confirm/payout actions (a convenience lock, **not**
  security). Destructive actions (revert, undo release, reset, restore) need a
  confirmation; **Reset all data** additionally needs you to type `RESET` and
  re-enter the PIN, and no longer clears the PIN

## Technology

| Part | Choice |
|------|--------|
| Frontend | Plain HTML, CSS, vanilla JavaScript — no framework, no build step |
| Database | [Supabase](https://supabase.com) (PostgreSQL) |
| File storage | Supabase Storage (payment screenshots) |
| Live sync | Supabase Realtime (+ polling fallback) |
| Hosting | Any static host; instructions below are for [Vercel](https://vercel.com) |
| Installable | Progressive Web App (manifest + service worker) — see below |
| Source control | Git / GitHub |

The Supabase JavaScript client is **vendored** in `js/vendor/` (no runtime CDN
dependency, so the app shell works offline). There are no npm dependencies and
nothing to compile.

## Folder structure

```
power fund/
├── index.html            markup + PWA <meta>/<link> + <script> tags
├── manifest.webmanifest  PWA manifest (name, icons, theme colour)
├── sw.js                  service worker (offline shell; never caches fund data)
├── vercel.json            cache-control headers for sw.js / manifest / index.html
├── css/
│   └── style.css          all styles (self-hosted @font-face, PWA notice bar)
├── js/
│   ├── config.js          Supabase URL + anon key (you fill these in)
│   ├── calculations.js    pure fund maths (totals, progress, overdue, …)
│   ├── database.js         every Supabase call lives here
│   ├── app.js              rendering + button/form handling + realtime
│   ├── pwa.js              service-worker registration, install/update/offline UI
│   └── vendor/             vendored Supabase JS SDK (pinned)
├── assets/
│   ├── gcash-qr.jpg        the treasurer's payment QR (replace with your own)
│   └── fonts/              self-hosted Inter + Space Grotesk (.woff2)
├── icons/                  PWA icons (192/512/maskable/apple-touch/favicon)
├── scripts/
│   └── make-icons.py       regenerates icons/ from the ⚡ mark (Pillow)
├── supabase/
│   ├── schema.sql          tables, security policies, storage bucket
│   ├── seed.sql            5 members, 30 cycles, 5 payout rows
│   └── migrations/         incremental changes for databases already created
├── .gitignore
└── README.md
```

## Setup

### 1. Create a Supabase project

1. Sign in at [supabase.com](https://supabase.com) → **New project**.
2. Pick a name, a strong database password, and a region close to your group.
3. Wait for it to finish provisioning (~2 minutes).

### 2. Create the database tables

1. In the project, open **SQL Editor → New query**.
2. Paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql) and **Run**.
   This creates the tables, the (intentionally open) security policies, enables
   Realtime, and creates the `payment-proofs` storage bucket.
3. **If your database was created before a schema change**, also run each file in
   [`supabase/migrations/`](supabase/migrations/) in order. A brand-new database
   created from the current `schema.sql` already includes them and can skip this.

### 3. Seed members and cycles

1. **SQL Editor → New query** again.
2. Paste [`supabase/seed.sql`](supabase/seed.sql) and **Run**.
3. Check the results:

   ```sql
   select 'members' t, count(*) from members
   union all select 'cycles',  count(*) from cycles
   union all select 'payouts', count(*) from payouts;
   ```

   You should see `members = 5`, `cycles = 30`, `payouts = 5`.

To change the schedule, edit the `first_cycle_date` line in `seed.sql` **before**
running it, or edit `due_date` values directly in the `cycles` table afterwards.
To rename members, edit them in the app (treasurer mode → *Edit names*) or in the
`members` table.

### 4. Configure credentials

1. In Supabase: **Project Settings → API**.
2. Copy **Project URL** and the **`anon` `public`** key.
3. Open [`js/config.js`](js/config.js) and paste them in:

   ```js
   window.APP_CONFIG = {
     SUPABASE_URL: "https://xxxxxxxx.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi...",
     QR_IMAGE_URL: "assets/gcash-qr.jpg",
   };
   ```

The `anon` key is meant to be used in the browser and is safe to commit. **Never**
put the `service_role` key here — it bypasses all security.

There is no `.env` file and no Vite in this project, so there are no
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` environment variables to set. If you
later add a build step, move the two values into env vars named exactly that and
read them via `import.meta.env`.

### 5. Add the payment QR

Two options:

- **From the app (recommended):** unlock **Treasurer mode → Payment QR → choose
  a new QR code → Upload**. The image is stored in the `payment-assets` Supabase
  bucket and every member sees it. Requires migration `003` (see step 2).
- **Bundled default:** replace [`assets/gcash-qr.jpg`](assets/gcash-qr.jpg) with
  the real QR. This is only the fallback shown until a QR is uploaded from the app.

## Run locally

It's a static site — no build, no server code.

- **VS Code:** install the **Live Server** extension, then right-click
  `index.html` → *Open with Live Server*.
- **Or** any static server, e.g. `npx serve .` or `python -m http.server`.

Opening `index.html` as a `file://` URL will not work (the browser blocks the
Supabase connection) — always serve it over `http://`.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. At [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. Settings:
   - **Framework Preset:** *Other*
   - **Build Command:** leave empty
   - **Output Directory:** leave empty (serves the repo root)
4. **Deploy.** Every push to the default branch redeploys automatically.

Because `js/config.js` is committed with the anon key in it, the deployed site
works with no extra Vercel configuration. `vercel.json` sets the cache headers
the service worker needs (`sw.js` and `index.html` are served `no-cache`); it is
picked up automatically.

## Install as an app (PWA)

The site is a Progressive Web App. Once it is served over HTTPS (Vercel does this
automatically), it can be installed to a phone's home screen and launched like a
native app — its own icon, full-screen, no browser chrome.

- **Android / Chrome / Edge:** open the site, then use the **Install** prompt that
  appears at the top (or *⋮ menu → Install app / Add to Home screen*).
- **iPhone / iPad (Safari):** open the site, tap **Share**, then **Add to Home
  Screen**. (iOS only installs PWAs from Safari, not Chrome/Firefox.)
- **Desktop Chrome / Edge:** an install icon appears in the address bar.

**What works offline:** only the app *shell* (the page, styles, scripts). Fund
data always requires a live connection to Supabase — offline, the app shows a
clear **"Offline — reconnect to manage fund data"** notice and every action
(recording a contribution, confirming a payment, releasing a payout, starting a
round, editing members, backup/restore) refuses until you are back online. There
is no offline queue and no cached ledger, by design: a savings fund must never be
edited against stale data.

**Updates:** every deploy that changes the app ships a new service-worker version.
Installed apps pick it up automatically and show a small **"New version — Reload"**
bar; it never reloads on its own while you might be mid-action. (If you deploy a
change and want installed devices to get it, bump the `CACHE` string at the top of
[`sw.js`](sw.js), e.g. `pf-v1` → `pf-v2`.)

**Icons** live in [`icons/`](icons/) and are regenerated by
[`scripts/make-icons.py`](scripts/make-icons.py) (`pip install pillow`, then
`python scripts/make-icons.py`) — edit that script to change the mark.

## Security limitations — read this

This app has **no authentication**. That is a deliberate choice to keep it simple
for five people who trust each other.

- The Supabase **anon key is visible** in `js/config.js` and in the deployed
  JavaScript. Anyone who can open the site can extract it.
- The database is configured for **open read and write** from the browser. The RLS
  policies in `schema.sql` say `using (true) with check (true)` — they exist only
  because Supabase requires a policy to allow any access at all. **They provide no
  user-level protection**, because there are no users to distinguish.
- Uploads to the `payment-proofs` (screenshots) and `payment-assets` (payment QR)
  buckets are likewise open read/write.
- The **treasurer PIN is not security**. It is a soft UI lock stored in plain text
  in the `app_settings` table; anyone technical can bypass it. Use it only to stop
  accidental edits. This includes the **Payment QR** upload — technically any
  visitor with the anon key could replace the QR, so treat the site URL as the
  secret and keep an eye on the activity log.

**What actually protects the data:** keeping the site URL private. Treat the
Vercel URL like a shared password — share it only with the 5 members, don't post
it publicly, and don't submit it to search engines.

**Member accounts are being added** (migration 008), and they are the route to
real protection — per-person logins, then RLS policies that check `auth.uid()`
instead of `using (true)`. That work is deliberately staged, and where it has
got to is controlled by one setting, `AUTH_MODE` in `js/config.js`:

| `AUTH_MODE` | What it does |
| --- | --- |
| `"off"` *(shipped default)* | No auth anywhere. Everything above still applies, unchanged. |
| `"optional"` | A "Sign in with Google" row appears in Menu and signing in works, but the app is fully usable without it. Use this to test on a real phone without locking the other four members out. |
| `"required"` | No session, no app: the sign-in screen replaces everything. |

Before switching off `"off"`, both of these must be true, or **every member is
locked out, treasurer included**:

1. Google is enabled under Supabase → Authentication → Providers.
2. This site's URL is listed under Authentication → URL Configuration →
   Redirect URLs.

Note what a login does and does not buy you today. RLS is **still**
`using (true) with check (true)`, so a signed-in member is not yet restricted
to their own rows, and **the PINs are still readable in plaintext** by anyone
with the anon key. Signing in currently proves who you are; it does not yet
stop anyone from writing anything. Tightening RLS and moving the PINs out of
the client's reach is a later migration — that is the step that turns the login
into actual protection.

**Never commit:** the `service_role` key, the database password (kept locally in
`supabase-db-password.local.txt`, which is git-ignored), or real credentials in
this README.

## Backup

Financial data — keep copies.

- **Treasurer mode → Export CSV:** a readable grid of every cycle and who has paid.
- **Treasurer mode → Download backup:** a full JSON snapshot (members, cycles,
  contributions, payouts, activity log).
- **Treasurer mode → Restore backup:** load a JSON snapshot back. This **replaces**
  all current contributions and payout status, so it asks for confirmation first.
