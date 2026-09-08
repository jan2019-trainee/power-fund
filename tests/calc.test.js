/* ---------------------------------------------------------------------------
 * Power Fund — calculations unit tests
 *
 * The money rules, checked directly rather than through the browser. These are
 * the parts where a mistake is silent and expensive: a status that accidentally
 * counts as collected inflates a round's funding, and a status that accidentally
 * stops counting as owed excuses a member from paying.
 *
 * Focused on status 3 (rejected, migration 006), because it is the newest value
 * and the one every older `=== STATUS_UNPAID` comparison predates.
 *
 * RUN:  node tests/calc.test.js
 * ------------------------------------------------------------------------- */
const fs = require("fs");
const path = require("path");

// calculations.js is a browser IIFE that assigns window.Calc.
global.window = {};
new Function(fs.readFileSync(path.join(__dirname, "..", "js", "calculations.js"), "utf8"))();
const C = global.window.Calc;

let failed = 0;
function check(name, pass, detail) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// --- fixtures -------------------------------------------------------------
const MEMBER = "m1";
const OTHER = "m2";
// Cycle 1 fell due well in the past, so anything unpaid on it is overdue.
const cycles = [
  { id: "c1", cycle_number: 1, due_date: "2026-01-15" },
  { id: "c2", cycle_number: 2, due_date: "2026-01-31" },
  // Far future: never overdue, whatever the status.
  { id: "c3", cycle_number: 3, due_date: "2099-01-15" },
];
const row = (over) =>
  Object.assign(
    { id: "x", member_id: MEMBER, cycle_id: "c1", cycle_number: 1, amount: 1000, status: 0, proof_url: null, paid_at: null },
    over
  );

console.log("\nStatus 3 is not money");
{
  const rejected = [row({ id: "r1", status: C.STATUS_REJECTED, proof_url: "p.jpg" })];
  eq("totalCollected ignores rejected", C.totalCollected(rejected), 0);
  eq("totalPerMember ignores rejected", C.totalPerMember(rejected, MEMBER), 0);
  eq("cycleTotal ignores rejected", C.cycleTotal(rejected, 1), 0);
  eq("paidCountForCycle ignores rejected", C.paidCountForCycle(rejected, 1), 0);
  eq("roundCollected ignores rejected", C.roundCollected(rejected, 1), 0);
  eq("pendingCount ignores rejected", C.pendingCount(rejected), 0);
  eq("pendingTotal ignores rejected", C.pendingTotal(rejected), 0);
  eq("roundPending ignores rejected", C.roundPending(rejected, 1), 0);

  // Sanity: the same row as confirmed IS money, so the checks above are
  // testing the status and not some unrelated filter.
  const paid = [row({ id: "p1", status: C.STATUS_PAID })];
  eq("control: confirmed counts", C.totalCollected(paid), 1000);
}

console.log("\nStatus 3 still owes the cycle");
{
  // Cycle 2 is also past due, so it gets a confirmed row — that way the only
  // thing left overdue is the rejected cycle, and the counts below are
  // unambiguous rather than incidentally right.
  const rejected = [
    row({ id: "r1", status: C.STATUS_REJECTED, proof_url: "p.jpg" }),
    row({ id: "r2", cycle_id: "c2", cycle_number: 2, status: C.STATUS_PAID }),
  ];
  eq("isOwed(rejected)", C.isOwed(C.STATUS_REJECTED), true);
  eq("isOwed(unpaid)", C.isOwed(C.STATUS_UNPAID), true);
  eq("isOwed(pending)", C.isOwed(C.STATUS_PENDING), false);
  eq("isOwed(paid)", C.isOwed(C.STATUS_PAID), false);

  // The regression this guards: rejecting a claim must not quietly excuse the
  // member from a cycle that is already past due.
  eq("rejected past-due cycle is overdue", C.isOverdue(rejected, cycles, MEMBER, 1), true);
  eq("memberOverdueCount counts it", C.memberOverdueCount(rejected, cycles, MEMBER), 1);
  eq(
    "totalOverdueCount counts it",
    C.totalOverdueCount(rejected, cycles, [{ id: MEMBER }]),
    1
  );
  eq(
    "missedContributions includes it",
    C.missedContributions(rejected, cycles, [{ id: MEMBER }]).length,
    1
  );

  // A rejected cycle that isn't due yet is not overdue — rejection doesn't
  // invent a deadline that hasn't arrived.
  const future = [
    row({ id: "r2", cycle_id: "c3", cycle_number: 3, status: C.STATUS_REJECTED, proof_url: "p.jpg" }),
  ];
  eq("rejected future cycle is not overdue", C.isOverdue(future, cycles, MEMBER, 3), false);

  // A confirmed payment is never overdue, past due or not.
  const paid = [row({ id: "p1", status: C.STATUS_PAID })];
  eq("control: confirmed is not overdue", C.isOverdue(paid, cycles, MEMBER, 1), false);
}

console.log("\nStatus 3 is excluded from on-time stats");
{
  const rejected = [
    row({ id: "r1", status: C.STATUS_REJECTED, proof_url: "p.jpg", paid_at: "2026-01-01T00:00:00Z" }),
  ];
  const s = C.onTimeStats(rejected, cycles, MEMBER);
  eq("nothing counted", s.counted, 0);
  eq("rate is null, not 0%", s.rate, null);
}

console.log("\nlatestRejection");
{
  eq("none -> null", C.latestRejection([], MEMBER), null);

  // A rejected advance batch: two cycles, one screenshot, one timestamp.
  const batch = [
    row({ id: "b1", cycle_id: "c1", cycle_number: 1, status: C.STATUS_REJECTED,
          proof_url: "shared.jpg", rejection_note: "Blurry", rejected_at: "2026-02-01T00:00:00Z" }),
    row({ id: "b2", cycle_id: "c2", cycle_number: 2, status: C.STATUS_REJECTED,
          proof_url: "shared.jpg", rejection_note: "Blurry", rejected_at: "2026-02-01T00:00:00Z" }),
  ];
  const r = C.latestRejection(batch, MEMBER);
  eq("batch cycles grouped", JSON.stringify(r.cycles), "[1,2]");
  eq("batch amount summed", r.amount, 2000);
  eq("note carried", r.note, "Blurry");

  // An older rejection must not mask the newest one.
  const two = [
    row({ id: "o1", cycle_id: "c1", cycle_number: 1, status: C.STATUS_REJECTED,
          proof_url: "old.jpg", rejection_note: "Old", rejected_at: "2026-01-01T00:00:00Z" }),
    row({ id: "n1", cycle_id: "c2", cycle_number: 2, status: C.STATUS_REJECTED,
          proof_url: "new.jpg", rejection_note: "New", rejected_at: "2026-03-01T00:00:00Z" }),
  ];
  const latest = C.latestRejection(two, MEMBER);
  eq("newest batch wins", latest.note, "New");
  eq("newest batch cycles", JSON.stringify(latest.cycles), "[2]");

  // Scoped to the member asked about.
  const mixed = [
    row({ id: "x1", member_id: OTHER, status: C.STATUS_REJECTED, proof_url: "p.jpg",
          rejection_note: "Theirs", rejected_at: "2026-02-01T00:00:00Z" }),
  ];
  eq("other member's rejection not returned", C.latestRejection(mixed, MEMBER), null);

  // Once resubmitted the row leaves the rejected state, so the banner clears
  // even though the note column still holds the old text.
  const resubmitted = [
    row({ id: "s1", status: C.STATUS_PENDING, proof_url: "new.jpg",
          rejection_note: "Blurry", rejected_at: "2026-02-01T00:00:00Z" }),
  ];
  eq("resubmitted clears the rejection", C.latestRejection(resubmitted, MEMBER), null);
}

console.log("\nFund constants are unchanged");
{
  eq("contribution", C.CONTRIBUTION_AMOUNT, 1000);
  eq("cycles per round", C.CYCLES_PER_ROUND, 6);
  eq("total rounds", C.TOTAL_ROUNDS, 5);
  eq("total cycles", C.TOTAL_CYCLES, 30);
  eq("goal per round", C.GOAL_PER_ROUND, 30000);
  eq("fund target", C.TARGET_AMOUNT, 150000);
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : "\nall checks passed\n");
process.exit(failed ? 1 : 0);
