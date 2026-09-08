/* ---------------------------------------------------------------------------
 * View: rounds
 *
 * Rounds & cycles, and the payout history beneath them.
 *
 * Returns an HTML string; it never touches the DOM and never writes. Everything
 * it needs arrives on `ctx`, rebuilt by render() each pass, so a view is a pure
 * function of the state at that moment.
 * ------------------------------------------------------------------------- */
window.PFViews = window.PFViews || {};

window.PFViews.rounds = function (ctx) {
  const {
    members, rounds, curCycle, allDone, curRound, ROUND_PILL, state,
    unlocked, openRound, escapeHtml, inlineArg, icon, getPayout,
    payoutRecipientName, payoutDateText, C
  } = ctx;
  let html = "";


  html += `<div class="view-head">
    <h2 class="view-title">Rounds &amp; cycles</h2>
    <p class="view-sub">${C.TOTAL_ROUNDS} rounds · ${C.TOTAL_CYCLES} cycles · ${C.peso(
      C.GOAL_PER_ROUND
    )} paid out per round</p>
  </div>`;

  // rounds & cycles (the view heading above already names this section)
  for (let r = 1; r <= C.TOTAL_ROUNDS; r++) {
    const recipient = members.find((m) => m.member_order === r);
    const { startCycle, endCycle } = C.roundCycleRange(r);
    const roundCollected = C.roundCollected(state.contributions, r);
    const roundPending = C.roundPending(state.contributions, r);
    const isOpen = openRound === r;
    const payout = getPayout(r);
    const fullyFunded = roundCollected >= C.GOAL_PER_ROUND;
    const rStatus = C.roundStatus(state.contributions, rounds, r); // not_started|collecting|payout_pending|completed
    const endDue = C.dueDateOf(state.cycles, endCycle);

    html += `<div class="round">
      <div class="round-header" role="button" tabindex="0" aria-expanded="${
        isOpen ? "true" : "false"
      }" onclick="PowerFund.toggleRound(${r})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();PowerFund.toggleRound(${r})}">
        <div class="round-title"><span class="round-chevron ${
          isOpen ? "open" : ""
        }">▸</span> Round ${r} — ${recipient ? escapeHtml(recipient.name) : "—"} ${
      ROUND_PILL[rStatus]
    }${r === curRound && !allDone ? ' <span class="round-active-tag">active</span>' : ""}</div>
        <div class="round-status">${C.peso(roundCollected)} / ${C.peso(C.GOAL_PER_ROUND)}${
      fullyFunded ? "" : ` · ${Math.round(C.progressPercentRound(state.contributions, r))}%`
    }${roundPending ? ` · ${roundPending} pending` : ""}${
      endDue ? ` · ${C.formatDate(endDue)}` : ""
    }</div>
      </div>
      <div class="round-body ${isOpen ? "open" : ""}">
        <div class="cycle-list">
          ${(function () {
            let rowsHtml = "";
            for (let c = startCycle; c <= endCycle; c++) {
              const due = C.dueDateOf(state.cycles, c);
              const isCurrent = c === curCycle;
              const rowTag = isCurrent
                ? due && C.isSameDay(due, new Date())
                  ? "today"
                  : "next due"
                : null;
              const chips = members
                .map((m) => {
                  const status = C.statusOf(state.contributions, m.id, c);
                  const overdue = C.isOverdue(
                    state.contributions,
                    state.cycles,
                    m.id,
                    c
                  );
                  const cls =
                    status === 2
                      ? "paid"
                      : status === 1
                      ? "pending"
                      : overdue
                      ? "overdue"
                      : "";
                  const icon =
                    status === 2 ? "✓" : status === 1 ? "…" : overdue ? "!" : "";
                  const clickable = unlocked || status === 0;
                  const tip =
                    status === 1
                      ? "Pending treasurer review"
                      : status === 2
                      ? "Confirmed paid"
                      : overdue
                      ? "Overdue — tap to contribute"
                      : "Tap to contribute";
                  // Treasurer mode makes every chip clickable, including
                  // paid/pending ones that would otherwise look like plain
                  // status badges — a dashed border marks those as also
                  // being buttons (tap to revert / review), not just info.
                  const treasurerTap = unlocked && status !== 0;
                  return `<span class="member-chip ${cls} ${
                    clickable ? "editable" : ""
                  } ${
                    treasurerTap ? "treasurer-tap" : ""
                  }" onclick="PowerFund.cellClicked('${m.id}', ${c})" title="${escapeHtml(
                    m.name
                  )}: ${tip}">${escapeHtml(m.name)}${icon ? ` ${icon}` : ""}</span>`;
                })
                .join("");
              rowsHtml += `<div class="cycle-row ${isCurrent ? "current-row" : ""}">
                <div class="cycle-date">${due ? C.formatDate(due) : `Cycle ${c}`}${
                rowTag ? ` <span class="today-tag">${rowTag}</span>` : ""
              }</div>
                <div class="cycle-chips">${chips}</div>
              </div>`;
            }
            return rowsHtml;
          })()}
        </div>
        ${
          payout.released
            ? `<div class="payout-status-box">
                 <div>${icon("check", 14)} Payout released to <b>${escapeHtml(
                   payoutRecipientName(payout)
                 )}</b>${
                payout.amount != null ? `, ${C.peso(payout.amount)}` : ""
              }${
                payout.released_on
                  ? ` on ${payoutDateText(payout.released_on)}`
                  : ""
              }${payout.note ? ` — ${escapeHtml(payout.note)}` : ""}${
                payout.receipt_url
                  ? ` · <button type="button" class="ph-receipt" onclick="PowerFund.openLightbox('${inlineArg(
                      payout.receipt_url
                    )}')">${icon("sheet", 13)}<span>receipt</span></button>`
                  : ""
              }</div>
                 ${
                   unlocked
                     ? `<button class="reset-btn" onclick="PowerFund.unmarkPayoutReleased(${r})">Undo</button>`
                     : ""
                 }
               </div>`
            : fullyFunded
            ? // No "Mark payout released" button here even when unlocked —
              // every payout-pending round is already listed with that
              // exact button in the "Needs your attention" panel above,
              // which is visible on every render (not just while this
              // round's accordion happens to be expanded). Two buttons
              // for the same action on the same page is just noise.
              `<div class="payout-status-box pending-box"><div><span class="round-dot pending"></span>Payout Pending — ${C.peso(
                C.GOAL_PER_ROUND
              )} reached</div></div>`
            : ""
        }
      </div>
    </div>`;
  }

  // ---- Payout history: released payouts, recipient/amount as recorded ----
  (function () {
    const released = (state.payouts || [])
      .filter((p) => p.released)
      .sort((a, b) => a.round_number - b.round_number);
    if (!released.length) return;
    html += `<p class="section-label">Payout history</p><div class="payout-history">`;
    released.forEach((p) => {
      const amt =
        p.amount != null ? C.peso(p.amount) : C.peso(C.GOAL_PER_ROUND);
      html += `<div class="payout-history-row">
        <div class="ph-main"><b>Round ${p.round_number}</b> — ${escapeHtml(
        payoutRecipientName(p)
      )} · ${amt}</div>
        <div class="ph-meta">${
          p.released_on ? payoutDateText(p.released_on) : "date not recorded"
        }${p.note ? ` · ${escapeHtml(p.note)}` : ""}</div>
        ${
          p.receipt_url
            ? `<button type="button" class="ph-receipt" onclick="PowerFund.openLightbox('${inlineArg(
                p.receipt_url
              )}')">${icon("sheet", 13)}<span>View receipt</span></button>`
            : ""
        }
      </div>`;
    });
    html += `</div>`;
  })();

  return html;
};
