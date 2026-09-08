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

const ACTIVITY_LOG = [
  { id: uuid(201), message: 'Payout released — Round 1 (Regine)', created_at: '2026-09-20T10:00:00Z' },
  { id: uuid(202), message: "Treasurer confirmed Sarah's cycle 2 payment — ₱1,000", created_at: '2026-09-19T09:00:00Z' },
  { id: uuid(203), message: 'Jan marked cycle 2 as sent — ₱1,000', created_at: '2026-09-18T08:00:00Z' },
  { id: uuid(204), message: "Treasurer rejected Clara's cycle 2 claim", created_at: '2026-09-17T08:00:00Z' },
  { id: uuid(205), message: 'Treasurer started Round 1', created_at: '2026-09-15T08:00:00Z' },
  { id: uuid(206), message: 'Fund was reset — all contributions cleared', created_at: '2026-09-14T08:00:00Z' },
  { id: uuid(207), message: 'Payout order: Clara swapped positions with Verdz', created_at: '2026-09-13T08:00:00Z' },
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
