# UI/UX QA handoff — member accounts, onboarding, admin

For the independent UI/UX QA agent. Written by Claude Code under
`CLAUDE.md` → *UI/UX QA Gate*, which requires the implementation to be
**prepared** for review rather than declared complete.

**Branch** `feature/mockup-port` · **Preview**
`https://power-fund-git-feature-mockup-port-vitamin5.vercel.app/`
**Config** `AUTH_MODE = "optional"` in `js/config.js`
**Not yet applied** `011_rls_lockdown.sql` — writes are still unrestricted in
Postgres. See *Known limits*.

---

## 1. What is in scope for this pass

Everything below arrived after the last QA pass. It splits into two very
different categories, and the distinction matters more than anything else in
this document.

### 1a. PORTS — judge these against the artboards

| Screen | Artboard | Notes |
| --- | --- | --- |
| Onboarding, 5 steps | `OnboardingWelcome/HowItWorks/HowToPay/PayoutOrder/WhoAreYou.dc.html` | Two recorded departures — see §3 |
| Onboarding, desktop | the `Desktop*` twins of all five | One render path, two frames |
| Edit Profile | `EditProfile.dc.html` | Bottom sheet; `camera`/`photos` icon paths lifted verbatim |
| Change Photo | `ProfilePhotoSheet.dc.html` | Opens over Edit Profile; Esc must close this one first |

### 1b. NEW DESIGN — there is no mockup to judge these against

The design canvas has **no auth at all** and says so
(`canvas.json`, `forgot-pin-notes`). Member accounts are a feature beyond the
design, so these screens were composed rather than ported. **Please review
them as new design.** Where they borrow, they borrow
`OnboardingWelcome.dc.html`'s composition.

| Screen | How to reach it |
| --- | --- |
| Sign-in screen | First visit in `optional` mode; or `required` mode |
| First-run sign-in prompt | Same screen + a **Not now** button |
| Account dead-end: not on the roster | `required` mode, sign in with an address on no member row |
| Account dead-end: already claimed | `required` mode, an address whose row is linked elsewhere |
| Account dead-end: fund not ready | `required` mode, roster with no addresses at all |
| Optional-mode warning banner | `optional` mode, same three conditions — a banner, not a wall |
| **Member sign-in** panel | Menu → Account → Member sign-in (admin only) |
| **Transfer treasurer role** | Menu → Security → Transfer treasurer role (admin only) |

---

## 2. What to test, and the states each screen has

Test both frames for everything: **mobile ≤ 430px** and **desktop ≥ 900px**
(`isWide` is a JS branch at 900px, not a CSS reflow — the two shells are
genuinely different code paths).

### Sign-in / first-run prompt
- **Skippable vs not.** `optional` shows **Not now**; `required` must not.
- Mid-flight: the button reads *"Opening Google…"* and is disabled.
- Skip is remembered per device (`localStorage.pf_signin_skipped`), so it asks
  once. **Each preview URL is its own origin with its own storage** — an
  apparent "it asked me again" is usually a different URL.
- Ordering: prompt renders **before** onboarding and **after** the data load.
  A fund that fails to load must show the connection error, not a login.

### Member sign-in panel (admin only)
- Rows: **Signed in** / **Hasn't signed in yet** / **No address yet**, plus a
  **Treasurer** tag on the flagged member.
- Live validation as you type: malformed address, two members sharing one.
  Blank is **valid** — it is the state of every member not yet collected.
- **Unlink** appears only on a member who has signed in; confirms first.
- The readiness line: counts, and a green state when all three conditions hold.
- Caret behaviour: validation patches two DOM nodes by hand rather than
  re-rendering. If typing ever loses the caret, that is a P1.

### Transfer treasurer role (admin only)
- Names the current holder; lists only members who have **signed in**; says
  why the others are missing.
- **Continue** disabled until somebody is picked.
- The confirm step must state plainly that *you* lose the role, and asks for
  the treasurer PIN.
- After a transfer: treasurer mode drops, the unlock button disappears, and a
  toast confirms. A half-completed transfer reports two treasurers rather than
  claiming success.
- Empty state: nobody else signed in → an explanation, not an empty list.

### The unlock button
- **Hidden** from a member the app can identify as not the treasurer.
- **Shown** in every uncertain case — auth off, signed out, not linked, or
  nobody flagged. This is deliberate: the button is the only route to the PIN
  modal and so to the **master PIN**, the fund's recovery path. Hiding it from
  someone merely unidentified would remove the way back in. Please do not file
  "shown to an anonymous visitor" as a bug without reading §4.

### Onboarding
- 5 dots normally; **4 for a linked member** (§3).
- Skip from any step; Skip still marks it seen.
- Desktop: centred column, no horizontal scroll.
- Re-entry via Menu → Learn → **Replay the intro**.

### Regression surface most at risk
The admin auto-unlock changed which Menu branch a signed-in treasurer sees.
- An auto-unlocked admin does **not** get the "You are / Edit" profile card —
  that lives in the member branch. Their route is Menu → Account → **Edit my
  profile**. Intentional; two smoke tests moved to a non-treasurer login for
  it. Worth a look as a UX question even so: is that discoverable enough?

---

## 3. Recorded deviations from the approved design

Each is a decision with a reason, not an oversight. Per the QA Gate, classify
them — but please read the reason before filing.

| # | Deviation | Class | Why |
| --- | --- | --- | --- |
| 1 | Onboarding drops its final who-am-I step for a **linked** member | Intentional | That step writes a per-device preference. Once a login owns a member row the identity comes from the database and cannot be switched — `openWhoAmIPicker()` refuses. The design predates accounts. |
| 2 | Every name and figure in onboarding is **real**, not the artboards' "Ana / Ben / Cathy" / "GCash" | Intentional | Rendering the hardcoded ones would be fake data (`CLAUDE.md` rule 4). |
| 3 | PIN entry does **not** auto-submit on the 4th digit | Intentional | PINs here may exceed four digits; auto-submit would make a longer PIN untypable, since a wrong attempt clears the field. |
| 4 | Cash payments kept as a treasurer-only path | Intentional | The design removes them; this project overrode that. |
| 5 | Forgot PIN solved with a master PIN, not the design's destructive reset | Intentional | Non-destructive, and every use is logged. |
| 6 | CropPhoto (drag to reposition / pinch to zoom) | **Deferred** | Photos are centre-cropped and downscaled to 512px in the browser; they render at 30–60px. |
| 7 | Fund Setup wizard | **Deferred** | The designer marked it lowest priority. |
| 8 | Mid-fund member add/remove | Out of scope | The roster is read-only. |
| 9 | Menu → "Replay the intro" | Addition | The design gives the flow no re-entry point, making it unreachable after one showing. |
| 10 | `pesoWhole()` for prose figures | Addition | The artboards write "₱1,000", not "₱1,000.00". Ledger figures keep two decimals. |

---

## 4. Things that look like bugs and are not

Please check these before filing, they have each been argued out:

1. **The unlock button shows to an anonymous visitor.** Deliberate — it is the
   only route to the master PIN. See §2.
2. **A member with the PIN sees treasurer buttons that then fail.** True today
   only for money writes after 011 is applied; `requireRows()` names the
   account needed rather than blaming the network. Before 011 they succeed.
3. **`optional` mode does not gate the app.** By design. It exists so sign-in
   can be rolled out without locking out members who are not on file yet.
4. **The activity log never shows an email address.** Deliberate — the log is
   read by every member and lands in the CSV export and the backup file.
5. **The desktop Menu is a sidebar footer, not a tab.** Mobile has 5 tabs with
   Members as a Home drill-down; desktop's sidebar carries Members. Two
   navigation models on purpose (`canvas.json`).
6. **Blank member emails.** Valid state, not a validation gap.

---

## 4b. One observation I found while testing, and did not change

**The destructive-confirm dialog does not focus its PIN field.** Every
irreversible action (Reset all data, Restore backup, Undo a payout release,
and now Transfer treasurer role) ends in a confirm dialog asking for the
treasurer PIN — and the field is not focused, so on a phone the keyboard does
not come up until you tap it.

I left it alone rather than fixing it in passing. Autofocus is a one-line
change, but *Reset all data* deliberately makes you type `RESET` **before** the
PIN, and focusing the PIN there would put the cursor in the wrong field of a
two-step gate. That is a UX call about the shared dialog, which is this pass's
call to make, not mine. Flagging it as an observation, unrated.

---

## 5. Known limits — do not file these against the UI

- **Migration 011 is not applied.** Postgres still permits any write. The
  permission behaviour you see in the UI is the *intended* model, enforced
  only client-side for now.
- **`AUTH_MODE` is `"optional"`.** The `required`-mode screens (the gate and
  the three dead-ends) need `AUTH_MODE` flipped, or the smoke harness, to see.
- **No approved mockup exists** for anything in §1b. If a finding is "this
  doesn't match the design", for those screens there is no design to match —
  the useful finding is what it *should* look like.

---

## 6. How to see it without the live Supabase project

The smoke harness renders every screen against mock data:

```bash
python3 -m http.server 8791
PF_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node tests/smoke.js
```

`tests/qa-capture.js` drives the same fixtures for screenshots.

Useful `localStorage` keys when poking by hand:
`pf_onboarded` (`"1"` = intro seen), `pf_signin_skipped` (`"1"` = prompt
dismissed), `pf_my_member_id` (the unverified who-am-I preference).

---

## 7. Severity, and where QA does not decide alone

Per the QA Gate, P0/P1 findings block the phase. One carve-out, quoted from
`CLAUDE.md`:

> When a QA finding conflicts with business logic, financial rules, security,
> or database integrity, do not blindly implement the visual recommendation.
> Investigate and report the conflict first.

The surfaces in this pass where that is most likely to bite:

- **Who may confirm a payment or release a payout.** Treasurer-only, and after
  011 enforced by Postgres. A finding that makes it easier for a member is a
  business-rule change, not a UX fix.
- **Who may edit member emails and transfer the role.** Admin-only, keyed to
  `members.is_treasurer` rather than the shared PIN — because the PIN is shared
  with all five members by design.
- **The unlock button's visibility rule** (§4.1) — recovery path.
- **Anything that would put an email address into the activity log, CSV or
  backup.**
