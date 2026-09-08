/* ---------------------------------------------------------------------------
 * Power Fund — calculations
 *
 * Pure functions only. Nothing in here touches the DOM or the network.
 * Everything takes plain data (arrays / numbers / Date) and returns a value,
 * so these can be unit-tested or reused anywhere.
 *
 * Data shapes used below:
 *   member       { id, name, member_order }
 *   cycle        { id, cycle_number, due_date }   due_date is "YYYY-MM-DD"
 *   contribution { id, member_id, cycle_id, cycle_number, amount, status,
 *                  proof_url, notes, paid_at }
 *
 * Payment status:  0 = unpaid   1 = pending review   2 = confirmed paid
 * ------------------------------------------------------------------------- */

window.Calc = (function () {
  "use strict";

  // ---- Fund constants (from the original app) ----------------------------
  const CONTRIBUTION_AMOUNT = 1000; // peso per member per cycle
  const CYCLES_PER_ROUND = 6;
  const TOTAL_ROUNDS = 5;
  const TOTAL_CYCLES = CYCLES_PER_ROUND * TOTAL_ROUNDS; // 30
  const GOAL_PER_ROUND = CONTRIBUTION_AMOUNT * CYCLES_PER_ROUND * TOTAL_ROUNDS; // 30,000
  const TARGET_AMOUNT = GOAL_PER_ROUND * TOTAL_ROUNDS; // 150,000

  const STATUS_UNPAID = 0;
  const STATUS_PENDING = 1;
  const STATUS_PAID = 2;

  // ---- Formatting -------------------------------------------------------
  const _pesoFmt = new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
  });

  /** Format a number as Philippine Peso, e.g. 1000 -> "₱1,000.00". */
  function peso(amount) {
    const n = Number(amount) || 0;
    return _pesoFmt.format(n);
  }

  // ---- Date helpers ----------------------------------------------------
  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  /** Parse a cycle's "YYYY-MM-DD" due_date into a local Date at midnight. */
  function parseDueDate(due_date) {
    return new Date(due_date + "T00:00:00");
  }

  /** Look up a cycle's due date (Date object) by its cycle_number. */
  function dueDateOf(cycles, cycleNumber) {
    const c = cycles.find((c) => c.cycle_number === cycleNumber);
    return c ? parseDueDate(c.due_date) : null;
  }

  function formatDate(d) {
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function isSameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  // ---- Contribution lookups ------------------------------------------
  /** The contribution row for a member + cycle_number, or null. */
  function contributionFor(contributions, memberId, cycleNumber) {
    return (
      contributions.find(
        (c) => c.member_id === memberId && c.cycle_number === cycleNumber
      ) || null
    );
  }

  /** Payment status (0/1/2) for a member + cycle_number. Missing row = unpaid. */
  function statusOf(contributions, memberId, cycleNumber) {
    const row = contributionFor(contributions, memberId, cycleNumber);
    return row ? row.status : STATUS_UNPAID;
  }

  function proofOf(contributions, memberId, cycleNumber) {
    const row = contributionFor(contributions, memberId, cycleNumber);
    return row ? row.proof_url : null;
  }

  /**
   * Is `proofUrl` still referenced by a contribution other than the ones in
   * `exceptIds`? Used before archiving/removing a screenshot so a file that a
   * sibling cycle of the same advance batch still points at is left in place.
   */
  function proofInUse(contributions, proofUrl, exceptIds) {
    if (!proofUrl) return false;
    const skip = new Set(exceptIds || []);
    return contributions.some(
      (c) => !skip.has(c.id) && (c.proof_url || null) === proofUrl
    );
  }

  /**
   * The set of cycles a treasurer should review together when clicking one
   * pending cycle: the maximal contiguous run of that member's PENDING cycles
   * that share the same proof screenshot and the same round (i.e. one advance
   * payment). Returns [cycleNumber] when it isn't pending.
   */
  function pendingRun(contributions, memberId, cycleNumber) {
    const row = contributionFor(contributions, memberId, cycleNumber);
    if (!row || row.status !== STATUS_PENDING) return [cycleNumber];
    const proof = row.proof_url || null;
    const round = roundOfCycle(cycleNumber);
    const sameBatch = (c) => {
      if (c < 1 || c > TOTAL_CYCLES || roundOfCycle(c) !== round) return false;
      const r = contributionFor(contributions, memberId, c);
      return (
        r && r.status === STATUS_PENDING && (r.proof_url || null) === proof
      );
    };
    let lo = cycleNumber;
    let hi = cycleNumber;
    while (sameBatch(lo - 1)) lo--;
    while (sameBatch(hi + 1)) hi++;
    const out = [];
    for (let c = lo; c <= hi; c++) out.push(c);
    return out;
  }

  /**
   * Group every pending-review contribution into review batches — one entry per
   * advance payment (a contiguous run of a member's PENDING cycles that share a
   * proof and a round). Sorted for a treasurer's review queue:
   *   1) oldest submission first   2) then earliest cycle   3) then member id
   *
   * Returns: [{ memberId, cycles: [n, ...], proofUrl, submittedAt, amount }]
   * where `submittedAt` is the earliest created_at in the batch (ISO string or
   * null) and `amount` is the batch total in pesos.
   */
  function pendingBatches(contributions) {
    const pend = contributions
      .filter((c) => c.status === STATUS_PENDING)
      .slice()
      .sort((a, b) => a.cycle_number - b.cycle_number);

    const seen = new Set();
    const batches = [];
    for (const row of pend) {
      if (seen.has(row.member_id + "|" + row.cycle_number)) continue;
      const cycles = pendingRun(contributions, row.member_id, row.cycle_number);
      let submittedAt = null;
      let amount = 0;
      for (const n of cycles) {
        seen.add(row.member_id + "|" + n);
        const r = contributionFor(contributions, row.member_id, n);
        if (!r) continue;
        amount += Number(r.amount) || 0;
        const t = r.created_at || r.paid_at || null;
        if (t && (!submittedAt || t < submittedAt)) submittedAt = t;
      }
      batches.push({
        memberId: row.member_id,
        cycles,
        proofUrl: row.proof_url || null,
        submittedAt,
        amount,
      });
    }

    batches.sort((a, b) => {
      const ta = a.submittedAt || "";
      const tb = b.submittedAt || "";
      if (ta !== tb) return ta < tb ? -1 : 1;
      if (a.cycles[0] !== b.cycles[0]) return a.cycles[0] - b.cycles[0];
      return String(a.memberId) < String(b.memberId) ? -1 : 1;
    });
    return batches;
  }

  // ---- Totals --------------------------------------------------------
  /** Total pesos confirmed paid across the whole fund. */
  function totalCollected(contributions) {
    return contributions
      .filter((c) => c.status === STATUS_PAID)
      .reduce((sum, c) => sum + Number(c.amount), 0);
  }

  /** Total pesos a single member has confirmed paid. */
  function totalPerMember(contributions, memberId) {
    return contributions
      .filter((c) => c.member_id === memberId && c.status === STATUS_PAID)
      .reduce((sum, c) => sum + Number(c.amount), 0);
  }

  /** Total pesos confirmed paid for one cycle. */
  function cycleTotal(contributions, cycleNumber) {
    return contributions
      .filter((c) => c.cycle_number === cycleNumber && c.status === STATUS_PAID)
      .reduce((sum, c) => sum + Number(c.amount), 0);
  }

  /** How many people have confirmed-paid a given cycle. */
  function paidCountForCycle(contributions, cycleNumber) {
    return contributions.filter(
      (c) => c.cycle_number === cycleNumber && c.status === STATUS_PAID
    ).length;
  }

  /** Number of contributions still awaiting treasurer review (whole fund). */
  function pendingCount(contributions) {
    return contributions.filter((c) => c.status === STATUS_PENDING).length;
  }

  /** Pesos submitted but not yet confirmed by the treasurer (whole fund). */
  function pendingTotal(contributions) {
    return contributions
      .filter((c) => c.status === STATUS_PENDING)
      .reduce((sum, c) => sum + Number(c.amount), 0);
  }

  // ---- Rounds ------------------------------------------------------
  function roundCycleRange(round) {
    return {
      startCycle: (round - 1) * CYCLES_PER_ROUND + 1,
      endCycle: round * CYCLES_PER_ROUND,
    };
  }

  function roundOfCycle(cycleNumber) {
    return Math.ceil(cycleNumber / CYCLES_PER_ROUND);
  }

  /** Pesos confirmed paid within a round. */
  function roundCollected(contributions, round) {
    const { startCycle, endCycle } = roundCycleRange(round);
    return contributions
      .filter(
        (c) =>
          c.status === STATUS_PAID &&
          c.cycle_number >= startCycle &&
          c.cycle_number <= endCycle
      )
      .reduce((sum, c) => sum + Number(c.amount), 0);
  }

  /** Count of pending-review contributions within a round. */
  function roundPending(contributions, round) {
    const { startCycle, endCycle } = roundCycleRange(round);
    return contributions.filter(
      (c) =>
        c.status === STATUS_PENDING &&
        c.cycle_number >= startCycle &&
        c.cycle_number <= endCycle
    ).length;
  }

  // ---- Round lifecycle ----------------------------------------------
  //
  // A round moves through three states:
  //   COLLECTING       -> members are still contributing
  //   PAYOUT PENDING   -> the ₱30,000 target is reached but not paid out
  //   COMPLETED        -> the treasurer has released the payout (payouts.released)
  //
  // Two INDEPENDENT treasurer actions:
  //   * "Mark payout released"  -> sets payouts.released / released_on / note
  //   * "Start next round"      -> sets payouts.started_at on the next round
  // Reaching ₱30,000 never does either automatically, and starting round N+1
  // does NOT release round N's payout.
  //
  // `rounds` is the array from DB.getPayouts():
  //   { round_number, released, note, released_on, started_at? }
  // `started_at` only exists once migration 002 has been run. When it is
  // absent the app falls back to the earlier behaviour: the active round is the
  // first one not yet at ₱30,000. The payout-release workflow works either way
  // because it depends only on the money total, never on started_at.
  //
  // Every per-round money total comes from roundCollected(), which filters
  // strictly by the round's own cycle range — a finished round can never add to
  // another round's progress.

  function roundRow(rounds, round) {
    return (rounds || []).find((r) => r.round_number === round) || null;
  }

  /** True when the payouts table has the started_at column (migration 002). */
  function roundLifecycleEnabled(rounds) {
    return (
      Array.isArray(rounds) &&
      rounds.length > 0 &&
      rounds.some((r) => Object.prototype.hasOwnProperty.call(r, "started_at"))
    );
  }

  /** True once a round's confirmed contributions reach its own ₱30,000 target. */
  function isRoundFunded(contributions, round) {
    return roundCollected(contributions, round) >= GOAL_PER_ROUND;
  }

  // Backwards-compatible alias (older name).
  function isRoundComplete(contributions, round) {
    return isRoundFunded(contributions, round);
  }

  /** First round not yet at ₱30,000 (fallback when started_at is unavailable). */
  function firstUnfundedRound(contributions) {
    for (let r = 1; r <= TOTAL_ROUNDS; r++) {
      if (!isRoundFunded(contributions, r)) return r;
    }
    return TOTAL_ROUNDS;
  }

  /** The round the dashboard is centred on. */
  function currentRound(rounds, contributions) {
    if (!roundLifecycleEnabled(rounds)) {
      return firstUnfundedRound(contributions || []);
    }
    let cur = 1;
    rounds.forEach((row) => {
      if (row.started_at && row.round_number > cur) cur = row.round_number;
    });
    return Math.min(cur, TOTAL_ROUNDS);
  }

  /** True once the treasurer has started this round (round 1 is always started). */
  function isRoundStarted(rounds, round, contributions) {
    if (!roundLifecycleEnabled(rounds)) {
      return round <= currentRound(rounds, contributions);
    }
    const row = roundRow(rounds, round);
    return !!(row && row.started_at);
  }

  /**
   * 'not_started' | 'collecting' | 'payout_pending' | 'completed'.
   * PAYOUT PENDING is driven purely by the money total, so the
   * "Mark payout released" button shows whenever a round is funded and
   * unreleased — with or without migration 002.
   */
  function roundStatus(contributions, rounds, round) {
    const row = roundRow(rounds, round);
    if (row && row.released) return "completed";
    if (isRoundFunded(contributions, round)) return "payout_pending";
    if (isRoundStarted(rounds, round, contributions)) return "collecting";
    return "not_started";
  }

  /**
   * Started rounds before the current one whose payout has not been released —
   * normally zero or one. Shown on the dashboard as a separate "previous round".
   * Empty unless migration 002 is in place.
   */
  function pendingPayoutRounds(contributions, rounds) {
    if (!roundLifecycleEnabled(rounds)) return [];
    const cur = currentRound(rounds, contributions);
    const out = [];
    for (let r = 1; r < cur; r++) {
      const row = roundRow(rounds, r);
      if (row && row.started_at && !row.released) out.push(r);
    }
    return out;
  }

  /** True only when every round's payout has been released. */
  function allRoundsComplete(contributions, rounds) {
    for (let r = 1; r <= TOTAL_ROUNDS; r++) {
      const row = roundRow(rounds, r);
      if (!row || !row.released) return false;
    }
    return true;
  }

  /** May the treasurer start round (currentRound + 1) right now? */
  function canStartNextRound(contributions, rounds) {
    if (!roundLifecycleEnabled(rounds)) return false; // needs migration 002
    const cur = currentRound(rounds, contributions);
    if (cur >= TOTAL_ROUNDS) return false; // there is no round 6
    if (isRoundStarted(rounds, cur + 1, contributions)) return false; // no duplicates
    return isRoundFunded(contributions, cur); // current round must have hit ₱30,000
  }

  /** How many rounds have had their payout released. */
  function completedRoundsCount(contributions, rounds) {
    let n = 0;
    for (let r = 1; r <= TOTAL_ROUNDS; r++) {
      if (roundStatus(contributions, rounds, r) === "completed") n++;
    }
    return n;
  }

  // ---- Progress ---------------------------------------------------
  function remainingAmount(contributions) {
    return Math.max(0, TARGET_AMOUNT - totalCollected(contributions));
  }

  /** Overall fund progress as a 0–100 percentage. */
  function progressPercentOverall(contributions) {
    return Math.min(100, (totalCollected(contributions) / TARGET_AMOUNT) * 100);
  }

  /** One round's progress toward its ₱30,000 goal, 0–100. */
  function progressPercentRound(contributions, round) {
    return Math.min(100, (roundCollected(contributions, round) / GOAL_PER_ROUND) * 100);
  }

  // ---- Overdue / missed ----------------------------------------
  /** True when a cycle is unpaid AND its due date is already in the past. */
  function isOverdue(contributions, cycles, memberId, cycleNumber, today) {
    const ref = startOfDay(today || new Date());
    const due = dueDateOf(cycles, cycleNumber);
    if (!due) return false;
    return (
      statusOf(contributions, memberId, cycleNumber) === STATUS_UNPAID &&
      due < ref
    );
  }

  function memberOverdueCount(contributions, cycles, memberId, today) {
    let count = 0;
    for (let c = 1; c <= TOTAL_CYCLES; c++) {
      if (isOverdue(contributions, cycles, memberId, c, today)) count++;
    }
    return count;
  }

  function totalOverdueCount(contributions, cycles, members, today) {
    return members.reduce(
      (sum, m) => sum + memberOverdueCount(contributions, cycles, m.id, today),
      0
    );
  }

  /**
   * How reliably one member pays on time, as { onTime, counted, rate }.
   *
   * Only CONFIRMED contributions are counted, and only those carrying a
   * paid_at — a row recorded before that column existed can't be judged, and
   * guessing would quietly punish members for a schema change. A payment
   * counts as on time when it was paid on or before its cycle's due date.
   * `rate` is null when nothing is countable yet, so callers can say "no data"
   * instead of showing a misleading 0%.
   */
  function onTimeStats(contributions, cycles, memberId) {
    let onTime = 0;
    let counted = 0;
    for (let c = 1; c <= TOTAL_CYCLES; c++) {
      const row = contributionFor(contributions, memberId, c);
      if (!row || row.status !== STATUS_PAID || !row.paid_at) continue;
      const due = dueDateOf(cycles, c);
      if (!due) continue;
      counted++;
      if (startOfDay(new Date(row.paid_at)) <= startOfDay(due)) onTime++;
    }
    return { onTime, counted, rate: counted ? (onTime / counted) * 100 : null };
  }

  /**
   * Every (member, cycle) pair that is past due and not confirmed paid.
   * A pending claim still counts as "not yet collected".
   */
  function missedContributions(contributions, cycles, members, today) {
    const missed = [];
    for (const m of members) {
      for (let c = 1; c <= TOTAL_CYCLES; c++) {
        const due = dueDateOf(cycles, c);
        if (!due) continue;
        if (
          due < startOfDay(today || new Date()) &&
          statusOf(contributions, m.id, c) !== STATUS_PAID
        ) {
          missed.push({ memberId: m.id, cycleNumber: c });
        }
      }
    }
    return missed;
  }

  // ---- Cycle timeline -----------------------------------------
  /** The cycle_number that is "current": the first not-yet-past cycle. */
  function currentCycle(cycles, today) {
    const ref = startOfDay(today || new Date());
    const sorted = [...cycles].sort((a, b) => a.cycle_number - b.cycle_number);
    for (const c of sorted) {
      if (parseDueDate(c.due_date) >= ref) return c.cycle_number;
    }
    return sorted.length ? sorted[sorted.length - 1].cycle_number : 1;
  }

  /** Cycles whose due date has passed. */
  function completedCyclesCount(cycles, today) {
    const ref = startOfDay(today || new Date());
    return cycles.filter((c) => parseDueDate(c.due_date) < ref).length;
  }

  /** Cycles whose due date is today or later. */
  function remainingCyclesCount(cycles, today) {
    return cycles.length - completedCyclesCount(cycles, today);
  }

  /**
   * How many consecutive unpaid cycles a member can pay at once, starting at
   * cycleNumber (used by the "paying in advance" stepper).
   */
  function maxAdvanceCount(contributions, memberId, cycleNumber, maxCycle) {
    const end = Math.min(maxCycle || TOTAL_CYCLES, TOTAL_CYCLES);
    let count = 0;
    for (let c = cycleNumber; c <= end; c++) {
      if (statusOf(contributions, memberId, c) === STATUS_UNPAID) count++;
      else break;
    }
    return count;
  }

  /** Last cycle number of the round that `cycleNumber` belongs to. */
  function roundEndCycle(cycleNumber) {
    return roundCycleRange(roundOfCycle(cycleNumber)).endCycle;
  }

  // ---- Validation ------------------------------------------
  /** Returns an error string, or null when the contribution input is valid. */
  function validateContribution({ amount, memberId, cycleNumber, members, cycles }) {
    if (amount == null || isNaN(Number(amount)) || Number(amount) < 0) {
      return "Amount must be a number that is zero or more.";
    }
    if (!members.some((m) => m.id === memberId)) {
      return "That member no longer exists — refresh and try again.";
    }
    if (!cycles.some((c) => c.cycle_number === cycleNumber)) {
      return "That cycle no longer exists — refresh and try again.";
    }
    return null;
  }

  return {
    CONTRIBUTION_AMOUNT,
    CYCLES_PER_ROUND,
    TOTAL_ROUNDS,
    TOTAL_CYCLES,
    GOAL_PER_ROUND,
    TARGET_AMOUNT,
    STATUS_UNPAID,
    STATUS_PENDING,
    STATUS_PAID,

    peso,
    startOfDay,
    parseDueDate,
    dueDateOf,
    formatDate,
    isSameDay,

    contributionFor,
    statusOf,
    proofOf,
    proofInUse,
    pendingRun,
    pendingBatches,

    totalCollected,
    totalPerMember,
    cycleTotal,
    paidCountForCycle,
    pendingCount,
    pendingTotal,

    roundCycleRange,
    roundOfCycle,
    roundEndCycle,
    roundCollected,
    roundPending,
    roundRow,
    roundLifecycleEnabled,
    isRoundStarted,
    isRoundFunded,
    isRoundComplete,
    firstUnfundedRound,
    roundStatus,
    currentRound,
    pendingPayoutRounds,
    allRoundsComplete,
    canStartNextRound,
    completedRoundsCount,

    remainingAmount,
    progressPercentOverall,
    progressPercentRound,

    isOverdue,
    memberOverdueCount,
    totalOverdueCount,
    onTimeStats,
    missedContributions,

    currentCycle,
    completedCyclesCount,
    remainingCyclesCount,
    maxAdvanceCount,

    validateContribution,
  };
})();
