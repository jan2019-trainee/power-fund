/* ---------------------------------------------------------------------------
 * Power Fund — DEMO SEED  (branch: demo/group-walkthrough)
 *
 * The starting state for DEMO_MODE. Not real records: this file exists so the
 * app can be shown to the group without touching the live fund, and without
 * needing four other people's Google accounts.
 *
 * TWO STARTING STATES, chosen by APP_CONFIG.DEMO_SEED:
 *
 *   "empty"    DEFAULT. Day one. Members, the 30-cycle schedule and round 1
 *              started — exactly what supabase/seed.sql leaves behind — and
 *              nothing else. You build the story up live: pay a cycle as one
 *              member, switch to the treasurer, confirm it, release a payout.
 *   "midfund"  Arrives with the whole feature set already reachable: a
 *              confirmed payout, a DISPUTED one, a claim in review, a
 *              rejection, a pending turn swap. Use it to show a screen
 *              without first having to produce the state behind it.
 *
 * THE SCHEDULE DIFFERS BETWEEN THEM, and that is the part not to collapse
 * into one. "midfund" is deliberately 13 cycles in, so its dates run into the
 * past. Reusing those for an empty fund would open the demo with THIRTEEN
 * overdue cycles across five members — 65 red chips on a fund where nobody
 * has done anything wrong. "empty" instead generates forward from the next
 * 15th-or-end-of-month at least two days out, so day one is genuinely day one
 * and cycle 1 is payable but not late.
 *
 * WHY FIXTURES AND NOT THE REAL DATABASE. `CLAUDE.md` rule 4 forbids fake
 * data "unless explicitly requested for prototyping" — this is that case, and
 * it is fenced two ways: it loads only when `DEMO_MODE` is true, and the app
 * carries a banner saying so on every screen.
 * ------------------------------------------------------------------------- */

window.PF_DEMO_SEED = (function () {
  "use strict";

  const uuid = (n) => "d0000000-0000-4000-8000-" + String(n).padStart(12, "0");
  const DAY = 86400000;
  const at = (days, hour) => {
    const d = new Date(Date.now() + days * DAY);
    d.setHours(hour == null ? 10 : hour, 0, 0, 0);
    return d.toISOString();
  };
  const dateOnly = (days) =>
    new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

  // The real group's names, because that is who the demo is being shown to.
  //
  // `auth_user_id` IS SET and `email` is NOT, and that combination is the
  // whole trick. resolveAccount() matches on auth_user_id BEFORE it looks at
  // any address, so the demo's faked session resolves straight to `linked` —
  // which is what makes editableMember() answer, and therefore what makes
  // Received ✓, disputes, My payout details and turn swaps DRIVABLE rather
  // than merely visible. All four are gated on a linked account, so with no
  // session they render inert and the newest half of the app cannot be
  // demonstrated at all.
  //
  // No emails, because this repo is public and matching by id needs none.
  // WHO HOLDS THE ROLE, in one place. Every treasurer action in the midfund
  // story below is attributed from this rather than spelled out, so moving the
  // role is one edit and cannot leave the activity log describing somebody
  // else doing the treasurer's job.
  const TREASURER = "Verdz";

  const MEMBERS = ["Regine", "Sarah", "Jan", "Clara", "Verdz"].map((name, i) => ({
    id: uuid(i + 1),
    name: name,
    member_order: i + 1,
    email: null,
    auth_user_id: "demo-user-" + (i + 1),
    is_treasurer: name === TREASURER, // the person giving the demo
    avatar_url: null,
    payout_bank: i < 3 ? "GCash" : null,
    payout_account_name: i < 3 ? name + " " + "SDGJ"[i] + "." : null,
    payout_account_number: i < 3 ? "0917 555 000" + (i + 1) : null,
    payout_qr_url: null,
    payout_updated_at: i < 3 ? at(-40) : null,
  }));
  const M = (n) => MEMBERS[n - 1].id;

  const MODE =
    (window.APP_CONFIG && window.APP_CONFIG.DEMO_SEED) === "midfund"
      ? "midfund"
      : "empty";

  /** MIDFUND: 13 cycles in. Cycle 13 fell four days ago and cycle 14 is a
   *  fortnight out, which puts the demo in the middle of round 3. */
  function midfundCycles() {
    return Array.from({ length: 30 }, (_, i) => ({
      id: uuid(100 + i + 1),
      cycle_number: i + 1,
      due_date: dateOnly((i - 12) * 15 - 4),
    }));
  }

  /** EMPTY: the 15th and the last day of each month, same rhythm as
   *  supabase/seed.sql, starting from the next one at least two days out — so
   *  nothing is overdue on arrival and cycle 1 is the one to pay. */
  function emptyCycles() {
    const out = [];
    const start = new Date(Date.now() + 2 * DAY);
    let y = start.getFullYear();
    let m = start.getMonth();
    let half = start.getDate() < 15 ? 0 : 1; // 0 = the 15th, 1 = month end
    for (let i = 0; i < 30; i++) {
      const d =
        half === 0 ? new Date(y, m, 15) : new Date(y, m + 1, 0); // day 0 = last of m
      out.push({
        id: uuid(100 + i + 1),
        cycle_number: i + 1,
        due_date:
          d.getFullYear() +
          "-" +
          String(d.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(d.getDate()).padStart(2, "0"),
      });
      if (half === 0) half = 1;
      else {
        half = 0;
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
      }
    }
    return out;
  }

  const CYCLES = MODE === "midfund" ? midfundCycles() : emptyCycles();

  /** A payout row per round. `started_at` on round 1 only is what
   *  supabase/seed.sql leaves behind for a brand-new fund. */
  function blankPayouts() {
    return [1, 2, 3, 4, 5].map((r) => ({
      round_number: r,
      released: false,
      note: null,
      released_on: null,
      started_at: r === 1 ? at(-1) : null,
      amount: null,
      recipient_member_id: null,
      recipient_name: null,
      receipt_url: null,
      released_by: null,
      received_at: null,
      received_note: null,
      disputed_at: null,
      disputed_note: null,
    }));
  }

  const PAYOUTS = blankPayouts();
  if (MODE === "midfund") {
    // Rounds 1 and 2 started long ago; round 3 is the one collecting.
    PAYOUTS.forEach((p) => {
      if (p.round_number <= 3) p.started_at = at(-15 * (3 - p.round_number) - 90);
    });
    Object.assign(PAYOUTS[0], {
      released: true,
      released_on: dateOnly(-97),
      amount: 30000,
      recipient_member_id: M(1),
      recipient_name: "Regine",
      released_by: TREASURER,
      receipt_url: "assets/gcash-qr.jpg", // stands in for a receipt photo
      received_at: at(-96),
      received_note: "GCash, received in full — thanks!",
    });
    Object.assign(PAYOUTS[1], {
      released: true,
      released_on: dateOnly(-6),
      amount: 30000,
      recipient_member_id: M(2),
      recipient_name: "Sarah",
      released_by: TREASURER,
      receipt_url: "assets/gcash-qr.jpg",
      // THE DISPUTE (014) — the newest thing to show, and the one screen
      // the live fund will hopefully never be in.
      disputed_at: at(-2, 9),
      disputed_note: "Nothing in GCash as of today — checked twice",
    });
  }

  const CONTRIBUTIONS = [];
  let cid = 500;
  const add = (memberN, cycleNumber, status, extra) => {
    CONTRIBUTIONS.push(
      Object.assign(
        {
          id: uuid(cid++),
          cycle_id: CYCLES[cycleNumber - 1].id,
          member_id: M(memberN),
          status: status,
          amount: 1000,
          proof_url: status === 0 ? null : "assets/gcash-qr.jpg",
          paid_at: status === 2 ? at(-(30 - cycleNumber) * 3) : null,
          created_at: at(-(30 - cycleNumber) * 3 - 1),
          rejection_note: null,
          rejected_at: null,
        },
        extra || {}
      )
    );
  };

  // Everything below is MIDFUND ONLY. An empty fund has no contributions, no
  // activity and no swap requests — the same three things `resetAll()` clears.
  if (MODE === "midfund") {
  // Rounds 1 and 2 — every cycle settled, which is what made them payable.
  for (let c = 1; c <= 12; c++) {
    for (let m = 1; m <= 5; m++) add(m, c, 2);
  }
  // Round 3, collecting. Cycle 13 is past due, cycle 14 is not.
  //
  // The REJECTED claim is deliberately not the treasurer's. Verdz holds the
  // role, so parking it on them would have the treasurer refusing their own
  // payment — which the app permits but which reads as a mistake in the demo
  // rather than as the feature.
  add(1, 13, 2); // Regine paid
  add(2, 13, 2); // Sarah paid
  add(5, 13, 2); // Verdz — the treasurer, who pays in like everyone else
  add(4, 13, 1); // Clara: in review — gives the treasurer a queue to work
  add(3, 13, 3, {
    // Jan: refused, with a reason. Cycle 13 IS past due, so this reads red
    // rather than as a refused advance.
    proof_url: "assets/gcash-qr.jpg",
    rejection_note: "Screenshot is cut off — can't see the amount or the date",
    rejected_at: at(-1, 16),
  });
  // Cycle 14 not due yet: one member has paid ahead, the rest have not.
  add(1, 14, 2);

  }

  const SWAP_REQUESTS = MODE !== "midfund" ? [] : [
    {
      // Jan (round 3... already collecting) asking Clara (round 4). Both
      // rounds are unreleased, which is what 013 allows.
      id: uuid(900),
      from_member_id: M(3),
      to_member_id: M(4),
      from_round: 3,
      to_round: 4,
      status: "pending",
      note: "Tuition due next month — could we trade?",
      created_at: at(-1, 20),
      resolved_at: null,
    },
  ];

  const ACTIVITY_LOG = MODE !== "midfund" ? [] : [
    { id: uuid(800), message: "Sarah reported that the Round 2 payout has not arrived — Nothing in GCash as of today", created_at: at(-2, 9), event_type: "payout", amount: null, ref_status: null, member_id: M(2), round_number: 2 },
    { id: uuid(801), message: TREASURER + " rejected Jan's cycle 13 claim — \"Screenshot is cut off\"", created_at: at(-1, 16), event_type: "payment", amount: 1000, ref_status: 3, member_id: M(3), round_number: 3 },
    { id: uuid(802), message: "Jan asked Clara to swap turns — Round 3 ↔ Round 4", created_at: at(-1, 20), event_type: "admin", amount: null, ref_status: null, member_id: M(3), round_number: 3 },
    { id: uuid(803), message: "Payout released — Round 2 (Sarah) · ₱30,000.00", created_at: at(-6, 14), event_type: "payout", amount: -30000, ref_status: null, member_id: M(2), round_number: 2 },
    { id: uuid(804), message: TREASURER + " confirmed Clara's cycle 13 as sent — ₱1,000.00", created_at: at(-3, 11), event_type: "payment", amount: 1000, ref_status: 1, member_id: M(4), round_number: 3 },
    { id: uuid(805), message: "Regine confirmed receiving ₱30,000.00 for Round 1 — GCash, received in full", created_at: at(-96, 12), event_type: "payout", amount: null, ref_status: null, member_id: M(1), round_number: 1 },
    { id: uuid(806), message: "Treasurer started Round 3", created_at: at(-30, 8), event_type: "admin", amount: null, ref_status: null, member_id: null, round_number: 3 },
  ];

  const SETTINGS = {
    id: 1,
    // Says DEMO in the one place that is on every screen.
    fund_name: "DEMO — ViTAMiN Fund",
    // (the banner carries the DEMO warning too; this is what a screenshot shows)
    qr_code_url: null, // falls back to QR_IMAGE_URL
    qr_updated_at: null,
    qr_bank: "GCash",
    // The fund's collecting account belongs to whoever holds the role.
    qr_account_name: TREASURER + " R.",
    qr_account_number: "0917 555 0005",
  };

  return {
    mode: MODE,
    members: MEMBERS,
    cycles: CYCLES,
    contributions: CONTRIBUTIONS,
    payouts: PAYOUTS,
    activity_log: ACTIVITY_LOG,
    swap_requests: SWAP_REQUESTS,
    app_settings: SETTINGS,
    // DEMO_MODE has no PIN vault, so treasurer mode opens on these digits.
    demo_pins: { treasurer: "1234", master: "9999" },
  };
})();
