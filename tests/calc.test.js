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

console.log("\nA rejected cycle can still be paid");
{
  // maxAdvanceCount used to break on anything that was not status 0, so a
  // resubmission offered zero cycles and the contribute sheet could not submit.
  const rejected = [row({ id: "r1", status: C.STATUS_REJECTED, proof_url: "p.jpg" })];
  eq("rejected cycle is payable", C.maxAdvanceCount(rejected, MEMBER, 1, 3), 3);
  eq("control: unpaid is payable", C.maxAdvanceCount([], MEMBER, 1, 3), 3);
  // A confirmed cycle still stops the run.
  const paid = [row({ id: "p1", status: C.STATUS_PAID })];
  eq("confirmed stops the run", C.maxAdvanceCount(paid, MEMBER, 1, 3), 0);
  // So does one awaiting review.
  const pending = [row({ id: "q1", status: C.STATUS_PENDING, proof_url: "p.jpg" })];
  eq("pending stops the run", C.maxAdvanceCount(pending, MEMBER, 1, 3), 0);
}

console.log("\nPer-round on-time rate and member states");
{
  const members = [{ id: MEMBER }, { id: OTHER }];
  // Round 1 is cycles 1-6. Cycle 1 was paid late, cycle 2 on time.
  const rows = [
    row({ id: "a", cycle_id: "c1", cycle_number: 1, status: C.STATUS_PAID,
          paid_at: "2026-02-01T00:00:00Z" }),                      // late (due Jan 15)
    row({ id: "b", cycle_id: "c2", cycle_number: 2, status: C.STATUS_PAID,
          paid_at: "2026-01-20T00:00:00Z" }),                      // on time (due Jan 31)
  ];
  const r1 = C.onTimeRateForRound(rows, cycles, 1);
  eq("counts only that round's dated payments", r1.counted, 2);
  eq("on-time count", r1.onTime, 1);
  eq("rate", Math.round(r1.rate), 50);
  // A round nobody has paid into reports null, not 0% — no data is not failure.
  eq("empty round -> null", C.onTimeRateForRound(rows, cycles, 3).rate, null);

  // roundMemberStates buckets each member by their earliest unsettled cycle.
  const st = C.roundMemberStates(rows, cycles, members, 1);
  // MEMBER paid cycles 1-2 but not 3-6, and cycle 3 is far future.
  eq("payer is not counted overdue", st.overdue.indexOf(MEMBER), -1);
  // `paid` means NOTHING OUTSTANDING, not "all six cycles done". This assertion
  // used to read `st.notDue`, and that was the bug: "paid" was unreachable
  // until a round was nearly over, so a member who had genuinely paid and been
  // confirmed was charted as "Not due yet" — reported from use, and fair,
  // because they had paid and the chart said they had done nothing.
  eq("a member square so far counts as paid", st.paid.indexOf(MEMBER) >= 0, true);
  // The distinction that makes it honest: having paid NOTHING while nothing is
  // due is a different state, and must stay in notDue. Otherwise everybody
  // would read as "paid" on the first day of a round.
  const fresh = C.roundMemberStates([], cycles, [{ id: MEMBER }], 5);
  eq("nothing paid and nothing due stays notDue", fresh.notDue.length, 1);
  eq("...and is not counted as paid", fresh.paid.length, 0);
  // OTHER has paid nothing; cycle 1 is long past due -> overdue.
  eq("non-payer is overdue", st.overdue.indexOf(OTHER) >= 0, true);
  // Every member lands in exactly one bucket.
  const total =
    st.paid.length + st.pending.length + st.rejected.length +
    st.overdue.length + st.notDue.length;
  eq("every member bucketed once", total, members.length);

  // A rejected claim shows as rejected, not silently as unpaid.
  const rej = [row({ id: "z", member_id: OTHER, cycle_id: "c1", cycle_number: 1,
                     status: C.STATUS_REJECTED, proof_url: "p.jpg" })];
  const st2 = C.roundMemberStates(rej, cycles, [{ id: OTHER }], 1);
  eq("rejected bucketed as rejected", st2.rejected.indexOf(OTHER) >= 0, true);
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
