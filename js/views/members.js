/* ---------------------------------------------------------------------------
 * View: members
 *
 * The roster: one card per member, in payout order.
 *
 * Returns an HTML string; it never touches the DOM and never writes. Everything
 * it needs arrives on `ctx`, rebuilt by render() each pass, so a view is a pure
 * function of the state at that moment.
 * ------------------------------------------------------------------------- */
window.PFViews = window.PFViews || {};

window.PFViews.members = function (ctx) {
  const {
    members, state, unlocked, escapeHtml, icon, memberAvatar,
    memberStanding, getPayout, selectedMemberId, isWide, C
  } = ctx;
  let html = "";

  // Drill-down: one member's full record, reached from their card.
  const selected = selectedMemberId
    ? members.find((m) => m.id === selectedMemberId)
    : null;
  if (selected) return renderMemberDetail(selected, ctx);

  // On mobile the roster is a drill-down from Home rather than a tab, so it
  // needs its own way back — nothing in the bottom bar is lit while it is
  // open. On desktop it IS a sidebar item, and a back button would be a
  // dead-end control pointing at a screen the nav already reaches.
  if (!isWide) {
    html += `<button type="button" class="detail-back" onclick="PowerFund.setView('home')">
      ${icon("chevronLeft", 15)}<span>Home</span>
    </button>`;
  }

  html += `<div class="view-head">
    <h2 class="view-title">Members</h2>
    <p class="view-sub">${members.length} members · paid in payout order · ${C.peso(
      C.CONTRIBUTION_AMOUNT
    )} per cycle each</p>
  </div>`;

  // member cards (the view heading above already names this section)
  html += `<div class="member-grid">`;
  // Cycles due so far (date-based) — the denominator for each member's
  // "caught up" ratio. Cycles not yet due aren't counted against anyone.
  const cyclesDueSoFar = C.completedCyclesCount(state.cycles);
  members.forEach((m) => {
    const total = C.totalPerMember(state.contributions, m.id);
    const payoutCycle = m.member_order * C.CYCLES_PER_ROUND;
    const payoutDue = C.dueDateOf(state.cycles, payoutCycle);
    const mOverdue = C.memberOverdueCount(state.contributions, state.cycles, m.id);
    const paidOut = getPayout(m.member_order).released;
    let mPaidSoFar = 0;
    for (let c = 1; c <= cyclesDueSoFar; c++) {
      if (C.statusOf(state.contributions, m.id, c) === C.STATUS_PAID) mPaidSoFar++;
    }
    const standing = memberStanding(m.id, cyclesDueSoFar, paidOut);
    html += `<div class="member-card ${
      paidOut ? "paid-out" : ""
    }" role="button" tabindex="0" onclick="PowerFund.openMemberDetail('${
      m.id
    }')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();PowerFund.openMemberDetail('${
      m.id
    }')}">
      <div class="member-order-row">
        <span class="member-order-num">#${m.member_order} in order</span>
        ${
          unlocked
            ? `<div class="reorder-arrows">
                 <button onclick="event.stopPropagation();PowerFund.moveMember('${m.id}', -1)" ${
                m.member_order === 1 ? "disabled" : ""
              }>↑</button>
                 <button onclick="event.stopPropagation();PowerFund.moveMember('${m.id}', 1)" ${
                m.member_order === members.length ? "disabled" : ""
              }>↓</button>
               </div>`
            : ""
        }
      </div>
      <div class="member-ident">
        ${memberAvatar(m.name, standing, 40)}
        <p class="member-name">${escapeHtml(m.name)}</p>
      </div>
      <div class="member-contrib-label">Contributed</div>
      <div class="member-contrib">${C.peso(total)}</div>
      ${
        cyclesDueSoFar > 0
          ? `<div class="member-ratio ${
              mPaidSoFar < cyclesDueSoFar ? "behind" : ""
            }">${mPaidSoFar}/${cyclesDueSoFar} cycles paid</div>`
          : ""
      }
      <div class="member-payout-date">Payout target: ${
        payoutDue ? C.formatDate(payoutDue) : "—"
      }${paidOut ? ' <span class="payout-done-tag">paid out</span>' : ""}</div>
      ${
        mOverdue
          ? `<div class="overdue-badge">${icon(
              "alert",
              13
            )}<span>${mOverdue} overdue</span></div>`
          : ""
      }
    </div>`;
  });
  html += `</div>`;

  return html;
};

/** Escape a value being dropped into an inline onclick string literal. */
function inlineArgSafe(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * One member's full record: standing, the money, where their payout goes, and
 * every cycle grouped by round. Payment history is read-only by design —
 * recording and reviewing stays on the cycle grids in Rounds, so this can't
 * become a second, divergent way to change what someone has paid.
 */
function renderMemberDetail(m, ctx) {
  const { state, unlocked, escapeHtml, icon, memberAvatar, memberStanding, getPayout, C } = ctx;
  const cyclesDueSoFar = C.completedCyclesCount(state.cycles);
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

  let html = `<button type="button" class="detail-back" onclick="PowerFund.closeMemberDetail()">
    ${icon("chevronLeft", 15)}<span>All members</span>
  </button>
  <div class="detail-head">
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
  </div>`;

  // Where this member's payout goes. Shown to everyone (so a member can check
  // their own details are right) but only editable in treasurer mode.
  const hasPayoutDetails =
    m.payout_qr_url || m.payout_bank || m.payout_account_name || m.payout_account_number;
  html += `<p class="section-label">Payout destination</p>
  <div class="payout-dest">
    ${
      hasPayoutDetails
        ? `<div class="payout-dest-main">
             ${
               m.payout_qr_url
                 ? `<button type="button" class="payout-dest-qr" onclick="PowerFund.openLightbox('${inlineArgSafe(
                     m.payout_qr_url
                   )}')"><img src="${escapeHtml(
                     m.payout_qr_url
                   )}" alt="${escapeHtml(m.name)}'s payout QR code"></button>`
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
                   ? `<div class="payout-dest-name">${escapeHtml(
                       m.payout_account_name
                     )}</div>`
                   : ""
               }
               ${
                 m.payout_account_number
                   ? `<div class="payout-dest-num">${escapeHtml(
                       m.payout_account_number
                     )}</div>`
                   : ""
               }
               ${
                 m.payout_qr_url ? "" : `<div class="payout-dest-num">No QR on file</div>`
               }
             </div>
           </div>`
        : `<p class="payout-dest-empty">Nothing on file yet — the treasurer records where this payout should be sent.</p>`
    }
    ${
      unlocked
        ? `<button type="button" class="payout-dest-edit" onclick="PowerFund.openPayoutQrModal('${m.id}')">${icon(
            hasPayoutDetails ? "qr" : "upload",
            14
          )}<span>${hasPayoutDetails ? "Edit payout details" : "Add payout details"}</span></button>`
        : ""
    }
  </div>`;

  // Grouped by round rather than one flat run of 30 rows, so the history
  // reads against the structure the fund actually works in.
  html += `<p class="section-label">Cycle history</p><div class="detail-rounds">`;
  for (let r = 1; r <= C.TOTAL_ROUNDS; r++) {
    const range = C.roundCycleRange(r);
    const rStatus = C.roundStatus(state.contributions, state.payouts, r);
    html += `<div class="detail-round">
      <div class="detail-round-head">
        <span class="detail-round-name">Round ${r}</span>
        <span class="detail-round-status">${rStatus.replace(/_/g, " ")}</span>
      </div>
      <div class="detail-cycles">`;
    for (let c = range.startCycle; c <= range.endCycle; c++) {
      const st = C.statusOf(state.contributions, m.id, c);
      const due = C.dueDateOf(state.cycles, c);
      const late = C.isOverdue(state.contributions, state.cycles, m.id, c);
      const cls =
        st === 2 ? "paid" : st === 1 ? "pending" : st === 3 ? "rejected" : late ? "overdue" : "unpaid";
      const word =
        st === 2
          ? "paid"
          : st === 1
          ? "in review"
          : st === 3
          ? "rejected"
          : late
          ? "overdue"
          : "not due";
      html += `<div class="detail-cycle ${cls}">
        <span class="detail-cycle-n">Cycle ${c}</span>
        <span class="detail-cycle-date">${due ? C.formatDate(due) : "—"}</span>
        <span class="detail-cycle-state">${word}</span>
      </div>`;
    }
    html += `</div></div>`;
  }
  html += `</div>`;
  return html;
}
