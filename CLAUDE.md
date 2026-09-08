# Power Fund — UI/UX Mockup Rebuild

## Status: Core tab architecture complete; features in progress

The app is transitioning from a single long-scrolling page to a tabbed interface matching the mockup (Home / Rounds / Members / Activity / Insights / Menu). The navigation works on both mobile (bottom tab bar) and desktop (left sidebar) via CSS-only switching — one set of view functions, two layouts.

### Completed

- **Tab-shell scaffold** — `currentView` state, `setView()` function, tab bar navigation, view routing
- **View extraction** — Separate render functions:
  - `js/views/home.js` — rostered fund status, hero card, roster strip, sparkline, Rounds link
  - `js/views/rounds.js` — accordion cycles/rounds, payout history, two-column layout on desktop
  - `js/views/members.js` — member roster cards, drill-down detail screen with full payment history
  - `js/views/menu.js` — treasurer settings (QR upload, edit names, backup/restore, PIN, reset)
  - `renderActivityView()` (app.js:1578) — activity log with filter chips
  - `renderInsightsView()` (app.js:1632) — stats, per-round bar chart, on-time leaderboard
- **Member payout details** — Database schema (5 nullable columns), treasurer-only QR/account-number editing
- **Toast notifications** — Transient success messages with auto-dismiss, positioned above floating CTAs
- **Responsive layout** — Mobile/desktop CSS, `.view` wrapper, view-specific styling

### Verified Working

- Tab switching and state preservation
- Member drill-down from roster → detail → back
- All treasurer actions (QR upload, settings changes) from Menu tab
- Render performance (no lingering state when switching views)
- Activity log filters across tab switches
- Console-clean (no errors beyond expected realtime-socket warning)

### Known Limitations & Design Decisions

- **Treasurer-only payout QR**: Members cannot edit their own QR (app has no per-member auth). Treasurer manages all.
- **No PIN recovery**: Users who forget the PIN must ask the treasurer to reset it (shown as clear warning before PIN setup).
- **Offline-first caching**: Service worker v2 precaches all view files; old cache evicted on first load.
- **RLS policies open**: Entire database is readable/writable to anyone with the URL (documented in README).

### Testing

Run smoke tests locally:
```bash
python3 -m http.server 8791 &
node tests/smoke.js
```

The test suite mocks all Supabase REST calls and verifies tab rendering, modal state, and keystroke handling — never hits the live project.

### Database Migrations

Run in Supabase SQL editor (Dashboard → SQL Editor → paste file → Run):
- `supabase/migrations/005_member_payout_details.sql` — Adds payout QR, bank, account fields

### Next Steps (Optional)

1. **Polish Activity tab** — Currently a flat list; consider a 6-column HTML table for wider screens (low priority)
2. **Build Onboarding flow** — 5 screens, insertable anywhere; fund already mid-flight so unseen for now (low priority)
3. **Desktop testing** — Resize browser to 960px+ and verify sidebar layout, two-column rounds accordion, etc.

### Branch Info

- **Integration branch**: `feature/mockup-port` (45 commits ahead of main)
- **Piece branches** (as needed): Off `feature/mockup-port`, merged back with plain merges

### Key Files

- `js/app.js:1650-2350` — Main render orchestrator, shared state, view router, tab bar
- `js/views/*.js` — View render functions (pure functions of context, no side effects)
- `css/style.css` — All layout, animations, theming; view-scoped classes
- `supabase/migrations/005_*.sql` — Payout schema
- `sw.js` — Cache v2, view file precaching

### To Contribute

- Keep view render functions pure (no `render()` calls, no state mutation)
- Add view-scoped styles under `.view-<name>` or generic `.view` rules
- Test tab switches for state preservation and modal gating
- Run smoke test before pushing
