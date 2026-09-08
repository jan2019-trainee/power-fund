# Design source — Power Fund redesign

The approved Claude Design canvas, committed so it is available to every future
session without depending on a network fetch or a chat transcript.

**This is design source, not application code.** Nothing here is served, imported
or bundled. Do not add it to `sw.js`'s precache list.

## What's here

| File | What it is |
| --- | --- |
| `*.dc.html` | 92 artboards — one self-contained HTML page per screen |
| `canvas.json` | Layout, artboard titles, page grouping, **and 36 designer annotations** |

`canvas.json` is the most valuable file in this directory. Its `annotations`
array is the design's own written specification: motion rules, interaction
decisions, and binding scope decisions that are *not* discoverable by reading
artboard markup. Read it before implementing any screen.

## Provenance

- **Source canvas:** <https://claude.ai/code/artifact/cb641b21-37ca-4364-a5aa-afe6f3378a64>
- **Extracted:** 8 Sep 2026
- **Artboards:** 92 of 92, plus `canvas.json`

The canvas is a published artifact. Its entire editable state lives in one
`<script id="appifact-doc">` JSON block; `content.files` is a map of filename →
file contents.

## Re-syncing after a canvas edit

Read the artifact, then extract:

```python
import re, json, os

src = open("artifact.html", errors="replace").read()          # the fetched canvas page
doc = re.search(r'<script[^>]*id="appifact-doc"[^>]*>(.*?)</script>', src, re.S)
files = json.loads(doc.group(1).strip())["content"]["files"]

for name, body in files.items():
    open(os.path.join("design", name), "w").write(body)
```

Commit the diff. Artboards change rarely, so this stays a small, readable
changeset rather than a wall of noise.

## Scope decisions recorded in `canvas.json`

Three constraints a future session must not re-litigate. Quoted, not paraphrased:

**Cash payments — removed from the redesign** (`scope-note-cash-payments`)
> "the current live app supports recording a contribution as cash (no proof
> required). That capability is intentionally NOT carried into this redesign …
> There is no 'mark as paid / cash' action anywhere in this design … This is a
> deliberate decision, not an oversight."

*Project decision (Sep 2026): cash is retained as a treasurer-only path, because
members are geographically dispersed and cash is rare but real. It stays out of
the member-facing payment flow, matching the design's intent that members never
see a no-proof route.*

**Mid-fund member add/remove — out of scope** (`gap5-no-member-changes-notes`)
> "DECIDED OUT OF SCOPE. Members commit to finishing the sinking fund for its
> full run (5 rounds / 30 cycles) once it starts … Members.dc.html /
> DesktopMembers.dc.html intentionally stay read-only rosters (no add/remove
> controls)."

**Fund Setup — deprioritized by the designer** (`fund-setup-notes`)
> "LOWEST PRIORITY, kept as reference only … this flow was speculative … Keep it
> here in case a true blank-slate setup is ever needed, but don't prioritize
> implementing it."

## Two things the artboards do not tell you

**There is no approved Member Detail screen.** `MemberDetail.dc.html` was drafted
during the design session but never published to the canvas, and is therefore not
in this directory. `members-notes` records why:

> "a full Member Detail screen was tried and felt like overkill for what's just a
> few lines of cycle history. Tapping a row expands a compact panel below it."

Mobile uses an inline accordion. Desktop uses a master-detail pane.

**Mobile and desktop navigate differently, deliberately.** Mobile carries five
tabs — Home / Rounds / Activity / Insights / Menu — with Members reached as a
drill-down from Home's "See all" and roster avatar taps. Desktop restores Members
to the sidebar and moves Menu to a profile footer. See `activity-analytics-notes`,
`members-notes` and `desktop-notes`.

## Pages

`canvas.json`'s `pages` array groups the artboards:

| Page | Contents |
| --- | --- |
| `page-1` Dashboard | Mobile core screens, sheets and state variants |
| `page-2` Onboarding | 5-screen first-run flow |
| `page-3` Desktop | Full desktop set |
| `page-4` Fund Setup | Day-zero wizard (deferred) |
