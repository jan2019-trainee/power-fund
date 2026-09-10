# UI smoke test

A headless-browser pass over the things that would be embarrassing to break:
every tab renders, treasurer mode unlocks, the caught-up and fund-complete
states appear, decorative motion respects `prefers-reduced-motion`, and nothing
throws.

There is no build step and no unit-test framework here — this is one script you
run when you've changed the UI and want to know you didn't break a tab.

## It never touches the live fund

Every Supabase REST call is intercepted and answered from `mock-data.js`. The
real project is never contacted, so a run is safe from any machine, gives the
same answer every time, and can't corrupt anyone's contributions.

`mock-data.js` holds a small but deliberately awkward fund: five members, one
claim awaiting review, one member behind on recent cycles, and one who pays a
week late every time (so the on-time leaderboard has something to rank).

## Running it

Playwright isn't vendored — use a global install:

```sh
npm install -g playwright        # once
python3 -m http.server 8791 &    # from the repo root
NODE_PATH=$(npm root -g) node tests/smoke.js
```

Exits non-zero if any check fails, so it works in CI as-is.

| Variable | Purpose |
| --- | --- |
| `PF_BASE_URL` | Point at another server (default `http://localhost:8791/index.html`) |
| `PF_SHOT_DIR` | Directory to write screenshots to — useful for eyeballing a change |
| `PF_CHROMIUM` | Path to a Chromium binary, if Playwright's own isn't installed |

## What it does not cover

It exercises the UI against fixed data. It does not test the database layer,
the PWA/service worker, or anything that writes — so a green run means the
screens still render and behave, not that a release is safe. Anything touching
real money still wants a walkthrough against real data.
