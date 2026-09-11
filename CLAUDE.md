# Power Fund — Design-to-Code Rules

## Current Development Phase

Power Fund is currently undergoing a major redesign based on completed UI/UX flows and mockups created in Claude Design.

The mockups represent the **target product experience**.

They do NOT necessarily represent functionality that already exists in the codebase.

Some screens and interactions in the design may represent:

* existing functionality
* redesigned existing functionality
* partially implemented functionality
* completely new features
* future functionality
* UI concepts requiring backend/database support

Your responsibility is to determine which category each designed feature belongs to before implementing it.

---

# 1. Three Sources of Truth

When working on the redesign, use the following hierarchy:

### 1. Existing Codebase

This is the source of truth for:

* what currently exists
* current implementation
* existing business logic
* existing database behavior
* authentication
* permissions
* Supabase configuration
* existing calculations

### 2. Approved Design

Claude Design mockups and UX flows are the source of truth for:

* intended visual design
* intended navigation
* intended user experience
* intended information hierarchy
* intended interaction patterns
* target UI structure
* target mobile experience
* target desktop experience

### 3. Business Rules

Business requirements determine:

* what the system is allowed to do
* financial rules
* payment rules
* member rules
* treasurer rules
* approval rules
* data integrity requirements

When these sources conflict, do not silently choose one.

Identify the conflict and explain it.

---

# 2. Design Does Not Mean Implemented

Never assume that a feature shown in the design already exists.

For every significant designed feature, determine:

| Status          | Meaning                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| Existing        | Functionality already exists and can be connected to the redesigned UI    |
| Partial         | Some functionality exists but additional implementation is required       |
| UI Only         | The data/logic exists but the new presentation does not                   |
| New Feature     | The functionality does not currently exist                                |
| Design Conflict | The mockup conflicts with current business rules or technical constraints |

Use the actual repository to determine the status.

Do not invent existing functionality.

---

# 3. New Features Hidden Inside the Design

When a mockup introduces functionality that does not currently exist, do not treat it as a simple UI task.

Investigate what is required across the full stack.

Consider:

* frontend UI
* application state
* business logic
* database schema
* Supabase queries
* RLS policies
* storage
* authentication
* authorization
* notifications
* background processing
* PWA limitations
* error handling
* audit/history requirements

For example, if a design shows:

"Payment verified"

determine whether the existing system already supports:

* verification state
* verifier identity
* verification timestamp
* database persistence
* member notification
* transaction history

If not, identify those missing pieces before implementation.

---

# 4. Never Fake Backend Functionality

If the design contains functionality that requires backend/database support, do not create a UI that merely looks functional.

Do not use:

* fake data
* hardcoded success states
* local-only state pretending to be persisted
* placeholder database records presented as real
* simulated notifications presented as actual notifications

unless explicitly requested for prototyping.

The UI should accurately reflect what the system can actually do.

---

# 5. Design Fidelity

When implementing an approved design:

Aim for high visual fidelity.

Pay attention to:

* spacing
* typography
* sizing
* hierarchy
* cards
* buttons
* icons
* navigation
* states
* mobile layouts
* desktop layouts
* responsive transitions
* empty states
* loading states
* error states
* confirmation states

Do not simplify the design merely because the existing code structure makes it inconvenient.

If the existing structure is incompatible with the approved design, refactor the structure.

---

# 6. Do Not Blindly Copy the Mockup

The design is the target experience, but implementation must still respect:

* accessibility
* security
* performance
* responsive behavior
* actual data availability
* existing business rules
* technical limitations

If the mockup contains something that would create a poor technical or UX implementation, identify the issue and recommend a better solution.

---

# 7. Feature Gap Analysis

Before implementing a major redesigned screen, perform a feature gap analysis.

Determine:

### Design Requirements

What the mockup expects.

### Existing Capability

What the current application already provides.

### Missing Capability

What must be built.

### Data Requirements

What information the UI needs.

### Backend Requirements

What API/database/storage functionality is required.

### Security Requirements

What permissions and RLS policies are required.

### UX States

What should happen during:

* loading
* success
* failure
* empty data
* unauthorized access
* pending processing

Then implement accordingly.

---

# 8. Preserve the Meaning, Not the Old Structure

During this redesign:

The old UI structure may be replaced.

The old component structure may be replaced.

The old CSS architecture may be replaced.

The old navigation may be replaced.

The old HTML structure may be replaced.

However, the meaning and integrity of existing business operations must remain intact unless explicitly changed.

The objective is:

OLD IMPLEMENTATION
↓
UNDERSTAND EXISTING BEHAVIOR
↓
COMPARE WITH APPROVED DESIGN
↓
IDENTIFY GAPS
↓
BUILD TARGET EXPERIENCE
↓
PRESERVE BUSINESS INTEGRITY

---

# 9. When a Design Feature Requires a Business Decision

If the mockup introduces behavior that cannot be determined from the existing code or business rules, do not invent a financial or business rule.

Flag it as a product decision.

For example:

> "The design shows an automatic overdue status, but the current system does not define whether a grace period applies. This needs a business decision before implementation."

Technical assumptions are acceptable when low-risk.

Business-rule assumptions involving money, permissions, or records are not.

---

# 10. Definition of Done

A redesigned feature is not complete merely because the UI matches the mockup.

It is complete when:

1. The UI matches the approved design closely.
2. The intended user flow works.
3. Existing business logic remains correct.
4. New functionality is actually implemented rather than simulated.
5. Database behavior is correct where applicable.
6. Security and permissions are correct.
7. Mobile behavior works.
8. Desktop behavior works.
9. Loading/error/empty states are handled.
10. Existing functionality affected by the change has been regression-checked.

---

# Core Principle

The mockup tells you:

**WHAT the new product should feel and behave like.**

The codebase tells you:

**WHAT currently exists.**

The business rules tell you:

**WHAT the system is allowed to do.**

Your job is to safely transform the current implementation into the approved target experience while identifying and implementing the missing functionality.

Never confuse a designed feature with an implemented feature.

---

# Appendix — where the port actually stands

*Added by Claude as a working record. The rules above are the contract; this is
just current state, safe to trim whenever it goes stale.*

## Source of truth for the design

`design/` holds all 92 artboards plus `canvas.json`, extracted from the
published Claude Design canvas. **`canvas.json`'s `annotations` array is the
design's own written spec** — motion rules, interaction decisions, and three
binding scope decisions. Read it before implementing any screen; several
conclusions are not discoverable from artboard markup. See `design/README.md`.

## Scope decisions already taken

- **Cash payments** — kept as a treasurer-only path, out of the member flow.
  (The design removes them entirely; this project overrode that.)
- **Mid-fund member add/remove** — out of scope. The roster is read-only.
- **Fund Setup wizard** — deferred; the designer marked it lowest priority.
- **Payout QR / renaming** — ~~treasurer-managed. No per-member auth exists, so
  a member-only gate would be decorative.~~ **REVERSED once auth landed** —
  members now manage their own payout QR and bank details, which is what the
  design said all along. See "My payout details" below.
- **Forgot PIN** — solved with a master PIN (`app_settings.master_pin`), not the
  design's destructive reset. Non-destructive; every use is logged.
- **Profile photos** — now built (migration 009). **Onboarding** — now built,
  mobile and desktop, from all five artboards plus their `Desktop*` twins.
- **CropPhoto (drag to reposition / pinch to zoom)** — deferred. Photos are
  centre-cropped square and downscaled to 512px in the browser before upload,
  which frames a phone portrait acceptably at the 34–60px these render at. The
  interactive crop is a real gesture surface and was not worth it for that.
- **Editing your own name and photo needs a LINKED ACCOUNT**, not just the
  who-am-I preference. That preference is unverified and per-device, so
  honouring it would let anyone with the site URL pick any member and rename
  them — and names are stamped into the activity log and payout records. A
  permission decision, taken conservatively; the treasurer's Edit-member-names
  path is unchanged. With `AUTH_MODE` `off` this surface is inert, by design.
- **PIN entry does not auto-submit** on the 4th digit, though the design's
  annotation asks for it. PINs here may be longer than four digits (setup
  enforces only a minimum), and auto-submitting would make a longer PIN
  impossible to type, since a wrong attempt clears the field. The confirm
  button costs one tap and always works. Recorded as a deviation, not a bug.
- **The master PIN is now set from the app** (Menu → Security), not only by
  hand in SQL. It still cannot be blanked, and it may not duplicate the
  treasurer PIN — sharing digits would defeat the one case it exists for.

## Phases done

1. Design source committed · 2. Rejected payments, master PIN, PIN keypad ·
3. Navigation shell split per breakpoint · 4. Desktop Home dashboard ·
5. Members accordion + Menu grouping · 6. Feedback pass (upload states,
restore feedback, error toast with Retry, receipt enforcement, undo-confirmed
payment) · 7. Activity date grouping and typed columns, Insights trends, fund
name in the header · 8. Payment sheets rebuilt to their mockups · 9. Coverage
backlog (below).

Phase 9, from the independent coverage audit — all closed:

- **PIN wizard** — current → new → confirm → done, with a shake on a bad entry
  and a mismatch that bounces back one step, not to the start.
- **QR account details** (bank / account name / number) are written from the
  app, which is what finally gave `qr_bank` a writer; a member sees them
  beside the QR before sending.
- **Desktop header actions** — Export CSV on Activity, Reorder payout order on
  Members (treasurer only), and a titled Rounds detail header with Export
  round CSV.
- **Toasts are one stack**, bottom-anchored above the tab bar on the phone and
  bottom-right on desktop, carrying failures and confirmations together.
  Exports confirm; they used to save silently.
- **Boot failure** draws the NoConnection artboard, and only says "No
  connection" when the failure really looks like one.
- **Member names validate as you type** — by patching the two affected nodes,
  never by re-rendering, which would eat the caret.
- **Camera capture** on every upload surface, offered beside the file picker.
- Desktop modals blur what is behind them; the pending avatar pulses; the
  sparkline draws in; the balance counts up (once per change, not per render).
- Share text splits Overdue from Not-yet-due and breaks out rejected.
- Fund-complete says "Paid out" in words; the rejected screen is one red card.
- **A master PIN is offered right after the first treasurer PIN is set** —
  skippable, and still available from Menu → Security. Before this, a fund
  that never set one had no way back in.

**The plaintext-PIN P0 is closed** by migration 010 — see below.

## Architecture notes that bite

- **Views cannot see `app.js`'s closure.** Each `js/views/*.js` is a separate
  script; every helper must arrive on `ctx`. Getting this wrong throws only when
  that branch runs — it took the app down in production once. `tests/views.test.js`
  guards it statically.
- **`render()` assigns `innerHTML` on its last line.** A throw part-way leaves
  the previous DOM live and the UI frozen. It is wrapped in try/catch that shows
  the error instead.
- **Mobile and desktop navigate differently by design** — 5 mobile tabs with
  Members as a Home drill-down; desktop sidebar carries Members, with Menu as a
  profile footer. Not a CSS reflow: `renderTabBar` and `home.js` branch on
  `isWide`.
- **Status 3 (rejected)** is not money and still owes the cycle. `isOwed()` keeps
  unpaid and rejected together.

## My payout details (member-managed)

A **port**, not new design: `MyPayoutQRManage.dc.html` + its `Desktop` twin,
and `canvas.json`'s `my-payout-qr-notes` ("every member now has their own
receiving QR… added as a row in Menu — Member") plus
`payout-release-no-qr-notes` ("a real scenario now that members self-manage
their own payout QR"). The app was the deviation, for one stated reason — no
per-member auth — which migration 008 removed.

**The gate is `editableMember()`, a LINKED ACCOUNT — never
`localStorage.pf_my_member_id`.** That preference is unverified and
per-device, so honouring it would restore exactly the hole the old code
comment described: anyone with the site URL could pick any member and change
where their ₱30,000 is sent. `openPayoutQrModal()` also **ignores its
argument** and always targets the caller's own row; the argument survives only
so an old call site does not break, and taking it as the target would leave one
guard between a member and somebody else's destination.

**The treasurer's edit button is gone from everyone else's card.** Their route
is unchanged where it matters: Release Payout still shows the recipient's full
details, and `PayoutReleaseNoQR`'s "Copy reminder message" is how they chase a
member who has not added one. That was already built.

- **The treasurer may still edit a member who has NEVER SIGNED IN**
  (`payoutEditableMember(memberId)`), and the button on that member's card says
  *"until they sign in"*. Without this the feature strands exactly the people
  it is meant to serve: a member with no account cannot set their own details,
  and if nobody else can either, their payout destination is unreachable from
  the app and the only route left is SQL — worse than the treasurer-managed
  world this replaces. **The carve-out closes the moment they link**, and
  shrinks to nothing once the fund has all signed in. An ordinary member never
  gets it, linked target or not.
- **The database still lets the treasurer write these columns unconditionally**,
  which is the recovery path for a member who loses their Google account. The
  UI is narrower than the database on purpose. Do not "finish the job" by
  tightening the guard without deciding what happens to that member.
- **Account numbers are MASKED in the roster** (`maskAccount()`, last four
  digits). Not secrecy — the treasurer needs the full number and gets it in
  Release Payout, and the owner sees their own in full where they edit it. It
  is that a roster read by all five does not need to recite everyone's account
  number to say a destination exists.
- **The bank is a picker now**, from `PAYOUT_BANKS`, per the artboard's own
  `<select>`. Five people typing "GCash" / "gcash" / "G-Cash" into a free-text
  box the treasurer reads back under time pressure is a real way to send money
  to the wrong wallet. The artboard offers **"Other"** and gives it nowhere to
  go; it reveals a field here, because a dead option is worse than none. Free
  text saved before this was a picker selects "Other" rather than silently
  becoming GCash.
- **The activity entry names the member, not the number** — same rule as the
  member emails: the log is read by all five and lands in the CSV export and
  the backup file.
- **One addition the design does not have:** a Home nudge when a member has
  nothing on file and their round is the one collecting now or next. The design
  built only the treasurer's end of this reminder (the "Copy reminder message"
  above), which is the fallback for a nudge that never happened. Deliberately
  narrow — any earlier it is noise for four rounds, any later the payout is
  already out.

### The storage path had to change

`uploadMemberPayoutQr()` now writes **`payout-qr/<memberId>/<ts>.<ext>`**, not
the flat `payout-qr/<memberId>-<ts>.<ext>`. `storage.foldername()` sees folders
and never a filename prefix, so the old path could not be scoped to a member
at all — only to the whole bucket, which is why it was treasurer-only. Same
shape as `member-avatars`.

**Migration 011 was amended** (it is not applied yet, so no 012 was needed):
`payment_assets_write/update/delete` now allow `pf_is_treasurer()` **or** a
member's own `payout-qr/<their id>/` folder. Everything else in the bucket —
the fund's payment QR, the payout receipts — stays treasurer-only.

### `.single()` bit again, on the worst possible write

`saveMemberPayoutDetails()` used `.single()` and so **could not tell a refusal
from a success**: RLS hides the row rather than raising, and the reply is `[]`
with no error. It now uses `requireRows()`. This was a ninth instance of the
bug the "all eight money writes" note below describes — missed because payout
details were not in that audit. `tests/sql/run.sh` asserts the refusal returns
0 rows and no error, which is what makes the guard necessary rather than
decorative.

## Whose cycle is this? (payment attribution)

Reported from use: tapping another member's chip in Rounds opened the pay
sheet **for them**, with their name only in a small subtitle after "Round 2 ·".
Submitting filed your screenshot as *their* contribution. Easy to do by
accident, hard to notice afterwards.

- **A member may now only tap their OWN chip.** `cellClicked()` refuses another
  member's cycle by name ("That's Regine's cycle — you can only send your own
  payment"), and `rounds.js` no longer marks those chips clickable. The guard
  is in both places because `cellClicked` is exported on `PowerFund`.
- **Migration 011 settles it anyway**: `contributions_self` checks
  `member_id = pf_member_id()`, so paying for somebody else is about to be
  refused by Postgres. The UI was offering a button that is going to fail.
- **Not identified on this device → ask.** `openWhoAmIPicker()`, rather than
  taking the chip they happened to tap as the answer. That guess is what filed
  the payment against somebody else.
- **The treasurer's path is unchanged** and is the legitimate one, but it now
  announces itself: the member's name moves into the sheet TITLE ("Pay Cycle 7
  for Sarah") and an amber `.pay-for-warn` says the proof is filed against
  their cycle. Your own payment looks exactly as it did.

## The floating CTA's geometry

Reported from a real phone: the pinned "Resubmit payment" button cut a hard
band across the round card behind it. Three numbers disagreed, and none of the
~370 behavioural checks could see any of them — so `tests/smoke.js` now
MEASURES BOXES for this (`ctaGeometry`).

- **`--tab-h` and `--cta-h` on `:root` are the single source.** The tab bar's
  height and the CTA's clearance above it were two hardcoded guesses: the bar
  measures 60px, the CTA was pinned at `bottom: 58px`, so it sat **2px inside
  the bar** — and both gained `env(safe-area-inset-bottom)` independently, so
  they stayed 2px apart on a phone with a home indicator.
- **`.cta-spacer` was 84px against a CTA that measures 101px.** The last card
  could never fully clear it, and a button wrapping to two lines would have
  been covered outright. If the button's padding or font changes, re-measure
  and update `--cta-h`.
- **The scrim now fades instead of cutting.** It was
  `linear-gradient(to top, var(--bg-primary) 55%, transparent)` — 52px of fully
  opaque page background laid over `.battery-hero`, which is *lighter*
  (`--bg-card`). Against a card with its own rounded corners that reads as a
  chunk removed from the card, not as a scrim.
- **The Resubmit button's icon was on its own line.** `.floating-cta .hero-cta`
  set `display: block`, which outranks `.rejected-cta`'s `display: flex` — so
  that button's `justify-content` and `gap` were computed but **inert**, its
  block-level `<svg>` took a line of its own at the left edge, and the label
  wrapped underneath, centred. The `display` declaration is gone (`.hero-cta`
  already sets block for the plain variant), and the button went from 55px to
  44px. The container checks below all passed while this was broken — measuring
  a box says nothing about what is inside it — so the alignment is asserted
  directly now.
- **`.tab-bar` is the desktop sidebar too.** Giving the mobile bar a fixed
  height collapsed the sidebar to a 60px strip, so the desktop media query
  resets `height: auto`. A test asserts the sidebar is still full height —
  that regression was introduced and caught inside one edit.

## Member names: "Board Members", capped at 10 characters

- The roster heading on Home, the Members screen's own title, and the desktop
  sidebar's nav label all read **"Board Members"**. The mobile tab bar has no
  Members item at all (it is a Home drill-down), so that label only ever
  appears in the 232px sidebar, where it fits at the same row height as the
  others — measured, not assumed.
- **`NAME_MAX = 10`** is enforced in BOTH validators (`profileNameProblem()`
  and `editNamesProblem()`) and as `maxlength` on both inputs. The attribute is
  the courtesy that stops the keystroke; the validators are the rule, because
  `maxlength` does not survive a paste into a modified field or a direct call
  to the exported setter.
- Counted in UTF-16 units to match what `maxlength` itself counts, so the two
  can never disagree about whether a given string fits.
- The treasurer's modal **names the offending value** ("\"Wednesdayyy\" is too
  long") rather than saying one of five is — and flags that field, since a name
  already on file from before the cap arrives over-length and Save would
  otherwise refuse with nothing to point at.

## Migrations

Run in the Supabase SQL editor, in order. `006` also needs a one-off
`update app_settings set master_pin = '<digits>' where id = 1;`

`001`–`005` (earlier work) · `006_redesign_foundation.sql` — rejected payments,
master PIN, fund name, treasurer QR fields, typed activity, reserved avatar ·
`007_activity_attribution.sql` — `activity_log.member_id` / `.round_number` ·
`008_member_auth.sql` — `members.auth_user_id` / `.email` / `.is_treasurer`,
plus a documented one-off for the five addresses and the treasurer flag ·
`009_member_avatars.sql` — the `member-avatars` storage bucket, which is what
finally gave `members.avatar_url` (reserved back in 006) somewhere to point ·
`010_auth_helpers_and_secrets.sql` — the PIN vault, the identity helpers, the
claim RPC and the members guard trigger. **Changes no table policy, so it
cannot lock anyone out.** Ships with `010_rollback.sql`.

**`011` is written and validated but NOT APPLIED.** Three files:
`011_preflight.sql` (read-only readiness report, run it first),
`011_rls_lockdown.sql` (the policies), `011_rollback.sql`. The lockdown calls
the readiness check and **refuses to run** while any member lacks an email, a
treasurer is not flagged, or anybody has not signed in once — its policies key
off `members.auth_user_id`, so an unlinked member is denied everything.
Overridable with `select set_config('pf.allow_unready','yes',false);` but
don't.

**011 and `AUTH_MODE = "required"` must ship together.** 011 revokes `anon`
entirely, so the migration without the deploy shows every member a load error,
and the deploy without the migration is a gate in front of nothing.

Every migration from 010 on is wrapped in `begin; … commit;`. Not decoration:
without it a `raise` in 011's preflight aborted one statement and psql
cheerfully ran the rest, dropping `open_all` and locking the fund out — the
exact outcome the check exists to prevent.

## Member accounts (in progress)

A **new feature beyond the design** — the mockups have no auth and say so
(`canvas.json`, `forgot-pin-notes`). Decisions taken: **Google only** (the one
provider needing no SMTP, so a forgotten password is Google's problem and not a
recovery flow we have to build), **the treasurer PIN stays** as a second gate
on top of the `is_treasurer` role, and **linking is by email** — the treasurer
stores the five addresses and a first login with a matching address links
itself.

Everything is behind **`AUTH_MODE` in `js/config.js`** (`off` | `optional` |
`required`, default `off`), so switching auth on is a decision rather than a
side effect of a deploy. `optional` exists to test Google on a real phone
without gating the other four members. An unset or unrecognised value falls
back to `off`.

Done: migration 008, sign-in/sign-out, the session gate, the Menu → Account
group, the claim/link step, self-service name + photo (migration 009), and
**the treasurer's Member sign-in panel** (below). **Not done:** the RLS rewrite.

**Menu → Account → Member sign-in** (ADMIN only — see below — and only while
`AUTH_MODE` is not `off`) is where the addresses a login is matched against
are actually recorded. They had **no UI at all** — only a hand-written SQL update — which
meant whoever rolled accounts out had to be whoever held the Supabase
password, and every member's personal address had to travel to them. Category:
**UI Only**. 010's guard has always said the treasurer "may reorder, flag and
re-address anyone" and refuses a member `Only the treasurer can change a
member's email`; this is the missing presentation, not a new permission.

Four things in it worth not undoing:

- **Uniqueness is enforced, not cosmetic.** `resolveAccount()` matches with
  `.find()`, so two members sharing an address would silently hand the row to
  whichever came first in payout order.
- **Stored lowercased**, because that is how `resolveAccount()` compares. A
  capitalised paste would otherwise never match its own login.
- **The activity log gets the member's name, never the address.** The log is
  read by all five, and goes into the CSV export and the backup file; writing
  five personal addresses there would spread them past the one roster row that
  needs them.
- **Unlink** is the recovery path for a wrong claim (010 permits it to the
  treasurer only). It writes `auth_user_id: null` and nothing else — a test
  asserts the payload has exactly that one key.

It also prints the rollout state: addresses on file, who has signed in, and
whether a treasurer is flagged — the same three conditions `011_preflight.sql`
refuses to lock down without. Deliberately **not** a promise that the lockdown
will succeed; the migration stays the authority.

## `unlocked` is NOT the admin gate — `isTreasurerAccount()` is

A distinction worth keeping straight, because getting it wrong was a real hole
in the first cut of the sign-in panel.

`unlocked` means **somebody typed the treasurer PIN**, and that PIN is shared
with the whole group by design — any of the five can unlock treasurer mode.
That is fine for the day-to-day treasurer tools (the group trusts each other
with the fund) and it is the wrong gate for administering **who can sign in**:
gated on the PIN, any member could put their own address on somebody else's
row and claim it.

`isTreasurerAccount()` is the admin test: a Google-verified login that owns a
member row carrying `is_treasurer`. It is the same flag migration 011's
policies key off, so it is the authority Postgres will use after the lockdown.
The Member sign-in panel — the menu row, the render branch, and all four
exported handlers — is gated on it, never on `unlocked`.

- **Bootstrap escape hatch:** with nobody flagged at all, it falls back to the
  PIN. Otherwise a fund whose 008 one-off was never run could never reach the
  panel that sets the addresses — a permanent dead end. It grants nothing new:
  with no treasurer flagged, 011's readiness check refuses the lockdown
  anyway, so the PIN is the only authority that exists yet.
- **Treasurer mode starts LOCKED, and opens with one tap and no PIN** for a
  Google-verified treasurer. It used to auto-unlock on sign-in; that was
  reversed deliberately — loading the app is not an intent to act on money,
  and the owner wanted the mode entered on purpose.
- **`verifiedTreasurer()` is the strict test that gates the PIN-free path**,
  and it is NOT `isTreasurerAccount()`. The latter falls back to the PIN when
  nobody is flagged; using it here would turn "no treasurer on file yet" into
  "treasurer mode is one tap away".
- **Everyone else who can still see the button keeps the PIN.** That is the
  boundary, not an oversight: `canUnlockTreasurer()` deliberately shows the
  button to anyone the app cannot identify (auth off, signed out, unlinked)
  because it is the only route to the master PIN. A blanket "no PIN any more"
  would hand one-tap treasurer mode to any member who simply skips sign-in —
  and until 011 is applied, treasurer mode in the UI is real write access to
  every table. A test asserts both halves.
- **Destructive actions still ask for the PIN** (Reset all data, Restore,
  Undo release, Transfer role). Left as-is on purpose. Open question worth
  revisiting: a treasurer who never sets a PIN cannot satisfy them, since the
  unlock flow is no longer where a PIN gets created.
- **Consequence to remember:** the "You are / Edit" profile card lives in the
  member branch of the Menu, so an auto-unlocked admin does not see it. Their
  route to their own name and photo is Menu → Account → **Edit my profile**,
  which already existed for exactly this reason. Two smoke tests had to move
  to a non-treasurer login because of this.
- **The unlock button is hidden** from a member the app can positively
  identify as not the treasurer (`canUnlockTreasurer()`), and `toggleUnlock()`
  refuses them — the button is not the gate. **Shown in every uncertain
  case**: auth off, signed out, not linked, or nobody flagged. The direction
  is deliberate and is a recovery decision, not a UX one — the button is the
  only route to the PIN modal, and the PIN modal is the only route to the
  MASTER PIN. Hiding it from somebody merely unidentified would take the
  fund's own way back in with it. Do not "tighten" this to hide it whenever
  the viewer is not the flagged treasurer.

## Transferring the treasurer role

**A product decision the owner took explicitly**, after the conflict below was
put to them: the role moves by moving `members.is_treasurer`, and only members
who have signed in may hold it.

**The conflict that prompted it.** The owner's model was "everyone can enter
treasurer mode with the PIN, and the role transfers by handing over the PIN".
That works today and **stops working the moment 011 is applied**: every
treasurer-only policy keys off `is_treasurer`, the PIN appears nowhere in
them, and RLS cannot see a PIN at all — a policy runs inside Postgres on a
request carrying a Google session and nothing else. So after 011 the PIN would
transfer the buttons and none of the power, which is worse than either
alternative because it looks like it worked. Recorded here because it is
exactly the kind of thing `CLAUDE.md` rule 9 says to flag rather than decide.

Menu → Security → **Transfer treasurer role** (admin only). Three things in it
worth not undoing:

- **Grant first, then resign.** Two network calls with no transaction across
  them, so the only question is which half-state to fail into. Grant-then-
  resign leaves TWO treasurers: visible in the sign-in panel, caught by 011's
  preflight, and either of them can finish the job. Resign-then-grant leaves
  NONE — and nobody can set the flag back, because setting it requires being
  the treasurer. That is SQL-only recovery. The order is the safety property.
- **It verifies afterwards** and reports the two-treasurer state plainly
  rather than saying "done". A test asserts the write order.
- **Only linked members are offered.** `pf_is_treasurer()` matches on
  `auth_user_id`, so flagging an unlinked row would produce a fund whose
  treasurer nobody can actually be. The screen names who is missing and why.

Losing the role drops `unlocked` immediately — before 011 those buttons would
still *work*, which is worse than being refused.

No migration needed: 010's guard already lets the treasurer "reorder, flag and
re-address anyone".

## The optional-mode sign-in prompt

`AUTH_MODE = "optional"` used to hide sign-in behind Menu → Account, which
does not survive being explained to five people one at a time. A first visit
now opens on the sign-in screen, with a **Not now** that steps past it;
`localStorage.pf_signin_skipped` remembers the skip, so it asks once per
device. `promptSignIn()` decides; it waits on `authReady` so it cannot flash a
login at somebody whose session is still being read from storage.

- **Rendered BEFORE onboarding, AFTER `!state`.** Before onboarding so the
  claim has happened by the time the tour renders — which is what lets
  onboarding correctly drop its who-am-I step for a linked member. After
  `!state` so a member whose fund failed to load sees the connection error
  rather than a login screen that cannot work.
- **`signInHtml()` is skippable only when auth is not `required`.** The
  required-mode gate must not offer a way past itself; a test asserts it has
  no Not-now.
- **Signing out sets the skip flag.** Fronting the app with the prompt one
  render after a deliberate sign-out would read as the app refusing to let
  them out.
- **`tests/smoke.js`'s `markOnboarded()` now sets BOTH keys**, or the prompt
  would front every check the way onboarding once did. `{ freshDevice: true }`
  still skips the prompt and keeps the intro — the onboarding tests are not
  about the prompt.

**`required` does NOT have to ship with 011.** The coupling runs one way only:
011 without `required` shows every member a load error, but `required` without
011 is merely a gate in front of rules Postgres is not enforcing yet. What
`required` DOES need is **every member's address on file** — without one, that
member hits the `unknown` dead-end with no way into the app at all.

`resolveAccount()` runs after every load and puts the account in one of five
states, which drive everything else: `linked` (this login owns a member row),
`unknown` (signed in with an address nobody carries), `taken` (the matching row
belongs to another login), `no-email` (the roster has no addresses at all yet),
or null (auth off / signed out). The last three are a full-screen dead-end when
auth is `required`, and only a warning banner when it is `optional` — blocking
there would punish the person testing sign-in.

Two details worth not undoing:

- **The claim is guarded in the database, not in JS.** `linkMemberAccount()`
  updates `... .eq("id", …).is("auth_user_id", null)`, so two devices racing the
  same first login cannot both win: the loser's update matches no row and comes
  back empty, which resolves to `taken`.
- **`no-email` is its own state on purpose.** Reporting it as "you're not on the
  roster" would send someone chasing the wrong fix; the real cause is that
  migration 008's one-off was never run.

When a login owns a member row, **that row is the identity** — `identityId =
accountMemberId || myMemberId`, so `localStorage.pf_my_member_id` still answers
while `AUTH_MODE` is `off` or nobody is linked. Every "Change" / "Not you?"
control is hidden for a linked member (`identityLocked` on ctx) AND
`openWhoAmIPicker()` refuses, because it is an exported handler that anyone can
still reach.

## The PIN vault (migration 010)

`app_settings.treasurer_pin` / `.master_pin` are **gone**. The digits live in
`app_secrets`, which has RLS on and **no policy at all**, so PostgREST cannot
reach it. Three security-definer functions replace every read:
`pf_pin_status()` (booleans only), `pf_check_pin(kind, pin)`, `pf_set_pin(kind,
pin)`. `js/app.js` contains zero references to either column now.

`js/database.js` implements **both worlds** — `pinStatus()` / `verifyPin()` /
`setPin()` try the RPC and fall back to the plaintext columns when the function
is absent — so the app works either side of the migration. Which world it is in
is cached per session (`pinPath`), because otherwise a pre-010 database logs a
browser 404 on every load and every 30-second poll. The cache clears itself the
moment the legacy read stops working, which is exactly what applying 010
mid-session looks like.

**The one rule not to break here: an error is NEVER reported as "no PIN is
set".** The app offers to *create* a treasurer PIN when none exists, so
misreading a network blip as "no PIN" hands treasurer mode to whoever hit it.
Hence `hasTreasurerPin()` defaults to `true` when status is unknown, a
successful-but-empty RPC answer is distrusted rather than believed, and the
smoke harness now 404s unrouted RPCs the way real PostgREST does — answering
them with `200 []` hid this exact bug once.

**After 011 the PIN stops being a security boundary.** Permission will come from
`members.is_treasurer` inside the policies, so a guessed PIN would grant
treasurer *mode in the UI* and still be refused every write by Postgres. That is
why `pf_check_pin`'s brute-force surface is acceptable — slowed by a 0.3s sleep
on failure, not solved.

## What migration 010 was validated against

A real PostgreSQL 16 cluster with `auth.uid()` stubbed to Supabase's own
definition. Verified: the vault is unreachable as `authenticated`; wrong/empty/
right PIN checks; a non-treasurer cannot set either PIN; the master PIN may not
duplicate the treasurer PIN; claiming is atomic and idempotent and a claimed row
cannot be taken twice; a member may rename and re-photograph **themselves only**
and is refused `member_order`, `is_treasurer`, `email` and re-linking; the
treasurer may do all of those and unlink; `anon` is entirely unaffected; and the
rollback restores the columns, is idempotent, and 010 re-applies on top of it.

**That validation caught a bug that would have broken every first login**:
`pf_claim_member()` updates `auth_user_id`, which fires the guard trigger — and
at claim time the caller owns no row yet, so `pf_member_id()` is null and the
ownership test rejected the very update that establishes ownership. The guard
now recognises a claim explicitly, with every other column pinned so the
exemption cannot smuggle anything else through. No smoke test could have found
this; the harness mocks the network.

## What 011 enforces, and what it cost to get right

Reads stay open to any signed-in member — this fund is transparent by design.
Writes: own row only on `members` (010's trigger does the columns); own
contributions only, and **only into status 0/1 with a proof for 1 — status 2
is treasurer-only**, because confirming money is the treasurer's act;
`cycles`/`payouts`/`app_settings` treasurer-only; `activity_log` append-only
with **no update policy for anyone, treasurer included**; avatars scoped to
`<memberId>/` folders; the payment QR treasurer-only.

Validated on a real PostgreSQL 16 cluster with `auth.uid()` and
`storage.foldername()` stubbed to Supabase's definitions, exercising each rule
as an ordinary member and as the treasurer. Three real bugs came out of it:

- **The rollback did not roll back.** `%L` quotes a policy name as a string
  literal where Postgres wants an identifier (`%I`), so the storage section was
  a syntax error. A rollback that doesn't run is worse than none.
- **A rollback→reapply cycle left the lockdown undone for one bucket.** The
  rollback derived policy names from bucket ids, producing `payment_proofs_*`,
  but `schema.sql` calls those `proofs_*` — so 011 didn't know to drop them and
  `anon` kept insert/update/delete on payment-proofs. The rollback now uses an
  explicit mapping and 011 drops both spellings.
- **`.single()` does not detect a refusal.** It returned `[]` with no error, so
  `upsertContribution` reported success for a write Postgres declined.

That last one matters more than it sounds. **RLS refuses an update by making
the row invisible, not by raising** — the reply is `[]` with no error. And the
treasurer PIN is shared with the whole group, so a member who is not the
flagged treasurer can unlock treasurer mode, tap Confirm, and be told it
worked. `requireRows()` in `js/database.js` now guards all eight money writes
and says which account is actually needed. `unwrap()` also maps PGRST116 to
that message instead of "check your internet connection", which sent people
after their wifi over a permissions error.

Two things to keep in view:

- **Until 011 is applied, a login proves identity but does not restrict
  writes.** RLS is still `using (true)` on every table. The PINs are no longer
  exposed, but the write-side payoff arrives with 011.
- **The sign-in screen has no approved mockup.** It borrows
  `OnboardingWelcome.dc.html`'s composition. Flagged for UI/UX QA as new
  design, not as a port. The account dead-ends (`unknown` / `taken` /
  `no-email`) reuse that same shell and are likewise unmocked.
- **Edit Profile and Change Photo ARE ports** — `EditProfile.dc.html` and
  `ProfilePhotoSheet.dc.html`, both as bottom sheets, with the `camera` and
  `photos` icon paths lifted verbatim from the artboards. They reuse the
  established `.modal-overlay.sheet` treatment, whose `::before` already draws
  the grabber, so do not add another.

## Onboarding (built from the five approved artboards)

`Onboarding{Welcome,HowItWorks,HowToPay,PayoutOrder,WhoAreYou}` and their
`Desktop*` twins — one render path, two frames, the way the rest of the app
does it. Full-screen like the auth gate, so it renders in `renderView` **after**
the account checks (someone who cannot use the app at all should be told that,
not walked through a tour and dead-ended at the end of it) and **before** the
shell.

"Seen" is `localStorage.pf_onboarded` — per device, which is what "first-time"
means here, and there is no DB column for it.

**Two deliberate departures from the artboards:**

- **The final step is dropped for a linked member.** It is the who-am-I
  picker, which writes the per-device preference — but once a login owns a
  member row the identity comes from the database and cannot be switched
  (`openWhoAmIPicker()` refuses). The design predates accounts and cannot know
  this. Four steps and four dots in that case; five otherwise.
- **Every name and figure is real.** The artboards hardcode "Ana / Ben /
  Cathy…", "Paid out / This round / Upcoming" and "GCash". Rendering those
  would be fake data (rule 4), so the payout-order step reads the actual
  roster and round state, and step 3 names the treasurer's actual wallet from
  `settings.qr_bank`.

Two additions the design does not have: a **Menu → "Replay the intro"** row,
because otherwise the flow is unreachable and untestable after its one
showing; and `pesoWhole()` for the prose figures, since `C.peso()`'s two
decimals are right for a ledger and wrong in a sentence — the artboards write
"₱1,000", not "₱1,000.00".

**`tests/smoke.js`'s `serve()` now marks onboarding seen by default**, or it
would front all ~290 checks. Pass `{ freshDevice: true }` for a first-run
browser. A test that routes by hand instead of calling `serve()` must call
`markOnboarded(page)` itself — `pinVault` did not, and that is how this was
caught.

## Backup completeness (found while waiting on member emails)

`downloadBackup()` had silently fallen five migrations behind. A file called
"Backup data (JSON)" was omitting:

- **every member's payout destination** — `payout_bank`,
  `payout_account_name`, `payout_account_number`, `payout_qr_url` (005). This
  is *where each ₱30,000 is sent*, and it is the most consequential data in
  the app after the contributions themselves.
- `avatar_url` (009), `email` and `is_treasurer` (008)
- `contributions.rejection_note` / `rejected_at` (006) — a restored refusal
  said it was rejected but not why
- every typed column on `activity_log` (006/007), so a restored log collapsed
  to plain text with no type, member or round
- `app_settings` **entirely** — fund name, payment QR, QR account details

And `restoreFromBackup()` never wrote `activity_log` at all, though every
version of the backup captured it. So *Reset all data* → *Restore backup*
returned the money and dropped the history of how it got there.

Now `version: 2`, with all of the above captured and restored. Three rules
worth keeping:

- **`auth_user_id` is deliberately NOT in the backup.** It is a foreign key
  into one Supabase project's `auth.users`; restoring it would dangle or
  re-point who owns a row. Members re-link by signing in.
- **A v1 file must write only the keys it actually carries.** Spreading a v1
  member row would null out the payout account numbers currently on the
  roster — turning "restore my contributions" into "wipe the fund's config".
  Tested: a v1 restore writes exactly `["name"]`.
- **The PINs are not in the backup and cannot be.** They live in
  `app_secrets`, which the browser cannot read. A test asserts the file never
  contains either word.

The backup file now contains member emails, payout account numbers and links
to payment screenshots. It carries a `_note` saying so, and the restore
confirmation names everything it replaces.

## Tests

```bash
node tests/views.test.js      # static: view scope. no browser
node tests/calc.test.js       # money rules. no browser
bash tests/sql/run.sh         # RLS on a real Postgres 16. no browser
python3 -m http.server 8791 & # then:
PF_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node tests/smoke.js
```

`tests/sql/run.sh` is the only suite that can see an RLS policy at all — the
smoke harness mocks the network. It stands up a throwaway PostgreSQL 16
cluster, stubs Supabase's `auth.uid()` and `storage.foldername()` to their real
definitions, and applies the policy text **extracted from
`supabase/migrations/`** rather than a copy. Two things it taught, both of
which would have read as migration bugs:

- **`UPDATE … WHERE` applies SELECT policies too**, so the harness needs
  `payment_assets_read` from `schema.sql` — which 011 deliberately leaves
  alone. Without it, "a member may replace their own QR" fails against a
  policy that is correct.
- **`authenticated` needs `USAGE` on the `auth` and `storage` schemas**, which
  real Supabase grants. Without it every policy denies for the wrong reason —
  and that is a false PASS on every DENY assertion, which is the dangerous
  direction.

Bump `CACHE` in `sw.js` on every deploy that changes the shell.

## UI/UX QA Gate

Power Fund uses an independent UI/UX QA process.

Claude Code must not consider a major UI/UX phase complete simply because the code compiles or the feature functions.

After each major UI/UX implementation phase:

1. Verify the implementation against the approved design.
2. Run functional checks.
3. Ensure mobile and desktop behavior are correct.
4. Prepare the implementation for independent UI/UX QA.
5. Do not declare the phase fully complete until P0/P1 QA findings have been addressed.

The independent QA agent is responsible for visual and UX review.

Claude Code must not modify the design merely to justify an implementation mismatch.

If the implementation differs from the approved design, determine whether the difference is:
- intentional
- deferred
- superseded
- acceptable
- or an implementation gap.

When a QA finding conflicts with business logic, financial rules, security, or database integrity, do not blindly implement the visual recommendation. Investigate and report the conflict first.
