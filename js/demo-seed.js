/* ---------------------------------------------------------------------------
 * Power Fund — DEMO SEED  (branch: demo/group-walkthrough)
 *
 * The starting state for DEMO_MODE. Not real records: this file exists so the
 * app can be shown to the group without touching the live fund, and without
 * needing four other people's Google accounts.
 *
 * WHY FIXTURES AND NOT THE REAL DATABASE. `CLAUDE.md` rule 4 forbids fake
 * data "unless explicitly requested for prototyping" — this is that case, and
 * it is fenced two ways: it loads only when `DEMO_MODE` is true, and the app
 * carries a banner saying so on every screen.
 *
 * It is also the better demo. The live fund is mid-Round-2 at ₱0 collected,
 * so most of the app has nothing to show. This state deliberately walks
 * through the whole feature set at once:
 *
 *   Round 1  paid out to Regine, receipt attached, CONFIRMED RECEIVED
 *   Round 2  paid out to Sarah, receipt attached, and SARAH DISPUTES IT —
 *            "nothing in GCash", which is the newest feature (014)
 *   Round 3  collecting now: two confirmed, one in review, one REJECTED with
 *            a note, one not yet sent
 *   Round 4  not started, and Jan has an open SWAP REQUEST out to Clara (013)
 *
 * DATES ARE RELATIVE to the day the demo is opened, so nothing reads as
 * stale — cycle 13 is always "a few days ago" and cycle 15 is always "soon".
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
  const MEMBERS = ["Regine", "Sarah", "Jan", "Clara", "Verdz"].map((name, i) => ({
    id: uuid(i + 1),
    name: name,
    member_order: i + 1,
    email: null,
    auth_user_id: "demo-user-" + (i + 1),
    is_treasurer: name === "Jan", // the person giving the demo
    avatar_url: null,
    payout_bank: i < 3 ? "GCash" : null,
    payout_account_name: i < 3 ? name + " " + "SDGJ"[i] + "." : null,
    payout_account_number: i < 3 ? "0917 555 000" + (i + 1) : null,
    payout_qr_url: null,
    payout_updated_at: i < 3 ? at(-40) : null,
  }));
  const M = (n) => MEMBERS[n - 1].id;

  // 30 cycles, twice a month. Cycle 13 fell a few days ago and cycle 14 is a
  // week out, which puts the demo in the middle of Round 3.
  const CYCLES = Array.from({ length: 30 }, (_, i) => ({
    id: uuid(100 + i + 1),
    cycle_number: i + 1,
    // Cycle 13 = 4 days ago. Each cycle is ~15 days.
    due_date: dateOnly((i - 12) * 15 - 4),
  }));

  const PAYOUTS = [1, 2, 3, 4, 5].map((r) => {
    const base = {
      round_number: r,
      released: false,
      note: null,
      released_on: null,
      started_at: r <= 3 ? at(-15 * (3 - r) - 90) : null,
      amount: null,
      recipient_member_id: null,
      recipient_name: null,
      receipt_url: null,
      released_by: null,
      received_at: null,
      received_note: null,
      disputed_at: null,
      disputed_note: null,
    };
    if (r === 1) {
      return Object.assign(base, {
        released: true,
        released_on: dateOnly(-97),
        amount: 30000,
        recipient_member_id: M(1),
        recipient_name: "Regine",
        released_by: "Jan",
        receipt_url: "assets/gcash-qr.jpg", // stands in for a receipt photo
        received_at: at(-96),
        received_note: "GCash, received in full — thanks!",
      });
    }
    if (r === 2) {
      return Object.assign(base, {
        released: true,
        released_on: dateOnly(-6),
        amount: 30000,
        recipient_member_id: M(2),
        recipient_name: "Sarah",
        released_by: "Jan",
        receipt_url: "assets/gcash-qr.jpg",
        // THE DISPUTE (014) — the newest thing to show, and the one screen
        // the live fund will hopefully never be in.
        disputed_at: at(-2, 9),
        disputed_note: "Nothing in GCash as of today — checked twice",
      });
    }
    return base;
  });

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

  // Rounds 1 and 2 — every cycle settled, which is what made them payable.
  for (let c = 1; c <= 12; c++) {
    for (let m = 1; m <= 5; m++) add(m, c, 2);
  }
  // Round 3, collecting. Cycle 13 is past due, cycle 14 is not.
  add(1, 13, 2); // Regine paid
  add(2, 13, 2); // Sarah paid
  add(3, 13, 2); // Jan (the treasurer) paid
  add(4, 13, 1); // Clara: in review — gives the treasurer a queue to work
  add(5, 13, 3, {
    // Verdz: refused, with a reason. Cycle 13 IS past due, so this reads red
    // rather than as a refused advance.
    proof_url: "assets/gcash-qr.jpg",
    rejection_note: "Screenshot is cut off — can't see the amount or the date",
    rejected_at: at(-1, 16),
  });
  // Cycle 14 not due yet: one member has paid ahead, the rest have not.
  add(1, 14, 2);

  const SWAP_REQUESTS = [
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

  const ACTIVITY_LOG = [
    { id: uuid(800), message: "Sarah reported that the Round 2 payout has not arrived — Nothing in GCash as of today", created_at: at(-2, 9), event_type: "payout", amount: null, ref_status: null, member_id: M(2), round_number: 2 },
    { id: uuid(801), message: "Jan rejected Verdz's cycle 13 claim — \"Screenshot is cut off\"", created_at: at(-1, 16), event_type: "payment", amount: 1000, ref_status: 3, member_id: M(5), round_number: 3 },
    { id: uuid(802), message: "Jan asked Clara to swap turns — Round 3 ↔ Round 4", created_at: at(-1, 20), event_type: "admin", amount: null, ref_status: null, member_id: M(3), round_number: 3 },
    { id: uuid(803), message: "Payout released — Round 2 (Sarah) · ₱30,000.00", created_at: at(-6, 14), event_type: "payout", amount: -30000, ref_status: null, member_id: M(2), round_number: 2 },
    { id: uuid(804), message: "Jan confirmed Clara's cycle 13 as sent — ₱1,000.00", created_at: at(-3, 11), event_type: "payment", amount: 1000, ref_status: 1, member_id: M(4), round_number: 3 },
    { id: uuid(805), message: "Regine confirmed receiving ₱30,000.00 for Round 1 — GCash, received in full", created_at: at(-96, 12), event_type: "payout", amount: null, ref_status: null, member_id: M(1), round_number: 1 },
    { id: uuid(806), message: "Treasurer started Round 3", created_at: at(-30, 8), event_type: "admin", amount: null, ref_status: null, member_id: null, round_number: 3 },
  ];

  const SETTINGS = {
    id: 1,
    // Says DEMO in the one place that is on every screen.
    fund_name: "DEMO — ViTAMiN Fund",
    qr_code_url: null, // falls back to QR_IMAGE_URL
    qr_updated_at: null,
    qr_bank: "GCash",
    qr_account_name: "Jan N.",
    qr_account_number: "0917 555 0003",
  };

  return {
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
