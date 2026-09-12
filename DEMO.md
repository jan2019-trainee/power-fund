# Power Fund — demo build

Branch **`demo/group-walkthrough`**. Not for deploying over the real app.

```
AUTH_MODE: "optional"     DEMO_MODE: true      (js/config.js)
```

## How to use it

Open it like the normal app. A gold bar sits at the top of every screen:

```
DEMO   as [ Jan (treasurer) ▾ ]   [Reset]
```

- **The dropdown switches member.** That is the whole point of this branch —
  pick Regine, Sarah, Jan, Clara or Verdz and the app reloads as that person.
  No Google account, nobody's password, no sign-in.
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

## What the starting state is set up to show

Chosen so the whole feature set is reachable without setting anything up
(`js/demo-seed.js`). Dates are relative to the day you open it, so nothing
reads as stale.

| | |
| --- | --- |
| **Round 1** | Paid out to Regine · receipt attached · **confirmed received** |
| **Round 2** | Paid out to Sarah · receipt attached · **Sarah disputes it** — "nothing in GCash" |
| **Round 3** | Collecting · 3 confirmed, 1 in review, 1 **rejected** with a reason, and one member paid ahead |
| **Round 4** | Not started · Jan has an open **turn-swap request** out to Clara |

Some things worth driving, and who to be:

- **Jan** — the dispute leads the screen; unlock with `1234` for the review
  queue, then confirm Clara's claim. Undo release & re-send is on the dispute.
- **Sarah** — her own dispute card: *It arrived after all* or *Withdraw my
  report*, and *View the treasurer's receipt*.
- **Clara** — Jan's swap request, with Accept / Decline. Accepting really does
  move the payout order.
- **Verdz** — the rejected claim, with the treasurer's reason and *Resubmit*.

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
by name *and* by argument order. Two were wrong in the first draft
(`uploadMemberPayoutQr` and `uploadMemberAvatar` both take the **file** first),
and `pinStatus()` returned the column names instead of `hasTreasurer` /
`hasMaster` — which reads as "no PIN is set", the one thing `js/database.js`
says never to get wrong. That check exists because eyeballing 53 signatures is
how those got in.

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
