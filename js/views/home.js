/* ---------------------------------------------------------------------------
 * View: home
 *
 * The landing view: what needs doing, the money, and this round.
 *
 * Returns an HTML string; it never touches the DOM and never writes. Everything
 * it needs arrives on `ctx`, rebuilt by render() each pass, so a view is a pure
 * function of the state at that moment.
 * ------------------------------------------------------------------------- */
window.PFViews = window.PFViews || {};

window.PFViews.home = function (ctx) {
  const {
    members, rounds, allDone, curRound, curStatus, curCollected,
    heroRecipient, pct, prevPendingRounds, canStartNext, pendingCount,
    overdueCount, remainingToGo, payCycle, payCycleDue, cyclePaidCount,
    myMember, myStatus, ROUND_PILL, state, unlocked, busy,
    attentionQueueExpanded, overdueListOpen, startRoundConfirming,
    escapeHtml, inlineArg, icon, batteryCell, C
  } = ctx;
  let html = "";


  // ---- My status: personalized, only shown once a member has set "who
  // am I on this device" — never forced, never gates anything. ----------
  html += (function () {
    if (myMember && myStatus) {
      return `<div class="my-status-card my-status-${myStatus.kind}">
        <div class="my-status-row">
          <span class="my-status-text"><span class="status-dot"></span><b>${escapeHtml(
            myMember.name
          )}</b> — ${myStatus.label}</span>
          <button type="button" class="my-status-change" onclick="PowerFund.openWhoAmIPicker()">Not you?</button>
        </div>
        ${
          myStatus.actionCycle
            ? `<button type="button" class="my-status-cta" onclick="PowerFund.openContributeModal('${inlineArg(
                myMember.id
              )}', ${myStatus.actionCycle})">＋ Record my payment — ${C.peso(
                C.CONTRIBUTION_AMOUNT
              )}</button>`
            : ""
        }
      </div>`;
    }
    return `<button type="button" class="my-status-setup" onclick="PowerFund.openWhoAmIPicker()">👋 Which member are you? Tap to see your personal status.</button>`;
  })();

  // The old standalone due-countdown banner was removed — the same date is
  // always visible a little further down, either on the My-status card
  // (once a member is identified) or on the round card's own
  // "<date> · N/5 paid this cycle" line and the matching accordion row.

  // ---- Overall fund balance (whole fund, confirmed money only) ------
  // Built here but appended AFTER the treasurer's "Needs your attention"
  // panel below, so a treasurer sees what needs action before a passive
  // stat — see fundTotalHtml usage after that panel.
  const fundTotalHtml = (function () {
    const collected = C.totalCollected(state.contributions);
    const remaining = C.remainingAmount(state.contributions);
    const overallPct = Math.round(C.progressPercentOverall(state.contributions));
    const pendingPesos = C.pendingTotal(state.contributions);
    return `<div class="fund-total">
      <p class="fund-total-label">Fund balance</p>
      <div class="fund-total-amount">${C.peso(collected)} <span>/ ${C.peso(
      C.TARGET_AMOUNT
    )}</span></div>
      <div class="fund-total-bar"><div class="fund-total-fill" style="width:${Math.min(
        100,
        Math.max(0, overallPct)
      )}%"></div></div>
      <div class="fund-total-meta">${
        C.allRoundsComplete(state.contributions, rounds)
          ? "Fund complete"
          : `${overallPct}% collected · <b>${C.peso(remaining)}</b> to go`
      }${
      pendingPesos > 0
        ? ` <span class="fund-total-pending">+ ${C.peso(
            pendingPesos
          )} awaiting review</span>`
        : ""
    }</div>
    </div>`;
  })();

  // ---- Treasurer action center: "Needs your attention" --------------
  // Only actionable items. Hidden entirely when there is nothing to do.
  if (unlocked && !allDone) {
    const batches = C.pendingBatches(state.contributions);
    const releaseRounds = [];
    for (let r = 1; r <= C.TOTAL_ROUNDS; r++) {
      if (C.roundStatus(state.contributions, rounds, r) === "payout_pending") {
        releaseRounds.push(r);
      }
    }
    const nextRound = curRound + 1;

    if (!(batches.length || releaseRounds.length || canStartNext || overdueCount)) {
      // Nothing waiting. Say so explicitly — an absent panel is ambiguous
      // (is it clear, or did it fail to load?), and a caught-up queue is
      // the normal state most days.
      html += `<div class="attention-panel caught-up">
        <p class="attention-title">${icon("check", 15)}<span>All caught up</span></p>
        <p class="attention-caught-up-note">No payments waiting for review, nothing overdue, and no payout to release right now.</p>
      </div>`;
    } else {
      html += `<div class="attention-panel">
        <p class="attention-title">${icon("alert", 15)}<span>Needs your attention</span></p>`;

      // 1) pending review queue
      if (batches.length) {
        const shown = attentionQueueExpanded ? batches : batches.slice(0, 6);
        html += `<div class="attention-group">
          <p class="attention-group-label">${icon("bell", 14)}<span>${
            batches.length === 1
              ? "1 payment"
              : batches.length + " payments"
          } waiting for your review</span></p>
          <div class="queue-list">
            ${shown
              .map((b) => {
                const m = state.members.find((x) => x.id === b.memberId);
                const name = m ? m.name : "—";
                const multi = b.cycles.length > 1;
                const firstDue = C.dueDateOf(state.cycles, b.cycles[0]);
                const lastDue = C.dueDateOf(
                  state.cycles,
                  b.cycles[b.cycles.length - 1]
                );
                const range = multi
                  ? `${firstDue ? C.formatDate(firstDue) : "Cycle " + b.cycles[0]} – ${
                      lastDue
                        ? C.formatDate(lastDue)
                        : "Cycle " + b.cycles[b.cycles.length - 1]
                    }`
                  : `${firstDue ? C.formatDate(firstDue) : "Cycle " + b.cycles[0]}`;
                return `<div class="queue-card">
                  <div class="queue-card-info">
                    <div class="queue-card-l1"><b>${escapeHtml(name)}</b> · ${escapeHtml(
                  range
                )}${
                  multi
                    ? ` <span class="queue-badge">${b.cycles.length} cycles</span>`
                    : ""
                }</div>
                    <div class="queue-card-l2">${C.peso(b.amount)} · submitted ${
                  b.submittedAt ? formatDateTime(b.submittedAt) : "—"
                }</div>
                  </div>
                  <div class="queue-card-actions">
                    ${
                      b.proofUrl
                        ? `<button type="button" class="queue-thumb" onclick="PowerFund.openLightbox('${inlineArg(
                            b.proofUrl
                          )}')" aria-label="View ${escapeHtml(
                            name
                          )}'s payment screenshot larger"><img src="${escapeHtml(
                            b.proofUrl
                          )}" alt="Payment screenshot"></button>`
                        : `<span class="queue-thumb queue-thumb-empty">no&nbsp;proof</span>`
                    }
                    <button type="button" class="queue-btn queue-btn-review" onclick="PowerFund.openReviewModal('${inlineArg(
                      b.memberId
                    )}', ${b.cycles[0]})">Review</button>
                    <button type="button" class="queue-btn queue-btn-confirm" onclick="PowerFund.confirmBatch('${inlineArg(
                      b.memberId
                    )}', ${b.cycles[0]})" ${busy ? "disabled" : ""}>${
                  multi ? `Confirm ${b.cycles.length}` : "Confirm"
                }</button>
                  </div>
                </div>`;
              })
              .join("")}
          </div>
          ${
            batches.length > shown.length
              ? `<button type="button" class="attention-more" onclick="PowerFund.expandAttentionQueue()">Show ${
                  batches.length - shown.length
                } more</button>`
              : ""
          }
        </div>`;
      }

      // 2) payout(s) ready to release
      releaseRounds.forEach((r) => {
        const recip = members.find((m) => m.member_order === r);
        html += `<div class="attention-group">
          <p class="attention-group-label"><span class="round-dot pending"></span>Round ${r}${
          recip ? " — " + escapeHtml(recip.name) : ""
        } is funded — release the ${C.peso(C.GOAL_PER_ROUND)} payout</p>
          <button class="contribute-btn payout-btn" onclick="PowerFund.openPayoutModal(${r})">Mark payout released</button>
        </div>`;
      });

      // 3) start the next round
      if (canStartNext) {
        html += `<div class="attention-group">
          ${
            startRoundConfirming
              ? `<p class="attention-group-label">Start Round ${nextRound}? Round ${curRound}'s payout stays pending until you release it.</p>
                 <div class="start-round-confirm-btns">
                   <button class="modal-btn-secondary" onclick="PowerFund.cancelStartRound()">Cancel</button>
                   <button class="modal-btn-primary" onclick="PowerFund.confirmStartRound()" ${
                     busy ? "disabled" : ""
                   }>Start Round ${nextRound}</button>
                 </div>`
              : `<p class="attention-group-label">▶ Round ${nextRound} is ready to start</p>
                 <button class="contribute-btn" onclick="PowerFund.askStartNextRound()">Start Round ${nextRound}</button>`
          }
        </div>`;
      }

      // 4) overdue contributions (nudge — not a treasurer action per se)
      if (overdueCount) {
        const rows = overdueListOpen ? overdueRows() : null;
        html += `<div class="attention-group">
          <p class="attention-group-label">⏰ ${overdueCount} contribution${
          overdueCount === 1 ? "" : "s"
        } overdue</p>
          <button type="button" class="attention-more" onclick="PowerFund.toggleOverdueList()">${
            overdueListOpen ? "Hide" : "Show"
          } overdue</button>
          ${
            rows
              ? `<div class="overdue-list">${rows
                  .map(
                    (o) =>
                      `<div class="overdue-row"><span>${escapeHtml(
                        o.name
                      )}</span><span>${
                        o.due ? C.formatDate(o.due) : "Cycle " + o.cycle
                      }</span></div>`
                  )
                  .join("")}</div>`
              : ""
          }
        </div>`;
      }

      html += `</div>`;
    }
  }

  // Fund balance renders here — after "Needs your attention" for a
  // treasurer, and simply here (there's nothing before it) for a member.
  html += fundTotalHtml;

  // ---- Current round hero: round → money → to-go → who paid → CTA ----
  html += `<div class="battery-hero ${allDone ? "fund-complete" : ""}">
    <div class="hero-round-line">
      ${
        allDone
          ? `<span class="hero-round-num">${icon(
              "party",
              17
            )}<span>Fund complete — all ${C.TOTAL_ROUNDS} rounds paid out</span></span>`
          : `<span class="hero-round-num">Round ${curRound} of ${C.TOTAL_ROUNDS}${
              heroRecipient ? ` — ${escapeHtml(heroRecipient.name)}` : ""
            }</span> ${ROUND_PILL[curStatus]}`
      }
    </div>
    <div class="battery-amount">${
      allDone
        ? `${C.peso(C.TARGET_AMOUNT)} <span>/ ${C.peso(C.TARGET_AMOUNT)}</span>`
        : `${C.peso(curCollected)} <span>/ ${C.peso(C.GOAL_PER_ROUND)}</span>`
    }</div>
    <div class="hero-gauge" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(
      pct
    )}" aria-label="Round ${
    allDone ? C.TOTAL_ROUNDS : curRound
  } funding progress">
      <div class="hero-batt">
        ${batteryCell(pct, 96)}
        <div class="hero-batt-label ${
          pct >= 55 ? "on-fill" : ""
        }">
          <span class="hero-batt-pct">${Math.round(pct)}%</span>
          <span class="hero-batt-cap">funded</span>
        </div>
      </div>
      <div class="hero-gauge-meta">${
        allDone
          ? "<b>Fund fully funded</b>"
          : `<b>${C.peso(remainingToGo)}</b> still to collect this round`
      }</div>
    </div>
    ${
      pendingCount || overdueCount
        ? `<div class="cycle-note">${
            pendingCount
              ? `<b style="color:var(--accent)">${pendingCount} pending treasurer review</b>`
              : ""
          }${pendingCount && overdueCount ? " · " : ""}${
            overdueCount
              ? `<b style="color:#E15353">${overdueCount} overdue</b>`
              : ""
          }</div>`
        : ""
    }
    ${
      payCycle
        ? `<div class="cycle-status">
             <div class="cycle-status-head">${
               payCycleDue ? C.formatDate(payCycleDue) : `Cycle ${payCycle}`
             } · <b>${cyclePaidCount} / ${members.length} paid</b> this cycle</div>
             <div class="cycle-status-chips">
               ${members
                 .map((m) => {
                   const s = C.statusOf(state.contributions, m.id, payCycle);
                   const cls = s === 2 ? "paid" : s === 1 ? "pending" : "unpaid";
                   // No icon for "not paid yet" — a plain unpaid chip on a
                   // freshly-opened cycle isn't an error, so it shouldn't
                   // read like one (matches the Rounds & cycles grid below,
                   // which also shows no icon for a not-yet-due unpaid cycle).
                   const mark = s === 2 ? "✓" : s === 1 ? "…" : "";
                   const word =
                     s === 2
                       ? "paid"
                       : s === 1
                       ? "sent, awaiting review"
                       : "not paid";
                   // Same rule as the Rounds & cycles grid: treasurer can act
                   // on any chip, members only on their own unpaid one.
                   const clickable = unlocked || s === 0;
                   const action = !clickable
                     ? ""
                     : unlocked
                     ? s === 1
                       ? " — tap to review"
                       : s === 2
                       ? " — tap to mark unpaid"
                       : " — tap to record as paid"
                     : " — tap to record your payment";
                   const treasurerTap = unlocked && s !== 0;
                   return `<button type="button" class="mini-chip ${cls} ${
                     treasurerTap ? "treasurer-tap" : ""
                   }" ${
                     clickable ? "" : "disabled"
                   } onclick="PowerFund.cellClicked('${m.id}', ${payCycle})" aria-label="${escapeHtml(
                     m.name
                   )}: ${word}${action}">${mark ? mark + " " : ""}${escapeHtml(m.name)}</button>`;
                 })
                 .join("")}
             </div>
           </div>`
        : ""
    }
    ${
      // Skip this generic "pick your name" CTA when the My-status card
      // above already offers the exact same action for the exact same
      // cycle (one tap, no picker) — showing both is two buttons that do
      // the same thing. Still shown when unlocked (treasurer needs the
      // picker to act on ANY member) or when this device isn't tied to a
      // member yet, so a shared device can still be used by anyone.
      payCycle &&
      (unlocked || cyclePaidCount < members.length) &&
      !(!unlocked && myMember && myStatus && myStatus.actionCycle)
        ? `<button type="button" class="hero-cta" onclick="PowerFund.openContributePicker(${payCycle})">${
            unlocked ? "＋ Record / review a payment" : "＋ Record a contribution"
          }</button>`
        : ""
    }
    <button class="share-btn" onclick="PowerFund.openShareModal()">📋 Copy status update</button>
  </div>`;

  // Previous round(s) whose payout hasn't been released — shown AFTER the
  // current round and styled as history, so last round's ₱30,000 is never
  // mistaken for the active round's progress. The release action lives in the
  // treasurer "Needs your attention" panel above; this card is informational.
  prevPendingRounds.forEach((r) => {
    const collected = C.roundCollected(state.contributions, r);
    const recip = members.find((m) => m.member_order === r);
    html += `<div class="prev-round">
      <div class="prev-round-label">Previous round</div>
      <div class="prev-round-title">Round ${r}${
      recip ? ` — ${escapeHtml(recip.name)}` : ""
    } ${ROUND_PILL[C.roundStatus(state.contributions, rounds, r)]}</div>
      <div class="prev-round-meta">${C.peso(collected)} / ${C.peso(
      C.GOAL_PER_ROUND
    )} · historical, not part of Round ${curRound}</div>
    </div>`;
  });

  return html;
};
