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
- **Payout QR / renaming** — treasurer-managed. No per-member auth exists, so a
  member-only gate would be decorative.
- **Forgot PIN** — solved with a master PIN (`app_settings.master_pin`), not the
  design's destructive reset. Non-destructive; every use is logged.
- **Profile photos, onboarding** — deferred.

## Phases done

1. Design source committed · 2. Rejected payments, master PIN, PIN keypad ·
3. Navigation shell split per breakpoint · 4. Desktop Home dashboard ·
5. Members accordion + Menu grouping.

Remaining: **6** — upload states, restore feedback, error toast with Retry,
copy-reminder on payout-no-QR, receipt enforcement, undo-confirmed-payment on
the Rounds pills. **7** — Activity date grouping and typed columns, Insights
trends, fund name in the header.

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

## Migrations

Run in the Supabase SQL editor, in order. `006` also needs a one-off
`update app_settings set master_pin = '<digits>' where id = 1;`

`001`–`005` (earlier work) · `006_redesign_foundation.sql` — rejected payments,
master PIN, fund name, treasurer QR fields, typed activity, reserved avatar.

## Tests

```bash
node tests/views.test.js      # static: view scope. no browser
node tests/calc.test.js       # money rules. no browser
python3 -m http.server 8791 & # then:
PF_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node tests/smoke.js
```

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
