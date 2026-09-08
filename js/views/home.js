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
    escapeHtml, inlineArg, icon, batteryCell, memberAvatar, memberStanding,
    sparkline, C,
    formatDateTime, overdueRows, activityTimeLabel, isWide
  } = ctx;
  // Cycles due so far — the denominator behind each member's standing ring.
  const cyclesDueSoFar = C.completedCyclesCount(state.cycles);
  // Set when the pinned action renders, so the view can reserve room for it.
  let hasFloatingCta = false;
  let html = "";

  /*
   * Home is the one view whose two shells differ in COMPOSITION, not just in
   * width: mobile is a single column read top to bottom, desktop is a dashboard
   * with a main column and a right rail (see canvas.json's desktop-notes).
   *
   * Rather than write the markup twice, each block is built once and captured
   * into S as it goes; the two shells then assemble the same pieces in their
   * own order at the bottom of this file. `section()` returns whatever has been
   * appended since the last call, so the blocks below stay exactly as they read
   * in source order.
   */
  const S = {};
  let taken = 0;
  const section = () => {
    const out = html.slice(taken);
    taken = html.length;
    return out;
  };


  // ---- Day one: the fund exists but nothing has happened yet ----------
  // Without this the screen reads as "0%" everywhere with no explanation,
  // which looks like a fault rather than a fund that simply hasn't started.
  const collectedSoFar = C.totalCollected(state.contributions);
  const nothingYet =
    collectedSoFar === 0 && C.pendingCount(state.contributions) === 0 && curRound === 1;
  if (nothingYet && !allDone) {
    html += `<div class="dayone-card">
      <p class="dayone-title">${icon("party", 16)}<span>Your fund just started</span></p>
      <p class="dayone-note">Round 1 is open — nothing collected yet. Payments show up here as they come in.</p>
    </div>`;
  }
  S.dayOne = section();

  // ---- Rejected payment: the one thing that needs acting on -----------
  // Sits above the status card because it is the only state where the member
  // has to do something and would otherwise never learn why their payment
  // vanished. Needs migration 006 — before that no row can be rejected, so
  // latestRejection() returns null and nothing renders.
  const myRejection =
    myMember && C.latestRejection ? C.latestRejection(state.contributions, myMember.id) : null;
  if (myRejection) {
    const cyc = myRejection.cycles;
    const cycLabel =
      cyc.length > 1 ? `Cycles ${cyc[0]}–${cyc[cyc.length - 1]}` : `Cycle ${cyc[0]}`;
    html += `<div class="rejected-card" role="alert">
      <div class="rejected-head">
        ${icon("alert", 16)}
        <span class="rejected-title">Your proof for ${cycLabel} wasn't accepted</span>
      </div>
      ${
        myRejection.note
          ? `<div class="rejected-note">
               <span class="rejected-note-label">Treasurer's note</span>
               <p class="rejected-note-text">${escapeHtml(myRejection.note)}</p>
             </div>`
          : ""
      }
      <p class="rejected-hint">${
        cyc.length > 1 ? "These cycles are" : "This cycle is"
      } still due. Send the payment again and attach a clearer screenshot.</p>
      <button type="button" class="rejected-cta" onclick="PowerFund.openContributeModal('${inlineArg(
        myMember.id
      )}', ${cyc[0]})">${icon("upload", 15)}<span>Resubmit payment</span></button>
    </div>`;
  }

  S.rejected = section();

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

  S.myStatus = section();

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

      // Payouts ready to release are NOT part of this panel — they are built
      // separately below and rendered above it. See the release-card note.

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

  S.attention = section();

  /*
   * Payout ready to release — its own card, ABOVE "Needs your attention".
   *
   * The design settles the stacking order explicitly: a funded round means a
   * real person is waiting on money that is ready to send, while a pending
   * review can sit a little longer without costing anyone anything. So this
   * outranks the review queue rather than sitting as one more group inside it.
   */
  if (unlocked && !allDone) {
    for (let r = 1; r <= C.TOTAL_ROUNDS; r++) {
      if (C.roundStatus(state.contributions, rounds, r) !== "payout_pending") continue;
      const recip = members.find((m) => m.member_order === r);
      html += `<div class="release-card">
        <p class="release-card-title">${icon("party", 16)}<span>Round ${r}${
        recip ? ` — ${escapeHtml(recip.name)}` : ""
      } is funded</span></p>
        <p class="release-card-note">${C.peso(
          C.GOAL_PER_ROUND
        )} collected and ready to send${
        recip ? ` to ${escapeHtml(recip.name)}` : ""
      }.</p>
        <button class="contribute-btn payout-btn" onclick="PowerFund.openPayoutModal(${r})">Release payout</button>
      </div>`;
    }
  }
  S.release = section();

  // Fund balance renders here — after "Needs your attention" for a
  // treasurer, and simply here (there's nothing before it) for a member.
  html += fundTotalHtml;

  S.fundTotal = section();

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
      ${
        sparkline(state.contributions, C) ||
        `<div class="hero-spark hero-spark-empty">
           <div class="hero-spark-label">Fund growth</div>
           <p class="hero-spark-note">Shows up once contributions come in.</p>
         </div>`
      }
    </div>
    <div class="hero-gauge-meta">${
      allDone
        ? "<b>Fund fully funded</b>"
        : `<b>${C.peso(remainingToGo)}</b> still to collect this round`
    }</div>
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
    <button class="share-btn" onclick="PowerFund.openShareModal()">${icon(
      "sheet",
      14
    )}<span>Copy status update</span></button>
  </div>`;

  S.hero = section();

  // Skip this generic "pick your name" action when the My-status card above
  // already offers the same one for the same cycle — two buttons doing one
  // thing. Still shown when unlocked (a treasurer acts on ANY member) or when
  // this device isn't tied to a member yet, so a shared phone still works.
  hasFloatingCta =
    payCycle &&
    (unlocked || cyclePaidCount < members.length) &&
    !(!unlocked && myMember && myStatus && myStatus.actionCycle);
  if (hasFloatingCta) {
    html += `<div class="floating-cta"><button type="button" class="hero-cta" onclick="PowerFund.openContributePicker(${payCycle})">${
      unlocked ? "＋ Record / review a payment" : "＋ Record a contribution"
    }</button></div>`;
  }

  S.cta = section();

  // ---- Roster strip: the whole group at a glance, without leaving Home.
  // The Members tab is the full detail; this is the "who still owes" glance
  // a treasurer wants while looking at the round.
  html += `<div class="roster-strip-wrap">
    <div class="roster-strip-head">
      <span class="roster-strip-title">Members</span>
      <button type="button" class="roster-strip-all" onclick="PowerFund.setView('members')">See all ${icon(
        "chevron",
        13
      )}</button>
    </div>
    <div class="roster-strip">
      ${members
        .map((m) => {
          const paidOut = C.roundStatus(state.contributions, rounds, m.member_order) === "completed";
          const standing = memberStanding(m.id, cyclesDueSoFar, paidOut);
          const cycleStatus = payCycle
            ? C.statusOf(state.contributions, m.id, payCycle)
            : null;
          const mark =
            cycleStatus === 2 ? "check" : cycleStatus === 1 ? "clock" : null;
          return `<button type="button" class="roster-chip" onclick="PowerFund.setView('members')" aria-label="${escapeHtml(
            m.name
          )} — ${standing.replace("-", " ")}">
            <span class="roster-avatar-wrap">
              ${memberAvatar(m.name, standing, 52)}
              <span class="roster-order">${m.member_order}</span>
            </span>
            <span class="roster-name">${
              mark ? `<span class="roster-mark ${mark}">${icon(mark, 10)}</span>` : ""
            }${escapeHtml(m.name)}</span>
          </button>`;
        })
        .join("")}
    </div>
  </div>`;

  S.roster = section();

  // ---- Compact link out to the Rounds screen, mirroring the design: Home
  // summarises the round, Rounds is where you work through it.
  html += `<button type="button" class="rounds-link" onclick="PowerFund.setView('rounds')">
    <span class="rounds-link-main">
      <span class="rounds-link-title">Round ${allDone ? C.TOTAL_ROUNDS : curRound}</span>
      ${allDone ? "" : ROUND_PILL[curStatus]}
      <span class="rounds-link-meta">${C.peso(curCollected)} / ${C.peso(
    C.GOAL_PER_ROUND
  )}</span>
    </span>
    ${icon("chevron", 15)}
  </button>`;

  S.roundsLink = section();

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

  S.prevRounds = section();

  if (hasFloatingCta) html += `<div class="cta-spacer" aria-hidden="true"></div>`;
  S.spacer = section();

  /* =====================================================================
   * Mobile: one column, read top to bottom. This is the order every mobile
   * artboard shows, and the order the app already shipped.
   * ===================================================================== */
  if (!isWide) {
    return (
      S.dayOne + S.rejected + S.myStatus + S.release + S.attention + S.fundTotal +
      S.hero + S.cta + S.roster + S.roundsLink + S.prevRounds + S.spacer
    );
  }

  /* =====================================================================
   * Desktop: a dashboard, not the same column made wider.
   *
   * "hero + roster + recent activity on the left, a right rail for 'Needs
   * your attention' / personal status, a 5-round progress strip, and quick
   * actions, all visible at once" — canvas.json, desktop-notes.
   *
   * Everything below reuses the sections built above; only the three panels
   * that exist solely on this shell are built here.
   * ===================================================================== */

  // Greeting — the design leads with the person, then the fund's position.
  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const greeting = `<div class="home-greet">
    <div>
      <h2 class="home-greet-title">${partOfDay}${
    myMember ? `, ${escapeHtml(myMember.name)}` : ""
  }</h2>
      <p class="home-greet-sub">Group of ${members.length} · ${
    allDone ? "Fund complete" : `Round ${curRound} of ${C.TOTAL_ROUNDS}`
  }</p>
    </div>
    ${
      payCycle
        ? `<button type="button" class="home-greet-cta" onclick="PowerFund.openContributePicker(${payCycle})">${icon(
            "plus",
            15
          )}<span>${unlocked ? "Record contribution" : "Pay this cycle"}</span></button>`
        : ""
    }
  </div>`;

  // Recent activity — the three latest entries, with "View all" into the tab.
  // Mobile has no equivalent: there the Activity tab is one tap away and the
  // column is too narrow to spend on a preview.
  const recent = (state.activityLog || []).slice(0, 3);
  const recentPanel = `<div class="home-panel">
    <div class="home-panel-head">
      <span class="home-panel-title">Recent activity</span>
      <button type="button" class="home-panel-all" onclick="PowerFund.setView('activity')">View all ${icon(
        "chevron",
        13
      )}</button>
    </div>
    ${
      recent.length
        ? `<div class="home-recent">${recent
            .map(
              (e) => `<div class="home-recent-row">
                 <span class="home-recent-text">${escapeHtml(e.message)}</span>
                 <span class="home-recent-time">${escapeHtml(
                   activityTimeLabel(e.created_at)
                 )}</span>
               </div>`
            )
            .join("")}</div>`
        : `<p class="home-panel-empty">Nothing yet — actions show up here as the group uses the tracker.</p>`
    }
  </div>`;

  // Five-round progress strip: where the whole fund stands, at a glance.
  const overview = `<div class="home-panel">
    <div class="home-panel-head">
      <span class="home-panel-title">Rounds overview</span>
      <button type="button" class="home-panel-all" onclick="PowerFund.setView('rounds')">Open ${icon(
        "chevron",
        13
      )}</button>
    </div>
    <div class="home-rounds-strip">
      ${Array.from({ length: C.TOTAL_ROUNDS }, (_, i) => {
        const r = i + 1;
        const st = C.roundStatus(state.contributions, rounds, r);
        const amt = C.roundCollected(state.contributions, r);
        const p = Math.min(100, (amt / C.GOAL_PER_ROUND) * 100);
        const recip = members.find((m) => m.member_order === r);
        return `<div class="home-round-cell ${st}" title="Round ${r}${
          recip ? " — " + escapeHtml(recip.name) : ""
        }: ${C.peso(amt)} of ${C.peso(C.GOAL_PER_ROUND)}">
          <div class="home-round-bar"><div class="home-round-fill" style="height:${p}%"></div></div>
          <span class="home-round-label">R${r}</span>
        </div>`;
      }).join("")}
    </div>
  </div>`;

  // Quick actions — the two the design puts here. Export is treasurer-only
  // because that is how the Menu gates it; share is open to everyone.
  const quick = `<div class="home-panel">
    <div class="home-panel-head"><span class="home-panel-title">Quick actions</span></div>
    <div class="home-quick">
      ${
        unlocked
          ? `<button type="button" class="home-quick-btn" onclick="PowerFund.exportCsv()">${icon(
              "sheet",
              15
            )}<span>Export CSV summary</span></button>`
          : ""
      }
      <button type="button" class="home-quick-btn" onclick="PowerFund.openShareModal()">${icon(
        "share",
        15
      )}<span>Share fund status</span></button>
    </div>
  </div>`;

  return (
    S.dayOne +
    greeting +
    `<div class="home-grid">
      <div class="home-main">
        ${S.fundTotal}${S.hero}${S.roster}${S.roundsLink}${recentPanel}${S.prevRounds}
      </div>
      <aside class="home-rail">
        ${S.rejected}${S.myStatus}${S.release}${S.attention}${overview}${quick}
      </aside>
    </div>` +
    S.cta +
    S.spacer
  );
};
