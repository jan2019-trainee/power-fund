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
    memberStanding, getPayout, C
  } = ctx;
  let html = "";


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
    html += `<div class="member-card ${paidOut ? "paid-out" : ""}">
      <div class="member-order-row">
        <span class="member-order-num">#${m.member_order} in order</span>
        ${
          unlocked
            ? `<div class="reorder-arrows">
                 <button onclick="PowerFund.moveMember('${m.id}', -1)" ${
                m.member_order === 1 ? "disabled" : ""
              }>↑</button>
                 <button onclick="PowerFund.moveMember('${m.id}', 1)" ${
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
