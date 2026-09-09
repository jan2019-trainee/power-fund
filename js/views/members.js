/* ---------------------------------------------------------------------------
 * View: members
 *
 * The roster, in payout order.
 *
 * Two shells, one set of facts:
 *   mobile  — a list whose rows expand inline. The design tried a full detail
 *             screen first and dropped it: "overkill for what's just a few
 *             lines of cycle history" (canvas.json, members-notes). Reached as
 *             a drill-down from Home, so it carries its own way back.
 *   desktop — the same list as a master column beside a detail pane, which is
 *             what the room allows and what DesktopMembers shows.
 *
 * Returns an HTML string; it never touches the DOM and never writes. Everything
 * it needs arrives on `ctx`, rebuilt by render() each pass, so a view is a pure
 * function of the state at that moment.
 * ------------------------------------------------------------------------- */
window.PFViews = window.PFViews || {};

window.PFViews.members = function (ctx) {
  const {
    members, rounds, state, unlocked, escapeHtml, icon, memberAvatar,
    memberStanding, getPayout, selectedMemberId, isWide, C
  } = ctx;

  const cyclesDueSoFar = C.completedCyclesCount(state.cycles);
  const selected = selectedMemberId
    ? members.find((m) => m.id === selectedMemberId)
    : null;

  let html = "";

  // On mobile this screen is a drill-down from Home and lights no tab, so it
  // needs its own way back. On desktop it is a sidebar item and a back button
  // would point at a screen the nav already reaches.
  if (!isWide) {
    html += `<button type="button" class="detail-back" onclick="PowerFund.setView('home')">
      ${icon("chevronLeft", 15)}<span>Home</span>
    </button>`;
  }

  html += `<div class="view-head">
    <h2 class="view-title">Members</h2>
    <p class="view-sub">${members.length} members · sorted by payout order</p>
  </div>`;

  const list = `<div class="member-list">${members
    .map((m) => memberRow(m, ctx, cyclesDueSoFar, isWide))
    .join("")}</div>`;

  if (!isWide) return html + list;

  // Desktop: master beside detail. With nothing picked the pane says so rather
  // than sitting empty, which would read as a failure to load.
  return (
    html +
    `<div class="members-split">
      <div class="members-master">${list}</div>
      <div class="members-detail">${
        selected
          ? memberDetail(selected, ctx, cyclesDueSoFar)
          : `<div class="members-detail-empty">
               ${icon("members", 22)}
               <p>Pick a member to see their cycle history and where their payout goes.</p>
             </div>`
      }</div>
    </div>`
  );
};

/** Escape a value being dropped into an inline onclick string literal. */
function inlineArgSafe(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * One roster row: who they are, where they stand, and — on mobile — their
 * history folded in underneath.
 */
function memberRow(m, ctx, cyclesDueSoFar, isWide) {
  const {
    state, rounds, escapeHtml, icon, memberAvatar, memberStanding, getPayout,
    selectedMemberId, C
  } = ctx;

  const paidOut = getPayout(m.member_order).released;
  const standing = memberStanding(m.id, cyclesDueSoFar, paidOut);
  const open = selectedMemberId === m.id;
  const curRound = C.currentRound(state.payouts, state.contributions);

  // The tag reuses the onboarding Payout Order screen's language, so the same
  // three words mean the same thing wherever a member appears.
  const tag = paidOut
    ? { cls: "paid-out", word: "Paid out" }
    : m.member_order === curRound
    ? { cls: "this-round", word: "This round" }
    : standing === "rejected"
    ? { cls: "rejected", word: "Rejected" }
    : standing === "overdue"
    ? { cls: "overdue", word: "Overdue" }
    : standing === "pending"
    ? { cls: "pending", word: "In review" }
    : { cls: "upcoming", word: "Upcoming" };

  // What this member is doing in the round that is actually running — the
  // earliest cycle of THAT round they haven't settled. currentCycle() answers a
  // different question (the next cycle by date, which can still belong to the
  // previous round), and using it here labelled a Round-1 cycle as Round 2's.
  const range = C.roundCycleRange(curRound);
  let openCycle = null;
  for (let c = range.startCycle; c <= range.endCycle; c++) {
    if (C.statusOf(state.contributions, m.id, c) !== C.STATUS_PAID) {
      openCycle = c;
      break;
    }
  }
  let cycWord;
  if (openCycle === null) {
    cycWord = "all paid";
  } else {
    const st = C.statusOf(state.contributions, m.id, openCycle);
    // "not due yet" contradicted Home, which asks for this very cycle
    // ("Payment due Dec 15") and offers a button to pay it. Both were reading
    // the same cycle and telling the member opposite things. Name the date
    // instead: same fact, no contradiction, and more useful than either.
    const due = C.dueDateOf(state.cycles, openCycle);
    cycWord =
      st === C.STATUS_PENDING
        ? "pending review"
        : st === C.STATUS_REJECTED
        ? "rejected"
        : C.isOverdue(state.contributions, state.cycles, m.id, openCycle)
        ? "overdue"
        : due
        ? `due ${C.formatDate(due)}`
        : "due";
  }

  return `<div class="member-row-wrap ${open ? "open" : ""}">
    <button type="button" class="member-row ${open ? "open" : ""}"
      aria-expanded="${open ? "true" : "false"}"
      onclick="PowerFund.openMemberDetail('${inlineArgSafe(m.id)}')">
      <span class="member-row-avatar">
        ${memberAvatar(m.name, standing, 40)}
        <span class="member-row-order">${m.member_order}</span>
      </span>
      <span class="member-row-main">
        <span class="member-row-top">
          <span class="member-row-name">${escapeHtml(m.name)}</span>
          <span class="member-tag ${tag.cls}">${tag.word}</span>
        </span>
        <span class="member-row-sub">Payout order #${m.member_order} · Round ${
    curRound
  }: ${cycWord}</span>
      </span>
      <span class="member-row-chevron">${icon("chevron", 15)}</span>
    </button>
    ${
      // Desktop shows the record in the pane beside the list, so folding it in
      // here as well would print the same thing twice.
      open && !isWide
        ? `<div class="member-row-panel">${roundSummaries(m, ctx)}${payoutDest(m, ctx)}</div>`
        : ""
    }
  </div>`;
}

/**
 * The cycle history, one line per round rather than thirty rows.
 *
 * The design's shape: a finished round collapses to a count, the running round
 * is spelled out cycle by cycle, and everything not started is a single line —
 * "Rounds 3–5 — not started".
 */
function roundSummaries(m, ctx) {
  const { state, rounds, escapeHtml, C } = ctx;
  const curRound = C.currentRound(state.payouts, state.contributions);
  let out = "";

  for (let r = 1; r <= C.TOTAL_ROUNDS; r++) {
    const status = C.roundStatus(state.contributions, rounds, r);
    if (status === "not_started" && r > curRound) continue; // folded up below

    const { startCycle, endCycle } = C.roundCycleRange(r);
    let paid = 0;
    for (let c = startCycle; c <= endCycle; c++) {
      if (C.statusOf(state.contributions, m.id, c) === C.STATUS_PAID) paid++;
    }

    if (r < curRound) {
      const gotPayout = getPayoutReleased(rounds, r) && m.member_order === r;
      out += `<div class="round-line">
        <b>Round ${r}</b> — ${paid} of ${C.CYCLES_PER_ROUND} paid${
        gotPayout ? " · received the payout" : ""
      }
      </div>`;
      continue;
    }

    // The round in progress: name the cycles that are actually live, then say
    // how many more are behind them rather than listing all six.
    const parts = [];
    let shown = 0;
    for (let c = startCycle; c <= endCycle && shown < 2; c++) {
      const due = C.dueDateOf(state.cycles, c);
      if (!due) continue;
      const st = C.statusOf(state.contributions, m.id, c);
      const late = C.isOverdue(state.contributions, state.cycles, m.id, c);
      const word =
        st === C.STATUS_PAID
          ? "paid"
          : st === C.STATUS_PENDING
          ? "pending review"
          : st === C.STATUS_REJECTED
          ? "rejected"
          : late
          ? "overdue"
          : "not due";
      parts.push(
        `Cycle ${c}: <span class="round-line-state ${word.replace(
          / /g,
          "-"
        )}">${word}</span> (${C.formatDate(due)})`
      );
      shown++;
    }
    const more = endCycle - startCycle + 1 - shown;
    out += `<div class="round-line">
      <b>Round ${r}</b> — ${parts.join(" · ")}${
      more > 0 ? ` · +${more} more this round` : ""
    }
    </div>`;
  }

  const firstNotStarted = curRound + 1;
  if (firstNotStarted <= C.TOTAL_ROUNDS) {
    out += `<div class="round-line muted"><b>Round${
      firstNotStarted === C.TOTAL_ROUNDS ? "" : "s"
    } ${firstNotStarted}${
      firstNotStarted === C.TOTAL_ROUNDS ? "" : "–" + C.TOTAL_ROUNDS
    }</b> — not started</div>`;
  }
  return `<div class="round-lines">${out}</div>`;
}

function getPayoutReleased(rounds, r) {
  const row = (rounds || []).find((p) => p.round_number === r);
  return !!(row && row.released);
}

/**
 * Where this member's payout goes. Shown to everyone so a member can check
 * their own details are right, but only editable in treasurer mode — the app
 * has no per-member authentication, so a member-only gate would be decorative.
 */
function payoutDest(m, ctx) {
  const { escapeHtml, icon, unlocked } = ctx;
  const has =
    m.payout_qr_url || m.payout_bank || m.payout_account_name || m.payout_account_number;

  return `<div class="payout-dest-block">
    <p class="section-label">Payout destination</p>
    <div class="payout-dest">
      ${
        has
          ? `<div class="payout-dest-main">
               ${
                 m.payout_qr_url
                   ? `<button type="button" class="payout-dest-qr" onclick="PowerFund.openLightbox('${inlineArgSafe(
                       m.payout_qr_url
                     )}')"><img src="${escapeHtml(m.payout_qr_url)}" alt="${escapeHtml(
                       m.name
                     )}'s payout QR code"></button>`
                   : ""
               }
               <div class="payout-dest-lines">
                 ${
                   m.payout_bank
                     ? `<div class="payout-dest-bank">${escapeHtml(m.payout_bank)}</div>`
                     : ""
                 }
                 ${
                   m.payout_account_name
                     ? `<div class="payout-dest-name">${escapeHtml(m.payout_account_name)}</div>`
                     : ""
                 }
                 ${
                   m.payout_account_number
                     ? `<div class="payout-dest-num">${escapeHtml(m.payout_account_number)}</div>`
                     : ""
                 }
                 ${m.payout_qr_url ? "" : `<div class="payout-dest-num">No QR on file</div>`}
               </div>
             </div>`
          : `<p class="payout-dest-empty">Nothing on file yet — the treasurer records where this payout should be sent.</p>`
      }
      ${
        unlocked
          ? `<button type="button" class="payout-dest-edit" onclick="PowerFund.openPayoutQrModal('${inlineArgSafe(
              m.id
            )}')">${icon(has ? "qr" : "upload", 14)}<span>${
              has ? "Edit payout details" : "Add payout details"
            }</span></button>`
          : ""
      }
    </div>
  </div>`;
}

/** Desktop's right-hand pane: the same record, with room for the numbers. */
function memberDetail(m, ctx, cyclesDueSoFar) {
  const { state, escapeHtml, memberAvatar, memberStanding, getPayout, C } = ctx;
  const paidOut = getPayout(m.member_order).released;
  const standing = memberStanding(m.id, cyclesDueSoFar, paidOut);
  const total = C.totalPerMember(state.contributions, m.id);
  const overdue = C.memberOverdueCount(state.contributions, state.cycles, m.id);
  const onTime = C.onTimeStats(state.contributions, state.cycles, m.id);
  let paidSoFar = 0;
  for (let c = 1; c <= cyclesDueSoFar; c++) {
    if (C.statusOf(state.contributions, m.id, c) === C.STATUS_PAID) paidSoFar++;
  }
  const payoutDue = C.dueDateOf(state.cycles, m.member_order * C.CYCLES_PER_ROUND);

  // The ring colour is never the only cue — the same standing is spelled out.
  const STANDING_WORD = {
    "paid-out": "Payout received",
    rejected: "Payment rejected — needs resending",
    overdue: overdue === 1 ? "1 cycle overdue" : overdue + " cycles overdue",
    pending: "Payment awaiting review",
    current: "Caught up",
    idle: "Nothing due yet",
  };

  return `<div class="detail-head">
    ${memberAvatar(m.name, standing, 60)}
    <div class="detail-ident">
      <h2 class="detail-name">${escapeHtml(m.name)}</h2>
      <p class="detail-order">Payout order #${m.member_order}${
    payoutDue ? " · target " + C.formatDate(payoutDue) : ""
  }</p>
    </div>
    <span class="detail-standing standing-${standing}">${STANDING_WORD[standing]}</span>
  </div>

  <div class="stat-grid detail-stats">
    <div class="stat-tile"><div class="stat-value">${C.peso(
      total
    )}</div><div class="stat-label">contributed so far</div></div>
    <div class="stat-tile"><div class="stat-value">${paidSoFar} / ${cyclesDueSoFar}</div><div class="stat-label">cycles paid, of those due</div></div>
    <div class="stat-tile"><div class="stat-value ${
      onTime.rate === null ? "" : onTime.rate >= 80 ? "success" : "danger"
    }">${
    onTime.rate === null ? "—" : Math.round(onTime.rate) + "%"
  }</div><div class="stat-label">${
    onTime.rate === null
      ? "no dated payments yet"
      : "paid on time (" + onTime.onTime + "/" + onTime.counted + ")"
  }</div></div>
  </div>

  <p class="section-label">Cycle history</p>
  ${roundSummaries(m, ctx)}
  ${payoutDest(m, ctx)}`;
}
