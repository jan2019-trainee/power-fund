# Power Fund — demo brief

A single, upload-ready knowledge file for a **Claude Project** whose job is to help
run a live demo of Power Fund to the group. It describes what the app *actually*
does today, so the assistant does not invent features from the mockups.

Everything below is drawn from the running code and `README.md`, not from the
design canvas. Where a screen exists only as a mockup it is marked **not built**.

---

## 1. What the app is

A shared **rotating savings fund** tracker (Filipino *paluwagan*) for one group of
five people.

- 5 members, ₱1,000 each per cycle
- 30 cycles — the 15th and the last day of each month, about 15 months
- 5 rounds of 6 cycles; each round pools **₱30,000** and pays out to one member
- Round states: **🟢 Collecting → 🟡 Payout Pending → ✅ Completed**

**The app moves no money.** Payments happen outside it (GCash / InstaPay to the
treasurer). The app is the shared ledger and the proof-of-payment trail. Say this
out loud in the first minute of the demo — it is the single most common
misunderstanding.

It is a **PWA**: a website that installs to the home screen. No app store, no
download. Works on Android and iOS Safari, and on desktop.

---

## 2. The two roles

| | Member | Treasurer |
|---|---|---|
| Sees the whole fund | ✅ | ✅ |
| Submits own payment + screenshot | ✅ | ✅ |
| Confirms / rejects payments | ❌ | ✅ |
| Releases payouts, starts next round | ❌ | ✅ |
| Edits names, payout order, payment QR | ❌ | ✅ |

Treasurer mode is unlocked with a **shared treasurer PIN** — a convenience lock,
not security, and every member technically knows it. There is also a **master
PIN** as the way back in if the treasurer PIN is forgotten.

Google sign-in exists and is currently set to `AUTH_MODE: "optional"` in
`js/config.js` — members can sign in, but nobody is forced to. A signed-in member
who owns a roster row can edit their own name and photo. **The database is not
locked down yet** (migration `011` is written but not applied), so do not promise
the group that the app enforces permissions server-side. It does not, yet.

---

## 3. The screens

**Mobile — 5 tabs:** Home · Rounds · Activity · Insights · Menu.
Members is a drill-down from Home, not a tab.

**Desktop — sidebar:** Home · Rounds · Members · Activity · Insights, with Menu
as the profile row at the bottom. Mobile and desktop navigate differently *on
purpose*; that is not a bug to apologise for during the demo.

- **Home** — the active round's progress to ₱30,000, your own payment status, and
  (for the treasurer) the **Pending review** queue at the top.
- **Rounds** — all 5 rounds, their state, who each one pays out to.
- **Members** — the roster in payout order, each member's paid/unpaid history.
- **Activity** — the log, grouped by date, exportable to CSV.
- **Insights** — trends and a sparkline over the fund's life.
- **Menu** — grouped as You & this app · Group · Payments · Data · Account ·
  Security · Learn. Includes *Replay the intro*, *Share fund status*,
  *Export CSV summary*, *Backup data (JSON)*, *Restore from backup*.

First-time visitors get a **5-step onboarding tour** (4 steps if signed in). It
can be replayed any time from Menu → *Replay the intro* — which is how to show it
during a demo without wiping anything.

---

## 4. The one flow the demo lives or dies on

**Member pays:**

1. Home → **Pay this cycle** (or **Pay ahead** for several cycles at once).
2. See the treasurer's QR and account details. Pay in GCash / bank app.
3. **Upload proof** — file picker or camera. A screenshot is **required**; the
   submit button will not accept a payment without one.
4. Status becomes **Submitted — awaiting treasurer verification** (pending).

**Treasurer verifies:**

5. Home → Pending review queue → open the payment, view the screenshot enlarged.
6. **Confirm Payment** → status **Confirmed**. Or **Reject** (behind a
   confirmation step) with a reason → status **Rejected**.

**Rejected still owes the cycle.** It is not money and it is not forgiven — it
goes back into the unpaid bucket. Worth saying explicitly; people read the red
badge as "cancelled".

**Payout:** when a round reaches ₱30,000 the treasurer records the release —
recipient, amount, date, optional receipt image. Reaching the target does **not**
auto-advance; the treasurer taps **Start next round**.

---

## 5. Good demo order (about 12 minutes)

1. **1 min** — what this is, and that no money moves through it.
2. **2 min** — install it: share the URL, Add to Home Screen, show the icon.
3. **2 min** — the intro tour (Menu → Replay the intro).
4. **1 min** — Home: the round bar, your own status.
5. **4 min** — the pay flow end to end, on two phones if possible: one member
   submits with a screenshot, the treasurer confirms on theirs. The update
   appears on the other phone live.
6. **1 min** — show a rejection and say what it means.
7. **1 min** — Rounds, Members, Activity, Share fund status.

Two phones matters. The live sync is the moment the group understands that this
is one shared ledger and not five separate notes apps.

---

## 6. Things to prepare before demoing

- A real payment QR uploaded (Menu → Payment QR code), or the demo's step 2 is
  hollow.
- A screenshot already saved on the demo phone, so the upload step is not a
  scramble.
- Everyone's *who am I* set, or sign-in done, so statuses read as theirs.
- Decide beforehand whether you demo on **live fund data** or on a scratch
  Supabase project. Confirming a fake payment on the real fund puts a wrong row
  in the ledger and a wrong line in the activity log. There is *Backup data
  (JSON)* → *Restore from backup* if you want a way back, but a separate demo
  database is cleaner.

---

## 7. Do not demo these — they are not built

- **Fund Setup wizard** (deferred).
- **Adding or removing members mid-fund** — the roster is fixed; out of scope.
- **Drag-to-crop profile photos** — photos are auto-centre-cropped.
- **In-app payment** of any kind. There is none and there will not be one.
- **Server-enforced permissions** — migration `011` is not applied.
- **Notifications / reminders** — none exist. Nothing is pushed to anyone.

Cash payments are treasurer-only and stay out of the member flow.

---

## 8. Vocabulary to keep straight

| Term | Means |
|---|---|
| Cycle | One ₱1,000 payment window (30 of them) |
| Round | 6 cycles pooling ₱30,000, paying out to one member (5 of them) |
| Pending | Member submitted with proof; treasurer has not confirmed |
| Confirmed | Treasurer verified the money arrived |
| Rejected | Treasurer refused the proof; the cycle is still owed |
| Payout Pending | Round is fully funded, money not yet released |
| Treasurer mode | Unlocked with the shared PIN |
| Master PIN | The recovery PIN when the treasurer PIN is lost |
