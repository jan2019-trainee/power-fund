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
    myMember, myStatus, ROUND_PILL, ROUND_PILL_WORD, state, unlocked, busy,
    attentionQueueExpanded, overdueListOpen, startRoundConfirming,
    escapeHtml, inlineArg, icon, batteryCell, memberAvatar, getPayout,
    sparkline, C,
    formatDateTime, overdueRows, activityTimeLabel, isWide, identityLocked,
    payoutOwner, pesoWhole
  } = ctx;
  // Cycles due so far — the denominator behind each member's standing ring.
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
    // MainMemberRejected draws ONE red card, not two: the identity line the
    // status card would carry lives in this card's head, and the status card
    // is suppressed below. Two stacked red cards saying the same thing made
    // the screen read like two separate failures.
    html += `<div class="rejected-card" role="alert">
      <div class="rejected-ident">
        <span class="rejected-who">${escapeHtml(myMember.name)} · <b>Rejected</b></span>
        ${
          identityLocked
            ? ""
            : `<button type="button" class="my-status-change" onclick="PowerFund.openWhoAmIPicker()">Change</button>`
        }
      </div>
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
    </div>`;
  }

  S.rejected = section();

  // ---- My status: personalized, only shown once a member has set "who
  // am I on this device" — never forced, never gates anything. ----------
  html += (function () {
    // Already said, in red, directly above — see the rejected card.
    if (myRejection && myMember) return "";
    if (myMember && myStatus) {
      // The mockup's shape: a tinted icon tile, the name and status word on
      // one line with the detail beneath, and "Change" to the right. Compact —
      // the old card stacked a long single sentence over a full-width button,
      // which made the most common state (nothing to do) the tallest thing on
      // the screen.
      const optional = myStatus.kind === "paid";
      return `<div class="my-status-card my-status-${myStatus.kind}">
        <div class="my-status-row">
          ${
            myStatus.mark
              ? `<span class="my-status-icon">${icon(myStatus.mark, 16)}</span>`
              : ""
          }
          <span class="my-status-text">
            <span class="my-status-line">${escapeHtml(myMember.name)} · <b>${escapeHtml(
              myStatus.word || myStatus.label
            )}</b></span>
            ${
              myStatus.detail
                ? `<span class="my-status-detail">${escapeHtml(myStatus.detail)}</span>`
                : ""
            }
          </span>
          ${
            identityLocked
              ? ""
              : `<button type="button" class="my-status-change" onclick="PowerFund.openWhoAmIPicker()">Change</button>`
          }
        </div>
        ${
          // Suppressed while a rejection is showing: the rejected card directly
          // above already offers "Resubmit payment" for the same member and the
          // same cycle. Two buttons in two colours doing one job, on the one
          // screen where the member is already asking why their money vanished.
          myStatus.actionCycle && !myRejection
            ? `<button type="button" class="my-status-cta${
                optional ? " optional" : ""
              }" onclick="PowerFund.openContributeModal('${inlineArg(
                myMember.id
              )}', ${myStatus.actionCycle})">${icon("plus", 14)}<span>${
                optional ? "Pay ahead" : "Record my payment"
              } — ${C.peso(C.CONTRIBUTION_AMOUNT)}</span></button>`
            : ""
        }
      </div>`;
    }
    return `<button type="button" class="my-status-setup" onclick="PowerFund.openWhoAmIPicker()">👋 Which member are you? Tap to see your personal status.</button>`;
  })();

  S.myStatus = section();

  /* ---- "Add your payout QR" -------------------------------------------
   * The member-side half of a reminder the design only built one end of.
   * PayoutReleaseNoQR gives the TREASURER a "Copy reminder message" to paste
   * into the group chat when a recipient has no QR on file — which is the
   * fallback for a nudge that never happened. This is the nudge: tell the
   * member themselves, in the app, before their round lands.
   *
   * Shown only when it is actually theirs to act on and actually soon:
   *   - a LINKED account (the who-am-I preference cannot be trusted with
   *     where money goes, so a nudge keyed off it would point at a sheet
   *     that refuses to open),
   *   - nothing on file at all,
   *   - and their round is the one collecting now, or the next one up.
   * Any earlier and it is noise for four rounds; any later and the payout has
   * already been released.
   */
  if (payoutOwner) {
    const nothingOnFile =
      !payoutOwner.payout_qr_url &&
      !payoutOwner.payout_bank &&
      !payoutOwner.payout_account_number;
    const mine = payoutOwner.member_order;
    const cur = C.currentRound(state.contributions, rounds);
    const released = getPayout(mine).released;
    if (nothingOnFile && !released && mine <= cur + 1) {
      html += `<button type="button" class="payout-nudge" onclick="PowerFund.openPayoutQrModal()">
        <span class="payout-nudge-mark">${icon("qr", 17)}</span>
        <span class="payout-nudge-lines">
          <span class="payout-nudge-title">${
            mine === cur
              ? "Add your payout QR — your round is collecting now"
              : "Add your payout QR before Round " + mine
          }</span>
          <span class="payout-nudge-note">The treasurer sends your ${pesoWhole(
            C.GOAL_PER_ROUND
          )} to whatever you save here. Nothing is on file yet.</span>
        </span>
        <span class="payout-nudge-go">›</span>
      </button>`;
    }
  }
  // section() slices whatever was appended since the last call, so it must be
  // called unconditionally — skipping it would hand the next section this
  // block's markup.
  S.payoutNudge = section();

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
    // Scope has to be on the label. The hero directly below shows the CURRENT
    // ROUND's progress, and the design carries only that one hero — two
    // unlabelled progress bars reading 20% and 0% within a single scroll look
    // like a fault rather than two questions. Demoted to a strip in CSS so the
    // hero stays the primary answer; the lifetime total is worth keeping, just
    // not worth competing.
    return `<div class="fund-total">
      <p class="fund-total-label">Whole fund · all ${C.TOTAL_ROUNDS} rounds</p>
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

  // Rounds whose payout is funded and unreleased. Computed once, up here,
  // because BOTH the attention panel (which must not claim "all caught up"
  // over one) and the release card below it need the answer — and the panel
  // renders first.
  const releaseReady = [];
  if (unlocked && !allDone) {
    for (let r = 1; r <= C.TOTAL_ROUNDS; r++) {
      if (C.roundStatus(state.contributions, rounds, r) === "payout_pending") {
        releaseReady.push(r);
      }
    }
  }

  // ---- Fund complete: the terminal state, for everyone --------------
  // Every fund reaches this and the screen used to just fall silent — the
  // attention panel and the release card are both gated on !allDone, and the
  // CTA needs a payCycle that no longer exists. Say it is finished.
  if (allDone) {
    html += `<div class="attention-panel caught-up fund-complete-panel">
      <p class="attention-title">${icon("check", 15)}<span>Fund complete</span></p>
      <p class="attention-caught-up-note">All ${C.TOTAL_ROUNDS} rounds collected and paid out — ${C.peso(
      C.TARGET_AMOUNT
    )} in total. Nothing is outstanding.</p>
      ${
        // DesktopHomeMemberFundComplete closes the fund with the viewer's own
        // result — what they received, and how they paid in. Every figure here
        // is read back from the record, not assumed from the fund's shape: a
        // payout can be released for an amount other than the goal, and
        // on-time only counts contributions that carry a paid_at.
        myMember
          ? (function () {
              const mine = getPayout(myMember.member_order);
              const amount =
                mine && mine.amount != null ? mine.amount : C.GOAL_PER_ROUND;
              const st = C.onTimeStats(state.contributions, state.cycles, myMember.id);
              const paidLine =
                st.counted === 0
                  ? "Your contributions are all settled."
                  : st.onTime === st.counted
                  ? `You made all ${st.counted} of your dated contributions on time.`
                  : `You paid ${st.onTime} of ${st.counted} dated contributions on time.`;
              return `<p class="fund-complete-personal">You received <b>${C.peso(
                amount
              )}</b> in Round ${myMember.member_order}. ${escapeHtml(paidLine)}</p>`;
            })()
          : ""
      }
    </div>`;
  }
  S.complete = section();

  // ---- Treasurer action center: "Needs your attention" --------------
  // Only actionable items. Hidden entirely when there is nothing to do.
  if (unlocked && !allDone) {
    const batches = C.pendingBatches(state.contributions);
    const nextRound = curRound + 1;

    // What this panel can actually SHOW. Payouts ready to release are
    // deliberately not part of it — they render as their own card above (see
    // the release-card note) — so counting them here produced a panel with a
    // heading and nothing under it whenever a ready payout was the only
    // outstanding thing. An empty "Needs your attention" is worse than none:
    // it says something is wrong and then declines to say what.
    const nothingWaiting = !(batches.length || canStartNext || overdueCount);
    if (nothingWaiting && releaseReady.length) {
      // A payout is sitting there ready to send. "All caught up" immediately
      // under that card would contradict it, so the release card speaks for
      // itself and this panel stays out of the way.
    } else if (nothingWaiting) {
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
        // The design's panel is a POINTER into the queue, not the queue itself:
        // a title, one summary line and a count. Rendering every card here
        // buried the hero, roster and round link below the fold on the screen
        // the treasurer opens most — mid-round with five members that is the
        // normal state, not an edge case. Collapsed by default; the cards are
        // one tap away.
        const shown = attentionQueueExpanded ? batches : [];
        const waiting =
          batches.length === 1 ? "1 payment" : batches.length + " payments";
        html += `<div class="attention-group">
          <p class="attention-group-label">${icon("bell", 14)}<span>${
            waiting
          } waiting for your review</span><span class="attention-count">${
            batches.length
          }</span></p>
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
                    )}', ${b.cycles[0]})">${
                  multi ? `Review ${b.cycles.length}` : "Review"
                }</button>
                  </div>
                </div>`;
              })
              .join("")}
          </div>
          <button type="button" class="attention-more" onclick="PowerFund.expandAttentionQueue()" aria-expanded="${
            attentionQueueExpanded ? "true" : "false"
          }">${
            attentionQueueExpanded ? "Hide the queue" : `Review ${waiting} →`
          }</button>
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
    for (const r of releaseReady) {
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
        // One pill carrying round, position and state — "ROUND 2 OF 5 ·
        // COLLECTING" — instead of a heading plus a separate status chip. The
        // recipient moves to the footer line below; it is useful but it is not
        // the headline, and on a phone it pushed the state chip onto its own
        // row.
        allDone
          ? `<span class="hero-round-pill completed">${icon(
              "party",
              13
            )}<span>Fund complete · all ${C.TOTAL_ROUNDS} rounds paid out</span></span>`
          : `<span class="hero-round-pill ${curStatus}"><span class="hero-round-dot"></span><span>Round ${curRound} of ${
              C.TOTAL_ROUNDS
            } · ${escapeHtml(ROUND_PILL_WORD[curStatus] || curStatus)}</span></span>`
      }
    </div>
    <div class="battery-amount">${
      allDone
        ? `<span class="count-up" data-count-key="hero" data-count="${
            C.TARGET_AMOUNT
          }">${C.peso(C.TARGET_AMOUNT)}</span> <span>/ ${C.peso(
            C.TARGET_AMOUNT
          )}</span>`
        : `<span class="count-up" data-count-key="hero" data-count="${curCollected}">${C.peso(
            curCollected
          )}</span> <span>/ ${C.peso(C.GOAL_PER_ROUND)} goal</span>`
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
        ? `${icon("users", 13)}<span><b>Fund fully funded</b> · ${C.peso(
            C.TARGET_AMOUNT
          )} paid out</span>`
        : // The mockup's line, plus the recipient the pill above displaced.
          // The cycle's own date is deliberately not repeated here: the
          // member's status card states their date, and Rounds carries every
          // date — a third copy only lengthened the line into a wrap.
          `${icon("users", 13)}<span><b>${cyclePaidCount} of ${
            members.length
          } members paid</b> · ${C.peso(remainingToGo)} to go${
            heroRecipient ? ` · payout to ${escapeHtml(heroRecipient.name)}` : ""
          }</span>`
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
    <button class="share-btn" onclick="PowerFund.openShareModal()">${icon(
      "sheet",
      14
    )}<span>Share fund status</span></button>
  </div>`;

  S.hero = section();

  // Who this generic "pick your name" action is for:
  //   treasurer — any member, so always offered while a cycle is open;
  //   identified member — never, because either the My-status card above
  //     already offers exactly this for exactly their cycle (two buttons, one
  //     job) or they have nothing to pay, and the design is explicit that the
  //     CTA is then "simply absent — just the tab bar". Prompting someone to
  //     pay a cycle they have already submitted is the bug this closes;
  //   unidentified device — offered, so a shared phone still works.
  // A rejected member's action is pinned, as the design has it — it used to
  // live only inside the rejection card, so scrolling past that card left them
  // with no action anywhere on screen.
  if (myRejection && !unlocked) {
    hasFloatingCta = true;
    html += `<div class="floating-cta"><button type="button" class="hero-cta rejected-cta" onclick="PowerFund.openContributeModal('${inlineArg(
      myMember.id
    )}', ${myRejection.cycles[0]})">${icon("upload", 15)}<span>Resubmit payment</span></button></div>`;
  } else {
  hasFloatingCta =
    !!payCycle && (unlocked ? true : !myMember && cyclePaidCount < members.length);
  if (hasFloatingCta) {
    html += `<div class="floating-cta"><button type="button" class="hero-cta" onclick="PowerFund.openContributePicker(${payCycle})">${
      unlocked
        ? "＋ Record a contribution"
        : `＋ Pay this cycle · ${C.peso(C.CONTRIBUTION_AMOUNT)}`
    }</button></div>`;
  } else if (allDone && unlocked) {
    // The design's terminal CTA. A member has nothing left to do, so they
    // correctly get none — but the treasurer still has to close the books.
    hasFloatingCta = true;
    html += `<div class="floating-cta"><button type="button" class="hero-cta" onclick="PowerFund.exportCsv()">${icon(
      "sheet",
      15
    )}<span>Export final report</span></button></div>`;
  }
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
    <div class="roster-strip${isWide ? " roster-list" : ""}">
      ${members
        .map((m) => {
          // The ring answers ONE question: has this member paid the cycle
          // being collected? It used to show memberStanding(), which ranks
          // "paid-out" (their round is finished) above everything — so the
          // member whose round had already completed was ringed green while
          // owing the current cycle, and green meant two different things.
          // Colour is now the only cue; no glyph beside the name.
          const cycleStatus = payCycle
            ? C.statusOf(state.contributions, m.id, payCycle)
            : null;
          const overdue =
            payCycle != null &&
            C.isOverdue(state.contributions, state.cycles, m.id, payCycle);
          // payCycle is null once the round is fully funded (or the fund is
          // finished), which only happens when every member has paid every
          // cycle in it — so that is "paid", not "nothing to show". They were
          // all rendering neutral with no glyph on exactly the screen that
          // says the round is complete.
          const allPaid = payCycle == null;
          const ring = allPaid
            ? "paid"
            : cycleStatus === 2
            ? "paid"
            : cycleStatus === 1
            ? "pending"
            : cycleStatus === 3
            ? "rejected"
            : overdue
            ? "overdue"
            : "idle";
          const said = allPaid
            ? "paid up"
            : cycleStatus === 2
            ? "paid this cycle"
            : cycleStatus === 1
            ? "sent, awaiting review"
            : cycleStatus === 3
            ? "rejected — needs sending again"
            : overdue
            ? "overdue"
            : "not paid yet";
          // The glyph beside the name, as the mockup draws it (✓ Ana · ◷ You ·
          // ⚠ Dan · Elena). Nothing for a cycle that simply isn't due — that
          // is not a state anyone needs to act on.
          const mark =
            allPaid || cycleStatus === 2
              ? "check"
              : cycleStatus === 1
              ? "clock"
              : cycleStatus === 3 || overdue
              ? "alert"
              : null;
          // The mockup labels the device's own member "You" rather than
          // repeating their name.
          const shown = myMember && m.id === myMember.id ? "You" : m.name;
          // Desktop states the status in WORDS beside the name, as
          // DesktopHomeMember/Treasurer draw it. On the widest, most-read
          // surface the mobile treatment left status as colour plus a 10px
          // glyph — a design mismatch and a colour-only cue in one.
          // On a finished fund every member has received their round, so the
          // word is "Paid out" — DesktopHomeMemberFundComplete labels the whole
          // roster that way. Mid-fund "Paid" only ever means this cycle.
          const wordFor = allDone
            ? "Paid out"
            : allPaid
            ? "Paid"
            : cycleStatus === 2
            ? "Paid"
            : cycleStatus === 1
            ? "In review"
            : cycleStatus === 3
            ? "Rejected"
            : overdue
            ? "Overdue"
            : "Not due yet";
          if (isWide) {
            return `<button type="button" class="roster-row" onclick="PowerFund.setView('members')" aria-label="${escapeHtml(
              m.name
            )} — ${said}">
              <span class="roster-row-avatar">${memberAvatar(m.name, ring, 34, m.avatar_url)}</span>
              <span class="roster-row-name">${escapeHtml(shown)}</span>
              <span class="roster-row-status ${ring}">${
              mark ? `<span class="roster-mark rm-${
                cycleStatus === 3 && !allPaid ? "rejected" : mark
              }">${icon(mark, 11)}</span>` : ""
            }<span>${wordFor}</span></span>
            </button>`;
          }
          return `<button type="button" class="roster-chip" onclick="PowerFund.setView('members')" aria-label="${escapeHtml(
            m.name
          )} — ${said}">
            <span class="roster-avatar-wrap">
              ${memberAvatar(m.name, ring, 52, m.avatar_url)}
              <span class="roster-order">${m.member_order}</span>
            </span>
            <span class="roster-name">${
              mark
                ? // Namespaced modifier: a bare "check" here collided with the
                  // unrelated legacy .check cycle-cell class (style.css), which
                  // carries its own 28px box — so the tick rendered nearly
                  // three times its size and squeezed the name into an
                  // ellipsis.
                  `<span class="roster-mark rm-${
                    cycleStatus === 3 && !allPaid ? "rejected" : mark
                  }">${icon(mark, 10)}</span>`
                : ""
            }<span class="roster-name-text">${escapeHtml(shown)}</span></span>
            ${
              // A tick alone doesn't say what was paid. On the closing screen
              // the phone roster spells it out too, as the design does.
              allDone ? `<span class="roster-chip-word">Paid out</span>` : ""
            }
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
      ${
        // Once every round is done this link is about the whole fund, not a
        // round in progress — it read "Round 5 · ₱30,000/₱30,000" with the
        // status pill stripped, which says less than either alternative.
        allDone
          ? `<span class="rounds-link-title">All ${C.TOTAL_ROUNDS} rounds</span>
             ${ROUND_PILL.completed || ""}
             <span class="rounds-link-meta">${C.peso(C.TARGET_AMOUNT)} paid out</span>`
          : `<span class="rounds-link-title">Round ${curRound}</span>
             ${ROUND_PILL[curStatus]}
             <span class="rounds-link-meta">${C.peso(curCollected)} / ${C.peso(
              C.GOAL_PER_ROUND
            )}</span>`
      }
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
      // Annotation 1: "Needs your attention" leads the screen, right under the
      // header, ahead of the balance card. For a treasurer the queue and a
      // ready payout outrank the personal card; for a member there is no queue
      // and their own status IS the lead.
      S.dayOne +
      S.rejected +
      (unlocked ? S.complete + S.release + S.attention + S.myStatus : S.myStatus + S.complete) +
      S.payoutNudge +
      S.fundTotal + S.hero + S.cta + S.roster + S.roundsLink + S.prevRounds +
      S.spacer
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
    ${(function () {
      // Desktop hides .floating-cta entirely, so this greeting button is the
      // ONLY CTA on this shell — it cannot simply borrow hasFloatingCta.
      // Borrowing it emitted openContributePicker(null) once the fund was
      // complete (payCycle is null then), producing a primary button that did
      // nothing, while the design's terminal action never rendered at all.
      if (allDone && unlocked) {
        return `<button type="button" class="home-greet-cta" onclick="PowerFund.exportCsv()">${icon(
          "sheet",
          15
        )}<span>Export final report</span></button>`;
      }
      if (!hasFloatingCta || !payCycle) return "";
      return `<button type="button" class="home-greet-cta" onclick="PowerFund.openContributePicker(${payCycle})">${icon(
        "plus",
        15
      )}<span>${unlocked ? "Record a contribution" : "Pay this cycle"}</span></button>`;
    })()}
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
        ${S.rejected}${
          unlocked
            ? `${S.complete}${S.release}${S.attention}${S.myStatus}`
            : `${S.myStatus}${S.complete}`
        }${S.payoutNudge}${overview}${quick}
      </aside>
    </div>` +
    S.cta +
    S.spacer
  );
};
