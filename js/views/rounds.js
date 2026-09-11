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
    payoutRecipientName, payoutDateText, C, isWide, undoPaidTarget, payCycle,
    markPaidTarget, myMember
  } = ctx;
  let html = "";
  // Filled only on wide screens, where the list and detail render separately.
  let listHtml = "";
  let detailHtml = "";


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

    // ONE badge. The lifecycle pill and a separate amber "active" tag were two
    // badges for one header — Rounds.dc.html carries a single "Current". The
    // pill now says which round is live, so nothing is lost by dropping the
    // tag; .is-current also marks the card itself.
    const headerHtml = `<div class="round ${isOpen ? "is-open" : ""}${
      r === curRound && !allDone ? " is-current" : ""
    }">
      <div class="round-header" role="button" tabindex="0" aria-expanded="${
        isOpen ? "true" : "false"
      }" onclick="PowerFund.toggleRound(${r})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();PowerFund.toggleRound(${r})}">
        <div class="round-title"><span class="round-chevron ${
          isOpen ? "open" : ""
        }">▸</span> Round ${r} — ${recipient ? escapeHtml(recipient.name) : "—"} ${
      ROUND_PILL[rStatus]
    }</div>
        <div class="round-status">${C.peso(roundCollected)} / ${C.peso(C.GOAL_PER_ROUND)}${
      fullyFunded ? "" : ` · ${Math.round(C.progressPercentRound(state.contributions, r))}%`
    }${roundPending ? ` · ${roundPending} pending` : ""}${
      endDue ? ` · ${C.formatDate(endDue)}` : ""
    }</div>
      </div>`;
    const bodyHtml = `<div class="round-body ${isOpen ? "open" : ""}">
        <div class="cycle-list">
          ${(function () {
            let rowsHtml = "";
            for (let c = startCycle; c <= endCycle; c++) {
              const due = C.dueDateOf(state.cycles, c);
              // curCycle is date-driven: it names the next cycle whose due
              // date has not passed, which can be a cycle every member has
              // already paid — that put an amber "next due" tag on settled
              // history inside a Completed round, while Home pointed at a
              // different cycle entirely. payCycle is Home's answer (earliest
              // unsettled cycle of the active round), so both screens now
              // agree, and nothing is tagged as owed once it is paid.
              const isDue = payCycle != null && c === payCycle;
              const rowTag = isDue
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
                  // Rejected (status 3, migration 006) reads as its own state
                  // rather than folding into "unpaid": the member did submit,
                  // and the treasurer needs to see that they refused it.
                  //
                  // EXCEPT WHEN IT WAS NEVER DUE. A member who pays six cycles
                  // in advance and is refused owes nothing on the five that
                  // had not come due — they volunteered early and were turned
                  // down. Painting those red says "you are behind" about money
                  // nobody was asking for yet.
                  //
                  // DISPLAY ONLY. The row keeps status 3 and its note, so the
                  // refusal stays on record and nothing is deleted; isOwed()
                  // and isOverdue() are untouched, and they already agree —
                  // isOwed is true for unpaid AND rejected alike, and
                  // isOverdue needs the due date to have passed either way.
                  // So this changes what the chip SAYS, never what is counted.
                  const refusedAdvance = status === 3 && !overdue;
                  const cls =
                    status === 2
                      ? "paid"
                      : status === 1
                      ? "pending"
                      : refusedAdvance
                      ? ""
                      : status === 3
                      ? "rejected"
                      : overdue
                      ? "overdue"
                      : "";
                  const icon =
                    status === 2
                      ? "✓"
                      : status === 1
                      ? "⋯"
                      : refusedAdvance
                      ? ""
                      : status === 3
                      ? "✕"
                      : overdue
                      ? "!"
                      : "";
                  // WHOSE CHIP IS THIS? A member may only send their OWN
                  // payment. Tapping somebody else's used to open the pay
                  // sheet with their name in a small subtitle, and submitting
                  // recorded the contribution as THEIRS with your screenshot
                  // attached — easy to do by accident and hard to notice.
                  //
                  // Migration 011 settles it anyway: contributions_self checks
                  // `member_id = pf_member_id()`, so paying for somebody else
                  // is about to be refused by Postgres. Offering it would mean
                  // offering a button that fails.
                  //
                  // Not yet identified (no linked account, no who-am-I
                  // preference) → still tappable, but it asks who you are
                  // first rather than guessing from the chip you hit.
                  const isMine = !!myMember && String(m.id) === String(myMember.id);
                  const clickable =
                    unlocked || ((isMine || !myMember) && (status === 0 || status === 3));
                  // This string is now the chip's accessible NAME, so it has
                  // to describe what tapping does for THIS viewer. It said
                  // "tap to resubmit" to everyone, but a treasurer tapping a
                  // rejected chip gets the direct cash-record confirmation.
                  const tip = unlocked
                    ? status === 1
                      ? "In review — tap to review"
                      : status === 2
                      ? "Confirmed paid — tap to undo"
                      : status === 3
                      ? "Rejected — tap to record as paid"
                      : overdue
                      ? "Overdue — tap to record as paid"
                      : "Not paid — tap to record as paid"
                    : status === 1
                    ? "Pending treasurer review"
                    : status === 2
                    ? "Confirmed paid"
                    : status === 3
                    ? "Rejected — tap to resubmit"
                    : overdue
                    ? "Overdue — tap to contribute"
                    : "Tap to contribute";
                  // THE AFFORDANCE GOES ON WHAT THIS VIEWER CAN ACT ON, which
                  // is `clickable` — nothing else. It used to be
                  // `unlocked && status !== 0`, which marked the chips that
                  // were already settled and withheld the mark from the
                  // unpaid ones, on both sides of the gate:
                  //
                  //   * a member's OWN payable chip carried only
                  //     `cursor: pointer` — mouse-only, and this is a phone
                  //     app, so the one action they came for was invisible
                  //     while the four chips they are forbidden to tap looked
                  //     identical to it;
                  //   * a treasurer's unpaid chips (tap to record cash) had no
                  //     mark either, while paid and pending ones did.
                  const actionable = clickable;
                  // A real <button>, not a <span onclick>. Every per-cycle
                  // money action on this screen — confirm, revert, record,
                  // resubmit — is driven from these chips, and as spans they
                  // were unreachable by keyboard and invisible to a screen
                  // reader, while the `title` tooltip that carried their only
                  // label never fires on touch. Home's chips were already
                  // buttons; this makes the two agree.
                  return `<button type="button" class="member-chip ${cls} ${
                    clickable ? "editable" : ""
                  } ${actionable ? "actionable" : ""}" ${
                    clickable ? "" : "disabled"
                  } onclick="PowerFund.cellClicked('${inlineArg(
                    m.id
                  )}', ${c})" aria-label="${escapeHtml(m.name)}: ${escapeHtml(
                    tip
                  )}${
                    !unlocked && myMember && !isMine && C.isOwed(status)
                      ? " — only " + escapeHtml(m.name) + " can send this payment"
                      : ""
                  }">${escapeHtml(m.name)}${icon ? ` ${icon}` : ""}</button>`;
                })
                .join("");
              // Undoing one confirmed payment, inline under the row whose pill
              // was tapped — the same shape as this screen's Undo Release.
              const undoHere =
                undoPaidTarget && undoPaidTarget.cycleNumber === c
                  ? members.find((m) => m.id === undoPaidTarget.memberId)
                  : null;
              const undoPanel = undoHere
                ? `<div class="undo-paid-panel">
                     <p class="undo-paid-text">Undo <b>${escapeHtml(
                       undoHere.name
                     )}</b>'s confirmed ${C.peso(C.CONTRIBUTION_AMOUNT)} for ${
                    due ? C.formatDate(due) : "cycle " + c
                  }? It goes back to unpaid for them only — everyone else in this cycle is untouched, and the screenshot is kept.</p>
                     <div class="undo-paid-btns">
                       <button type="button" class="modal-btn-secondary" onclick="PowerFund.cancelUndoPaid()">Cancel</button>
                       <button type="button" class="modal-btn-primary confirm-yes" onclick="PowerFund.confirmUndoPaid()">Undo confirmation</button>
                     </div>
                   </div>`
                : "";

              // Recording a payment with no proof — the treasurer's cash path.
              // Same inline shape as undo above, because it writes money too.
              const markHere =
                markPaidTarget && markPaidTarget.cycleNumber === c
                  ? members.find((m) => m.id === markPaidTarget.memberId)
                  : null;
              const markPanel = markHere
                ? `<div class="undo-paid-panel mark-paid-panel">
                     <p class="undo-paid-text">Record <b>${escapeHtml(
                       markHere.name
                     )}</b>'s ${C.peso(C.CONTRIBUTION_AMOUNT)} for ${
                    due ? C.formatDate(due) : "cycle " + c
                  } as paid? No screenshot is attached, so this is only for money you have already received another way — it counts toward the round immediately.</p>
                     <div class="undo-paid-btns">
                       <button type="button" class="modal-btn-secondary" onclick="PowerFund.cancelMarkPaid()">Cancel</button>
                       <button type="button" class="modal-btn-primary modal-btn-confirm" onclick="PowerFund.confirmMarkPaid()">Record as paid</button>
                     </div>
                   </div>`
                : "";

              rowsHtml += `<div class="cycle-row ${isDue ? "current-row" : ""}">
                <div class="cycle-date">${
                  due ? C.formatDate(due) : `Cycle ${c}`
                }<span class="cycle-ref">Cycle ${c}</span>${
                rowTag ? ` <span class="today-tag">${rowTag}</span>` : ""
              }</div>
                <div class="cycle-chips">${chips}</div>
                ${undoPanel}${markPanel}
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
                   // A round that is released but no longer funded is a fund
                   // whose own books contradict each other. Releasing is gated
                   // on isRoundFunded(), so this is only reachable through a
                   // revert in the wrong order — now refused, but a fund that
                   // already got here must SAY so rather than merely be wrong.
                   C.isRoundFunded(state.contributions, r)
                     ? ""
                     : `<p class="payout-shortfall">${icon("alert", 13)}<span>Paid
                          out in full, but this round now holds only
                          ${C.peso(C.roundCollected(state.contributions, r))} in
                          confirmed payments — ${C.peso(
                            C.GOAL_PER_ROUND - C.roundCollected(state.contributions, r)
                          )} short.</span></p>`
                 }
                 ${
                   unlocked
                     ? `<button class="reset-btn" onclick="PowerFund.unmarkPayoutReleased(${r})">Undo Release</button>`
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
      </div>`;

    // On a wide screen the list and the open round's detail sit side by side,
    // so rounds read as a master list with a detail pane instead of an
    // accordion that pushes everything below it down the page.
    if (isWide) {
      listHtml += headerHtml + `</div>`;
      if (isOpen) {
        // DesktopRounds gives the detail pane its own header: which round, its
        // state, who receives it, and how much of the goal is raised — none of
        // which the pane repeats from the list beside it.
        const word =
          rStatus === "completed"
            ? "Paid out"
            : rStatus === "payout_pending"
            ? "Payout pending"
            : rStatus === "collecting"
            ? "Collecting"
            : "Upcoming";
        detailHtml += `<div class="rounds-detail-head">
          <div class="view-head-text">
            <h3 class="rounds-detail-title">Round ${r} · ${word}</h3>
            <p class="rounds-detail-sub">Recipient: ${
              recipient ? escapeHtml(recipient.name) : "—"
            } · ${C.peso(roundCollected)} / ${C.peso(C.GOAL_PER_ROUND)} raised</p>
          </div>
          ${
            // Treasurer mode only, like Activity's Export CSV — the member
            // Menu says exports are treasurer-only and the mobile shell gives
            // a member none, so a desktop member getting one was the outlier.
            unlocked
              ? `<button type="button" class="head-action" onclick="PowerFund.exportRoundCsv(${r})">Export round CSV</button>`
              : ""
          }
        </div>`;
        detailHtml += bodyHtml;
      }
    } else {
      html += headerHtml + bodyHtml + `</div>`;
    }
  }

  // ---- Payout history: released payouts, recipient/amount as recorded ----
  if (isWide) {
    html += `<div class="rounds-split">
      <div class="rounds-list">${listHtml}</div>
      <div class="rounds-detail">${
        detailHtml ||
        `<p class="rounds-detail-empty">Pick a round to see its cycles.</p>`
      }</div>
    </div>`;
  }

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
