# Power Fund — demo build

Branch **`demo/group-walkthrough`**. Not for deploying over the real app.

```
AUTH_MODE: "optional"   DEMO_MODE: true   DEMO_SEED: "empty"   (js/config.js)
```

## How to use it

Open it like the normal app. A gold bar sits at the top of every screen:

```
DEMO   as [ Verdz (treasurer) ▾ ]   [Reset]
```

- **The dropdown switches member.** That is the whole point of this branch —
  pick Regine, Sarah, Jan, Clara or Verdz and the app reloads as that person.
  No Google account, nobody's password, no sign-in.
- **Verdz holds the treasurer role**, and the demo opens as them. To move it,
  change `TREASURER` in `js/demo-seed.js` — one constant, which every
  treasurer action in the mid-fund story is attributed from, so the activity
  log cannot end up describing somebody else doing the job.
- **Treasurer PIN is `1234`.** Master PIN is `9999`.
- **Reset** puts the demo back to its starting state.

Everything you do is saved in that browser and survives a reload, so you can
set something up and come back to it. Nothing reaches the real fund.

## Why not just `AUTH_MODE: "optional"` on the real app

Because it could not work, and it is worth knowing why:

- **Migration 011 is applied** to the live project and it revokes `anon`
  entirely — every policy is `to authenticated`. So "optional" while signed
  out reads nothing at all. The demo would be a load error, not an app.
- **"optional" while signed in locks identity.** A linked account sets
  `identityLocked`, so the who-am-I picker is hidden and
  `openWhoAmIPicker()` refuses — deliberately, because that preference is
  unverified and must not be able to move where somebody's ₱30,000 is sent.
  You would still not be able to switch.

And demoing against the real database while switching identities would write
real records as other people, which is a bad idea regardless.

So `DEMO_MODE` replaces the data layer with an in-browser store
(`js/demo-db.js`) and **fakes a session for whichever member the bar names**.
That last part matters: Received ✓, reporting a payout as not arrived, My
payout details and turn swaps are all gated on a linked account, so with auth
off they render inert — you could show them but never drive them.

## Two starting states — `DEMO_SEED` in `js/config.js`

### `"empty"` — day one (the default)

Members, the 30-cycle schedule and round 1 started. That is it, and it is
exactly what `supabase/seed.sql` leaves behind for a brand-new fund. Home says
*"Your fund just started"*, the whole fund reads ₱0 of ₱150,000, and **nothing
is overdue** — cycle 1 falls a few days out, so the first payment is due rather
than late.

You build the story live, which is the better walkthrough:

1. **As any member** — *Record my payment — ₱1,000*, attach a screenshot, send.
2. **Switch to Verdz** in the DEMO bar, unlock with `1234`, open *Needs your
   attention* and confirm it. The round moves to ₱1,000 / ₱30,000.
3. Keep going: pay the other four, watch the battery fill, release the payout
   to Regine with a receipt, then switch to Regine and confirm it arrived — or
   report that it did not.

### `"midfund"` — everything already reachable

For showing a screen without first producing the state behind it.

| | |
| --- | --- |
| **Round 1** | Paid out to Regine · receipt attached · **confirmed received** |
| **Round 2** | Paid out to Sarah · receipt attached · **Sarah disputes it** — "nothing in GCash" |
| **Round 3** | Collecting · 3 confirmed, 1 in review, 1 **rejected** with a reason, one paid ahead |
| **Round 4** | Not started · Jan has an open **turn-swap request** out to Clara |
| **Cycle 13** | Verdz (treasurer) confirmed · Clara in review · **Jan rejected** with a reason |

Worth driving, and who to be: **Verdz** (the dispute leads the screen; unlock
for the review queue), **Sarah** (her own dispute card — *It arrived after all*
or *Withdraw my report*), **Clara** (accept Jan's swap; the payout order really
moves), **Jan** (the rejected claim and *Resubmit*).

The rejected claim is deliberately **not** the treasurer's own — the app allows
it, but a treasurer refusing their own payment reads as a mistake in the demo
rather than as the feature.

### The schedules differ on purpose

`"midfund"` sits thirteen cycles in, so its dates run into the past. Reusing
those for an empty fund would open the demo with **thirteen overdue cycles
across five members** — sixty-five red chips on a fund where nobody has done
anything wrong. `"empty"` generates forward from the next 15th-or-month-end at
least two days out instead.

Changing `DEMO_SEED` takes effect on the next load: the store notices the mode
no longer matches and reseeds itself, so you do not have to remember to press
Reset.

## What is NOT real here

- **The data.** `CLAUDE.md` rule 4 forbids fake data "unless explicitly
  requested for prototyping" — this is that case, and it is fenced twice: the
  store only loads when `DEMO_MODE` is true, and the banner says so on every
  screen.
- **The rules.** The demo store is deliberately dumb. Where the live database
  would REFUSE something — 011's policies, 010's guard trigger, 013/014's
  functions — the demo does not. A demo is not where permissions get tested;
  `tests/sql/run.sh` is.
- **Sign-in.** Pressing it says so and points at the bar.

## Keeping it honest

```bash
node tests/demo.test.js      # the demo layer agrees with the real one
```

`js/database.js` exports 53 functions and the demo has to match all of them,
by name, by argument order *and* by the shape of what they take. Four things
were wrong before that file existed:

- `uploadMemberPayoutQr` and `uploadMemberAvatar` both take the **file** first,
  and the demo had them reversed — every upload would have failed mid-demo with
  "choose an image file".
- `pinStatus()` returned the column names instead of `hasTreasurer` /
  `hasMaster`, which reads as *"no PIN is set"* — the one thing
  `js/database.js` says never to get wrong.
- `addActivityLog`'s second argument is the app's `{type, amount, refStatus,
  memberId, round}`, not column names, so every logged entry arrived untyped
  and unattributed.
- **Contributions come in as camelCase** — `{cycleId, memberId, proofUrl}` —
  and `js/database.js` is what maps them to columns. The demo stored the
  caller's keys raw, so Review Payment showed `?` for the member, *"Cycle
  undefined"*, and *"No screenshot attached"* for a claim that had one. The
  argument-order table could not see that, so the test now **runs** the layer
  against a stub window and checks what it actually stored.

## If you want a demo on a real database instead

Create a second Supabase project, run `supabase/schema.sql` and
`supabase/seed.sql`, **do not** run migration 011, paste its URL and anon key
into `js/config.js`, and set `DEMO_MODE: false` with `AUTH_MODE: "optional"`.
Real persistence, shared between phones — at the cost of a project to keep and
real sign-ins to switch member.

## Merging

**Don't.** This branch exists to be deployed somewhere separate, or run from
`python3 -m http.server`. If any of it is ever wanted on `main`, the only part
that should go is `tests/demo.test.js`, and only alongside `DEMO_MODE: false`.
