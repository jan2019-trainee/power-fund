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

## Two bugs from the first day on 011

**A view destructured its own function off `ctx`.** `inlineArgSafe` is a
module-level function in `members.js`; `payoutDest()` also pulled the name off
`ctx`, which shadowed the real one with `undefined` and crashed the whole
Members screen — but only for a member who had a payout QR on file, so it
surfaced the day somebody uploaded one.

`tests/views.test.js` exists precisely to catch this and could not see it:
`ctxUsedByView()` used `match`, not `matchAll`, so it only ever checked the
FIRST `= ctx` destructure in a file and every helper function's was invisible.
Now it reads all of them, with the body bounded to `[^{}]` — a non-greedy
any-char body happily spans from one `const {` to a LATER `} = ctx;` and
reported `startCycle` (from `C.roundCycleRange`) as missing, a false positive
that would have trained the next person to ignore the check. A second
assertion catches the sharper form directly: **a name the file declares AND
destructures off ctx** is always this bug.

**The Insights donut called a paying member "Not due yet".** `roundMemberStates`
bucketed by the earliest unsettled cycle, and `paid` meant all SIX cycles of
the round — unreachable until a round is nearly over, so the slice was dead
for most of a round's life and somebody who had genuinely paid and been
confirmed was charted as having done nothing. Reported from use, and fair.

`paid` now means **nothing outstanding**: square on every cycle that has come
due. It degrades correctly — at the end of a round, square and all-six are the
same thing. The distinction that keeps it honest is that having paid *nothing*
while nothing is due stays `notDue`; without that, everybody would read as
"paid" on day one of a round. The donut has no approved mockup (the design
specifies only "on-time rate, per-member standing, and a per-round collection
timeline"), so its semantics were ours to correct.

## Resubmitting a rejected batch

Reported from use: a member paid six cycles in one transfer, the treasurer
rejected all six, and **"Resubmit payment" opened a sheet set to ONE cycle**
(`modalCount = 1`, unconditionally). They submitted, one cycle went to review,
five stayed rejected — and the card kept reporting a refusal they thought they
had answered.

`openContributeModal()` now defaults the count to the size of the rejected
batch the cycle belongs to, capped by `maxAdvanceCount()` so it can never
select a cycle that is already confirmed or in review. The button offers to
redo the rejection shown beside it, so it should offer to redo all of it;
reducing the count is still one tap.

**The owner asked for the remaining rejected cycles to be RESET when a member
resubmits any of them. That was declined and put back to them as a product
decision**, per rule 9 and the QA gate's money carve-out. A member who
resubmits 1 of 6 still owes the other five: clearing the flag would stop the
member being told, drop them out of the treasurer's attention queue, and take
them out of `isOwed()` so the round's funding gap silently shrinks on screen.
`CLAUDE.md` already states the invariant — *"a rejected cycle stays OVERDUE:
refusing a claim must never quietly excuse the member from paying it."*

What was done instead is honest about both halves: a **partial** resubmission
now shows a purple `.rejected-inreview` line inside the red card ("Cycle 1 is
with the treasurer for review"), so a resubmission never looks like it
vanished while the genuinely-still-owed cycles keep saying so.

### A refused ADVANCE is not a debt

The owner came back with a sharper version of the same question, and it was
right: a member who pays six cycles when only one is due is **paying ahead**.
Refuse the batch and five of those cycles were never owed — the member
volunteered early and was turned down. Painting them red said "you are behind"
about money nobody had asked for, and the card's `rejected-hint` said *"These
cycles are still due"*, which for a not-yet-due cycle is simply **false**.

**Display only — the data is untouched.** The rows keep status 3, the note and
the proof, so the refusal stays on record. That is safe precisely because the
accounting does not distinguish them: `isOwed()` is true for unpaid AND
rejected alike, and `isOverdue()` needs the due date to have passed either way.
So this changes what a chip SAYS, never what is counted. (The owner's earlier
request — clear the remaining rejected cycles on resubmit — was a different
thing and stays declined: those cycles WERE due.)

- `rounds.js` renders `status === 3 && !overdue` as a plain not-due chip.
- The rejected card splits its sentence: what is genuinely due gets "send that
  again", what was paid ahead gets "isn't due yet — nothing is late".
- **The roster ring stays red**, deliberately. `memberStanding()` already
  argues it: "a refused claim outranks the rest… it should read that way even
  before the cycle falls due." The ring is about the member having an ACTION;
  the chip is about whether that cycle is late. They can differ and both be
  true.

**Every due date in `tests/mock-data.js` is in the future**, so every rejection
in the fixtures is a refused advance. The pre-existing "chip marked in Rounds"
check was therefore asserting red for a case that should never have been red;
it now pushes one cycle's due date into the past so it tests a refused DEBT,
which is the case that must still read red.

### Pending is purple everywhere now

`.member-chip.pending` was the lone amber one, while `.my-status-pending`,
`.acct-pill.wait`, `.stat-value.pending` and the Insights donut's "In review"
slice all used `--pending-review`. The same payment read as one colour in the
cycle grid and another in Insights. **`.round-state.pending` is deliberately
left amber** — it is "Payout Pending", a round lifecycle state, not a payment
awaiting review, and making it purple would claim the two mean the same thing.

The full chip vocabulary: green paid · purple in review · **red solid
overdue** · **red dashed rejected** (sent and refused, versus never sent) ·
plain not-due-yet.

## The first independent UI/UX QA pass, and what it found

Run per the QA Gate, by a separate reviewer working from `UX_QA_AGENT.md`,
against `design/`, the source, and 115 real captures. Verdict: **NEEDS
REVISION** — 1 P0, 5 P1, 16 P2, 16 P3. Every finding below was verified
against the code before acting on it. **Closed so far:**

**P0 — a confirmed payment could be reverted inside a round already paid out.**
`markPayoutReleased()` gates release on `isRoundFunded()`, so the app asserted
funded-implies-released in ONE direction and let the other be broken silently.
Two taps produced a round badged *Completed* at ₱28,000 / ₱30,000 with a
₱30,000 payout on record against it — no warning at the moment of the change,
no marker afterwards, and the contribution only recoverable from `activity_log`.
`tests/mock-data.js` is already in that state (Verdz is short on cycles 5–6 of
round 1, which is released), which is what made the marker testable.

- `revertBreaksReleasedRound()` **refuses** rather than double-confirming: the
  correct order already exists and every step of it is built — Undo Release,
  revert, release again.
- Checked where the panel opens AND in `doRevertContribution()`. `cellClicked`
  is exported on `PowerFund`, so an untappable chip is not the gate.
- **A fund that already got there now SAYS so** — `.payout-shortfall` names the
  gap on any round that is `released && !isRoundFunded()`. Being wrong quietly
  was the worse half of this.

**P1 — the destructive confirm button was never disabled.** `menu-pin-notes`
names this property explicitly: *"type RESET AND enter the PIN before 'Reset
everything' enables — genuinely disabled/enabled live based on both fields."*
It was disabled only while `busy`, so "Reset everything" rendered as a
saturated red primary on an empty dialog. `submitConfirm()` did validate, so
nothing was destroyed — but an invisible gate teaches the treasurer to press
first and read second, on the screen that wipes every contribution.
`confirmGateUnmet()` now drives the attribute, patched by hand on input rather
than via `render()` (which would eat the caret). The PIN is checked for
PRESENCE there and for CORRECTNESS in `submitConfirm()`: the button must not
become the gate.

**P1 — the round-lifecycle palette disagreed three ways.** Collecting was green
on Rounds and amber on the desktop Home strip; Completed was green in both, so
Collecting and Completed — the two most opposed states — shared a colour and
were told apart only by their word; and the strip painted Payout Pending in
`--pending-review`, which is exactly the claim the `.member-chip` note refuses
to make. **One palette now**: amber for the two in-flight states (a real
progression), an inset outline separating pending from collecting, green only
for done. The payment vocabulary is untouched — that work was correct.

Also closed: **"Undo" → "Undo Release"** on the round accordion (P2-14), which
sat on the same screen as "Undo confirmation" with no way to tell the scope of
the tap apart.

**Every one of these passed the suite before the fix, because nothing asserted
the behaviour at all.** The 12 new checks were run against the unfixed code
first: 7 failed. Two initially passed in BOTH directions and were rewritten —
one was a false pass (`/short/` matched the sentinel string "(no
.payout-shortfall rendered)"), the other called `cellClicked(null, …)`, a
no-op. A check that cannot fail is not a check.

**P1 — money actions were gated on `unlocked`, the SHARED PIN.** 011 keys every
money write off `members.is_treasurer`; only the five ADMIN surfaces had been
moved. Confirm, reject, revert, record-as-paid and release still checked the
PIN, so four of five members were invited into a mode where Postgres refuses
every write — and found out by pressing Confirm on a real claim.

**The obvious fix would have broken the app, and this is the part to keep.**
The predicate is NOT `!isTreasurerAccount()`: that is false whenever the app
cannot identify the viewer AT ALL — auth off, signed out, a link that broke —
and a fund on `AUTH_MODE` `"off"` still has flagged members, so keying off it
would disable every money action for a legitimate treasurer with no session.
`moneyWritesRefused()` acts only on a viewer it can POSITIVELY identify as
somebody other than the treasurer, the same direction `canUnlockTreasurer()`
takes, with the same nobody-flagged escape hatch. A test asserts the
auth-off direction, which is the one that would have taken the fund down.

The note is shown in Review Payment before the press, both buttons are
disabled, and all five handlers refuse — they are exported on `PowerFund`, so
a disabled button is not the gate.

### The two product decisions, taken by the owner

- **The Release Payout amount stays FIXED** at `GOAL_PER_ROUND`, against
  `payout-release-notes` ("stays editable … historical record only"). Recorded
  here rather than left as an unexplained deviation. `payouts.amount` is a
  restatement of the goal, not a record of what was transferred — so a bank fee
  or a partial send is not expressible, and release is funded-gated so the
  round always held at least that much when it went out. The dead doc-comment
  describing the removed parser is deleted.
- **Home's whole-fund block is DEMOTED to one line**, per the design's
  "split out of Home so the dashboard stays glanceable" (`rounds-notes`); no
  Home artboard carries a whole-fund meter. **The QA report's stated reason was
  wrong and it is worth knowing why**: it said the block "carries the largest
  type on the screen". Measured, `.battery-amount` is **30px** against
  `.fund-total-amount`'s **16px** — the hero already won on size, and the code
  comment claiming it was demoted was accurate. What actually outranked the
  hero was SHAPE and POSITION: a three-line block with its own progress bar,
  sitting first. So the fix is the shape, not the type — one line, and the
  second progress bar is gone, because two meters in one scroll read as a
  fault rather than as two questions.

### The P2 pass — all 16 closed

Mostly consistency, but four were real defects wearing a P2 label:

- **P2-1, the chip affordance was INVERTED.** The mark was
  `unlocked && status !== 0` — on the chips already settled, withheld from the
  unpaid ones, on both sides of the gate. A member's own payable chip carried
  only `cursor: pointer`, which does nothing on a phone: the one action they
  came for was invisible while the four chips they may not tap looked identical
  to it. It now goes on `clickable`. And it is **no longer `border-style`** —
  dashed already means "sent and refused", so the old hover flipped dashed to
  SOLID and turned a rejected chip momentarily into an overdue one (P3-11).
  An inset ring in the chip's own colour instead.
- **P2-2, the payment QR had no height bound.** A full phone screenshot of a
  GCash QR renders 476px tall at 220px wide, pushing the amount, stepper, proof
  upload and "I've sent this" off a 92vh sheet. `max-height: 220px` +
  `object-fit: contain`; the lightbox is how you read a dense code.
- **P2-10, Start Round N outweighed Release Payout.** `css/style.css` carries a
  comment at `.payout-btn` setting exactly that hierarchy — and a later pass
  gave `.contribute-btn` a gradient primary with a drop shadow, which outranks
  `.payout-btn`'s flat accent. So the non-urgent action came to look more urgent
  than sending somebody their ₱30,000. Its own `.start-round-btn` now.
- **P2-9, the terminal screen read differently by role.** `S.complete` was
  pulled ahead of the personal card for a treasurer by the rule about the
  attention QUEUE outranking it — but when the fund is complete there is no
  queue and no release (both gated on `!allDone`), so all that rule did was
  give the treasurer a different reading order on the last screen the group
  ever sees. The duplicated-and-clipped sentence is gone too: the status card
  carries the receipt, the green card carries the fund total and your on-time
  record. Fixing it once moved the duplication down a card rather than removing
  it, which the screenshot caught.

The rest: the schedule modal's warning and live error moved ABOVE its list with
sticky actions (they were below a 50vh list, and the error carries
`role="alert"` so it was announced while invisible) and two columns at ≥900px;
desktop Menu is the 2-column settings page `desktop-notes` asks for, with the
danger zone as a full-width band — the groups are one element each now, which
is what made the grid possible; desktop Members opens populated; exports are
treasurer-only on all three surfaces that disagreed; roster tag colours
un-inverted; "In review" is the single label for that state; a negative amount
in the activity log is always a signed debit (a revert is logged with
`refStatus: STATUS_UNPAID`, which routed it into the unsigned branch); Day One
no longer renders beside All-caught-up; and the reset dialog no longer promises
to keep a PIN the fund does not have.

**P2-15: the 640px breakpoints moved to 899px.** Three breakpoints disagreed
about what device this is — the shell switches at 900px, but the sheet
treatment and the 44px touch targets both stopped at 640px. So 641–899px (iPad
portrait, a phone in landscape) got the thumb-reach tab bar with mouse-sized
hit areas and desktop-positioned centre modals. No check had ever run in that
band; `tabletBand` does now, and 768px is captured.

### The P3 pass — closed, with two findings corrected

Polish, mostly. Three were not:

- **P3-14 was reported as "the trend delta is missing" and the fixtures blamed.
  The fixtures were fine.** `trendHtml` required the CURRENT round to have
  dated payments, and a round that has just started never does — so the delta
  was invisible for most of every round's life, which is why neither capture
  showed one. It now compares **the two most recent rounds that actually have a
  rate**. It also NAMES both ("R3 ↑4pts vs R2"): the tile's value is the
  LIFETIME rate, so a bare "↑4pts" beside it read as a delta on that figure,
  which is not what was being measured.
- **P3-6's colour half is NOT a defect and was left alone.** The report called
  the gold 100% battery a vocabulary clash. `HomeFundComplete.dc.html` uses
  `#F5A623` nineteen times and `#4CAF83` once — the artboard's fund-complete
  screen is amber by design. What WAS real is the icon: the status card used
  `party`, the same glyph as Menu's "Replay the intro", so a terminal state
  shared an icon with a how-to-use-the-app link. It is `check` now, matching
  the green card beside it.
- **P3-8's "not vertically centred" is wrong** — `.signin` is
  `min-height: 100vh` with `align-items: center`, and the block measures
  centred. The real gap was the composition: a 320px mobile column on a 1440px
  canvas, where `DesktopOnboardingWelcome.dc.html` — which this screen says it
  borrows — is a **520px** centred column, and the app's own onboarding already
  does 520px here. **Adding the artboard's two corner glows was a mistake and
  was reverted**: they already exist app-wide as `body::before` / `body::after`
  (`position: fixed`), and a second pair inside `.signin` (which is
  `overflow: hidden`) clipped each blurred circle into a hard rectangular seam
  across the page. Caught in the screenshot, not the tests.

The rest: the Activity sub-line drops "loaded" (a developer's word for a fetch)
and the count entirely when nothing is filtered; an empty log offers no filter
chips and no export of nothing; the hidden-rows note arrives **quiet** and only
becomes an alert once the viewer narrows the filters themselves — it fired on
arrival because the round filter defaults to the current round; Rounds carries
ONE badge per header with the current round marked on the card instead
(`.round-active-tag` is deleted, not orphaned); the desktop Rounds strip marks
which round is collecting; `.acct-pill.wait` is amber, not the payment-review
purple; the Day One card is neutral rather than an attention treatment; the
`.pin-input` 4px tracking no longer applies to PLACEHOLDERS ("T r e a s u r e r
P I N" read as a rendering fault); the member Menu's explainer is a `<details>`
on the phone and stays open in the desktop column; and the schedule modal has
**Reset changes** plus `past` dimming that refreshes — it was computed once at
render, so a cycle shifted out of the past stayed greyed on the screen whose
job is moving dates.

**One substitution worth knowing.** `DesktopHomeMember.dc.html`'s second quick
action is "View payment QR code". That is NOT built: `openQrModal()` is the
treasurer's MANAGE screen, the QR a member needs is already in the contribute
sheet at the moment they need it, and a read-only twin of a treasurer screen is
more surface than the gap deserves. **My payout details** is there instead —
member-facing, already built, and gated on a linked account. Recorded as a
substitution, not as the artboard's row.

The status card also gained the artboard's **"Submitted N ago"**, which is the
one thing on it a member cannot work out for themselves: without it there is no
telling a claim sent an hour ago from one sitting unreviewed for a week.

### The evidence gap the pass exposed

The reviewer could not judge **My payout details** or **Onboarding** — both
declared ports — because neither appears in the 115 captures, along with Edit
Profile, Change Photo, Share, Toasts, the restore states, the lightbox and the
account dead-ends. `tests/qa-capture.js` pins `AUTH_MODE` to `off`, and those
surfaces need a linked account. Anything marked **J** in the report is
unreviewed, not approved.

## Two PIN dead ends, both made by the PIN-free unlock

Both existed because the PIN rules were written when treasurer mode could only
be entered BY TYPING A PIN — so a PIN always existed, and you always knew it.
A Google-verified treasurer now unlocks without one, and neither rule was
revisited.

**1. A fund with no treasurer PIN at all.** The verified treasurer unlocks,
nothing anywhere mentions that no PIN exists, and then Reset all data / Transfer
role / Remove treasurer present a PIN field. Every entry answered **"Incorrect
PIN"** — perfectly true and completely useless, since the correct PIN was no
digits at all.

- The confirm dialog now detects it and **offers the way out instead of an
  input that cannot be satisfied**: an amber `.confirm-no-pin` note and a
  "Set a treasurer PIN" button (`startPinForConfirm()`) in place of the
  destructive one.
- **The missing-PIN check runs BEFORE the type-to-confirm check** in
  `submitConfirm()`. The render hides the RESET field in this state, so the
  other order would refuse with "Type RESET exactly to confirm" about a field
  that is not on screen.
- The type-to-confirm field is hidden too — typing RESET into a dialog that
  cannot be submitted is busywork.
- **It does NOT resume the action afterwards.** Re-confirming a reset on
  purpose costs one tap; auto-resuming a destructive action after a detour is
  not a thing to build.
- Menu → Security now reads **"Set a treasurer PIN"** with a note naming the
  three actions that need it, mirroring what the master-PIN row already did.
  Nothing else in the app would ever have mentioned the absence.

**2. The master PIN could unlock the lockout but never END it.** This one was
worse, because the app *instructed* people into it: unlocking with the master
PIN shows *"Set a new treasurer PIN from Menu → Change PIN so the group can use
their own again"* — and `openChangePin()` opened by demanding the current
treasurer PIN, the very one they had just proved they had forgotten. The master
PIN exists for exactly this situation and could not finish the job.

`changeNeedsCurrentPin()` is now the single rule, used by the flow AND by the
progress bar so a two-step flow cannot draw three dots: prove the current PIN
unless there is none, **or you are in on the master PIN this session**
(`unlockedViaMaster`, set only after a successful database check). Not a new
permission — `pf_set_pin` already allows it, and the app already promised it.
A test asserts the control case: an ordinary PIN unlock still proves the
current PIN, or anyone holding an unlocked phone could lock the group out.

## The payment schedule is editable now (Menu → Group → Payment schedule)

Found while auditing what "complete" was hiding. `cycles.due_date` has existed
since the first schema, and all 30 dates are written **once** by
`supabase/seed.sql`, generated two and a half years ahead. Nothing in `js/`
ever wrote them — every reference was a read, and `schema.sql`'s own comment
says *"edit freely"*, meaning in SQL.

Those dates are not decoration. They drive `isOverdue()`, every red chip, the
treasurer's attention queue and the share text. A paluwagan slips — somebody's
salary is late, a round starts two weeks after the last one closed — and the
app then confidently accused people of being late with the only fix being the
Supabase SQL editor. The same shape of gap the Member sign-in panel was built
to close for emails, on data that makes accusations about people.

Category: **UI Only**. **No migration** — 011's `cycles_treasurer` already
permits the write.

- **Gated on `isTreasurerAccount()`, not on `unlocked`.** 011 keys the policy
  off `members.is_treasurer`, which the shared PIN cannot express, so a
  PIN-gated row would offer the other four a button Postgres refuses. Checked
  in the menu row, in the render branch and in both handlers — `openScheduleModal`
  and `saveSchedule` are exported on `PowerFund`, so the absent row is not the
  gate. (The bootstrap fallback inside `isTreasurerAccount()` stands: with
  nobody flagged, 011 is not in force either.)
- **"Move later cycles too", on by default.** The real use case is "round 3
  started two weeks late", which is 28 edits by hand — the kind of chore that
  leaves a feature unused and the schedule wrong. It also keeps the ordering
  correct for free.
- **The shift measures from the last VALID date, not the previous draft.** A
  date input empties itself between segments when edited with the keyboard
  (`"2026-10-15"` → `""` → `"2026-11-15"`), so measuring against the draft saw
  a move out of nothing and skipped the shift for anyone not using the picker.
  Found while writing the test, not in the browser.
- **Strictly increasing is ENFORCED**, and it is a technical invariant rather
  than an invented business rule: `currentCycle()` returns the first cycle in
  number order whose date has not passed, while `completedCyclesCount()` counts
  every cycle whose date has. Out of order those two disagree and the app shows
  one cycle as current while counting a later one as done.
- **Moving a settled cycle is WARNED, never blocked.** `onTimeStats()` judges
  `paid_at <= due_date`, so moving a cycle that already has confirmed payments
  rewrites who is on record as having paid on time. A schedule that genuinely
  slipped should still move — the screen names the affected cycles instead of
  refusing, and refusing would be inventing a rule nobody asked for.
- `updateCycleDueDates()` sends **only `due_date`**, row by row. An upsert would
  need every NOT NULL column back in the payload, and sending `cycle_number`
  with it is how a typo renumbers the schedule. `requireRows()`, not `.single()`
  — the tenth place that bug could have landed.
- **No approved mockup exists for this screen.** It borrows the established
  `.modal` treatment the way Edit member names does. Flagged for UI/UX QA as
  new design, not as a port.

## The entry animation marks a SCREEN CHANGE, not a render

Reported from use: the 30-second background poll replayed the whole page's
entry transition, so the screen re-assembled under somebody who was reading it.
The owner wanted the transition KEPT for navigation — it is good — and gone
everywhere else.

`render()` reassigns `innerHTML`, so every element is new on every render and
every CSS entry animation restarts. That is right for a screen change and
wrong for a poll, a realtime push, a `busy` flip, or any re-render of the
screen you are already on.

`animateEntry` (js/app.js) is true for the first paint and for a deliberate
move between screens — `setView()`, an onboarding step, entering or leaving
the tour — and false otherwise. `render()` toggles `body.pf-anim` from it
BEFORE assigning innerHTML, so the new elements are inserted with the class
already present, then clears the flag.

**The switch is a CUSTOM PROPERTY, not a class selector, and that is the part
not to "simplify".** `body.pf-anim .view-head { … }` looks equivalent and is
not: it raises specificity from (0,1,0) to (0,2,1), and the `animation`
SHORTHAND resets `animation-delay` to 0. The stagger (`.fund-total`,
`.battery-hero`, …) and the whole `prefers-reduced-motion` block are both
(0,1,0) and win today purely by SOURCE ORDER — they would have silently lost,
taking the stagger and the accessibility opt-out with them. Swapping only the
VALUE (`animation: var(--pf-entry)`) leaves every existing cascade
relationship exactly as it was. Tests assert both: the 0.08s stagger survives,
and reduced motion still overrides.

**The trap this fix could have introduced.** `.spark-line` draws itself by
animating `stroke-dashoffset` 400 → 0. Switching the animation off without
moving the BASE to 0 would have left the line fully dashed — invisible — on
every screen that is not a fresh navigation, which is worse than the bug being
fixed. `--pf-dash` is 400 only while animating. A test asserts the line is
still drawn when it does not animate.

**Not covered, and worth knowing:** an ERROR toast visible when the poll fires
still replays `pfToastIn`. Success toasts auto-dismiss after 4.5s so the window
is small, but an error toast waits to be dismissed. Fixing it properly means
tracking the toast's identity the way `runCountUps()` tracks `countedValues`,
rather than reusing `pf-anim` — gating a toast on a screen change would stop a
NEW toast animating in, which is the case that matters.

## "Received ✓" — the payout's missing second side (migration 012)

Found by asking what the payout record does NOT say. `released`, `amount`,
`recipient_member_id`, `recipient_name`, `receipt_url`, `released_by` — every
column on `payouts` is the **treasurer's** word. Meanwhile a member's ₱1,000
contribution needs a proof screenshot AND the treasurer's confirmation. The
largest single transfer in the fund, ₱30,000, had nobody on record saying it
arrived. Category: **New Feature**, and **no approved mockup exists** — the
design has no auth and no recipient-side anything. Flagged for UI/UX QA as new
design.

**It protects the treasurer most.** "I sent it" versus "I never got it" is the
one dispute this app cannot currently settle, and the treasurer is the one
holding the other four people's money when it happens.

### The gate is a NEW AXIS: being the recipient

Not `unlocked`, not `isTreasurerAccount()`, not `verifiedTreasurer()` — every
other permission in the app is about the treasurer, and this one is not.

- **`myUnconfirmedPayout()` matches on `recipient_member_id`, not on
  `member_order`.** 012's policy is `recipient_member_id = pf_member_id()`, and
  the roster can be reordered after a release — which is exactly when the
  payout ORDER and the recorded recipient disagree. Keying the button off the
  order would offer it to whoever currently sits at position N. A null
  recipient (a pre-004 row the backfill never reached) is refused by that
  policy for everyone, so it correctly offers the button to nobody.
- **`editableMember()`, a LINKED ACCOUNT — never `pf_my_member_id`.** Same rule
  as the payout QR, for the same reason: that preference is unverified and
  per-device, so honouring it would let anyone with the site URL close the one
  record that says somebody else's ₱30,000 arrived.
- Checked in `openReceiptAck` AND `confirmReceiptAck` — both are exported on
  `PowerFund`, so the absent card is not the gate.

### Six decisions worth not undoing

- **No `received_by` column. Its absence IS the integrity property.** There is
  only one person who may set `received_at`, enforced in Postgres, so a second
  column naming them could only ever disagree with the policy or restate it.
- **`received_at` is stamped SERVER-SIDE** (`new.received_at := now()` in the
  guard). The client does not choose when the money arrived.
- **A round stays *Completed* while unconfirmed.** The money genuinely left.
  This is a receipt, not a gate — one member forgetting to tap must not freeze
  the fund or reopen a round. The record line says what is true instead.
- **Acknowledge ONCE.** No un-acknowledging; only the treasurer can clear it,
  and only via Undo Release, which clears the whole release
  (`doUnmarkPayoutReleased()` now clears `received_at`/`received_note` too —
  otherwise a re-release would arrive pre-confirmed).
- **The treasurer cannot acknowledge on a member's behalf.** A receipt somebody
  else can sign is not a receipt. The guard refuses it explicitly, and a test
  asserts that direction.
- **The activity entry carries NO amount.** The money moved at release and was
  logged there; a figure here would make a release-and-confirm read as ₱60,000
  leaving the fund — the same bug `doUnmarkPayoutReleased`'s comment describes.
  It does name the member (`memberId`), because the log is read by all five.

### Two real design flaws the SQL suite caught

Neither was findable in the browser — the smoke harness mocks the network.

- **My first guard forbade the treasurer setting `received_at` at all**, on the
  reasoning that confirming receipt is the member's act. But in this fund the
  treasurer IS a member with a payout round, so Jan could never confirm their
  own ₱30,000. The rule is **"only the recipient"**, which is a different
  statement from "not the treasurer".
- **`is distinct from` could not detect a second confirm.** `now()` returns the
  same value throughout one transaction, so `new.received_at is distinct from
  old.received_at` was FALSE on a re-confirm — the update fell straight through
  to the member branch, where `received_note` was unpinned and therefore
  editable. The set-branch is `new.received_at is not null and old.received_at
  is null`, and the member branch refuses outright once `old.received_at` is
  set.

### And one the smoke output caught, by printing it

The record line read **"Received by Sarah on Invalid Date"**. `payoutDateText`
fed everything through `C.parseDueDate()`, which appends `"T00:00:00"` — right
for `released_on` (a plain `date`) and fatal for `received_at` (a
`timestamptz`). It branches on the shape now. The check that printed it was
passing: it asserted the name and the note but not the date, so the assertion
was tightened to name the formatted day and reject `Invalid`.

### UI

- **Home, green, above `S.myStatus` and below `S.attention`.** Green and not
  amber deliberately: the amber family on Home means "the fund's money needs
  something doing about it", and money arriving for *you* is not that.
- **Two taps, inline, not a modal** — one button opens a panel with an optional
  one-line note and Confirm / Cancel. The note is the only free text, capped at
  120 characters.
- **The record line on the Rounds accordion is shown to EVERYONE**: "Awaiting
  Sarah's confirmation that it arrived." before, "Received by Sarah on <date>
  — <note>" after. "Did Sarah actually get it?" is the group's question, not
  the treasurer's, and an absence has to read as an absence rather than as
  nothing at all.
- Both `received_at` and `received_note` are in the backup and restored.

## Turn swaps — *palit ng turno* (migration 013)

Two members agree to trade payout positions. The mockups have **no swap flow
at all** and explicitly scope post-setup member actions to EditMemberNames +
ReorderPayout (`canvas.json`, `gap5-no-member-changes-notes`), so this is a
**New Feature beyond the design** — flagged for UI/UX QA as new design, not a
port.

### The bug this started as

**"Reorder payout order" had never worked.** `members.member_order` is
`not null unique` (`schema.sql`), and the app swapped a pair with two
sequential single-row updates. The first one always collides:

```
update members set member_order = 2 where id = <A>;
ERROR:  duplicate key value violates unique constraint "members_member_order_key"
DETAIL:  Key (member_order)=(2) already exists.
```

A single `case` statement fails **identically** — Postgres checks a
non-deferrable unique constraint per ROW, not per statement. Verified on a
real Postgres 16 before writing any code. Three things had to line up for this
to survive: the smoke harness mocks the network; the reorder test rendered the
screen and **never clicked an arrow**; and `tests/sql/run.sh`'s stub of
`members` had **omitted the `unique`** that `schema.sql` declares. The stub now
carries it, the test clicks the arrow, and a check asserts the two-write form
still collides — so nobody can "simplify" the RPC away.

So the swap flow is not an addition on top of a working reorder. Fixing the
reorder IS the first half of it, and both halves now go through the same
deferred-constraint statement inside a function.

### The two product decisions, taken by the owner

Put to them rather than invented, per rule 9 — both are money-and-permissions
calls.

- **Both members agree, then it applies.** A member asks, the counterparty
  accepts, and the order moves. The treasurer is **not a step**, and
  `pf_accept_swap` refuses them explicitly: a swap neither member agreed to is
  the thing this flow exists to prevent. The treasurer sees it in the roster
  and the activity log.
- **A round that is COLLECTING may be swapped.** "I need mine this month, take
  mine next month" is what *palit ng turno* is for; refusing it would remove
  the reason the feature exists. The money collected stays with the round —
  only who receives it changes.

**RELEASED is the one refusal**, both directions, and for the treasurer too. A
member whose round is paid out has had their ₱30,000; moving them to a later
round would pay them twice and leave the other member with nothing. Checked at
request time AND again at accept time, because a round can be released in
between.

### The gate is a new axis, again

Not `unlocked`, not `isTreasurerAccount()` — **being one of the two members**.
`canSwapTurns()` combines a linked account (`editableMember()`, never
`localStorage.pf_my_member_id`), a database carrying 013, a round of your own
left to trade, and at least one counterparty who could answer. Every handler is
checked as well as every row, because they are exported on `PowerFund`.

**Only LINKED members are offered as counterparties.** `pf_accept_swap` keys on
`pf_member_id()`, so asking an unlinked member produces a request nobody can
answer — worse than no button. The treasurer's reorder is the route for those.

### Three things in the migration worth not undoing

- **The unique constraint is looked up BY DEFINITION**, not assumed to be
  called `members_member_order_key`. `schema.sql` declares it inline, so the
  name is Postgres's own choice and a hand-built database may differ —
  dropping the wrong constraint would be silent and bad.
- **`from_round` / `to_round` are stored as they were WHEN ASKED**, and
  re-checked on accept. The order can change in between (another swap lands,
  or the treasurer reorders), and a request that then applied would trade
  different rounds than the two people agreed to. That request is **stale**.
- **The stale branch RETURNS rather than raising, and that is the point.** My
  first version marked the row stale and then raised — which **rolled back the
  very row it had just marked**, leaving it `pending` with an Accept button
  that could never work and the partial unique index still occupied. It is the
  one refusal here that has to PERSIST something, so it cannot be an
  exception. `acceptSwap()` in `js/app.js` therefore checks `status` and
  reports a stale answer as a failure: a successful call that moved nothing
  must not read as "Turns swapped". Caught by `tests/sql/run.sh`.

### The guard exemption, and why it is a GUC

`pf_members_guard()` pins `member_order` for anyone who is not the treasurer,
and the trigger fires even for a security-definer caller — `pf_is_treasurer()`
inside it reads the CALLER's `auth.uid()`. So without an exemption,
`pf_accept_swap` would be refused *"Only the treasurer can change the payout
order"* for the ordinary member it exists to serve.

Signalled by `pf.swap_ok`, a **transaction-local** GUC that only
`pf_accept_swap` sets, with every other column pinned — exactly the shape of
010's claim exemption, whose comment already argues this. A browser cannot set
it: PostgREST exposes only functions in the public schema, and `set_config`
lives in `pg_catalog`. Transaction-local so it cannot leak into the next
request on a pooled connection; a test asserts it does not survive the
transaction, and three more assert the exemption loosened nothing else.

### Logged in the database, not by the app

`pf_accept_swap` and `pf_swap_order` both write their `activity_log` entry
inside the same transaction. A swap is the one write that moves everybody's
turn, and the log is the only place the group can see that it was mutual — so
it must not be possible for the order to move and the record to be missing.
`moveMember()` no longer logs; doing both would double the entry.

### UI (no approved mockup)

- **Home, purple** for an incoming ask — the same family as every other
  "waiting on a person" surface (`.my-status-pending`, `.acct-pill.wait`, the
  Insights "In review" slice). Not amber: amber here means the fund's money
  needs something doing about it, and the fund is fine either way. Not green:
  nothing has happened yet.
- **The outgoing side is deliberately quiet** — a plain card, because the
  viewer has already acted and is waiting on somebody else. Without it a
  member who has asked has no way to tell whether the request went anywhere,
  and no way to withdraw it.
- **Menu → General → Swap my turn**, beside My Payout QR Code, with the same
  sign-in-first fallback row.
- The sheet spells out **both sides** of the trade before Send, names who can
  accept, and says both members keep paying every cycle either way — the thing
  somebody would reasonably worry about.
- **One live request per member.** 013's partial unique index enforces it and
  `pf_request_swap` supersedes the old one; the sheet warns in amber before the
  press, because a new ask withdraws the one already out.
- The `swap` icon is **two straight opposing arrows**. The first version curved
  one arrow around the other — the conventional shape, and illegible at the
  14px it renders at. Measured in a capture, not guessed.

### Who received round N: the RECORD, not the position

Reported from the captures, and the owner confirmed it matters ("it's about
who received 30k"). The accordion header read **"Round 1 — Regine"** over a
release record saying **"Payout released to Sarah"**.

`payouts.recipient_member_id` is stamped at release (`markPayoutReleased`
snapshots it, deliberately, "so the history stays correct even if members are
later renamed, reordered, or removed"). The roster can then move — a turn swap
or a treasurer reorder — and for a RELEASED round the position and the record
disagree. Reading the position credits somebody who never got the ₱30,000 and
tells the real recipient they are still owed.

**`roundRecipient(round)`** is now the single answer: the payout row's
recipient when there is one, the member at that position otherwise. **Six
sites** were reading the position; four of them are money statements:

- the Rounds accordion header (the reported one)
- the Insights "Collected per round" bars
- the desktop Home rounds strip
- `doUnmarkPayoutReleased()`'s activity-log entry — **for money that actually
  moved**, and the log is the only record left afterwards
- `members.js`'s "· received the payout" line
- and **`memberPayout(memberId)`** replaced
  `getPayout(m.member_order).released` in FIVE places, which was the sharpest
  instance: it drives the roster's **"Paid out"** tag and `memberStanding()`'s
  ring colour, plus the viewer's own *"You received ₱30,000 in Round N"* on
  the terminal screen and the standing shown in the profile and photo sheets.

**The sites about an UNRELEASED round still read the position, and must.**
Nothing has been sent, so `member_order` is what will decide: the release card,
the Release Payout sheet, `copyPayoutReminder()`, `markPayoutReleased()` (which
is how the record gets stamped in the first place), the Home hero recipient,
`autoSelectMember()`, the prev-pending cards and onboarding's "This round".
`memberPayout()` is the exception there — onboarding's "Paid out" word is
about a released round even inside that loop.

`payoutRecipientName(payout)` is unchanged and still prefers the snapshotted
`recipient_name`: that one renders the historical record line, where the name
as it was at release is the right thing.

Four smoke checks force the divergence (round 1 released to Sarah while Regine
holds position 1) and all four fail against the old reads — printing
"Round 1 — Regine" and `["Regine"]`, which is the reported bug exactly.

## "It never arrived" — payout disputes (migration 014)

Reported from use, looking at the live Received ✓ card: **a member asked "did
it arrive?" had exactly one button.** If the ₱30,000 had not arrived their
options were to press something untrue or to stay silent — and silence is
indistinguishable from forgetting to tap. The one dispute this app exists to
settle was the one thing it could not record. Category: **New Feature**, **no
approved mockup** — flagged for UI/UX QA as new design.

The same report named a second gap, narrower than it first looked: the
treasurer's receipt **already existed and was already viewable**, but only on
the Rounds screen (the release record and Payout history). So somebody was
being asked to sign for ₱30,000 with the evidence two taps away on another
screen. `payment_assets_read` is open to any signed-in member, so there was no
permission work — only placement.

### The product decision, taken by the owner

**A dispute is FLAGGED LOUDLY and BLOCKS NOTHING.** It leads every screen,
shows on the round for everyone, and is logged — while the fund keeps
collecting. Put to them rather than invented, because "does a dispute freeze
the fund" is a business rule about money.

The alternative (gating `canStartNextRound`) was offered and declined, and the
reasoning is worth keeping: the money has already left the treasurer's hands,
so a hold punishes the other four for a transfer they cannot fix, and one
member who forgets to withdraw a resolved report would stall the group with no
way for the treasurer to clear it. Same shape as 012's recorded decision that a
receipt is not a gate.

### The rules, and which ones differ from 012

- **Only the recipient may file one** — the same axis as the confirmation, and
  the treasurer explicitly cannot file on a member's behalf.
- **`disputed_at` is stamped SERVER-SIDE**, like `received_at`.
- **`received_at` and `disputed_at` can never both be set.** They are opposite
  answers, so it is a CHECK CONSTRAINT (`payout_ack_exclusive`) and not merely
  trigger logic — no path, present or future, should be able to put a row on
  record as both received and never received.
- **Confirming receipt CLEARS the dispute**, and the guard does it, not the
  client. Money arriving late is the ordinary happy ending, and leaving it to
  the caller would let a forgetful one violate the invariant.
- **A dispute may be withdrawn by the person who filed it**, which is the one
  place this deliberately differs from `received_at` (treasurer-only to
  clear). A confirmation is a receipt and amending one is a correction; a
  dispute is a report of a problem, and problems get resolved. **If a dispute
  were permanent nobody would dare press it.** The treasurer may also clear
  one, which is how a report gets closed out after the two of them have sorted
  it.
- **Already confirmed received → cannot be disputed.** Taking a receipt back
  is a correction, and corrections are Undo Release.

### What the SQL suite caught

Three of the 20 new assertions were wrong before the code was:

- **"a reporter may NOT delete the treasurer's receipt" was VACUOUS.** The
  fixture left `receipt_url` null, so setting it to null changed nothing, the
  pinning never fired, and the check passed against a guard that did not
  protect it. The fixture now populates `receipt_url` on released rounds —
  which is also more honest, since a receipt is required at release.
- **"the treasurer may also clear a report" filed the report AS the
  treasurer**, which the guard correctly refuses. The setup was wrong, not the
  rule.
- psql renders a concatenated boolean as `true`/`false`, not `t`/`f`.

**012's member branch would have refused every dispute write.** It raised
`'A recipient may only confirm receipt, nothing else'` whenever `received_at`
was null — which is exactly the shape of a dispute. The branch now admits a
dispute-only write, and the column pinning had to be re-asserted rather than
assumed to still apply, which is what the receipt check above exists for.

### UI (no approved mockup)

- **RED, and the only place on Home with the danger family.** It leads every
  screen — ahead of the rejected card, a funded round and the review queue, all
  of which are orderly by comparison. It outranks the rejected card by POSITION
  rather than by a louder colour: that one is also red but is about ₱1,000 and
  is fixed by resending.
- **Shown to EVERYONE.** The fund is transparent by design and a ₱30,000 gap is
  the group's problem; hiding it would make the treasurer the only person who
  could see it.
- **The recipient does NOT also get the group alert about themselves.** Their
  own card already says it and carries the two actions, so rendering both
  printed the same fact twice with the payout-QR nudge wedged between the
  copies. **Caught in a capture, not a test** — the second time that shape of
  duplication has only shown up in a screenshot (the first was the
  fund-complete screen). A check now asserts it.
- **"No — it hasn't arrived" is not a red button.** It sits under a green
  primary, and making it red would read as a destructive confirmation, which it
  is not: it files a report. The panel's own submit IS red, where it is the
  confirmed act.
- **The two panels can never both be open.** They are opposite answers with
  separate note fields, so a half-typed "received in full" can never be filed
  as a dispute. Asserted in both directions.
- **"Undo release", not "Undo release & re-send".** The longer label wrapped to
  two lines beside View receipt at 430px; the remedy is explained in the fine
  print instead, where it has room. Measured in a capture.
- The activity entry carries **no amount**, same rule as the confirmation: no
  money moved, and a figure would make a release-and-dispute read as ₱60,000
  leaving the fund.
- `disputed_at` / `disputed_note` are in the backup and restored. The rollback
  names the query to run first, because an open report is exactly the thing
  not to drop silently.

## The card title, in one place — and why "Needs your attention" had drifted

Reported from a real phone: the attention card looked like older UI than
everything around it. It was, and it was an **implementation gap rather than a
matter of taste** — worth checking before changing anything, because the QA
Gate says not to modify the design to justify an implementation.

`design/Main.dc.html` and `MainTreasurerFunded.dc.html` both specify the panel
as **sentence case, 14px/600, `#EDEFF2`, with an amber SVG glyph**. The app was
rendering **13px UPPERCASE with 0.05em tracking in `--accent`** — so it had
drifted from its own approved artboard, not merely from itself. Every notice
card built afterwards (`.ack-title`, `.dispute-alert-title`, `.swap-ask-title`,
`.dayone-title`, `.release-card-title`) independently landed on the artboard's
shape: Space Grotesk 14.5/700 in `--text-primary`, accent on the glyph.

**The cause was five near-identical copies of one treatment**, with nothing
tying them together. So the fix is not a sixth copy: there is now ONE grouped
selector carrying the shared declarations, placed EARLY in `css/style.css` so
per-card deviations below it still win by source order. Only one deviation
survives — `.dispute-alert-title` keeps `align-items: flex-start` and its
line-height, because that title routinely wraps to two lines and the glyph
should align to the first.

Also corrected while there, and both were the same drift:

- **`.attention-panel` was in the 18px structural-surface list** (with
  `.round`, `.fund-total`, `.stat-tile`, `.menu-list`) while every notice card
  beside it is 12px. It is a notice, not a surface, so it moved — and it now
  takes `--accent-soft` like `.release-card` rather than a flat `--bg-card`.
- **It carried a `border-left: 3px` rail** that no other card has and the
  artboard does not either. Gone; the caught-up variant's now-dead
  `border-left-color` went with it.

**`tests/smoke.js`'s `cardFamily` MEASURES this**, because nothing behavioural
can see it — the drift survived ~550 checks. It asserts the family rather than
any single card: three titles must agree on case, size, weight and font, the
accent must be on the glyph and not the words, and the panel's radius and
border must match the notice cards it sits among. Run against the old CSS,
five of its six checks fail.

**The two radii in the card family are deliberate** and worth not "fixing":
18px for structural surfaces that hold content, 12px for notices that make a
statement. A future card should pick the one that matches its job.

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

**`011` IS APPLIED** (all four preflight rows `ok`, with `AUTH_MODE =
"required"` already deployed). Three files:
`011_preflight.sql` (read-only readiness report, run it first),
`011_rls_lockdown.sql` (the policies), `011_rollback.sql`. The lockdown calls
the readiness check and **refuses to run** while any member lacks an email, a
treasurer is not flagged, or anybody has not signed in once — its policies key
off `members.auth_user_id`, so an unlinked member is denied everything.
Overridable with `select set_config('pf.allow_unready','yes',false);` but
don't — it caught a real problem on this fund's own rollout. The preflight
reported **two treasurers**, because "exactly one" is what it demands; the
owner cleared the second flag rather than overriding, and that is the right
move. See "Two treasurers" below.

**RLS is now enforcing.** The notes further down that say "until 011 is
applied" describe the world before this, and are kept because they explain why
each guard exists — not because the guard is still the only thing holding.

**011 needs `AUTH_MODE = "required"`, but NOT the other way round.** The
coupling runs one direction only, and an earlier version of this note had it
as a mutual dependency, which is wrong and would have held up a safe step:

- **011 without `required`** shows every member a load error — it revokes
  `anon` entirely, so an unauthenticated browser can read nothing.
- **`required` without 011** is merely a gate in front of rules Postgres is not
  yet enforcing. Harmless, reversible, and worth shipping first: it shakes out
  any sign-in problem while a bad outcome is still one redeploy away.

What `required` actually needs is **every member linked** — an address on file
and one sign-in each. Without that, a member hits the `unknown` dead-end with
no way into the app at all. `AUTH_MODE` is now `"required"`; all five are
linked.

**`012` IS APPLIED** — `012_payout_receipt_confirmation.sql`:
`payouts.received_at` / `.received_note`, the `payouts_recipient_ack` policy
and `pf_payouts_guard()`. Validated 14/14 on a real Postgres 16 by
`tests/sql/run.sh`, which is what caught the two flaws above. Ships with
`012_rollback.sql`. **Received ✓ is live** — a recipient can confirm their own
payout, and the Rounds accordion says whether it arrived.

**`013` IS APPLIED** — `013_turn_swaps.sql`: the deferrable `member_order`
constraint, `swap_requests`, `pf_request_swap` / `pf_accept_swap` /
`pf_decline_swap` / `pf_cancel_swap` / `pf_swap_order`, and the amended members
guard. Validated on a real Postgres 16 by `tests/sql/run.sh` (31 assertions,
including the rollback), which caught the stale-branch bug above. Ships with
`013_rollback.sql`, which deliberately leaves the constraint DEFERRABLE —
making it deferrable takes nothing away, and reverting it would re-break the
plain two-write swap.

**So "Reorder payout order" works for the first time**, and turn swaps are
live. Worth knowing which way the two features degrade if 013 is ever rolled
back: `getSwapRequests()` answers `[]`, `swapsAvailable()` goes false and the
swap flow is simply not offered, while the treasurer's reorder names the
migration rather than failing with a raw constraint error.

**`014` IS APPLIED** — `014_payout_disputes.sql`: `payouts.disputed_at` /
`.disputed_note`, the `payout_ack_exclusive` CHECK, and `pf_payouts_guard()`
extended (012's rules reproduced verbatim and not relaxed). Validated on a
real Postgres 16 by `tests/sql/run.sh` (20 assertions). Ships with
`014_rollback.sql`, which names the query to run first — an open report that
₱30,000 never arrived is not something to drop silently.

**So every migration through 014 is live.** A recipient can view the
treasurer's receipt, confirm it arrived, or report that it did not.

Every migration from 010 on is wrapped in `begin; … commit;`. Not decoration:
without it a `raise` in 011's preflight aborted one statement and psql
cheerfully ran the rest, dropping `open_all` and locking the fund out — the
exact outcome the check exists to prevent.

## Two treasurers, and the word "admin"

Both came out of the same rollout, and both were real gaps rather than
confusion on the owner's part.

**There is ONE role flag: `members.is_treasurer`.** No `is_admin`, no
hierarchy, no deputy. The code used to put `isAdmin` on ctx for it, which
invented a distinction the app does not have — the owner reasonably asked
where "admin" fell relative to "treasurer", and the honest answer was "they
are the same seat". Renamed to `isTreasurerAccount` throughout. The word
"admin" survives only as an **activity-log category** (admin actions vs
payments vs payouts), which is a different and legitimate meaning.

**The app could CREATE a two-treasurer state and not fix one.** Transfer
treasurer role grants first and resigns second — deliberately, so a failure
between the two network calls leaves two treasurers rather than none. But
nothing could then clear the extra flag: Transfer moves the role *away from
you*, and no surface touched anyone else's. So the recoverable half-state was
recoverable only in SQL, which is what that screen exists to avoid.

`removeTreasurer()` closes it, surfaced in the Transfer screen itself because
that is the screen about the role:

- **It refuses to remove the last one.** Zero treasurers is the unrecoverable
  direction — nobody can confirm a payment, and nobody can set the flag back,
  because setting it requires already being the treasurer. Checked again at
  write time, not just when the button was drawn: the roster reloads every 30
  seconds and the other treasurer may have resigned meanwhile.
- **Your own flag is not removable here.** Stepping down is Transfer treasurer
  role, which hands the role on in the same action rather than leaving the fund
  one mistake from having none.
- **It writes `is_treasurer: false` and nothing else** — a test asserts the
  payload carries exactly that one key — and reports what is actually true
  afterwards ("N treasurers remain") rather than "done".

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
- **Three actions still ask for the PIN**, and the list matters because an
  earlier version of this note had it wrong: **Reset all data**, **Transfer
  treasurer role** and **Remove treasurer**. Restore and Undo release do NOT
  (Restore asks you to type REPLACE; Undo release asks neither). Grep
  `requirePin: true` before repeating any list of them.
  **The dead end this created is now closed** — see "Two PIN dead ends" above.
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

**Two harness defaults, both learned the hard way.**

- **`serve()` pins `AUTH_MODE` to `"off"` for every page**, rather than
  inheriting whatever `js/config.js` ships. The shipped value is a deploy-time
  decision; a test that reads it is testing the deployment. The day it became
  `"required"`, every check that had not opted in met the sign-in wall. A test
  that cares calls `withAuthMode()` after, and wins — Playwright matches the
  most recently registered route first.
- **Every page gets its own context with `serviceWorkers: "block"`.**
  `page.route()` does NOT intercept requests a service worker makes, and
  `sw.js` claims the client on the first load — so from the second navigation
  onward every mocked route was silently bypassed and the page fetched the real
  files. That was invisible while the shipped config happened to match what the
  tests wanted. A fresh context per page, not one shared: these tests rely on
  their own `localStorage`, and sharing would leak identity between checks.
- **A test that routes by hand instead of calling `serve()` gets NEITHER
  default** and must set both itself. `pinVault`, `bootFailure` and the
  unreadable-vault check each had to be fixed for exactly this.

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

A fifth lesson, from 013: **the harness's own stub had drifted from
`schema.sql`.** `members.member_order` is declared `unique` there and was not
in the stub, which is the single reason this suite could not see that the
app's pair swap had never worked. When adding a column or a constraint to
`schema.sql`, add it to the stub in the same change.

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
- **`run()` only sniffed `UPDATE n`, so every DELETE assertion passed blind.**
  RLS refuses a DELETE the same way it refuses an UPDATE — `DELETE 0`, no
  error — so the helper saw no error, no zero-row UPDATE, and reported OK.
  Found by adding the first DELETE case (cycles); it now reads both verbs.
  Any DENY result recorded before this that was a DELETE proved nothing.

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
