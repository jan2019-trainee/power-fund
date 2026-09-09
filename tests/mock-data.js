/* Shared mock Supabase data for verifying UI pieces locally.
 * The live Supabase project is (correctly) unreachable from this sandbox, so
 * every verification run intercepts **REST calls and serves this instead —
 * production data is never touched. */
function uuid(n) { return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`; }

const MEMBERS = ['Regine', 'Sarah', 'Jan', 'Clara', 'Verdz'].map((name, i) => ({
  id: uuid(i + 1), name, member_order: i + 1,
}));

const CYCLES = Array.from({ length: 30 }, (_, i) => ({
  id: uuid(500 + i + 1),
  cycle_number: i + 1,
  due_date: new Date(2026, 8 + Math.floor(i / 2), (i % 2 === 0) ? 15 : 28).toISOString().slice(0, 10),
}));

const PAYOUTS = [1, 2, 3, 4, 5].map((r) => ({
  round_number: r,
  released: r === 1,
  note: null,
  released_on: r === 1 ? '2026-09-20' : null,
  started_at: r <= 2 ? new Date().toISOString() : null,
  amount: r === 1 ? 30000 : null,
  recipient_member_id: r === 1 ? MEMBERS[0].id : null,
  recipient_name: r === 1 ? MEMBERS[0].name : null,
  receipt_url: null,
  released_by: null,
}));

// A few confirmed contributions so rounds/members/insights have something real.
const CONTRIBUTIONS = [];
let cid = 1000;
[1, 2, 3, 4, 5, 6].forEach((cycleNumber) => {
  MEMBERS.forEach((m, mi) => {
    if (mi === 4 && cycleNumber > 4) return; // Verdz behind on the last cycles
    CONTRIBUTIONS.push({
      id: uuid(cid++),
      cycle_id: CYCLES[cycleNumber - 1].id,
      member_id: m.id,
      status: 2,
      amount: 1000,
      proof_url: null,
      // Clara pays a week late every cycle, so the on-time leaderboard has
      // something to actually distinguish.
      paid_at: new Date(
        2026,
        8 + Math.floor((cycleNumber - 1) / 2),
        ((cycleNumber % 2 === 1) ? 14 : 27) + (m.name === 'Clara' ? 7 : 0)
      ).toISOString(),
    });
  });
});
// One pending-review claim so the treasurer attention panel has content.
// created_at matters: the review queue formats a submission time, and with the
// field absent that branch never ran, which is how a ReferenceError in it
// reached production green.
CONTRIBUTIONS.push({
  id: uuid(cid++),
  cycle_id: CYCLES[6].id,
  member_id: MEMBERS[1].id,
  status: 1,
  amount: 1000,
  proof_url: 'https://example.invalid/proof.jpg',
  paid_at: null,
  created_at: '2026-09-21T02:15:00Z',
});

// Typed rows (migration 006) spread across several days, so the Activity view
// exercises date grouping, the amount column and the status chips. The last two
// deliberately carry NO typed columns — entries written before 006 — which is
// the degrade-to-message-only path.
const _day = (n, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const ACTIVITY_LOG = [
  { id: uuid(201), message: 'Jan marked cycle 8 as sent — ₱1,000', created_at: _day(0, 10, 42),
    event_type: 'payment', amount: 1000, ref_status: 1 },
  { id: uuid(202), message: "Treasurer confirmed Sarah's cycle 7 as paid — ₱1,000", created_at: _day(0, 9, 15),
    event_type: 'payment', amount: 1000, ref_status: 2 },
  { id: uuid(203), message: 'Payout released — Round 1 (Regine) · ₱30,000', created_at: _day(1, 16, 2),
    event_type: 'payout', amount: 30000, ref_status: null },
  { id: uuid(204), message: "Treasurer reverted Clara's cycle 6 to unpaid", created_at: _day(1, 11, 20),
    event_type: 'payment', amount: -1000, ref_status: 0 },
  { id: uuid(205), message: "Treasurer rejected Verdz's cycle 5 claim — \"Blurry screenshot\"", created_at: _day(1, 14, 30),
    event_type: 'payment', amount: 1000, ref_status: 3 },
  { id: uuid(206), message: 'Treasurer started Round 2', created_at: _day(4, 8, 0),
    event_type: 'admin', amount: null, ref_status: null },
  { id: uuid(207), message: 'Payout order: Clara swapped positions with Verdz', created_at: _day(5, 7, 45) },
  { id: uuid(208), message: 'Fund was reset — all contributions cleared', created_at: _day(6, 8, 0) },
];

const SETTINGS = { id: 1, treasurer_pin: null, qr_code_url: null };

const TABLE_DATA = {
  members: MEMBERS,
  cycles: CYCLES,
  contributions: CONTRIBUTIONS,
  payouts: PAYOUTS,
  activity_log: ACTIVITY_LOG,
  app_settings: SETTINGS,
};

/** Wire the mock onto a Playwright page (call before page.goto). */
async function installMocks(page) {
  await page.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const table = url.pathname.split('/').pop();
    const data = TABLE_DATA[table];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data === undefined ? [] : data),
    });
  });
  await page.route('**/realtime/v1/**', (route) => route.abort());
}

module.exports = { MEMBERS, CYCLES, PAYOUTS, CONTRIBUTIONS, ACTIVITY_LOG, SETTINGS, TABLE_DATA, installMocks };
