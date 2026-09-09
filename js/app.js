/* ---------------------------------------------------------------------------
 * Power Fund — UI / app controller
 *
 * Responsibilities: load data from Supabase (via window.DB), render the whole
 * page, handle every click/form, keep other devices in sync (Supabase Realtime
 * + a slow poll + refresh-on-focus). All maths live in window.Calc; all
 * database calls live in window.DB.
 * ------------------------------------------------------------------------- */

(function () {
  "use strict";

  // The QR shown to members: the treasurer-uploaded one (Supabase) if set,
  // otherwise the image bundled with the app.
  const FALLBACK_QR_URL =
    (window.APP_CONFIG && window.APP_CONFIG.QR_IMAGE_URL) || "";
  function qrImageUrl() {
    return (state && state.settings && state.settings.qr_code_url) || FALLBACK_QR_URL;
  }

  // ---- "Which member is this device?" (display-only, per-device) --------
  // A pure UI convenience: which member's status to highlight at the top of
  // the page. Stored only in this browser's localStorage, never sent to
  // Supabase, and never gates or changes any action — it only decides what
  // the "My status" card shows. Absent/invalid value = card is just hidden.
  const MY_MEMBER_KEY = "pf_my_member_id";
  function lsGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function lsSet(key, val) {
    try {
      if (val == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, val);
    } catch (e) {
      /* private mode / storage blocked — non-fatal, card just won't persist */
    }
  }

  // ---- Data cache (filled by loadAll) ---------------------------------
  let state = null; // { members, cycles, contributions, payouts, activityLog, settings }
  let cycleIdByNumber = {}; // cycle_number -> cycle uuid  (for writes)

  // ---- UI state (not persisted) -------------------------------------
  let selectedMemberId = null; // Members tab: which member's detail is open
  let currentView = "home"; // "home" | "rounds" | "members" | "activity" | "insights" | "menu"
  // Some views genuinely differ on a wide screen (rounds becomes a master list
  // plus a detail pane), which CSS alone can't express. Tracked here and passed
  // to the views; a re-render happens only when the breakpoint actually flips.
  const wideQuery = window.matchMedia("(min-width: 900px)");
  let isWide = wideQuery.matches;
  let unlocked = false; // treasurer mode
  let busy = false; // a write is in flight — block double clicks
  /**
   * Shared submit/upload state, so a long action can say what it is doing and
   * offer a retry where it failed rather than only in a banner at the top.
   *
   * The design calls for this on the contribute sheet and says it "applies to
   * any upload/submit action in the app, not just this one screen", so it is a
   * helper rather than one screen's markup. Shape:
   *   { phase: "working" | "failed", label, message, retry }
   */
  let submitState = null;
  let appError = null; // string shown in the red banner
  // When the failed action can simply be tried again, the banner carries a
  // Retry button that calls this. The design shows this as an error toast with
  // an action; the app already has a persistent banner, which suits an error
  // better than something that slides away, so the ACTION moves onto the banner
  // rather than the app growing a second way to report failures.
  let appErrorRetry = null;
  let appWarning = null; // amber banner: an action succeeded but a side effect didn't
  let appSuccess = null; // green banner: confirms an action fully succeeded (auto-dismisses)
  let successTimer = null;
  let openRound = null;
  let hasAutoOpened = false;

  let modalTarget = null; // { memberId, cycleNumber }
  let modalCount = 1;
  let modalProofFile = null; // File chosen in the contribute modal
  let modalProofPreview = null; // object URL for the local preview

  let reviewTarget = null; // { memberId, cycles: [n, ...] } — the whole advance batch
  // Which confirmed contribution the treasurer is undoing, as an inline panel
  // in the cycle grid: { memberId, cycleNumber }. The design asks for this
  // rather than a dialog, "deliberately mirroring the existing inline 'Undo
  // Release' pattern already used elsewhere in this same screen".
  let undoPaidTarget = null;
  // Recording a payment with no proof (the treasurer's cash path) writes money
  // too, so it gets the same inline gate as undo rather than firing on one tap.
  let markPaidTarget = null;
  // Set when a receipt upload fails, so the release sheet can offer the
  // explicit no-receipt fallback instead of trapping a real transfer.
  let receiptUploadFailed = false;
  let rejectConfirming = false;
  let rejectNoteValue = ""; // the treasurer's reason — shown to the member
  let rejectError = null;
  let startRoundConfirming = false; // inline confirm for "Start Next Round"

  // Generic "are you sure?" gate for destructive treasurer actions. Nothing
  // that destroys or reverses financial data runs on the first tap — it opens
  // one of these first. Shape:
  //   { kind, title, bodyHtml, confirmLabel, requireType, requirePin,
  //     typeValue, pinValue, error, ctx }
  let confirmDialog = null;

  let pinModalMode = null; // null | 'setup' | 'enter' | 'change'
  let pinInputValue = "";
  let pinError = null;
  // Treasurer mode was entered with the master PIN rather than the group's own.
  // Only used to nudge them toward setting a working PIN again — it grants no
  // different powers, because the master PIN exists precisely so a locked-out
  // group gets full treasurer access back.
  let unlockedViaMaster = false;

  let payoutModalRound = null;
  let payoutNoteValue = "";
  let payoutAmountValue = ""; // string in the release modal; blank => the ₱30,000 default
  let payoutReceiptFile = null; // optional receipt image the treasurer attaches
  let payoutReceiptPreview = null; // object URL for its preview

  let activityLogLimit = 30; // grows when the treasurer taps "Show older"
  let activityFilter = "all"; // "all" | "payment" | "payout" | "admin"
  // Desktop-only dropdowns (migration 007). "all" or a member id / round
  // number. Round defaults to the fund's current round, as the design does —
  // resolved at render time, since the current round moves.
  let activityMemberFilter = "all";
  let activityRoundFilter = null; // null = "not chosen yet, use current round"
  let shareModalOpen = false;
  let copyFeedback = null;

  let attentionQueueExpanded = false; // "show N more" in the review queue
  let overdueListOpen = false; // overdue detail list in the attention panel

  let reorderModalOpen = false; // "Reorder payout order", from Menu → Group
  /**
   * Restore's own three states — invalid file, working, done.
   *
   * Replacing every contribution is the most destructive thing the app does,
   * and it used to report nothing at all: the treasurer could not tell whether
   * it had run, was still running, or had failed silently.
   *   { phase: "invalid" | "working" | "done", fileName, reason, n, released, exportedAt }
   */
  let restoreState = null;
  let editNamesModalOpen = false;
  let editNamesValues = {};
  let editNamesError = null;

  let lightboxSrc = null; // image URL shown full-screen in the zoom lightbox

  let qrModalOpen = false; // treasurer "Payment QR code" panel
  let qrNewFile = null; // File the treasurer picked
  let qrNewPreview = null; // object URL for the preview
  let qrUploadMsg = null; // success / info line inside the QR panel

  // Payout details modal: where one member's payout should be sent.
  let payoutQrMemberId = null;
  let payoutQrFile = null;
  let payoutQrPreview = null;
  let payoutQrFields = null; // { bank, accountName, accountNumber }

  let contributePicker = null; // cycle number for the "who are you?" picker, or null
  let modalWasOpen = false; // for moving focus into a dialog when it opens

  let myMemberId = lsGet(MY_MEMBER_KEY); // this device's remembered member, or null
  let whoAmIPickerOpen = false; // "Which member are you?" picker modal

  // ===================================================================
  // Small helpers
  // ===================================================================
  const C = window.Calc;

  function memberName(id) {
    const m = state.members.find((x) => x.id === id);
    return m ? m.name : "—";
  }

  function memberOrderOf(id) {
    const m = state.members.find((x) => x.id === id);
    return m ? m.member_order : null;
  }

  function sortedMembers() {
    return [...state.members].sort((a, b) => a.member_order - b.member_order);
  }

  /** The fund's display name — settings first, falling back to the product
   *  name. Sidebar, header and the share text all read this, so a renamed fund
   *  cannot show two different names on one screen or paste the wrong one into
   *  the group chat. */
  function fundName() {
    return (state.settings && state.settings.fund_name) || "Power Fund";
  }

  function getPayout(round) {
    return (
      (state.payouts || []).find((p) => p.round_number === round) || {
        round_number: round,
        released: false,
        note: "",
        released_on: null,
        amount: null,
        recipient_member_id: null,
        recipient_name: null,
        receipt_url: null,
        released_by: null,
      }
    );
  }

  /** Recipient name for a payout row: the snapshot taken at release, else the
   *  member currently in that payout position. */
  function payoutRecipientName(payout) {
    if (payout && payout.recipient_name) return payout.recipient_name;
    const m = (state.members || []).find(
      (x) => x.member_order === payout.round_number
    );
    return m ? m.name : "—";
  }

  function payoutDateText(released_on) {
    if (!released_on) return "";
    return C.formatDate(C.parseDueDate(released_on));
  }

  /**
   * Run a submit/upload, reporting progress and failure in place.
   *
   * Returns true on success, false on failure — the caller decides what to do
   * next (close the sheet, reload, celebrate), because only it knows. On
   * failure the state carries a retry that runs exactly the same work again,
   * so the person does not have to re-enter anything.
   */
  async function runSubmit(label, fn) {
    submitState = { phase: "working", label: label };
    busy = true;
    render();
    try {
      await fn();
      submitState = null;
      return true;
    } catch (e) {
      console.error(label + " failed:", e);
      submitState = {
        phase: "failed",
        label: label,
        message: (e && e.message) || "Something went wrong.",
        retry: function () {
          runSubmit(label, fn);
        },
      };
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  function clearSubmitState() {
    submitState = null;
  }

  /** The inline progress / failure block a sheet shows while submitting. */
  function submitStateHtml() {
    if (!submitState) return "";
    if (submitState.phase === "working") {
      return `<div class="submit-state working" role="status" aria-live="polite">
        <span class="submit-spinner" aria-hidden="true"></span>
        <span>${escapeHtml(submitState.label)}…</span>
      </div>`;
    }
    return `<div class="submit-state failed" role="alert">
      <span class="submit-state-main">${icon("alert", 15)}<span>${escapeHtml(
      submitState.message
    )}</span></span>
      <button type="button" class="submit-retry" onclick="PowerFund.retrySubmit()">Retry</button>
    </div>`;
  }

  function showError(msg, retry) {
    appError = msg || "Something went wrong. Please try again.";
    appErrorRetry = typeof retry === "function" ? retry : null;
    appWarning = null; // a hard error supersedes a soft warning
    appSuccess = null; // ...and a stale success notice
    clearTimeout(successTimer);
    console.error("App error:", msg);
    render();
    // The banner renders at the top of the document. A treasurer confirming a
    // payment from the bottom of Rounds would never see it, so put it in front
    // of them. render() assigns innerHTML on its last line, so the node exists
    // only after this call returns — hence the next frame.
    requestAnimationFrame(() => {
      const el = document.getElementById("appErrorBanner");
      if (!el) return;
      const reduce =
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      try {
        el.scrollIntoView({
          behavior: reduce ? "auto" : "smooth",
          block: "center",
        });
      } catch (e) {
        el.scrollIntoView();
      }
    });
  }

  /** Run the failed action again, clearing the banner first so a second
   *  failure reads as new rather than stale. */
  function retryLastAction() {
    const again = appErrorRetry;
    appError = null;
    appErrorRetry = null;
    render();
    if (again) again();
  }

  /** A softer banner: the main action worked, but something alongside it didn't. */
  function showWarning(msg) {
    appWarning = msg || null;
    if (msg) console.warn("App warning:", msg);
    render();
  }
  function dismissError() {
    appError = null;
    appErrorRetry = null;
    render();
  }

  function dismissWarning() {
    appWarning = null;
    render();
  }

  /** A positive confirmation banner: the action fully succeeded. Auto-dismisses
   *  after a few seconds so it never lingers like a warning/error would. */
  function showSuccess(msg) {
    appSuccess = msg || null;
    clearTimeout(successTimer);
    render();
    if (msg) {
      successTimer = setTimeout(() => {
        appSuccess = null;
        render();
      }, 4500);
    }
  }
  function dismissSuccess() {
    clearTimeout(successTimer);
    appSuccess = null;
    render();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Safe to drop into an inline  onclick="PowerFund.x('...')"  attribute:
  // escape the JS-string layer first, then the HTML-attribute layer.
  function inlineArg(s) {
    return escapeHtml(String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
  }

  async function logActivity(message, meta) {
    const ok = await window.DB.addActivityLog(message, meta);
    if (ok === false) {
      // The action itself succeeded; make sure the missing audit line is seen.
      appWarning =
        "Your last action was saved, but it could not be added to the activity log.";
    }
    return ok !== false;
  }

  // ===================================================================
  // Load / reload
  // ===================================================================
  async function loadAll() {
    const data = await window.DB.loadEverything(activityLogLimit);

    // attach cycle_number to every contribution so Calc stays self-contained
    const numById = {};
    cycleIdByNumber = {};
    data.cycles.forEach((c) => {
      numById[c.id] = c.cycle_number;
      cycleIdByNumber[c.cycle_number] = c.id;
    });
    data.contributions = data.contributions.map((c) => ({
      ...c,
      cycle_number: numById[c.cycle_id],
    }));

    state = data;
    // A successful load means any earlier error message is now stale.
    appError = null;
  }

  function loadMoreActivity() {
    activityLogLimit += 30;
    reload();
  }

  async function reload() {
    try {
      await loadAll();
      render();
    } catch (e) {
      showError(e.message);
    }
  }

  // ===================================================================
  // Contribute modal (member marks "I've sent this")
  // ===================================================================
  function openContributeModal(memberId, cycleNumber) {
    // Same rule the cycle grid uses: can't pay into a round the treasurer
    // hasn't started yet. Display guard only — no business logic here.
    const cycleRound = C.roundOfCycle(cycleNumber);
    if (
      C.roundLifecycleEnabled(state.payouts) &&
      cycleRound > C.currentRound(state.payouts, state.contributions)
    ) {
      return showError(
        `Round ${cycleRound} hasn't started yet — the treasurer needs to start it first.`
      );
    }
    contributePicker = null;
    modalTarget = { memberId, cycleNumber };
    modalCount = 1;
    clearProofSelection();
    render();
  }

  /** "Record a contribution" → pick which member you are for a given cycle. */
  function openContributePicker(cycleNumber) {
    contributePicker = cycleNumber;
    render();
  }
  function closeContributePicker() {
    contributePicker = null;
    render();
  }
  function pickContributor(memberId) {
    const cyc = contributePicker;
    contributePicker = null;
    if (cyc == null) return render();
    // Route through the same handler the cycle grid uses, so a treasurer gets
    // the review / mark-paid behaviour and a member gets the contribute modal.
    cellClicked(memberId, cyc);
  }

  // ===================================================================
  // "Which member are you?" — this device's remembered member (display only)
  // ===================================================================
  function openWhoAmIPicker() {
    whoAmIPickerOpen = true;
    render();
  }
  function closeWhoAmIPicker() {
    whoAmIPickerOpen = false;
    render();
  }
  function setMyMember(memberId) {
    myMemberId = memberId || null;
    lsSet(MY_MEMBER_KEY, myMemberId);
    whoAmIPickerOpen = false;
    render();
  }
  function clearMyMember() {
    setMyMember(null);
  }

  function closeModal() {
    modalTarget = null;
    clearProofSelection();
    clearSubmitState();
    render();
  }

  function clearProofSelection() {
    if (modalProofPreview) URL.revokeObjectURL(modalProofPreview);
    modalProofFile = null;
    modalProofPreview = null;
  }

  function adjustModalCount(delta) {
    if (!modalTarget) return;
    const max = C.maxAdvanceCount(
      state.contributions,
      modalTarget.memberId,
      modalTarget.cycleNumber,
      C.roundEndCycle(modalTarget.cycleNumber) // don't let "advance" spill into the next round
    );
    modalCount = Math.min(max, Math.max(1, modalCount + delta));
    render();
  }

  function onProofSelected(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type || !file.type.startsWith("image/")) {
      showError("Please choose an image file for the screenshot.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showError("That image is larger than 5 MB — please choose a smaller one.");
      return;
    }
    if (modalProofPreview) URL.revokeObjectURL(modalProofPreview);
    modalProofFile = file;
    modalProofPreview = URL.createObjectURL(file);
    render();
  }

  async function markPending() {
    if (!modalTarget || busy) return;
    const { memberId, cycleNumber } = modalTarget;
    const count = modalCount;

    const invalid = C.validateContribution({
      amount: C.CONTRIBUTION_AMOUNT,
      memberId,
      cycleNumber,
      members: state.members,
      cycles: state.cycles,
    });
    if (invalid) return showError(invalid);

    // Proof of payment is required — no attachment, no submission.
    if (!modalProofFile) {
      return showError("Please attach your proof of payment before submitting.");
    }

    const ok = await runSubmit("Uploading proof", async () => {
      const proofUrl = await window.DB.uploadProof(
        modalProofFile,
        memberId,
        cycleNumber
      );
      const rows = [];
      const roundEnd = C.roundEndCycle(cycleNumber); // keep the batch inside one round
      for (let i = 0; i < count; i++) {
        const cn = cycleNumber + i;
        if (cn > roundEnd || !cycleIdByNumber[cn]) continue;
        rows.push({
          cycleId: cycleIdByNumber[cn],
          memberId,
          amount: C.CONTRIBUTION_AMOUNT,
          status: C.STATUS_PENDING,
          proofUrl,
        });
      }
      await window.DB.upsertContributions(rows);
      const range =
        count > 1
          ? `cycles ${cycleNumber}–${cycleNumber + count - 1}`
          : `cycle ${cycleNumber}`;
      await logActivity(
        `${memberName(memberId)} marked ${range} as sent — ${C.peso(
          count * C.CONTRIBUTION_AMOUNT
        )}`,
        {
          type: "payment",
          amount: count * C.CONTRIBUTION_AMOUNT,
          refStatus: C.STATUS_PENDING,
          memberId: memberId,
          round: C.roundOfCycle(cycleNumber),
        }
      );
    });

    // The sheet stays open on failure, holding the attachment and the cycle
    // count, so Retry re-sends exactly what was already entered.
    if (!ok) return;
    closeModal();
    await reload();
    showSuccess(
      `Payment submitted — ${C.peso(
        count * C.CONTRIBUTION_AMOUNT
      )} is waiting for treasurer verification.`
    );
  }

  // ===================================================================
  // Clicking a member chip in a cycle row
  // ===================================================================
  async function cellClicked(memberId, cycleNumber) {
    if (busy) return;
    const status = C.statusOf(state.contributions, memberId, cycleNumber);

    if (!unlocked) {
      // Rejected behaves like unpaid here: the cycle is still owed, and
      // tapping it is how the member sends a fresh screenshot.
      if (C.isOwed(status)) {
        // With migration 002 active, members can only pay into a round the
        // treasurer has started, so a new round always begins at ₱0. Without it
        // this check is a no-op (currentRound == first unfunded round).
        const cycleRound = C.roundOfCycle(cycleNumber);
        if (
          C.roundLifecycleEnabled(state.payouts) &&
          cycleRound > C.currentRound(state.payouts, state.contributions)
        ) {
          return showError(
            `Round ${cycleRound} hasn't started yet — the treasurer needs to start it first.`
          );
        }
        openContributeModal(memberId, cycleNumber);
      }
      return;
    }

    // Treasurer
    if (status === C.STATUS_PENDING) {
      openReviewModal(memberId, cycleNumber);
      return;
    }

    if (status === C.STATUS_PAID) {
      // Reverting a confirmed contribution destroys a financial record — never
      // do it on the first tap.
      const due = C.dueDateOf(state.cycles, cycleNumber);
      // Undoing a confirmed payment removes money from a round, so it is never
      // a single tap — but it stays in the grid, next to the pill that was
      // tapped, instead of throwing a dialog over the whole screen.
      undoPaidTarget = { memberId: memberId, cycleNumber: cycleNumber };
      render();
      return;
    }

    // Unpaid or rejected → treasurer records it as paid directly (cash).
    // Rejected lands here too, and should: a refused screenshot is often
    // followed by the member simply handing over cash. The rejection note
    // stays on the row as history; the member's banner clears because it only
    // reads rows still in the rejected state.
    //
    // This is a money write with no proof attached — the one payment path the
    // design removed entirely and this project deliberately kept. Keeping it
    // does not mean keeping it un-gated, so it confirms inline in the row,
    // exactly like undo.
    markPaidTarget = { memberId: memberId, cycleNumber: cycleNumber };
    render();
  }

  function cancelMarkPaid() {
    markPaidTarget = null;
    render();
  }

  /** The actual direct (cash) record, after the inline confirmation. */
  async function confirmMarkPaid() {
    if (busy || !markPaidTarget) return;
    const { memberId, cycleNumber } = markPaidTarget;
    markPaidTarget = null;
    busy = true;
    render();
    try {
      const cycleId = cycleIdByNumber[cycleNumber];
      await window.DB.upsertContribution({
        cycleId,
        memberId,
        amount: C.CONTRIBUTION_AMOUNT,
        status: C.STATUS_PAID,
      });
      await logActivity(
        `Treasurer recorded ${memberName(memberId)}'s cycle ${cycleNumber} as paid (direct) — ${C.peso(
          C.CONTRIBUTION_AMOUNT
        )}`,
        {
          type: "payment",
          amount: C.CONTRIBUTION_AMOUNT,
          refStatus: C.STATUS_PAID,
          memberId: memberId,
          round: C.roundOfCycle(cycleNumber),
        }
      );
      await reload();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  /** The actual revert, after the confirmation dialog. */
  async function doRevertContribution(memberId, cycleNumber) {
    if (busy) return;
    busy = true;
    render();
    try {
      const cycleId = cycleIdByNumber[cycleNumber];
      const row = C.contributionFor(state.contributions, memberId, cycleNumber);
      const proof = row && row.proof_url;
      await window.DB.deleteContribution(memberId, cycleId);

      const outcome = await preserveProof(proof, row ? [row.id] : []);

      await logActivity(
        `Treasurer reverted ${memberName(memberId)}'s cycle ${cycleNumber} to unpaid` +
          outcome.logSuffix,
        {
          type: "payment",
          amount: -C.CONTRIBUTION_AMOUNT,
          refStatus: C.STATUS_UNPAID,
          memberId: memberId,
          round: C.roundOfCycle(cycleNumber),
        }
      );
      await reload();
      if (outcome.warning) {
        showWarning(
          "The contribution was reverted, but its payment screenshot could not " +
            "be archived — it is still at its original URL. See the activity log."
        );
      }
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  /**
   * Keep a rejected/reverted payment screenshot instead of deleting it:
   *   - if another contribution still points at the file (shared advance-batch
   *     proof), leave it in place;
   *   - otherwise move it to the bucket's archive/ folder.
   * Never throws. Returns { logSuffix, warning } so the caller can record the
   * outcome and, on failure, tell the treasurer the two outcomes differed.
   */
  async function preserveProof(proofUrl, removedIds) {
    if (!proofUrl) return { logSuffix: "", warning: false };
    if (C.proofInUse(state.contributions, proofUrl, removedIds || [])) {
      return {
        logSuffix: " (screenshot kept — still used by another cycle)",
        warning: false,
      };
    }
    try {
      const archivedUrl = await window.DB.archiveProof(proofUrl);
      return {
        logSuffix: archivedUrl
          ? ` — screenshot archived: ${archivedUrl}`
          : " — screenshot kept",
        warning: false,
      };
    } catch (e) {
      console.error("Archive failed:", e);
      return {
        logSuffix: ` — WARNING: screenshot NOT archived (${proofUrl})`,
        warning: true,
      };
    }
  }

  // ===================================================================
  // Review modal (treasurer confirms / rejects a pending claim)
  // ===================================================================
  function openReviewModal(memberId, cycleNumber) {
    // Review the whole advance batch (contiguous pending cycles, same proof)
    // in one go, not cycle by cycle.
    reviewTarget = {
      memberId,
      cycles: C.pendingRun(state.contributions, memberId, cycleNumber),
    };
    rejectConfirming = false;
    rejectNoteValue = "";
    rejectError = null;
    render();
  }

  function closeReviewModal() {
    reviewTarget = null;
    rejectConfirming = false;
    rejectNoteValue = "";
    rejectError = null;
    render();
  }

  async function confirmReview() {
    if (!reviewTarget || busy) return;
    const { memberId, cycles } = reviewTarget;
    await confirmCycles(memberId, cycles);
  }

  /** Shared worker: mark the given pending cycles as confirmed-paid. */
  async function confirmCycles(memberId, cycles) {
    if (busy || !cycles || !cycles.length) return;
    busy = true;
    render();
    try {
      const now = new Date().toISOString();
      let total = 0;
      for (const c of cycles) {
        const row = C.contributionFor(state.contributions, memberId, c);
        if (row && row.status === C.STATUS_PENDING) {
          total += Number(row.amount) || 0;
          await window.DB.updateContribution(row.id, {
            status: C.STATUS_PAID,
            paid_at: now,
          });
        }
      }
      await logActivity(
        `Treasurer confirmed ${memberName(memberId)}'s ${cycleRangeLabel(
          cycles
        )} as paid — ${C.peso(total)}`,
        {
          type: "payment",
          amount: total,
          refStatus: C.STATUS_PAID,
          memberId: memberId,
          round: cycles.length ? C.roundOfCycle(cycles[0]) : null,
        }
      );
      closeReviewModal();
      await reload();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  function rejectReview() {
    rejectConfirming = true;
    render();
  }
  function cancelUndoPaid() {
    undoPaidTarget = null;
    render();
  }
  async function confirmUndoPaid() {
    if (!undoPaidTarget || busy) return;
    const { memberId, cycleNumber } = undoPaidTarget;
    undoPaidTarget = null;
    await doRevertContribution(memberId, cycleNumber);
  }

  function cancelRejectConfirm() {
    rejectConfirming = false;
    rejectNoteValue = "";
    rejectError = null;
    render();
  }

  async function doRejectReview() {
    if (!reviewTarget || busy) return;
    const { memberId, cycles } = reviewTarget;
    const note = rejectNoteValue.trim();
    if (!note) {
      // A rejection the member can't understand is the thing this whole flow
      // exists to fix, so the reason is required here even though the column
      // is nullable.
      rejectError = "Say why it wasn't accepted — the member sees this.";
      return render();
    }
    busy = true;
    render();
    try {
      const rows = cycles
        .map((c) => C.contributionFor(state.contributions, memberId, c))
        .filter(Boolean);
      const proof =
        (rows[0] && rows[0].proof_url) ||
        C.proofOf(state.contributions, memberId, cycles[0]);
      const ids = rows.map((r) => r.id);

      // Preferred path: keep the rows and mark them rejected, so the member
      // sees the reason and can resubmit. The screenshot stays where it is —
      // the surviving rows still point at it.
      const kept = await window.DB.rejectContributions(ids, note);

      let logSuffix = "";
      let warning = false;
      if (!kept) {
        // Migration 006 hasn't been run. Fall back to the old behaviour rather
        // than blocking the treasurer: delete the rows and archive the proof.
        for (const c of cycles) {
          await window.DB.deleteContribution(memberId, cycleIdByNumber[c]);
        }
        const outcome = await preserveProof(proof, ids);
        logSuffix = outcome.logSuffix;
        warning = outcome.warning;
      }

      await logActivity(
        `Treasurer rejected ${memberName(memberId)}'s ${cycleRangeLabel(
          cycles
        )} claim — "${note}"` + logSuffix,
        {
          type: "payment",
          amount: cycles.length * C.CONTRIBUTION_AMOUNT,
          refStatus: C.STATUS_REJECTED,
          memberId: memberId,
          round: cycles.length ? C.roundOfCycle(cycles[0]) : null,
        }
      );
      closeReviewModal();
      await reload();
      if (!kept) {
        showWarning(
          "The claim was rejected, but this database hasn't had " +
            "supabase/migrations/006_redesign_foundation.sql run yet, so the " +
            "record was removed instead of kept and " +
            memberName(memberId) +
            " won't see the reason in the app."
        );
      } else if (warning) {
        showWarning(
          "The claim was rejected, but its payment screenshot could not be " +
            "archived — it is still at its original URL. See the activity log."
        );
      } else {
        showSuccess("Claim rejected — " + memberName(memberId) + " can resubmit.");
      }
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  /** "cycle 3" or "cycles 3–5" for activity-log / modal copy. */
  function cycleRangeLabel(cycles) {
    if (!cycles || !cycles.length) return "cycle";
    if (cycles.length === 1) return `cycle ${cycles[0]}`;
    return `cycles ${cycles[0]}–${cycles[cycles.length - 1]}`;
  }

  // ===================================================================
  // Reorder members (payout order)
  // ===================================================================
  async function moveMember(memberId, direction) {
    if (!unlocked || busy) return;
    const sorted = sortedMembers();
    const idx = sorted.findIndex((m) => m.id === memberId);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    const a = sorted[idx];
    const b = sorted[swapIdx];
    busy = true;
    render();
    try {
      await window.DB.updateMemberOrder([
        { id: a.id, member_order: b.member_order },
        { id: b.id, member_order: a.member_order },
      ]);
      await logActivity(
        `Payout order: ${a.name} swapped positions with ${b.name}`,
        { type: "admin" }
      );
      await reload();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  // ===================================================================
  // Reset everything
  // ===================================================================
  function resetData() {
    openConfirm({
      kind: "reset",
      title: "Reset all fund data?",
      bodyHtml:
        `This permanently clears <b>every contribution</b>, the <b>activity log</b>, ` +
        `and <b>all payout status</b> (including released payouts). Uploaded payment ` +
        `screenshots are removed too.<br><br>` +
        `Members, their names, the payout order, cycle dates and the treasurer PIN ` +
        `are kept.<br><br>This cannot be undone.`,
      confirmLabel: "Reset everything",
      requireType: "RESET",
      requirePin: true,
    });
  }
  async function doReset() {
    if (busy) return;
    busy = true;
    render();
    try {
      await window.DB.resetAll();
      await logActivity("Fund was reset — all contributions cleared", { type: "admin" });
      // Reset keeps the PIN; the current session re-locks so treasurer mode
      // can only be re-entered with it.
      unlocked = false;
      await reload();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  // ===================================================================
  // Export CSV  /  JSON backup  /  JSON restore
  // ===================================================================
  function csvEscape(value) {
    const s = String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadFile(content, filename, type) {
    // On an installed iOS PWA (standalone) `<a download>` silently does nothing,
    // so hand CSV / JSON exports to the share sheet or a copy-out modal instead.
    // Desktop and every normal mobile browser keep the direct download below.
    // The file content is unchanged — see js/pwa.js.
    if (
      window.PowerFundPWA &&
      typeof window.PowerFundPWA.saveFile === "function" &&
      window.PowerFundPWA.needsSaveFallback()
    ) {
      window.PowerFundPWA.saveFile(content, filename, type);
      return;
    }
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Today's date as YYYY-MM-DD in the viewer's LOCAL timezone (not UTC), so a
   *  payout released late in the evening in PH records the right day. */
  function todayStamp() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function exportCsv() {
    const members = sortedMembers();
    const rows = [["Cycle", "Due Date", ...members.map((m) => m.name), "Cycle Total"]];
    for (let c = 1; c <= C.TOTAL_CYCLES; c++) {
      const due = C.dueDateOf(state.cycles, c);
      const row = [c, due ? C.formatDate(due) : ""];
      members.forEach((m) => {
        const s = C.statusOf(state.contributions, m.id, c);
        row.push(s === 2 ? "Paid" : s === 1 ? "Pending" : "Unpaid");
      });
      row.push(C.cycleTotal(state.contributions, c));
      rows.push(row);
    }
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
    downloadFile(csv, `power-fund-summary-${todayStamp()}.csv`, "text/csv");
  }

  function downloadBackup() {
    const backup = {
      app: "power-fund",
      version: 1,
      exported_at: new Date().toISOString(),
      members: state.members.map((m) => ({
        member_order: m.member_order,
        name: m.name,
      })),
      cycles: state.cycles.map((c) => ({
        cycle_number: c.cycle_number,
        due_date: c.due_date,
      })),
      contributions: state.contributions.map((c) => ({
        member_order: memberOrderOf(c.member_id),
        cycle_number: c.cycle_number,
        amount: c.amount,
        status: c.status,
        proof_url: c.proof_url,
        notes: c.notes,
        paid_at: c.paid_at,
      })),
      payouts: (state.payouts || []).map((p) => ({
        round_number: p.round_number,
        released: p.released,
        note: p.note,
        released_on: p.released_on,
        started_at: p.started_at, // present only with migration 002
        amount: p.amount, // \
        recipient_member_id: p.recipient_member_id, //  } present only with
        recipient_name: p.recipient_name, //  } migration 004
        receipt_url: p.receipt_url, //  /
        released_by: p.released_by, // /
      })),
      activityLog: (state.activityLog || []).map((a) => ({
        message: a.message,
        created_at: a.created_at,
      })),
    };
    downloadFile(
      JSON.stringify(backup, null, 2),
      `power-fund-backup-${todayStamp()}.json`,
      "application/json"
    );
  }

  function pickRestoreFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (file) restoreBackup(file);
    };
    input.click();
  }

  async function restoreBackup(file) {
    if (busy) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      restoreState = {
        phase: "invalid",
        fileName: file.name || "that file",
        reason: "It isn't valid JSON, so it can't be read at all.",
      };
      return render();
    }
    if (!data || !Array.isArray(data.contributions)) {
      restoreState = {
        phase: "invalid",
        fileName: file.name || "that file",
        reason: "It doesn't match the format this app exports.",
      };
      return render();
    }
    const n = data.contributions.length;
    const released = Array.isArray(data.payouts)
      ? data.payouts.filter((p) => p && p.released).length
      : 0;
    const summary = [
      data.exported_at ? `exported ${formatDateTime(data.exported_at)}` : null,
      `${n} contribution${n === 1 ? "" : "s"}`,
      `${released} released payout${released === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" · ");

    openConfirm({
      kind: "restore",
      title: "Replace all data with this backup?",
      bodyHtml:
        `<b>${escapeHtml(summary)}</b><br><br>` +
        `This <b>replaces every current contribution and all payout status</b> ` +
        `with the file's contents. Anything not in the file is lost. This cannot be undone.`,
      confirmLabel: "Replace everything",
      requireType: "REPLACE",
      ctx: { data },
    });
  }

  /** The actual restore, after the confirmation dialog. */
  async function doRestoreBackup(data) {
    if (busy) return;
    const n = data.contributions.length;
    const released = Array.isArray(data.payouts)
      ? data.payouts.filter((p) => p && p.released).length
      : 0;
    restoreState = { phase: "working" };
    busy = true;
    render();
    try {
      await window.DB.restoreFromBackup(data);
      await logActivity("Fund data restored from a backup file", { type: "admin" });
      await reload();
      // Positive proof it finished, and of exactly what is now on screen —
      // after replacing everything, silence is the one thing that leaves the
      // numbers untrustworthy.
      restoreState = {
        phase: "done",
        n,
        released,
        exportedAt: data.exported_at || null,
      };
    } catch (e) {
      restoreState = null;
      showError(e.message, function () {
        doRestoreBackup(data);
      });
    } finally {
      busy = false;
      render();
    }
  }

  // ===================================================================
  // Destructive-action confirmation gate
  // ===================================================================
  function openConfirm(cfg) {
    appWarning = null; // starting a new destructive action clears the last notice
    confirmDialog = Object.assign(
      { requireType: null, requirePin: false, typeValue: "", pinValue: "", error: null },
      cfg
    );
    render();
  }
  function closeConfirm() {
    confirmDialog = null;
    render();
  }
  function setConfirmType(v) {
    if (confirmDialog) confirmDialog.typeValue = v;
  }
  function setConfirmPin(v) {
    if (confirmDialog) confirmDialog.pinValue = v;
  }

  async function submitConfirm() {
    if (!confirmDialog || busy) return;
    const d = confirmDialog;

    if (
      d.requireType &&
      d.typeValue.trim().toUpperCase() !== d.requireType.toUpperCase()
    ) {
      d.error = `Type ${d.requireType} exactly to confirm.`;
      return render();
    }
    if (d.requirePin) {
      const pin = state.settings && state.settings.treasurer_pin;
      if (!pin || d.pinValue !== pin) {
        d.error = "Incorrect PIN.";
        d.pinValue = "";
        return render();
      }
    }

    const { kind, ctx } = d;
    confirmDialog = null;
    render();

    if (kind === "revert") return doRevertContribution(ctx.memberId, ctx.cycleNumber);
    if (kind === "undoRelease") return doUnmarkPayoutReleased(ctx.round);
    if (kind === "reset") return doReset();
    if (kind === "restore") return doRestoreBackup(ctx.data);
  }

  // ===================================================================
  // Treasurer PIN
  // ===================================================================
  function toggleUnlock() {
    if (unlocked) {
      unlocked = false;
      unlockedViaMaster = false;
      render();
      return;
    }
    pinInputValue = "";
    pinError = null;
    pinModalMode = state.settings && state.settings.treasurer_pin ? "enter" : "setup";
    render();
  }

  function closePinModal() {
    pinModalMode = null;
    pinInputValue = "";
    pinError = null;
    render();
  }

  function hasMasterPin() {
    return !!(state.settings && state.settings.master_pin);
  }

  /** Set or rotate the group's recovery PIN. Until now this existed only as a
   *  one-off SQL statement, so a fund deployed without running it had no
   *  recovery path and nothing in the app said so. */
  function openMasterPin() {
    // Treasurer-only, checked here and again in submitPin(). The Menu row that
    // opens this already sits behind `unlocked`, but the function is on the
    // PowerFund global — a UI-only gate on the recovery credential is not a
    // gate, it is decoration.
    if (!unlocked) {
      return showError("Unlock treasurer mode before changing the master PIN.");
    }
    pinInputValue = "";
    pinError = null;
    pinModalMode = "master";
    render();
  }

  function openChangePin() {
    pinInputValue = "";
    pinError = null;
    pinModalMode = "change";
    render();
  }

  async function submitPin() {
    if (pinModalMode === "master") {
      if (!unlocked) {
        pinError = "Treasurer mode must be unlocked to change the master PIN.";
        return render();
      }
      if (!pinInputValue || pinInputValue.length < 4) {
        pinError = "The master PIN must be at least 4 digits.";
        return render();
      }
      if (state.settings && pinInputValue === state.settings.treasurer_pin) {
        // Same digits for both defeats the point: the master PIN exists to be
        // usable when the treasurer PIN is the thing that has been lost.
        pinError = "Use different digits from the treasurer PIN.";
        return render();
      }
      const rotating = hasMasterPin();
      try {
        await window.DB.updateMasterPin(pinInputValue);
        // The digits are never logged — only that it changed, and by whom.
        await logActivity(
          rotating ? "Master PIN was changed" : "Master PIN was set",
          { type: "admin" }
        );
        closePinModal();
        await reload();
        showSuccess(
          rotating ? "Master PIN updated." : "Master PIN set. Keep it somewhere safe."
        );
      } catch (e) {
        pinError = e.message;
        render();
      }
      return;
    }
    if (pinModalMode === "setup" || pinModalMode === "change") {
      if (!pinInputValue || pinInputValue.length < 4) {
        pinError = "PIN must be at least 4 digits.";
        return render();
      }
      const wasChange = pinModalMode === "change";
      try {
        await window.DB.updateTreasurerPin(pinInputValue);
        await logActivity(
          wasChange
            ? "Treasurer PIN was changed"
            : "Treasurer PIN was set for the first time",
          { type: "admin" }
        );
        unlocked = true;
        closePinModal();
        await reload();
      } catch (e) {
        pinError = e.message;
        render();
      }
    } else {
      // enter
      const settings = state.settings || {};
      const entered = pinInputValue;
      if (entered && entered === settings.treasurer_pin) {
        unlocked = true;
        unlockedViaMaster = false;
        closePinModal();
        return;
      }
      // The master PIN (migration 006) is the way back in when the group's own
      // PIN has been forgotten. It is set by hand in the database and never
      // shown, changed or removed from inside the app. Absent = not configured,
      // and the lockout behaves exactly as it did before.
      if (entered && settings.master_pin && entered === settings.master_pin) {
        unlocked = true;
        unlockedViaMaster = true;
        closePinModal();
        // Logged so a master-PIN entry is visible after the fact, the same way
        // migration 005 makes payout-QR changes auditable.
        try {
          await logActivity("Treasurer mode unlocked with the master PIN", { type: "admin" });
          await reload();
        } catch (e) {
          console.warn("Could not log the master-PIN unlock:", e.message);
        }
        showWarning(
          "Unlocked with the master PIN. Set a new treasurer PIN from " +
            "Menu → Change PIN so the group can use their own again."
        );
        return;
      }
      pinError = "Incorrect PIN. Try again.";
      pinInputValue = "";
      render();
    }
  }

  /** Numeric-keypad entry: append one digit, or clear/backspace. */
  function pinKey(key) {
    if (key === "clear") pinInputValue = "";
    else if (key === "back") pinInputValue = pinInputValue.slice(0, -1);
    else if (/^[0-9]$/.test(key) && pinInputValue.length < 12) pinInputValue += key;
    pinError = null;
    render();
  }

  // ===================================================================
  // Payout release
  // ===================================================================
  function openPayoutModal(round) {
    receiptUploadFailed = false;
    payoutModalRound = round;
    const existing = getPayout(round);
    payoutNoteValue = existing.note || "";
    payoutAmountValue =
      existing.amount != null ? String(existing.amount) : String(C.GOAL_PER_ROUND);
    clearPayoutReceipt();
    render();
  }
  function closePayoutModal() {
    receiptUploadFailed = false;
    payoutModalRound = null;
    payoutNoteValue = "";
    payoutAmountValue = "";
    clearPayoutReceipt();
    render();
  }
  function clearPayoutReceipt() {
    if (payoutReceiptPreview) URL.revokeObjectURL(payoutReceiptPreview);
    payoutReceiptFile = null;
    payoutReceiptPreview = null;
  }
  function removePayoutReceipt() {
    clearPayoutReceipt();
    render();
  }
  function onPayoutReceiptSelected(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type || !file.type.startsWith("image/")) {
      return showError("Please choose an image file for the receipt.");
    }
    if (file.size > 5 * 1024 * 1024) {
      return showError("That image is larger than 5 MB — please choose a smaller one.");
    }
    if (payoutReceiptPreview) URL.revokeObjectURL(payoutReceiptPreview);
    payoutReceiptFile = file;
    payoutReceiptPreview = URL.createObjectURL(file);
    render();
  }

  /** Parse the release-modal amount field. Blank => the ₱30,000 default.
   *  This is a historical record only — it never touches round funding. */
  function parsePayoutAmount(v) {
    if (v == null || String(v).trim() === "") return C.GOAL_PER_ROUND;
    const n = Number(String(v).replace(/[₱,\s]/g, ""));
    return isFinite(n) ? n : null;
  }

  /** Release, but explicitly WITHOUT a receipt, after an upload has failed.
   *  The break-glass: refusing outright is right for a transient failure, but
   *  if the storage bucket is missing the treasurer can never record a payout
   *  at all — money has moved in the real world and the app would be unable to
   *  represent it, leaving the round Payout Pending forever. So this exists,
   *  behind a second deliberate tap, and is loud about what it is: the log
   *  says the receipt is missing and why, and a warning stays on screen. */
  async function releaseWithoutReceipt() {
    if (!payoutModalRound || busy) return;
    await markPayoutReleased({ skipReceipt: true });
  }

  async function markPayoutReleased(opts) {
    if (!payoutModalRound || busy) return;
    const skipReceipt = !!(opts && opts.skipReceipt === true);
    const round = payoutModalRound;
    // Guard at the action level: a payout can only be released once the round
    // has actually reached its ₱30,000 target in confirmed contributions. The
    // button is already hidden/disabled in the UI unless the round is funded —
    // this makes the rule hold even if the handler is reached another way, and
    // is the real check, not just a display state.
    if (!C.isRoundFunded(state.contributions, round)) {
      closePayoutModal();
      return showError(
        `Round ${round} isn't funded yet — it needs ${C.peso(
          C.GOAL_PER_ROUND
        )} in confirmed contributions before its payout can be released.`
      );
    }

    // The receipt is the only evidence the payout was actually sent, so it is
    // required (decision D4, matching the design). The button is disabled
    // without one; this makes the rule hold even if the handler is reached
    // another way, the same way the funded check above does.
    if (!payoutReceiptFile && !skipReceipt) {
      return showError(
        "Attach the receipt photo before releasing — it is the record that the payout was sent."
      );
    }

    const amount = parsePayoutAmount(payoutAmountValue);
    if (amount == null || amount < 0) {
      return showError("Enter a valid payout amount (₱0 or more).");
    }

    // Snapshot the recipient NOW so the history stays correct even if members
    // are later renamed, reordered, or removed.
    const recipient = sortedMembers().find((m) => m.member_order === round);
    busy = true;
    render();
    try {
      // The receipt is REQUIRED (decision D4), and "required" has to survive a
      // failed upload too. This used to catch the error and release anyway with
      // receipt_url null, which recorded a real payout with no evidence and no
      // way to attach any afterwards — the guard above says the receipt is the
      // record that the payout was sent, so releasing without one contradicts
      // it. Abort instead: the round stays Payout Pending, which is the honest
      // state when the app holds no proof, and the treasurer can retry.
      let receiptUrl = null;
      if (!skipReceipt) {
        try {
          receiptUrl = await window.DB.uploadPayoutReceipt(payoutReceiptFile, round);
        } catch (e) {
          console.warn("Payout receipt upload failed:", e.message);
          busy = false;
          receiptUploadFailed = true;
          // Report the REAL reason. The generic string this used to substitute
          // threw away database.js's actionable one ("run migration 003"),
          // making the abort less useful than the failure it wrapped. Shown
          // inside the sheet, where the treasurer is looking.
          submitState = {
            phase: "failed",
            message:
              (e && e.message ? e.message : "The receipt photo could not be uploaded.") +
              " The payout was NOT released — nothing has been recorded.",
            retry: () => markPayoutReleased(),
          };
          return render();
        }
      }

      // The release itself uses only pre-existing columns, so it always works.
      await window.DB.updatePayout(round, {
        released: true,
        note: payoutNoteValue || null,
        released_on: todayStamp(),
      });

      // The accountability snapshot needs migration 004. If it isn't there yet,
      // the release still stands — we just tell the treasurer to run it.
      let accWarning = false;
      try {
        await window.DB.updatePayout(round, {
          amount: amount,
          recipient_member_id: recipient ? recipient.id : null,
          recipient_name: recipient ? recipient.name : null,
          receipt_url: receiptUrl,
          released_by: "treasurer",
        });
      } catch (e) {
        accWarning = true;
        console.warn("Payout accountability not recorded:", e.message);
      }

      await logActivity(
        `Payout released — Round ${round} (${
          recipient ? recipient.name : "—"
        }) · ${C.peso(amount)}` +
          (payoutNoteValue ? ": " + payoutNoteValue : "") +
          (skipReceipt ? " — NO RECEIPT ON FILE (upload failed)" : ""),
        {
          type: "payout",
          // NEGATIVE: a released payout is money leaving the fund. Storing it
          // positive forced the renderers to infer direction from the event
          // type, which is how a ₱30,000 outflow ended up unsigned on mobile
          // and a reversal ended up indistinguishable from a release.
          amount: -Math.abs(amount),
          memberId: recipient ? recipient.id : null,
          round: round,
        }
      );
      closePayoutModal();
      await reload();

      // A failed receipt upload no longer reaches this point — it aborts the
      // release above rather than recording an unevidenced payout.
      const problems = [];
      if (skipReceipt) {
        problems.push(
          "this payout has NO receipt on file — the upload failed, so there is " +
            "no image proving it was sent. Attach one to the round's record " +
            "later if you can"
        );
      }
      if (accWarning) {
        problems.push(
          "the recipient / amount record could not be saved (run " +
            "supabase/migrations/004) — payout history falls back to the current " +
            "member order until then"
        );
      }
      if (problems.length) {
        showWarning("Payout released, but " + problems.join("; and ") + ".");
      }
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  function unmarkPayoutReleased(round) {
    openConfirm({
      kind: "undoRelease",
      title: "Undo payout release?",
      bodyHtml:
        `Undo the Round ${round} payout release?<br><br>` +
        `The round returns to <b>Payout Pending</b>. The recorded release date, ` +
        `note, amount, recipient and <b>the receipt photo</b> are cleared from ` +
        `the payout. The receipt's link is written to the activity log first, ` +
        `so the evidence is not lost.`,
      confirmLabel: "Yes, undo release",
      ctx: { round },
    });
  }

  async function doUnmarkPayoutReleased(round) {
    if (busy) return;
    const recipient = sortedMembers().find((m) => m.member_order === round);
    // The receipt is the only proof a real transfer happened. Undoing the
    // release nulls receipt_url, so capture it BEFORE the write and put it in
    // the activity log — otherwise a reversible-sounding confirmation quietly
    // destroys the evidence for money that actually moved.
    const prior = getPayout(round) || {};
    const priorReceipt = prior.receipt_url || null;
    // The amount that was actually released, not the round goal. Logging
    // -GOAL_PER_ROUND meant undoing an edited ₱32,000 release recorded
    // -₱30,000, so the release and its reversal never netted out.
    const priorAmount =
      prior.amount != null ? Number(prior.amount) : C.GOAL_PER_ROUND;
    busy = true;
    render();
    try {
      await window.DB.updatePayout(round, {
        released: false,
        note: null,
        released_on: null,
      });
      // Clear the accountability snapshot too; tolerate a DB without migration 004.
      try {
        await window.DB.updatePayout(round, {
          amount: null,
          recipient_member_id: null,
          recipient_name: null,
          receipt_url: null,
          released_by: null,
        });
      } catch (e) {
        console.warn("Payout accountability fields not cleared:", e.message);
      }
      await logActivity(
        `Payout release undone — Round ${round} (${recipient ? recipient.name : "—"})` +
          (priorReceipt ? ` — receipt kept on record: ${priorReceipt}` : ""),
        {
          type: "payout",
          // POSITIVE: an undo returns the money to the fund. Logging it
          // negative made the reversal render identically to the release it
          // reverses — red, "−₱30,000.00" — so a release-then-undo read as
          // ₱60,000 leaving the fund.
          amount: priorAmount,
          memberId: recipient ? recipient.id : null,
          round: round,
        }
      );
      await reload();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  // ===================================================================
  // Start next round (while the previous round's payout is still pending).
  // This is a SEPARATE action from "Release payout" — starting round
  // N+1 never releases round N's payout.
  // ===================================================================
  function askStartNextRound() {
    startRoundConfirming = true;
    render();
  }
  function cancelStartRound() {
    startRoundConfirming = false;
    render();
  }
  async function confirmStartRound() {
    if (busy) return;
    const rounds = state.payouts;
    if (!C.canStartNextRound(state.contributions, rounds)) {
      startRoundConfirming = false;
      return showError(
        "The next round can't be started yet — the current round must reach " +
          C.peso(C.GOAL_PER_ROUND) +
          " first."
      );
    }
    const next = C.currentRound(rounds, state.contributions) + 1;
    busy = true;
    startRoundConfirming = false;
    render();
    try {
      const updated = await window.DB.startRound(next);
      // updated is [] when the round was already started on another device —
      // that is fine, we just refresh to show the real state.
      if (Array.isArray(updated) && updated.length > 0) {
        await logActivity(`Treasurer started Round ${next}`, {
          type: "admin",
          round: next,
        });
      }
      await reload();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  // ===================================================================
  // Edit names
  // ===================================================================
  function closeRestoreState() {
    restoreState = null;
    render();
  }
  /** Straight from the invalid-file state back to the picker. */
  function chooseAnotherBackup() {
    restoreState = null;
    render();
    pickRestoreFile();
  }

  function openReorderModal() {
    reorderModalOpen = true;
    render();
  }
  function closeReorderModal() {
    reorderModalOpen = false;
    render();
  }

  function openEditNamesModal() {
    editNamesValues = {};
    state.members.forEach((m) => (editNamesValues[m.id] = m.name));
    editNamesError = null;
    editNamesModalOpen = true;
    render();
  }
  function closeEditNamesModal() {
    editNamesModalOpen = false;
    editNamesValues = {};
    editNamesError = null;
    render();
  }

  async function saveEditNames() {
    if (busy) return;
    const trimmed = {};
    for (const m of state.members) {
      const v = (editNamesValues[m.id] || "").trim();
      if (!v) {
        editNamesError = "All names must be filled in.";
        return render();
      }
      trimmed[m.id] = v;
    }
    const lower = Object.values(trimmed).map((n) => n.toLowerCase());
    if (new Set(lower).size !== lower.length) {
      editNamesError = "Names must be unique.";
      return render();
    }
    const changes = [];
    state.members.forEach((m) => {
      if (m.name !== trimmed[m.id]) changes.push(`${m.name} → ${trimmed[m.id]}`);
    });
    if (!changes.length) return closeEditNamesModal();

    busy = true;
    render();
    try {
      for (const m of state.members) {
        if (m.name !== trimmed[m.id]) {
          await window.DB.updateMember(m.id, { name: trimmed[m.id] });
        }
      }
      await logActivity(`Name(s) updated: ${changes.join(", ")}`, { type: "admin" });
      closeEditNamesModal();
      await reload();
    } catch (e) {
      editNamesError = e.message;
      busy = false;
      return render();
    }
    busy = false;
    render();
  }

  // ===================================================================
  // Rounds accordion + activity log
  // ===================================================================
  function toggleRound(roundNum) {
    openRound = openRound === roundNum ? null : roundNum;
    render();
  }
  function setActivityFilter(type) {
    activityFilter = type;
    render();
  }
  function setActivityMember(id) {
    activityMemberFilter = id;
    render();
  }
  function setActivityRound(round) {
    activityRoundFilter = round;
    render();
  }

  // ===================================================================
  // Icons — one stroke-based set, drawn in currentColor so a single
  // definition works on any background at any accent. Emoji were only ever a
  // placeholder: they render differently on every platform and can't inherit
  // colour or stroke weight.
  // ===================================================================
  const ICON_PATHS = {
    // Stroked, 24x24, no fill — see the .icon rule in style.css.
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    share:
      '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 15V4"/><path d="M8 8l4-4 4 4"/>',
    home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/>',
    rounds:
      '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    members:
      '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20.2c.5-3.6 3-5.6 6.2-5.6s5.7 2 6.2 5.6"/><circle cx="17.3" cy="8.6" r="2.4"/><path d="M15.9 14.3c2.3.5 4 2.3 4.3 5.4"/>',
    activity:
      '<line x1="8" y1="7" x2="20" y2="7"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="17" x2="20" y2="17"/><circle cx="4" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="17" r="1" fill="currentColor" stroke="none"/>',
    insights: '<polyline points="3 16 9 10 13 14 21 5"/><polyline points="15 5 21 5 21 11"/>',
    menu: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlocked: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.4-2"/>',
    qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="15" y="15" width="5" height="5"/>',
    users:
      '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20.2c.5-3.6 3-5.6 6.2-5.6s5.7 2 6.2 5.6"/><circle cx="17.3" cy="8.6" r="2.4"/><path d="M15.9 14.3c2.3.5 4 2.3 4.3 5.4"/>',
    key: '<circle cx="8" cy="12" r="3.2"/><path d="M11.2 12H21"/><path d="M17 12v3"/><path d="M20 12v2"/>',
    download: '<path d="M12 3v13"/><polyline points="7 11 12 16 17 11"/><path d="M4 20h16"/>',
    upload: '<path d="M12 21V8"/><polyline points="7 13 12 8 17 13"/><path d="M4 4h16"/>',
    sheet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    alert:
      '<path d="M10.3 4.6 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
    check: '<polyline points="4 12 10 18 20 6"/>',
    chevron: '<polyline points="9 6 15 12 9 18"/>',
    chevronLeft: '<polyline points="15 6 9 12 15 18"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    party: '<path d="M4 20l4.5-11L19 19.5 4 20Z"/><path d="M14 4.5v2M18.5 8h2M16.8 6.2l1.4-1.4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    trash:
      '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/>',
  };
  /**
   * The fund's battery-cell progress visual: a cell that fills bottom-up.
   *
   * The terminal cap stays grey until the cell is actually full, so a
   * part-charged battery never reads as a finished one at a glance — the
   * colour only means "done" when it is.
   */
  function batteryCell(pct, size) {
    const p = Math.max(0, Math.min(100, pct || 0));
    const px = size || 96;
    const full = p >= 100;
    // Inner (clipped) area of the cell body, in the 96x96 viewBox.
    const top = 13;
    const bottom = 92;
    const fillH = ((bottom - top) * p) / 100;
    const fillY = bottom - fillH;
    const capFill = full ? "#F5A623" : "rgba(255,255,255,0.16)";
    return `<svg class="batt" viewBox="0 0 96 96" width="${px}" height="${px}" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="battGrad" x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stop-color="#4CD9C0"/>
          <stop offset="100%" stop-color="#F5A623"/>
        </linearGradient>
        <clipPath id="battClip"><rect x="22" y="${top}" width="52" height="${
      bottom - top
    }" rx="12"/></clipPath>
      </defs>
      <rect x="32" y="0" width="32" height="9" rx="4" fill="${capFill}"/>
      <rect x="18" y="9" width="60" height="87" rx="16" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" stroke-width="3"/>
      <g clip-path="url(#battClip)">
        <rect class="batt-fill" x="22" y="${fillY}" width="52" height="${fillH}" fill="url(#battGrad)"/>
      </g>
    </svg>`;
  }

  /**
   * Member avatar: initial in a circle, ringed in the colour of that member's
   * standing. The ring is a redundant cue, never the only one — every card
   * that shows one also states the same thing in words, so the roster stays
   * readable without relying on colour.
   *
   * status: "paid-out" | "overdue" | "pending" | "current" | "idle"
   */
  function memberAvatar(name, status, size) {
    const px = size || 44;
    const initial = (name || "?").trim().charAt(0).toUpperCase();
    return `<span class="avatar avatar-${status}" style="width:${px}px;height:${px}px;font-size:${Math.round(
      px * 0.36
    )}px" aria-hidden="true">${escapeHtml(initial)}</span>`;
  }

  /** One member's standing, used for the avatar ring and the card's wording. */
  function memberStanding(memberId, cyclesDueSoFar, paidOut) {
    if (paidOut) return "paid-out";
    // A refused claim outranks the rest: it is the one state the member has to
    // act on, and it should read that way even before the cycle falls due.
    if (C.latestRejection && C.latestRejection(state.contributions, memberId))
      return "rejected";
    if (C.memberOverdueCount(state.contributions, state.cycles, memberId) > 0)
      return "overdue";
    for (let c = 1; c <= C.TOTAL_CYCLES; c++) {
      if (C.statusOf(state.contributions, memberId, c) === C.STATUS_PENDING)
        return "pending";
    }
    if (cyclesDueSoFar > 0) {
      let paid = 0;
      for (let c = 1; c <= cyclesDueSoFar; c++) {
        if (C.statusOf(state.contributions, memberId, c) === C.STATUS_PAID) paid++;
      }
      if (paid >= cyclesDueSoFar) return "current";
    }
    return "idle";
  }

  /**
   * Fund-growth sparkline: cumulative confirmed money over time.
   *
   * Built from the payments themselves (paid_at on confirmed contributions),
   * so it reflects when money actually arrived rather than a schedule. Rows
   * without a paid_at can't be placed on a timeline and are skipped; if fewer
   * than two points survive there is no trend to draw and it renders nothing
   * rather than an invented straight line.
   */
  function sparkline(contributions, Calc) {
    const paid = (contributions || [])
      .filter((c) => c.status === Calc.STATUS_PAID && c.paid_at)
      .map((c) => ({ t: new Date(c.paid_at).getTime(), amt: c.amount || Calc.CONTRIBUTION_AMOUNT }))
      .filter((c) => !isNaN(c.t))
      .sort((a, b) => a.t - b.t);
    if (paid.length < 2) return "";

    let running = 0;
    const pts = paid.map((p) => {
      running += p.amt;
      return { t: p.t, total: running };
    });
    const t0 = pts[0].t;
    const tSpan = pts[pts.length - 1].t - t0 || 1;
    const max = pts[pts.length - 1].total || 1;
    const W = 140;
    const H = 40;
    const xy = pts.map((p) => {
      const x = ((p.t - t0) / tSpan) * W;
      const y = H - (p.total / max) * (H - 4) - 2;
      return `${x.toFixed(1)} ${y.toFixed(1)}`;
    });

    return `<div class="hero-spark">
      <div class="hero-spark-label">Fund growth</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="sparkStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#F5A623"/>
            <stop offset="100%" stop-color="#4CD9C0"/>
          </linearGradient>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4CD9C0" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#4CD9C0" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="M${xy[0]} L${xy.join(" L")} L${W} ${H} L0 ${H} Z" fill="url(#sparkFill)"/>
        <polyline points="${xy.join(" ")}" fill="none" stroke="url(#sparkStroke)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="hero-spark-total">${Calc.peso(max)} collected to date</div>
    </div>`;
  }

  /** Inline SVG for one icon, sized in px and inheriting the caller's colour. */
  function icon(name, size) {
    const d = ICON_PATHS[name];
    if (!d) return "";
    const px = size || 18;
    return `<svg class="icon" viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true" focusable="false">${d}</svg>`;
  }

  // ===================================================================
  // Tab shell (Home / Rounds / Members / Activity / Insights / Menu)
  // ===================================================================
  // Every view the router can reach. Which of them appear in the nav, and in
  // what order, differs by shell — see NAV_MOBILE / NAV_DESKTOP below.
  const TAB_VIEWS = [
    { id: "home", label: "Home", icon: "home" },
    { id: "rounds", label: "Rounds", icon: "rounds" },
    { id: "members", label: "Members", icon: "members" },
    { id: "activity", label: "Activity", icon: "activity" },
    { id: "insights", label: "Insights", icon: "insights" },
    { id: "menu", label: "Menu", icon: "menu" },
  ];

  // The two shells navigate differently, and deliberately so.
  //
  // MOBILE — five tabs. Members is NOT one of them: it is a drill-down from
  // Home's roster ("See all", or tapping an avatar), which is why it carries a
  // back chevron and lights no tab. Six targets across a 390px bar would cost
  // about a fifth of each tab's width for a screen that already has an entry
  // point.
  //
  // DESKTOP — a persistent sidebar has the room, so Members returns to the nav.
  // Menu leaves it instead, becoming the profile affordance at the foot of the
  // sidebar ("Menu & settings"), under a card showing which mode you are in.
  const NAV_MOBILE = ["home", "rounds", "activity", "insights", "menu"];
  const NAV_DESKTOP = ["home", "rounds", "members", "activity", "insights"];
  const navItems = (ids) =>
    ids.map((id) => TAB_VIEWS.find((t) => t.id === id)).filter(Boolean);
  function setView(view) {
    if (currentView === view) return;
    // Leaving Members drops the drill-down, so coming back lands on the
    // roster rather than whoever was open several taps ago.
    if (currentView === "members") selectedMemberId = null;
    undoPaidTarget = null;
    markPaidTarget = null;
    currentView = view;
    render();
    // A new screen starts at its top. render() replaces innerHTML but leaves
    // the window scrolled where the last view was, so switching from a
    // scrolled Rounds to Activity landed mid-list.
    window.scrollTo(0, 0);
  }
  /**
   * Open one member's record.
   *
   * The same state drives two presentations: on mobile it is the row expanded
   * inline (the design rejected a full detail screen as overkill for a few
   * lines of history), on desktop it is which member the detail pane shows.
   * Tapping the open row again closes it, which is what an accordion has to do
   * and what the master-detail pane can do harmlessly.
   */
  function openMemberDetail(memberId) {
    selectedMemberId = selectedMemberId === memberId ? null : memberId;
    currentView = "members";
    render();
  }
  function closeMemberDetail() {
    selectedMemberId = null;
    render();
  }
  /** Fallback when a view can't be found on window.PFViews. Every tab has a
   * view now, so reaching this means its script didn't load — say that,
   * rather than implying the feature was never built. */
  function renderPlaceholderView(view) {
    const meta = TAB_VIEWS.find((t) => t.id === view);
    const label = meta ? meta.label : view;
    return `<div class="view-placeholder">
      <p>${meta ? icon(meta.icon, 18) : ""} <b>${escapeHtml(label)}</b></p>
      <p class="view-placeholder-note">This screen didn't load. Check your connection and reload — if it keeps happening, the app may need updating.</p>
    </div>`;
  }
  /** Activity tab. The log used to be a collapsed accordion competing for
   * room on the old single-page layout; on its own tab it is the whole screen,
   * so it renders expanded with the filter chips always in reach. */
  /**
   * Activity — grouped by date, "amount-forward like a bank transaction list"
   * (canvas.json, activity-analytics-notes).
   *
   * Rows carry typed columns from migration 006. Entries written before it, or
   * on a database without it, have none — those fall back to inferring a
   * category from the message text and simply show no amount or chip, rather
   * than an empty column that looks like missing data.
   */
  function renderActivityView() {
    const log = state.activityLog || [];
    const filterLabels = { all: "All", payment: "Payments", payout: "Payouts", admin: "Admin" };

    // event_type when the row has one; the old regex otherwise.
    const typeOf = (e) => e.event_type || activityCategory(e.message);

    // Member and round come from real columns (migration 007), never from
    // parsing `message` — see the note above the table markup below. Rows
    // written before 007 carry null and are shown, unattributed, only in the
    // unfiltered view; a filter that silently swallowed them would be a
    // filtered view of financial history that omits records without saying so.
    const roundChoice =
      activityRoundFilter === null
        ? C.currentRound(state.payouts, state.contributions)
        : activityRoundFilter;

    const matches = (e) =>
      (activityFilter === "all" || typeOf(e) === activityFilter) &&
      (!isWide ||
        ((activityMemberFilter === "all" || e.member_id === activityMemberFilter) &&
          (roundChoice === "all" || Number(e.round_number) === Number(roundChoice))));

    const visible = log.filter(matches);
    // Everything the current filters exclude, split by WHY. The notice used to
    // count only untagged rows, so with the round filter defaulting to the
    // current round a released ₱30,000 payout simply disappeared from a
    // financial log with nothing said about it.
    const hiddenTotal = log.length - visible.length;
    const unattributed = log.filter(
      (e) => e.member_id == null && e.round_number == null
    ).length;

    // Group by calendar day, newest first. The log already arrives in that
    // order, so a single pass keeps it.
    const groups = [];
    let current = null;
    for (const e of visible) {
      const key = activityDayKey(e.created_at);
      if (!current || current.key !== key) {
        current = { key, label: activityDayLabel(e.created_at), rows: [] };
        groups.push(current);
      }
      current.rows.push(e);
    }

    const rowHtml = (e) => {
      const type = typeOf(e);
      const st = e.ref_status == null ? null : Number(e.ref_status);
      const amt = e.amount == null ? null : Number(e.amount);

      // Icon and tone say what KIND of thing happened before the text is read.
      let mark = { icon: "key", tone: "admin" };
      if (type === "payout") mark = { icon: "party", tone: "payout" };
      else if (type === "payment") {
        mark =
          st === C.STATUS_PAID
            ? { icon: "check", tone: "in" }
            : st === C.STATUS_PENDING
            ? { icon: "clock", tone: "pending" }
            : st === C.STATUS_REJECTED
            ? { icon: "alert", tone: "rejected" }
            : st === C.STATUS_UNPAID
            ? { icon: "alert", tone: "out" }
            : { icon: "check", tone: "admin" };
      }

      const amountHtml = activityAmountHtml(amt, st);

      const chip =
        st === C.STATUS_PENDING
          ? `<span class="activity-chip-state pending">Pending review</span>`
          : st === C.STATUS_REJECTED
          ? `<span class="activity-chip-state rejected">Rejected</span>`
          : "";

      return `<div class="activity-row">
        <span class="activity-mark ${mark.tone}">${icon(mark.icon, 14)}</span>
        <span class="activity-body">
          <span class="activity-text">${escapeHtml(e.message)}</span>
          <span class="activity-meta">${escapeHtml(activityClockLabel(e.created_at))}${
        chip ? " " + chip : ""
      }</span>
        </span>
        ${amountHtml}
      </div>`;
    };

    // Title and filter chips are shared; the body below differs per shell.
    const head = `<div class="view-head">
      <h2 class="view-title">Activity</h2>
      <p class="view-sub">${"Every contribution, payout &amp; admin action"} · ${
        // Don't print a total the table isn't showing: with the round filter
        // defaulting to the current round, "8 entries loaded" above 3 rows
        // reads as a fault.
        visible.length === log.length
          ? `${log.length} ${log.length === 1 ? "entry" : "entries"} loaded`
          : `showing ${visible.length} of ${log.length} loaded`
      }</p>
    </div>
    <div class="activity-chips">${Object.entries(filterLabels)
      .map(
        ([type, label]) => `
      <button type="button" class="activity-chip ${
        activityFilter === type ? "active" : ""
      }" onclick="PowerFund.setActivityFilter('${type}')">${label}</button>`
      )
      .join("")}${
      // The two dropdowns are desktop-only, as in the design — the phone
      // shell has no room for them and its list is date-grouped instead.
      isWide
        ? `<span class="activity-selects">
            <label class="activity-select">
              <span class="sr-only">Filter by member</span>
              <select onchange="PowerFund.setActivityMember(this.value)">
                <option value="all"${
                  activityMemberFilter === "all" ? " selected" : ""
                }>All members</option>
                ${sortedMembers()
                  .map(
                    (m) =>
                      `<option value="${escapeHtml(m.id)}"${
                        activityMemberFilter === m.id ? " selected" : ""
                      }>${escapeHtml(m.name)}</option>`
                  )
                  .join("")}
              </select>
            </label>
            <label class="activity-select">
              <span class="sr-only">Filter by round</span>
              <select onchange="PowerFund.setActivityRound(this.value === 'all' ? 'all' : Number(this.value))">
                <option value="all"${
                  roundChoice === "all" ? " selected" : ""
                }>All rounds</option>
                ${Array.from({ length: C.TOTAL_ROUNDS }, (_, i) => i + 1)
                  .map(
                    (r) =>
                      `<option value="${r}"${
                        Number(roundChoice) === r ? " selected" : ""
                      }>Round ${r}</option>`
                  )
                  .join("")}
              </select>
            </label>
          </span>`
        : ""
    }</div>`;

    const listHtml = `${
      log.length === 0
        ? `<div class="activity-empty-state">${icon("activity", 22)}
             <p><b>No activity yet</b></p>
             <p class="activity-empty-note">Actions show up here as your group uses the tracker.</p>
           </div>`
        : groups.length === 0
        ? `<div class="activity-empty-state">${icon("activity", 22)}
             <p><b>Nothing matches this filter</b></p>
             <p class="activity-empty-note">No ${filterLabels[
               activityFilter
             ].toLowerCase()} in the loaded history — try "Show older entries" or switch filters.</p>
           </div>`
        : groups
            .map(
              (g) => `<div class="activity-group">
                <p class="activity-day">${escapeHtml(g.label)}</p>
                <div class="activity-list activity-list-tab">${g.rows
                  .map(rowHtml)
                  .join("")}</div>
              </div>`
            )
            .join("")
    }
    ${
      log.length >= activityLogLimit
        ? `<button type="button" class="attention-more activity-more" onclick="PowerFund.loadMoreActivity()">Show older entries</button>`
        : ""
    }`;

    // Desktop gets a real table rather than the phone list stretched wide —
    // the design's own desktop treatment. Member and Round are real columns
    // (migration 007), not names scraped out of `message`: those messages
    // snapshot the name at write time, so after a rename a text-matched filter
    // would silently drop that member's older rows. Rows written before 007
    // have no attribution and say so.
    const memberNameById = (id) => {
      const m = state.members.find((x) => x.id === id);
      return m ? m.name : null;
    };
    const tableHtml = `<div class="activity-table-wrap">
      <table class="activity-table">
        <thead>
          <tr>
            <th class="at-when">When</th>
            <th class="at-member">Member</th>
            <th class="at-type">Type</th>
            <th class="at-round">Round</th>
            <th class="at-detail">Detail</th>
            <th class="at-amount">Amount</th>
            <th class="at-status">Status</th>
          </tr>
        </thead>
        <tbody>
          ${visible
            .map((e) => {
              const type = typeOf(e);
              const st = e.ref_status == null ? null : Number(e.ref_status);
              const amt = e.amount == null ? null : Number(e.amount);
              const typeLabel =
                type === "payout"
                  ? "Payout"
                  : type === "payment"
                  ? "Contribution"
                  : "Admin";
              const amountHtml = activityAmountHtml(amt, st) || "—";
              const statusHtml =
                st === C.STATUS_PAID
                  ? `<span class="activity-chip-state confirmed">Confirmed</span>`
                  : st === C.STATUS_PENDING
                  ? `<span class="activity-chip-state pending">In review</span>`
                  : st === C.STATUS_REJECTED
                  ? `<span class="activity-chip-state rejected">Rejected</span>`
                  : type === "payout"
                  ? `<span class="activity-chip-state released">Released</span>`
                  : `<span class="at-dash">—</span>`;
              const who = memberNameById(e.member_id);
              return `<tr class="at-row at-${type}">
                <td class="at-when"><span class="at-date">${escapeHtml(
                  activityDayLabel(e.created_at)
                )}</span><span class="at-time">${escapeHtml(
                activityClockLabel(e.created_at)
              )}</span></td>
                <td class="at-member">${
                  who
                    ? `<span class="at-avatar">${escapeHtml(
                        who.trim().charAt(0).toUpperCase()
                      )}</span><span class="at-who">${escapeHtml(who)}</span>`
                    : `<span class="at-dash">—</span>`
                }</td>
                <td class="at-type"><span class="at-type-tag ${type}">${typeLabel}</span></td>
                <td class="at-round">${
                  e.round_number == null
                    ? `<span class="at-dash">—</span>`
                    : `Round ${Number(e.round_number)}`
                }</td>
                <td class="at-detail">${escapeHtml(e.message)}</td>
                <td class="at-amount">${amountHtml}</td>
                <td class="at-status">${statusHtml}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
      ${
        visible.length === 0
          ? `<div class="activity-empty-state">${icon("activity", 22)}
               <p><b>${
                 log.length === 0 ? "No activity yet" : "Nothing matches these filters"
               }</b></p>
               <p class="activity-empty-note">${
                 log.length === 0
                   ? "Actions show up here as your group uses the tracker."
                   : "Try a different member, round or type."
               }</p>
             </div>`
          : ""
      }
    </div>
    ${
      // Account for every row the filters are holding back, not just the
      // untagged ones — a partial view of financial history must never look
      // whole.
      hiddenTotal > 0
        ? `<p class="activity-unattributed">${icon("alert", 13)}<span><b>${hiddenTotal} ${
            hiddenTotal === 1 ? "entry is" : "entries are"
          } hidden by the current filters.</b>${
            unattributed > 0
              ? ` ${unattributed} of them ${
                  unattributed === 1 ? "was" : "were"
                } recorded before entries carried a member and round, so ${
                  unattributed === 1 ? "it" : "they"
                } can only appear unfiltered.`
              : ""
          } Choose <b>All</b>, <b>All members</b> and <b>All rounds</b> to see the full log.</span></p>`
        : ""
    }
    ${
      log.length >= activityLogLimit
        ? `<button type="button" class="attention-more activity-more" onclick="PowerFund.loadMoreActivity()">Show older entries</button>`
        : ""
    }`;

    return head + (isWide ? tableHtml : listHtml);
  }

  /** One signing rule for both shells. The mobile list and the desktop table
   *  had drifted apart: the same released payout rendered flat and unsigned in
   *  one and red "−₱30,000.00" in the other. Sign is DIRECTION of cash, taken
   *  from the stored amount, so nothing has to infer it from the event type.
   *  Unsettled money (a claim in review, a rejected claim) is deliberately
   *  unsigned — nothing has changed hands. */
  function activityAmountHtml(amt, st) {
    if (amt == null || amt === 0) return "";
    const settled = st == null || Number(st) === C.STATUS_PAID;
    const abs = C.peso(Math.abs(amt));
    if (!settled) return `<span class="activity-amt flat">${escapeHtml(abs)}</span>`;
    const out = amt < 0;
    return `<span class="activity-amt ${out ? "out" : "in"}">${
      out ? "−" : "+"
    }${escapeHtml(abs)}</span>`;
  }

  /** Calendar-day identity, so entries group by the day they happened. */
  function activityDayKey(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "?" : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  /** "Today" / "Yesterday" / "Sep 3" — a date heading a person reads quickly. */
  function activityDayLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "Earlier";
    const today = new Date();
    const key = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
    if (key(d) === key(today)) return "Today";
    const yest = new Date(today);
    yest.setDate(today.getDate() - 1);
    if (key(d) === key(yest)) return "Yesterday";
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
    });
  }

  /** Time of day only — the group heading already carries the date. */
  function activityClockLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  /** Insights tab — read-only summary of what the fund data already says.
   * Every number here is derived from confirmed contributions via Calc; this
   * view never writes and never gates an action. */
  /** Label for the rounds-completed tile — says what is happening, not just N/5. */
  function allDoneLabel(contributions, payouts, curRound) {
    if (C.allRoundsComplete(contributions, payouts)) return "rounds completed · fund closed";
    return `rounds completed · Round ${curRound} in progress`;
  }

  /**
   * Where the group stands in the current round, as a donut.
   *
   * A STATUS chart, not a categorical one: the four slices are reserved states
   * that mean the same thing everywhere else in the app, so they reuse the
   * app's own semantic colours rather than a chart palette. Identity is never
   * carried by colour alone — every slice is named with its count in the legend
   * beside it, and the legend text stays in normal ink with a small colour chip
   * doing the matching. A 2px gap of the card's own background separates
   * neighbouring arcs so they read as distinct segments.
   */
  function renderRoundStatusDonut(members, round) {
    const st = C.roundMemberStates(state.contributions, state.cycles, members, round);
    const slices = [
      { key: "paid", label: "Paid", n: st.paid.length, color: "#4CAF83" },
      { key: "pending", label: "In review", n: st.pending.length, color: "#9B7FE0" },
      { key: "rejected", label: "Rejected", n: st.rejected.length, color: "#E15353" },
      { key: "overdue", label: "Overdue", n: st.overdue.length, color: "#E15353" },
      { key: "notdue", label: "Not due yet", n: st.notDue.length, color: "rgba(255,255,255,0.16)" },
    ].filter((x) => x.n > 0);

    const total = slices.reduce((sum, x) => sum + x.n, 0);
    if (!total) return "";

    // A donut of ONE slice is a full ring and a single legend row: it carries
    // nothing the number alone doesn't, and an unbroken circle reads as a
    // loading spinner. Say it in a line instead.
    if (slices.length === 1) {
      const only = slices[0];
      return `<p class="section-label">This round's status</p>
      <div class="donut-card donut-card-single">
        <span class="donut-swatch" style="background:${only.color}"></span>
        <p class="donut-single-text">All <b>${total}</b> ${
        total === 1 ? "member is" : "members are"
      } <b>${only.label.toLowerCase()}</b> for Round ${round}.</p>
      </div>`;
    }

    // One ring, drawn with stroke-dasharray so each arc is a plain circle.
    const R = 42;
    const CIRC = 2 * Math.PI * R;
    const GAP = slices.length > 1 ? 2 : 0; // px of surface between arcs
    let offset = 0;
    const arcs = slices
      .map((x) => {
        const len = (x.n / total) * CIRC;
        const draw = Math.max(0, len - GAP);
        const el = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${
          x.color
        }" stroke-width="16" stroke-dasharray="${draw.toFixed(2)} ${(
          CIRC - draw
        ).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
        offset += len;
        return el;
      })
      .join("");

    return `<p class="section-label">This round's status</p>
    <div class="donut-card">
      <svg class="donut" viewBox="0 0 120 120" width="120" height="120" role="img"
           aria-label="Round ${round}: ${slices
      .map((x) => `${x.label} ${x.n}`)
      .join(", ")}">
        <circle cx="60" cy="60" r="${R}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="16"></circle>
        <g transform="rotate(-90 60 60)">${arcs}</g>
      </svg>
      <ul class="donut-legend">
        ${slices
          .map(
            (x) => `<li class="donut-legend-row">
              <span class="donut-swatch" style="background:${x.color}"></span>
              <span class="donut-legend-label">${x.label}</span>
              <span class="donut-legend-n">${x.n}</span>
            </li>`
          )
          .join("")}
      </ul>
    </div>`;
  }

  function renderInsightsView(members) {
    const contributions = state.contributions;
    const collected = C.totalCollected(contributions);
    const roundsDone = C.completedRoundsCount(contributions, state.payouts);
    const overdue = C.totalOverdueCount(contributions, state.cycles, state.members);
    const pending = C.pendingCount(contributions);

    const tile = (value, label, tone) =>
      `<div class="stat-tile"><div class="stat-value ${
        tone || ""
      }">${value}</div><div class="stat-label">${label}</div></div>`;

    let html = `<div class="view-head">
      <h2 class="view-title">Insights</h2>
      <p class="view-sub">How the fund is tracking, from confirmed payments only</p>
    </div>`;
    // On-time rate, with the change since the previous round. A trend needs two
    // rounds with dated payments in them; before that it just states the rate.
    const curRound = C.currentRound(state.payouts, contributions);
    const thisRound = C.onTimeRateForRound(contributions, state.cycles, curRound);
    const prevRound =
      curRound > 1 ? C.onTimeRateForRound(contributions, state.cycles, curRound - 1) : null;
    const overallOnTime = (() => {
      let on = 0;
      let n = 0;
      for (const m of members) {
        const st = C.onTimeStats(contributions, state.cycles, m.id);
        on += st.onTime;
        n += st.counted;
      }
      return n ? (on / n) * 100 : null;
    })();
    let trendHtml = "";
    if (thisRound.rate !== null && prevRound && prevRound.rate !== null) {
      const delta = Math.round(thisRound.rate - prevRound.rate);
      trendHtml =
        delta === 0
          ? `level with Round ${curRound - 1}`
          : `${delta > 0 ? "↑" : "↓"} ${Math.abs(delta)}pts vs Round ${curRound - 1}`;
    }

    // Name who is behind rather than only counting: "1 · Dan · Round 2".
    const missed = C.missedContributions(contributions, state.cycles, members);
    const overdueNames = [];
    for (const x of missed) {
      const st = C.statusOf(contributions, x.memberId, x.cycleNumber);
      if (!C.isOwed(st)) continue;
      const m = members.find((mm) => mm.id === x.memberId);
      if (m && overdueNames.indexOf(m.name) === -1) overdueNames.push(m.name);
    }
    const overdueSub = overdueNames.length
      ? overdueNames.slice(0, 2).join(", ") +
        (overdueNames.length > 2 ? ` +${overdueNames.length - 2}` : "")
      : "nobody behind";

    // FOUR tiles, as the design draws them. A fifth ("awaiting review") made
    // the grid odd, leaving a visible hole in the last row that read as a
    // layout fault — and pending money belongs beside the collected figure
    // anyway, since it is the part of it not yet counted.
    html += `<div class="stat-grid">
      ${tile(
        C.peso(collected),
        `collected of ${C.peso(C.TARGET_AMOUNT)}${
          pending ? ` · ${pending} awaiting review` : ""
        }`
      )}
      ${tile(
        `${roundsDone} / ${C.TOTAL_ROUNDS}`,
        allDoneLabel(contributions, state.payouts, curRound)
      )}
      ${tile(
        overallOnTime === null ? "—" : `${Math.round(overallOnTime)}%`,
        overallOnTime === null ? "no dated payments yet" : "paid on time" + (trendHtml ? " · " + trendHtml : ""),
        // Deliberately unthemed: "79% on time" is information, not a fault,
        // and colouring it red implied a threshold the app never states.
        ""
      )}
      ${tile(String(overdue), overdueSub, overdue ? "danger" : "success")}
    </div>`;

    html += renderRoundStatusDonut(members, curRound);

    // Per-round bar chart. Inline markup sized by percentage — the same
    // approach the battery hero already uses, so no charting library.
    html += `<p class="section-label">Collected per round</p>
    <div class="round-bars">`;
    for (let r = 1; r <= C.TOTAL_ROUNDS; r++) {
      const amt = C.roundCollected(contributions, r);
      const pctOfGoal = Math.min(100, (amt / C.GOAL_PER_ROUND) * 100);
      const recipient = members.find((m) => m.member_order === r);
      const full = amt >= C.GOAL_PER_ROUND;
      html += `<div class="round-bar-row">
        <div class="round-bar-label">R${r}<span class="round-bar-name">${
        recipient ? escapeHtml(recipient.name) : "—"
      }</span></div>
        <div class="round-bar-track" role="img" aria-label="Round ${r}: ${C.peso(
        amt
      )} of ${C.peso(C.GOAL_PER_ROUND)} collected">
          <div class="round-bar-fill ${
            full ? "full" : ""
          }" style="width:${pctOfGoal}%"></div>
        </div>
        <div class="round-bar-amt">${C.peso(amt)}</div>
      </div>`;
    }
    html += `</div>`;

    // On-time leaderboard. Members with nothing countable yet sort last and
    // say so, rather than being shown as 0%.
    const ranked = members
      .map((m) => ({ m, s: C.onTimeStats(contributions, state.cycles, m.id) }))
      .sort((a, b) => {
        if (a.s.rate === null && b.s.rate === null) return 0;
        if (a.s.rate === null) return 1;
        if (b.s.rate === null) return -1;
        return b.s.rate - a.s.rate;
      });

    html += `<p class="section-label">Paid on time</p><div class="leaderboard">`;
    ranked.forEach(({ m, s }) => {
      const pct = s.rate === null ? null : Math.round(s.rate);
      html += `<div class="leader-row">
        <div class="leader-name">${escapeHtml(m.name)}</div>
        <div class="leader-track"><div class="leader-fill" style="width:${
          pct === null ? 0 : pct
        }%"></div></div>
        <div class="leader-val">${
          pct === null
            ? '<span class="leader-nodata">no data yet</span>'
            : `${pct}% <span class="leader-sub">${s.onTime}/${s.counted}</span>`
        }</div>
      </div>`;
    });
    html += `</div>
    <p class="insights-note">On-time counts confirmed payments that carry a payment date, compared against each cycle's due date.</p>`;

    return html;
  }
  /** One nav, two shells.
   *
   * The chrome is still a single element that CSS lays out as a bottom bar or
   * a left sidebar — but the two shells no longer carry the same items, so the
   * item list is chosen here rather than hidden with CSS. Rendering only what
   * a shell actually shows keeps the hidden half out of the accessibility tree
   * and out of the tab order.
   *
   * The sidebar's extra furniture — brand, mode card, profile row — has no
   * equivalent on mobile, where the header already carries all three.
   */
  function renderTabBar(active, wide, myMember) {
    const items = navItems(wide ? NAV_DESKTOP : NAV_MOBILE);
    const btn = (t) => `
        <button type="button" class="tab-item ${
          t.id === active ? "active" : ""
        }" aria-current="${t.id === active ? "page" : "false"}" onclick="PowerFund.setView('${
      t.id
    }')">
          <span class="tab-icon">${icon(t.icon, 20)}</span>
          <span class="tab-label">${escapeHtml(t.label)}</span>
        </button>`;

    if (!wide) {
      return `<nav class="tab-bar" aria-label="Main">${items.map(btn).join("")}</nav>`;
    }

    // Mode card: states which side of the gate you are on, and is the way
    // through it. Locked, it is the sidebar's "Unlock treasurer mode" entry.
    const mode = `
      <button type="button" class="nav-mode ${
        unlocked ? "on" : ""
      }" onclick="PowerFund.toggleUnlock()">
        <span class="nav-mode-label">${icon(unlocked ? "unlocked" : "lock", 14)}<span>${
      unlocked ? "Treasurer mode" : "Member mode"
    }</span></span>
        <span class="nav-mode-state">${
          unlocked ? "Active" : "Unlock treasurer mode →"
        }</span>
      </button>`;

    // Menu lives here on desktop, as the profile row rather than a sixth nav
    // item — it is settings, not a destination alongside the fund's screens.
    const profile = `
      <button type="button" class="tab-item nav-profile ${
        active === "menu" ? "active" : ""
      }" aria-current="${
      active === "menu" ? "page" : "false"
    }" onclick="PowerFund.setView('menu')">
        <span class="nav-profile-avatar">${
          myMember ? escapeHtml(myMember.name.trim().charAt(0).toUpperCase()) : icon("menu", 16)
        }</span>
        <span class="tab-label">Menu &amp; settings</span>
      </button>`;

    return `<nav class="tab-bar" aria-label="Main">
      <div class="tab-brand">
        <span class="tab-brand-mark">⚡</span>
        <span class="tab-brand-name">${escapeHtml(fundName())}</span>
      </div>
      ${items.map(btn).join("")}
      <div class="nav-spacer"></div>
      ${mode}
      ${profile}
    </nav>`;
  }
  /** Infers a coarse category from an activity-log message so the log can be
   * filtered without a dedicated DB column — every logActivity() call site
   * produces one of a small, stable set of message shapes. */
  function activityCategory(message) {
    if (/^Payout (released|release undone)/i.test(message)) return "payout";
    if (
      /marked .* as sent|recorded .*'s cycle .* as paid|reverted .*'s cycle .* to unpaid|confirmed .*'s .*cycle|rejected .*'s .*cycle/i.test(
        message
      )
    )
      return "payment";
    return "admin"; // reset, PIN, round start, name edits, payout order swap, QR update, restore
  }
  function expandAttentionQueue() {
    // A toggle, not a one-way door. This only ever set true, and the control
    // that called it rendered only while collapsed — so once opened, the queue
    // held the fold for the rest of the session with no way back.
    attentionQueueExpanded = !attentionQueueExpanded;
    render();
  }
  function toggleOverdueList() {
    overdueListOpen = !overdueListOpen;
    render();
  }

  /** [{ name, cycle, due }] for every (member, cycle) that is overdue. */
  function overdueRows() {
    const out = [];
    for (const m of sortedMembers()) {
      for (let c = 1; c <= C.TOTAL_CYCLES; c++) {
        if (C.isOverdue(state.contributions, state.cycles, m.id, c)) {
          out.push({ name: m.name, cycle: c, due: C.dueDateOf(state.cycles, c) });
        }
      }
    }
    return out;
  }

  // ===================================================================
  // Zoom lightbox (QR code + proof-of-payment images)
  // ===================================================================
  function openLightbox(src) {
    if (!src) return;
    lightboxSrc = src;
    render();
  }
  function closeLightbox() {
    lightboxSrc = null;
    render();
  }

  // ===================================================================
  // Treasurer: view / upload / replace the payment QR code
  // ===================================================================
  const QR_ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
  const QR_MAX_BYTES = 5 * 1024 * 1024;

  function clearQrSelection() {
    if (qrNewPreview) URL.revokeObjectURL(qrNewPreview);
    qrNewFile = null;
    qrNewPreview = null;
  }
  function openQrModal() {
    if (!unlocked) return;
    qrModalOpen = true;
    qrUploadMsg = null;
    clearQrSelection();
    render();
  }
  function closeQrModal() {
    qrModalOpen = false;
    qrUploadMsg = null;
    clearQrSelection();
    clearSubmitState();
    render();
  }
  function cancelQrSelection() {
    clearQrSelection();
    render();
  }

  function onQrFileSelected(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!QR_ALLOWED_TYPES.includes((file.type || "").toLowerCase())) {
      return showError("Please select a valid image file (JPG, PNG or WEBP).");
    }
    if (file.size === 0) {
      return showError("That file is empty — please choose another image.");
    }
    if (file.size > QR_MAX_BYTES) {
      return showError("QR code image must be smaller than 5 MB.");
    }
    if (qrNewPreview) URL.revokeObjectURL(qrNewPreview);
    qrNewFile = file;
    qrNewPreview = URL.createObjectURL(file);
    qrUploadMsg = null;
    render();
  }

  // ===================================================================
  // Member payout details (treasurer only)
  //
  // Treasurer-managed rather than member-managed: this app has no per-member
  // auth, so "members edit their own" would in practice mean anyone can edit
  // anyone's — and a swapped QR redirects a ₱30,000 payout. Gating it behind
  // the same treasurer PIN as every other money action is the honest limit of
  // what this app can enforce. Every change is logged so a swap is visible.
  // ===================================================================
  function openPayoutQrModal(memberId) {
    if (!unlocked) return;
    const m = state.members.find((x) => x.id === memberId);
    if (!m) return;
    payoutQrMemberId = memberId;
    payoutQrFields = {
      bank: m.payout_bank || "",
      accountName: m.payout_account_name || "",
      accountNumber: m.payout_account_number || "",
    };
    clearPayoutQrSelection();
    render();
  }
  function closePayoutQrModal() {
    payoutQrMemberId = null;
    payoutQrFields = null;
    clearPayoutQrSelection();
    render();
  }
  function clearPayoutQrSelection() {
    if (payoutQrPreview) URL.revokeObjectURL(payoutQrPreview);
    payoutQrFile = null;
    payoutQrPreview = null;
  }
  function setPayoutQrField(field, value) {
    if (!payoutQrFields) return;
    payoutQrFields[field] = value;
    // No re-render: the inputs already hold what was typed, and re-rendering
    // mid-keystroke would move the caret.
  }
  function onPayoutQrFileSelected(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!QR_ALLOWED_TYPES.includes((file.type || "").toLowerCase())) {
      return showError("Please select a valid image file (JPG, PNG or WEBP).");
    }
    if (file.size === 0) {
      return showError("That file is empty — please choose another image.");
    }
    if (file.size > QR_MAX_BYTES) {
      return showError("The QR image must be smaller than 5 MB.");
    }
    clearPayoutQrSelection();
    payoutQrFile = file;
    payoutQrPreview = URL.createObjectURL(file);
    render();
  }
  async function savePayoutDetails() {
    if (!unlocked || !payoutQrMemberId || busy) return;
    const memberId = payoutQrMemberId;
    const m = state.members.find((x) => x.id === memberId);
    busy = true;
    render();
    try {
      const fields = {
        payout_bank: payoutQrFields.bank.trim() || null,
        payout_account_name: payoutQrFields.accountName.trim() || null,
        payout_account_number: payoutQrFields.accountNumber.trim() || null,
      };
      // Upload first, save second: a failed upload must never blank the QR
      // that is already on file.
      if (payoutQrFile) {
        fields.payout_qr_url = await window.DB.uploadMemberPayoutQr(payoutQrFile, memberId);
      }
      await window.DB.saveMemberPayoutDetails(memberId, fields);
      await logActivity(
        `Treasurer updated ${m ? m.name : "a member"}'s payout details${
          payoutQrFile ? " and QR code" : ""
        }`,
        { type: "admin", memberId: memberId }
      );
      closePayoutQrModal();
      await reload();
      showSuccess(`Payout details saved for ${m ? m.name : "the member"}.`);
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  async function confirmQrUpload() {
    if (!unlocked || !qrNewFile || busy) return;
    // Same submit pattern as the contribute sheet: progress and any failure
    // report in place, with the chosen file still attached for a retry.
    const ok = await runSubmit("Uploading QR code", async () => {
      await window.DB.uploadPaymentQr(qrNewFile, "treasurer");
      await logActivity("Treasurer updated the payment QR code", { type: "admin" });
    });
    if (!ok) return;
    clearQrSelection();
    qrUploadMsg = "Payment QR code updated successfully.";
    await reload();
    render();
  }

  // ===================================================================
  // Share / status text
  // ===================================================================
  function formatDateTime(iso) {
    const d = new Date(iso);
    return (
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " · " +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    );
  }

  /** Activity-log timestamp: relative for the last day, absolute (with year for
   *  older items) after that. Local timezone throughout. */
  function activityTimeLabel(iso) {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7)
      return (
        `${days} day${days === 1 ? "" : "s"} ago · ` +
        d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
      );
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    }) + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function generateStatusText() {
    const members = sortedMembers();
    const rounds = state.payouts;
    const curCycle = C.currentCycle(state.cycles);
    const allDone = C.allRoundsComplete(state.contributions, rounds);
    const round = allDone ? null : C.currentRound(rounds, state.contributions);
    const status = round ? C.roundStatus(state.contributions, rounds, round) : null;
    const recipient = round ? members.find((m) => m.member_order === round) : null;
    const roundCollected = round
      ? C.roundCollected(state.contributions, round)
      : C.GOAL_PER_ROUND;
    const prevPending = C.pendingPayoutRounds(state.contributions, rounds);
    const due = C.dueDateOf(state.cycles, curCycle);
    const now = new Date();

    const paid = [];
    const pending = [];
    const unpaid = [];
    members.forEach((m) => {
      const s = C.statusOf(state.contributions, m.id, curCycle);
      if (s === 2) paid.push(m.name);
      else if (s === 1) pending.push(m.name);
      else unpaid.push(m.name);
    });

    let text = `⚡ ${fundName()} Update — ${C.formatDate(now)}\n`;
    if (round) {
      const label = status === "payout_pending" ? " (🟡 payout pending)" : "";
      text += `Round ${round} of ${C.TOTAL_ROUNDS} — ${
        recipient ? recipient.name : "—"
      }'s turn${label}\n`;
    } else {
      text += `✅ All ${C.TOTAL_ROUNDS} rounds completed\n`;
    }
    if (prevPending.length) {
      text += `Round ${prevPending.join(", ")}: 🟡 payout pending\n`;
    }
    if (due && status === "collecting") text += `Cycle due: ${C.formatDate(due)}\n`;
    text += `\n`;
    if (paid.length) text += `✅ Paid: ${paid.join(", ")}\n`;
    if (pending.length) text += `⏳ Pending review: ${pending.join(", ")}\n`;
    if (unpaid.length) {
      const late = due && (C.isSameDay(due, now) || due < now);
      text += `${late ? "⚠️" : "⏰"} Not yet paid: ${unpaid.join(", ")}\n`;
    }
    text += `\nThis round: ${C.peso(roundCollected)} / ${C.peso(C.GOAL_PER_ROUND)}`;
    return text;
  }

  function openShareModal() {
    shareModalOpen = true;
    copyFeedback = null;
    render();
    const ta = document.getElementById("shareTextArea");
    if (ta) ta.select();
  }
  function closeShareModal() {
    shareModalOpen = false;
    copyFeedback = null;
    render();
  }
  /**
   * A message the treasurer can paste into the group chat asking the recipient
   * for their payout details. Same clipboard pattern as Share fund status,
   * including its fallback: some browsers refuse writeText without a gesture
   * they recognise, so the text is put on screen to copy by hand instead.
   */
  function copyPayoutReminder(round) {
    const m = (state.members || []).find((x) => x.member_order === round);
    const name = m ? m.name : "you";
    const text =
      `Hi ${name}! Round ${round} of the fund is ready to pay out ` +
      `${C.peso(C.GOAL_PER_ROUND)} to you. Could you send your GCash/bank QR ` +
      `(or account name + number) so I can transfer it? Thanks!`;
    const done = () => {
      copyFeedback = "Copied!";
      render();
      window.setTimeout(() => {
        if (copyFeedback === "Copied!") {
          copyFeedback = null;
          render();
        }
      }, 2000);
    };
    try {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        showWarning("Couldn't copy automatically. Message to send: " + text);
      });
    } catch (e) {
      showWarning("Couldn't copy automatically. Message to send: " + text);
    }
  }

  function copyShareText() {
    const text = generateStatusText();
    const ta = document.getElementById("shareTextArea");
    if (ta) ta.select();
    const done = () => {
      copyFeedback = "Copied!";
      render();
      const ta2 = document.getElementById("shareTextArea");
      if (ta2) ta2.select();
    };
    const fail = () => {
      copyFeedback = "Could not auto-copy — text is selected, use Ctrl/Cmd+C";
      render();
    };
    try {
      navigator.clipboard.writeText(text).then(done).catch(fail);
    } catch (e) {
      fail();
    }
  }

  // ===================================================================
  // Render
  // ===================================================================
  function isAnyModalOpen() {
    return !!(
      modalTarget ||
      reviewTarget ||
      pinModalMode ||
      payoutModalRound ||
      shareModalOpen ||
      editNamesModalOpen ||
      reorderModalOpen ||
      restoreState != null ||
      lightboxSrc ||
      startRoundConfirming ||
      qrModalOpen ||
      confirmDialog ||
      contributePicker != null ||
      whoAmIPickerOpen
    );
  }

  /** Close whatever dialog is on top (used by the Escape key). */
  function closeTopModal() {
    if (lightboxSrc) return closeLightbox();
    if (confirmDialog) return closeConfirm();
    if (contributePicker != null) return closeContributePicker();
    if (whoAmIPickerOpen) return closeWhoAmIPicker();
    if (modalTarget) return closeModal();
    if (reviewTarget) return closeReviewModal();
    if (pinModalMode) return closePinModal();
    if (payoutModalRound) return closePayoutModal();
    if (qrModalOpen) return closeQrModal();
    if (restoreState && restoreState.phase !== "working") return closeRestoreState();
    if (reorderModalOpen) return closeReorderModal();
    if (editNamesModalOpen) return closeEditNamesModal();
    if (shareModalOpen) return closeShareModal();
    if (startRoundConfirming) return cancelStartRound();
  }

  /** Keep Tab focus inside the open dialog. */
  function trapFocus(e) {
    const root =
      document.querySelector(".lightbox-overlay") ||
      document.querySelector(".modal-overlay");
    if (!root) return;
    const els = root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]'
    );
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  /**
   * Render, with a floor under it.
   *
   * renderView() builds the whole page into a string and assigns it in one go
   * at the very end, so anything that throws part-way leaves the PREVIOUS DOM
   * on screen — still carrying live onclick handlers that call render() and
   * throw again. The result is a frozen UI: a dialog that ignores both its
   * confirm and its cancel button, with nothing in the interface to say why.
   *
   * Catching here turns that silent freeze into something a person can act on
   * and report, and keeps a way out of whatever state broke.
   */
  function render() {
    const app = document.getElementById("app");
    if (!app) return;
    try {
      renderView(app);
    } catch (e) {
      console.error("Render failed:", e);
      app.innerHTML =
        `<div class="wrap"><div class="loading">` +
        `<p><b>Something went wrong drawing this screen.</b></p>` +
        `<p class="view-placeholder-note">The app stopped before it could finish. ` +
        `Reloading usually clears it — your data is safe, nothing was saved from this screen.</p>` +
        `<p class="view-placeholder-note"><code>${escapeHtml(
          (e && e.message) || String(e)
        )}</code></p>` +
        `<button class="reset-btn" style="margin-top:16px" onclick="location.reload()">Reload</button>` +
        `</div></div>`;
    }
  }

  function renderView(app) {
    if (!state) {
      app.innerHTML = appError
        ? `<div class="loading">
             <div class="save-error-banner">⚠️ ${escapeHtml(appError)}</div>
             <button class="reset-btn" style="margin-top:16px" onclick="PowerFund.retry()">Try again</button>
           </div>`
        : `<div class="loading"><div class="loading-spinner" aria-hidden="true"></div><p>Loading fund data…</p></div>`;
      return;
    }

    const members = sortedMembers();
    const rounds = state.payouts;
    const curCycle = C.currentCycle(state.cycles); // date-driven: cycle-row highlight only

    // Round state is DB-backed (payouts.started_at / .released), so it survives
    // refresh and matches on every device. Each round's money total comes only
    // from its own cycles — a finished round never feeds the next progress bar.
    const allDone = C.allRoundsComplete(state.contributions, rounds);
    const curRound = C.currentRound(rounds, state.contributions);
    const curStatus = C.roundStatus(state.contributions, rounds, curRound); // collecting|payout_pending|completed
    const curCollected = C.roundCollected(state.contributions, curRound);
    // Who this round's payout goes to — shown in the hero so it's visible
    // without opening the Rounds & cycles accordion.
    const heroRecipient = allDone
      ? null
      : members.find((m) => m.member_order === curRound);
    const pct = allDone ? 100 : C.progressPercentRound(state.contributions, curRound);
    const prevPendingRounds = C.pendingPayoutRounds(state.contributions, rounds);
    const canStartNext = C.canStartNextRound(state.contributions, rounds);

    const pendingCount = C.pendingCount(state.contributions);
    const overdueCount = C.totalOverdueCount(state.contributions, state.cycles, state.members);
    const remainingToGo = Math.max(0, C.GOAL_PER_ROUND - curCollected);

    // The cycle to act on: earliest not-fully-paid cycle in the active round.
    // Display helper only — cycle/round membership is unchanged.
    let payCycle = null;
    if (!allDone && curStatus === "collecting") {
      const range = C.roundCycleRange(curRound);
      for (let c = range.startCycle; c <= range.endCycle; c++) {
        if (
          members.some(
            (m) => C.statusOf(state.contributions, m.id, c) !== C.STATUS_PAID
          )
        ) {
          payCycle = c;
          break;
        }
      }
    }
    const payCycleDue = payCycle ? C.dueDateOf(state.cycles, payCycle) : null;
    const cyclePaidCount = payCycle
      ? members.filter(
          (m) => C.statusOf(state.contributions, m.id, payCycle) === C.STATUS_PAID
        ).length
      : members.length;

    // ---- "My status" — personalized status for this device's remembered
    // member (if any). Display only: derived entirely from data already
    // computed above, never gates any action. ---------------------------
    const myMember = myMemberId ? members.find((m) => m.id === myMemberId) : null;
    let myStatus = null;
    if (myMember) {
      if (allDone) {
        myStatus = {
          kind: "done",
          label: `All ${C.TOTAL_ROUNDS} rounds complete — thanks, ${escapeHtml(
            myMember.name
          )}!`,
          actionCycle: null,
        };
      } else if (payCycle == null) {
        // Current round is fully funded (payout pending) — since every cycle
        // in it costs exactly members.length × CONTRIBUTION_AMOUNT to fund,
        // that only happens once every member has paid every cycle in it.
        myStatus = {
          kind: "paid",
          label: `You're paid up — Round ${curRound} is fully funded`,
          actionCycle: null,
        };
      } else {
        const myOverdue = C.memberOverdueCount(state.contributions, state.cycles, myMember.id);
        const myCycleStatus = C.statusOf(state.contributions, myMember.id, payCycle);
        // Rejected still owes the cycle, so it is actionable exactly like
        // unpaid — C.isOwed is the single place that rule lives.
        const canAct = C.isOwed(myCycleStatus);
        if (myOverdue > 0) {
          myStatus = {
            kind: "overdue",
            label: `Payment overdue — ${myOverdue} cycle${
              myOverdue === 1 ? "" : "s"
            } unpaid past due`,
            actionCycle: canAct ? payCycle : null,
          };
        } else if (myCycleStatus === C.STATUS_PENDING) {
          myStatus = {
            kind: "pending",
            label: "Submitted — awaiting treasurer verification",
            actionCycle: null,
          };
        } else if (myCycleStatus === C.STATUS_PAID) {
          myStatus = { kind: "paid", label: "You're paid up", actionCycle: null };
        } else if (myCycleStatus === C.STATUS_REJECTED) {
          // The card used to read "Payment due" here, so the one state that
          // needs explaining looked identical to a cycle nobody had touched.
          // The rejected card above carries the reason and the action; this
          // just has to agree with it.
          myStatus = {
            kind: "rejected",
            label: "Payment not accepted — please send it again",
            actionCycle: null,
          };
        } else {
          myStatus = {
            kind: "due",
            label: `Payment due${payCycleDue ? " " + C.formatDate(payCycleDue) : ""}`,
            actionCycle: payCycle,
          };
        }
      }
    }

    if (!hasAutoOpened) {
      openRound = curRound;
      hasAutoOpened = true;
    }

    // The dot is decorative; the pill always spells the state out too.
    const pill = (cls, label) =>
      `<span class="round-state ${cls}"><span class="round-dot"></span>${label}</span>`;
    const ROUND_PILL = {
      not_started: pill("not-started", "Not started"),
      collecting: pill("collecting", "Collecting"),
      payout_pending: pill("pending", "Payout Pending"),
      completed: pill("completed", "Completed"),
    };

    let html = "";

    // The app header and the banners below it render on every tab: both
    // reflect app-wide state (treasurer mode, action feedback), not the state
    // of whichever view happens to be open.
    html += `<div class="header">
      <div class="header-titles">
        <p class="title" title="${escapeHtml(fundName())}">⚡ ${escapeHtml(
      fundName()
    )}</p>
        ${(function () {
          const sub = (function () {
            const fundName = (state.settings && state.settings.fund_name) || "";
            const configured = (window.APP_CONFIG && window.APP_CONFIG.SUBTITLE) || "";
            // Before fund_name existed the group's name lived in the config
            // subtitle, so once it is set in the database the two can hold the
            // same string and the header prints it twice. Fall through to the
            // structural summary in that case.
            const duplicate =
              fundName &&
              configured.trim().toLowerCase() === fundName.trim().toLowerCase();
            if (configured && !duplicate) return configured;
            return `${members.length}-member sinking fund · ${C.peso(
              C.CONTRIBUTION_AMOUNT
            )} on the 15th & end of every month`;
          })();
          // Two subtitles, not one hidden. The long form describes the fund's
          // schedule and only fits on desktop; the short form is what the
          // design actually shows at 390px ("Group of 5 · Paluwagan"). Hiding
          // it outright lost the schedule from every phone, and a `title`
          // tooltip on a display:none element is unreachable — and never fires
          // on touch anyway.
          const short = `Group of ${members.length} · Paluwagan`;
          return `<p class="subtitle subtitle-long">${escapeHtml(sub)}</p>
        <p class="subtitle subtitle-short">${escapeHtml(short)}</p>`;
        })()}
      </div>
      <button class="unlock-btn ${
        unlocked ? "unlocked" : ""
      }" onclick="PowerFund.toggleUnlock()" aria-label="${
        unlocked ? "Treasurer mode is on — tap to lock" : "Unlock treasurer mode"
      }">
        ${icon(unlocked ? "unlocked" : "lock", 13)}<span>${
          unlocked ? "Treasurer" : "Unlock"
        }</span>
      </button>
    </div>`;

    if (appError) {
      // role="alert" so a screen reader announces a failed write on insertion.
      // Without it — and without the scroll below — a save that failed while
      // the user was further down the page was completely silent, and they
      // would reasonably assume the money went through.
      html += `<div class="save-error-banner" role="alert" id="appErrorBanner">${icon(
        "alert",
        15
      )}<span>${escapeHtml(appError)}</span>${
        appErrorRetry
          ? ` <button type="button" class="banner-retry" onclick="PowerFund.retryLastAction()">Retry</button>`
          : ""
      }<button type="button" class="warn-dismiss" onclick="PowerFund.dismissError()" aria-label="Dismiss">✕</button></div>`;
    }
    if (appWarning) {
      html += `<div class="save-warning-banner" role="status" aria-live="polite">${icon(
        "alert",
        15
      )}<span>${escapeHtml(
        appWarning
      )}</span> <button type="button" class="warn-dismiss" onclick="PowerFund.dismissWarning()" aria-label="Dismiss">✕</button></div>`;
    }

    // ---- Tab views ----
    // Content is moving out of the old single-page Home view one piece at a
    // time; tabs whose content hasn't moved across yet show a placeholder.
    // ---- Tab views ----
    // Each view is a pure function of the render-time snapshot below: it gets
    // ctx, returns a string, and touches nothing else. Adding a view means
    // adding a file in js/views/ and a line here.
    const ctx = {
      // data computed once above, shared by whichever view is open
      members, rounds, curCycle, allDone, curRound, curStatus, curCollected,
      heroRecipient, pct, prevPendingRounds, canStartNext, pendingCount,
      overdueCount, remainingToGo, payCycle, payCycleDue, cyclePaidCount,
      myMember, myStatus, ROUND_PILL,
      // UI state, snapshotted so a view can't mutate it mid-render
      state, unlocked, busy, openRound, myMemberId, attentionQueueExpanded,
      overdueListOpen, startRoundConfirming, isWide, selectedMemberId,
      undoPaidTarget, markPaidTarget,
      hasMasterPin: hasMasterPin(),
      payoutQrMemberId,
      // Helpers the views render with.
      //
      // A view file is a separate script with no access to this closure, so
      // anything it calls has to arrive here. Miss one and the view throws a
      // ReferenceError the moment that branch is reached — which can be long
      // after the feature ships, if the branch is treasurer-only or needs data
      // the fixtures don't have. tests/views.test.js guards against that.
      escapeHtml, inlineArg, icon, memberAvatar, memberStanding, batteryCell,
      getPayout, payoutRecipientName, payoutDateText, sparkline,
      formatDateTime, overdueRows, activityTimeLabel, C,
    };

    const view = window.PFViews && window.PFViews[currentView];
    let viewHtml;
    if (currentView === "activity") {
      viewHtml = renderActivityView();
    } else if (currentView === "insights") {
      viewHtml = renderInsightsView(members);
    } else if (view) {
      viewHtml = view(ctx);
    } else {
      viewHtml = renderPlaceholderView(currentView);
    }
    // The wrapper is what lets a view lay itself out differently on a wide
    // screen without its own render path — the desktop rules key off it.
    html += `<div class="view view-${currentView}">${viewHtml}</div>`;

    html += renderTabBar(currentView, isWide, myMember);

    // Transient confirmation. Rendered last so it sits above the nav, and
    // announced politely rather than assertively — it confirms something the
    // user just did, it doesn't interrupt them.
    if (appSuccess) {
      // Both are pinned to the bottom, so the toast has to sit above the
      // action button rather than on top of it.
      const cta = viewHtml.indexOf("floating-cta") !== -1 ? " above-cta" : "";
      html += `<div class="toast${cta}" role="status" aria-live="polite">
        <span class="toast-icon">${icon("check", 15)}</span>
        <span class="toast-text">${escapeHtml(appSuccess)}</span>
        <button type="button" class="toast-x" onclick="PowerFund.dismissSuccess()" aria-label="Dismiss">✕</button>
      </div>`;
    }

    // ---- Modals ----
    if (modalTarget) {
      const member = state.members.find((m) => m.id === modalTarget.memberId);
      const due = C.dueDateOf(state.cycles, modalTarget.cycleNumber);
      const maxCount = C.maxAdvanceCount(
        state.contributions,
        modalTarget.memberId,
        modalTarget.cycleNumber,
        C.roundEndCycle(modalTarget.cycleNumber)
      );
      const lastDue = C.dueDateOf(
        state.cycles,
        modalTarget.cycleNumber + modalCount - 1
      );
      const total = C.CONTRIBUTION_AMOUNT * modalCount;
      const qrUrl = qrImageUrl();
      html += `<div class="modal-overlay sheet" onclick="if(event.target===this) PowerFund.closeModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Contribute — ${member ? escapeHtml(member.name) : ""}</h3>
          <p class="modal-sub">${
            modalCount === 1
              ? `Cycle due ${due ? C.formatDate(due) : "—"}`
              : `Cycles ${due ? C.formatDate(due) : "—"} – ${
                  lastDue ? C.formatDate(lastDue) : "—"
                }`
          }</p>
          <p class="qr-scan-label">Scan to Pay</p>
          ${
            qrUrl
              ? `<button type="button" class="qr-box-btn" onclick="PowerFund.openLightbox('${inlineArg(
                  qrUrl
                )}')" aria-label="Payment QR code — activate to enlarge">
                   <span class="qr-box">
                     <img src="${escapeHtml(
                       qrUrl
                     )}" alt="Payment QR code" onerror="this.onerror=null;this.src='${inlineArg(
                  FALLBACK_QR_URL
                )}'">
                   </span>
                 </button>
                 <p class="qr-hint">🔍 Tap the QR to enlarge</p>`
              : `<div class="qr-box">QR code goes here — the treasurer needs to add the InstaPay/GCash QR image</div>`
          }
          ${
            qrUrl
              ? `<a href="${escapeHtml(
                  qrUrl
                )}" download="powerfund-qr" class="download-qr-btn">⬇ Download QR to upload in your app</a>`
              : ""
          }
          <div class="modal-amount">${C.peso(total)}</div>
          ${
            maxCount > 1
              ? `<div class="advance-row">
                   <span class="advance-label">Paying in advance?</span>
                   <div class="stepper">
                     <button onclick="PowerFund.adjustModalCount(-1)" ${
                       modalCount <= 1 ? "disabled" : ""
                     }>−</button>
                     <span class="stepper-count">${modalCount} cycle${
                  modalCount > 1 ? "s" : ""
                }</span>
                     <button onclick="PowerFund.adjustModalCount(1)" ${
                       modalCount >= maxCount ? "disabled" : ""
                     }>+</button>
                   </div>
                 </div>`
              : ""
          }
          <label class="proof-upload">
            ${
              modalProofPreview
                ? `<img src="${modalProofPreview}" class="proof-preview" alt="Payment screenshot">`
                : `<span class="proof-upload-label">📎 Attach proof of payment (required)</span>`
            }
            <input type="file" accept="image/*" onchange="PowerFund.onProofSelected(this)" hidden>
          </label>
          ${
            modalProofPreview
              ? `<button type="button" class="zoom-link" onclick="PowerFund.openLightbox('${inlineArg(
                  modalProofPreview
                )}')">🔍 View proof larger</button>`
              : `<p class="proof-required-hint">Proof of payment is required to submit.</p>`
          }
          ${submitStateHtml()}
          <div class="modal-actions">
            <button class="modal-btn-primary" onclick="PowerFund.markPending()" ${
              busy || !modalProofPreview ? "disabled" : ""
            }>${busy ? "Saving…" : "I've sent this"}</button>
            <button class="modal-btn-secondary" onclick="PowerFund.closeModal()">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    if (reviewTarget) {
      const member = state.members.find((m) => m.id === reviewTarget.memberId);
      const rc = reviewTarget.cycles;
      const firstDue = C.dueDateOf(state.cycles, rc[0]);
      const lastDue = C.dueDateOf(state.cycles, rc[rc.length - 1]);
      const total = C.CONTRIBUTION_AMOUNT * rc.length;
      const proof = C.proofOf(state.contributions, reviewTarget.memberId, rc[0]);
      const multi = rc.length > 1;
      html += `<div class="modal-overlay sheet" onclick="if(event.target===this) PowerFund.closeReviewModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Review payment — ${member ? escapeHtml(member.name) : ""}</h3>
          <p class="modal-sub">${
            multi
              ? `Cycles ${firstDue ? C.formatDate(firstDue) : "—"} – ${
                  lastDue ? C.formatDate(lastDue) : "—"
                }`
              : `Cycle due ${firstDue ? C.formatDate(firstDue) : "—"}`
          } · <b>${C.peso(total)}</b>${
        multi ? ` · ${rc.length} payments in one transfer` : ""
      }</p>
          ${
            proof
              ? `<button type="button" class="qr-box-btn" onclick="PowerFund.openLightbox('${inlineArg(
                  proof
                )}')" aria-label="Submitted payment screenshot — activate to enlarge">
                   <span class="qr-box"><img src="${escapeHtml(
                     proof
                   )}" alt="Submitted payment screenshot"></span>
                 </button>
                 <p class="qr-hint">🔍 Tap the screenshot to enlarge</p>`
              : `<div class="qr-box">No screenshot attached — member confirmed by text only</div>`
          }
          <div class="modal-meta">Check the screenshot matches <b>${C.peso(
            total
          )}</b> sent to the right account before confirming${
        multi ? ` — this approves all ${rc.length} cycles at once` : ""
      }.</div>
          <div class="modal-actions">
            ${
              rejectConfirming
                ? `<p class="reject-confirm-text">Reject this claim? ${
                    multi ? `All ${rc.length} cycles go` : "It goes"
                  } back to unpaid and ${multi ? "stay" : "stays"} due. ${
                    memberName(reviewTarget.memberId)
                  } sees your reason and can send a new screenshot.</p>
                   <label class="reject-note-label" for="reject-note">Why wasn't it accepted? <span class="field-required">required</span></label>
                   <textarea id="reject-note" class="reject-note-input" rows="2" required
                     aria-describedby="reject-note-help"
                     placeholder="e.g. The screenshot doesn't show the amount or the date clearly."
                     oninput="PowerFund.setRejectNote(this.value)">${escapeHtml(
                       rejectNoteValue
                     )}</textarea>
                   <p id="reject-note-help" class="reject-note-help">A rejection with no reason leaves the member no way to fix it — this is the only thing they are told.</p>
                   ${
                     rejectError
                       ? `<p class="pin-error" role="alert">${escapeHtml(rejectError)}</p>`
                       : ""
                   }
                   <button class="modal-btn-primary confirm-yes" onclick="PowerFund.doRejectReview()" ${
                     busy || !rejectNoteValue.trim() ? "disabled" : ""
                   }>Yes, reject</button>
                   <button class="modal-btn-secondary" onclick="PowerFund.cancelRejectConfirm()">Never mind</button>`
                : `<button class="modal-btn-primary modal-btn-confirm" onclick="PowerFund.confirmReview()" ${
                    busy ? "disabled" : ""
                  }>${
                    busy
                      ? "Working…"
                      : multi
                      ? `Confirm all ${rc.length} as paid`
                      : "Confirm as paid"
                  }</button>
                   <button class="modal-btn-secondary reject" onclick="PowerFund.rejectReview()">Reject</button>
                   <button class="modal-btn-secondary" onclick="PowerFund.closeReviewModal()">Cancel</button>`
            }
          </div>
        </div>
      </div>`;
    }

    if (pinModalMode) {
      const titles = {
        setup: "Create a treasurer PIN",
        enter: "Enter treasurer PIN",
        change: "Change treasurer PIN",
        master: hasMasterPin() ? "Change the master PIN" : "Set a master PIN",
      };
      const subs = {
        setup:
          "This protects treasurer actions. Anyone with the PIN can edit — share it only with whoever holds that role.",
        enter:
          state.settings && state.settings.master_pin
            ? "Enter the PIN to unlock treasurer actions. Forgotten it? The group's master PIN also works, then set a new one from Menu → Change PIN."
            : "Enter the PIN to unlock treasurer actions. A forgotten PIN can't be recovered — ask whoever else in the group has it.",
        change: "Set a new PIN. This replaces the current one for everyone.",
        master:
          "The master PIN is the group's way back in if the treasurer PIN is " +
          "forgotten. It also unlocks treasurer mode, so keep it somewhere safe " +
          "and separate — ideally with a second person in the group.",
      };
      // There is deliberately no PIN recovery: any reset that worked without
      // the PIN would let whoever is holding the phone take treasurer control.
      // That is a fine trade only if people are told BEFORE they forget, so
      // the warning sits on the screens where a PIN is chosen.
      const hasMaster = hasMasterPin();
      const noRecovery =
        pinModalMode === "enter" || pinModalMode === "master"
          ? ""
          : `<p class="pin-warning">${icon("alert", 14)}<span>${
              hasMaster
                ? "If this PIN is forgotten, the group's master PIN is the only way back in — keep that one somewhere safe."
                : "There is no way to recover a forgotten PIN. Write it down somewhere safe, and make sure a second person in the group knows it."
            }</span></p>`;

      // Dot-and-keypad entry, replacing a text field: it is faster one-handed,
      // gives no keyboard autofill or autocorrect to fight, and matches how
      // banking apps ask for a PIN. The hidden live region is what a screen
      // reader announces, since the dots themselves carry no text.
      //
      // There is deliberately NO auto-submit on the 4th digit: PINs here may be
      // longer than four (setup only enforces a minimum), and submitting early
      // would make a longer PIN impossible to type — a wrong attempt clears the
      // field. The confirm button costs one tap and always works.
      const dots = Array.from(
        { length: Math.max(4, pinInputValue.length) },
        (_, i) =>
          `<span class="pin-dot ${i < pinInputValue.length ? "filled" : ""}"></span>`
      ).join("");
      const keypad =
        `<div class="pin-dots" role="img" aria-label="${pinInputValue.length} digit${
          pinInputValue.length === 1 ? "" : "s"
        } entered">${dots}</div>` +
        `<div class="pin-keypad">` +
        [1, 2, 3, 4, 5, 6, 7, 8, 9].
          map(
            (n) =>
              `<button type="button" class="pin-key" onclick="PowerFund.pinKey('${n}')">${n}</button>`
          )
          .join("") +
        `<button type="button" class="pin-key pin-key-util" onclick="PowerFund.pinKey('clear')" aria-label="Clear">C</button>` +
        `<button type="button" class="pin-key" onclick="PowerFund.pinKey('0')">0</button>` +
        `<button type="button" class="pin-key pin-key-util" onclick="PowerFund.pinKey('back')" aria-label="Delete last digit">⌫</button>` +
        `</div>`;
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closePinModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">${titles[pinModalMode]}</h3>
          <p class="modal-sub">${subs[pinModalMode]}</p>
          ${keypad}
          ${pinError ? `<p class="pin-error" role="alert">${escapeHtml(pinError)}</p>` : ""}
          ${noRecovery}
          <div class="modal-actions">
            <button class="modal-btn-primary" onclick="PowerFund.submitPin()">${
              pinModalMode === "enter"
                ? "Unlock"
                : pinModalMode === "master"
                ? "Save master PIN"
                : "Save PIN"
            }</button>
            <button class="modal-btn-secondary" onclick="PowerFund.closePinModal()">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    if (payoutModalRound) {
      const recipient = members.find((m) => m.member_order === payoutModalRound);
      // What the button will actually record: the typed amount when it parses,
      // the round goal otherwise — the same fallback markPayoutReleased() uses.
      const typedAmount = parsePayoutAmount(payoutAmountValue);
      const releaseAmount = typedAmount == null ? C.GOAL_PER_ROUND : typedAmount;
      html += `<div class="modal-overlay sheet" onclick="if(event.target===this) PowerFund.closePayoutModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Release payout</h3>
          <p class="modal-sub">Round ${payoutModalRound} — ${
        recipient ? escapeHtml(recipient.name) : "—"
      } · recorded now so it stays correct if the order changes later</p>

          ${
            recipient
              ? (function () {
                  const hasAny =
                    recipient.payout_qr_url ||
                    recipient.payout_bank ||
                    recipient.payout_account_name ||
                    recipient.payout_account_number;
                  // The point of showing this here is verification: check the
                  // account name against the person before sending, since a QR
                  // image on its own is opaque.
                  if (!hasAny) {
                    return `<div class="payout-dest-warn">${icon(
                      "alert",
                      15
                    )}<span>No payout details on file for ${escapeHtml(
                      recipient.name
                    )}. Releasing still works — arrange payment another way, or ask them for a QR.</span>
                    <button type="button" class="copy-reminder-btn" onclick="PowerFund.copyPayoutReminder(${payoutModalRound})">${icon(
                      "sheet",
                      13
                    )}<span>${
                      copyFeedback ? escapeHtml(copyFeedback) : "Copy reminder message"
                    }</span></button></div>`;
                  }
                  return `<div class="payout-dest payout-dest-inline">
                    <div class="payout-dest-main">
                      ${
                        recipient.payout_qr_url
                          ? `<button type="button" class="payout-dest-qr" onclick="PowerFund.openLightbox('${inlineArg(
                              recipient.payout_qr_url
                            )}')"><img src="${escapeHtml(
                              recipient.payout_qr_url
                            )}" alt="Payout QR for ${escapeHtml(
                              recipient.name
                            )}"></button>`
                          : ""
                      }
                      <div class="payout-dest-lines">
                        <div class="payout-dest-label">Sending to</div>
                        ${
                          recipient.payout_bank
                            ? `<div class="payout-dest-bank">${escapeHtml(
                                recipient.payout_bank
                              )}</div>`
                            : ""
                        }
                        ${
                          recipient.payout_account_name
                            ? `<div class="payout-dest-name">${escapeHtml(
                                recipient.payout_account_name
                              )}</div>`
                            : ""
                        }
                        ${
                          recipient.payout_account_number
                            ? `<div class="payout-dest-num">${escapeHtml(
                                recipient.payout_account_number
                              )}</div>`
                            : ""
                        }
                      </div>
                    </div>
                  </div>`;
                })()
              : ""
          }

          <label class="payout-field-label" for="payout-amount">Amount paid out</label>
          <div class="payout-amount-wrap">
            <span class="payout-amount-prefix" aria-hidden="true">₱</span>
            <input id="payout-amount" class="pin-input payout-amount-input" type="text"
                   inputmode="decimal" value="${escapeHtml(payoutAmountValue)}"
                   oninput="PowerFund.setPayoutAmount(this.value)"
                   placeholder="${C.GOAL_PER_ROUND.toLocaleString("en-PH")}">
          </div>
          <p class="payout-field-hint">Defaults to ${C.peso(
            C.GOAL_PER_ROUND
          )} (the round target). This is a record only — it never changes funding.</p>

          <label class="payout-field-label" for="payout-note">Note (optional)</label>
          <textarea id="payout-note" class="payout-note-input" placeholder="What did they buy? (e.g. BLUETTI AC70P, ₱32,000)"
                    oninput="PowerFund.setPayoutNote(this.value)">${escapeHtml(
                      payoutNoteValue
                    )}</textarea>

          <label class="payout-field-label">Receipt photo <span class="field-required">required</span></label>
          <label class="proof-upload ${payoutReceiptPreview ? "" : "needed"}">
            ${
              payoutReceiptPreview
                ? `<img src="${payoutReceiptPreview}" class="proof-preview" alt="Receipt preview">`
                : `<span class="proof-upload-label">${icon(
                    "sheet",
                    14
                  )}<span>Attach a receipt photo</span></span>`
            }
            <input type="file" accept="image/*" onchange="PowerFund.onPayoutReceiptSelected(this)" hidden>
          </label>
          <p class="payout-field-hint">${
            payoutReceiptPreview
              ? "Kept on this round's record as proof the payout was sent."
              : "A screenshot of the transfer. This is the only evidence the payout was actually sent, so it is required before releasing."
          }</p>
          ${
            payoutReceiptPreview
              ? `<button type="button" class="zoom-link" onclick="PowerFund.removePayoutReceipt()">Remove receipt</button>`
              : ""
          }

          ${submitStateHtml()}
          ${
            // Only after an upload has actually failed. Never a first-choice
            // path — the receipt requirement stands until storage refuses.
            receiptUploadFailed
              ? `<div class="release-noreceipt">
                   <p class="release-noreceipt-text">If the money really was sent and the photo still won't upload, you can record the payout without it. The round's record will say the receipt is missing, and so will the activity log.</p>
                   <button type="button" class="modal-btn-secondary reject" onclick="PowerFund.releaseWithoutReceipt()" ${
                     busy ? "disabled" : ""
                   }>Record ${C.peso(releaseAmount)} without the receipt</button>
                 </div>`
              : ""
          }
          <div class="modal-actions">
            <button class="modal-btn-primary" onclick="PowerFund.markPayoutReleased()" ${
              busy || !payoutReceiptFile ? "disabled" : ""
            }>${busy ? "Working…" : "Release " + C.peso(releaseAmount)}</button>
            <button class="modal-btn-secondary" onclick="PowerFund.closePayoutModal()">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    if (shareModalOpen) {
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeShareModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Status update</h3>
          <p class="modal-sub">Copy this and paste it into your group chat</p>
          <textarea id="shareTextArea" class="share-text-area" readonly>${escapeHtml(
            generateStatusText()
          )}</textarea>
          ${copyFeedback ? `<p class="copy-feedback">${escapeHtml(copyFeedback)}</p>` : ""}
          <div class="modal-actions">
            <button class="modal-btn-primary" onclick="PowerFund.copyShareText()">Copy</button>
            <button class="modal-btn-secondary" onclick="PowerFund.closeShareModal()">Close</button>
          </div>
        </div>
      </div>`;
    }

    if (restoreState) {
      // One shell for all three states, as the design asks — the treasurer
      // stays in the same place from picking a file to knowing it worked.
      const body =
        restoreState.phase === "working"
          ? `<div class="submit-state working" role="status" aria-live="polite">
               <span class="submit-spinner" aria-hidden="true"></span>
               <span>Restoring your data…</span>
             </div>
             <p class="modal-sub">Replacing contributions and payout status. This only takes a moment.</p>`
          : restoreState.phase === "done"
          ? `<div class="restore-done">${icon("check", 18)}<span>Restore complete</span></div>
             <p class="modal-sub">Your data now matches the backup${
               restoreState.exportedAt
                 ? ` exported ${escapeHtml(formatDateTime(restoreState.exportedAt))}`
                 : ""
             }.</p>
             <ul class="restore-summary">
               <li><b>${restoreState.n}</b> contribution${
              restoreState.n === 1 ? "" : "s"
            } restored</li>
               <li><b>${restoreState.released}</b> released payout${
              restoreState.released === 1 ? "" : "s"
            }</li>
             </ul>`
          : `<div class="restore-invalid">${icon("alert", 18)}<span>This isn't a Power Fund backup</span></div>
             <p class="modal-sub"><b>${escapeHtml(
               restoreState.fileName
             )}</b> couldn't be used. ${escapeHtml(restoreState.reason)}</p>
             <p class="restore-hint">${icon(
               "download",
               13
             )}<span>Look for a file named like <code>power-fund-backup-YYYY-MM-DD.json</code>, exported from Menu → Backup data.</span></p>
             <p class="restore-untouched">Nothing was changed — your current data is untouched.</p>`;

      const actions =
        restoreState.phase === "working"
          ? ""
          : restoreState.phase === "done"
          ? `<button class="modal-btn-primary" onclick="PowerFund.closeRestoreState()">Done</button>`
          : `<button class="modal-btn-primary" onclick="PowerFund.chooseAnotherBackup()">Choose another file</button>
             <button class="modal-btn-secondary" onclick="PowerFund.closeRestoreState()">Cancel</button>`;

      html += `<div class="modal-overlay" onclick="${
        restoreState.phase === "working"
          ? ""
          : "if(event.target===this) PowerFund.closeRestoreState()"
      }">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Restore from backup</h3>
          ${body}
          ${actions ? `<div class="modal-actions">${actions}</div>` : ""}
        </div>
      </div>`;
    }

    if (reorderModalOpen) {
      // Up/down arrows rather than drag: the design keeps the app's existing
      // interaction because drag "is easy to fumble one-handed". There is no
      // save step — each tap swaps a pair and writes immediately, which is what
      // moveMember() already did from the roster.
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeReorderModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Reorder payout order</h3>
          <p class="modal-sub">Round N always pays whoever is in position N. Changes apply immediately — there is no separate save.</p>
          <div class="reorder-list">
            ${members
              .map(
                (m) => `<div class="reorder-row">
                  <span class="reorder-pos">${m.member_order}</span>
                  <span class="reorder-name">${escapeHtml(m.name)}</span>
                  <span class="reorder-btns">
                    <button type="button" onclick="PowerFund.moveMember('${inlineArg(
                      m.id
                    )}', -1)" ${
                  m.member_order === 1 || busy ? "disabled" : ""
                } aria-label="Move ${escapeHtml(m.name)} up">↑</button>
                    <button type="button" onclick="PowerFund.moveMember('${inlineArg(
                      m.id
                    )}', 1)" ${
                  m.member_order === members.length || busy ? "disabled" : ""
                } aria-label="Move ${escapeHtml(m.name)} down">↓</button>
                  </span>
                </div>`
              )
              .join("")}
          </div>
          <p class="reorder-note">${icon(
            "alert",
            13
          )}<span>Rounds already paid out keep their recipient — reordering only affects rounds that haven't started.</span></p>
          <div class="modal-actions">
            <button class="modal-btn-secondary" onclick="PowerFund.closeReorderModal()">Done</button>
          </div>
        </div>
      </div>`;
    }

    if (editNamesModalOpen) {
      const ordered = sortedMembers();
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeEditNamesModal()">
        <div class="modal edit-names-modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Edit member names</h3>
          <p class="modal-sub">Updates apply everywhere — payment history stays linked to each person.</p>
          ${ordered
            .map(
              (m) => `
            <input type="text" class="pin-input name-input" value="${escapeHtml(
              editNamesValues[m.id] || ""
            )}"
                   oninput="PowerFund.setEditName('${m.id}', this.value)" placeholder="Name">
          `
            )
            .join("")}
          ${editNamesError ? `<p class="pin-error">${escapeHtml(editNamesError)}</p>` : ""}
          <div class="modal-actions">
            <button class="modal-btn-primary" onclick="PowerFund.saveEditNames()" ${
              busy ? "disabled" : ""
            }>Save names</button>
            <button class="modal-btn-secondary" onclick="PowerFund.closeEditNamesModal()">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    // Treasurer: payment QR code panel
    if (qrModalOpen && unlocked) {
      const current = qrImageUrl();
      const usingCustom = !!(state.settings && state.settings.qr_code_url);
      const updatedAt = state.settings && state.settings.qr_updated_at;
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeQrModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Payment QR code</h3>
          <p class="modal-sub">Members scan this to pay the treasurer. Replacing it updates every member's app.</p>
          ${
            qrUploadMsg
              ? `<p class="copy-feedback">${icon("check", 14)} ${escapeHtml(qrUploadMsg)}</p>`
              : ""
          }
          ${
            qrNewPreview
              ? `<p class="qr-admin-label">New QR code — preview</p>
                 <div class="qr-box"><img src="${qrNewPreview}" alt="New QR code preview" class="zoomable" onclick="PowerFund.openLightbox('${inlineArg(
                  qrNewPreview
                )}')"></div>
                 <div class="modal-meta">${escapeHtml(
                   qrNewFile ? qrNewFile.name : ""
                 )}</div>
                 ${submitStateHtml()}
                 <div class="modal-actions">
                   <button class="modal-btn-primary" onclick="PowerFund.confirmQrUpload()" ${
                     busy ? "disabled" : ""
                   }>${busy ? "Uploading…" : "Upload / Replace QR code"}</button>
                   <button class="modal-btn-secondary" onclick="PowerFund.cancelQrSelection()">Cancel</button>
                 </div>`
              : `<p class="qr-admin-label">Current QR code</p>
                 <div class="qr-box">${
                   current
                     ? `<img src="${escapeHtml(
                         current
                       )}" alt="Current payment QR code" class="zoomable" onclick="PowerFund.openLightbox('${inlineArg(
                         current
                       )}')">`
                     : "No QR code set yet."
                 }</div>
                 <div class="modal-meta">${
                   usingCustom
                     ? `Updated: ${updatedAt ? formatDateTime(updatedAt) : "—"}`
                     : "Using the QR bundled with the app."
                 }</div>
                 <label class="proof-upload">
                   <span class="proof-upload-label">📷 Choose new QR code (JPG, PNG or WEBP · max 5 MB)</span>
                   <input type="file" accept="image/jpeg,image/png,image/webp" onchange="PowerFund.onQrFileSelected(this)" hidden>
                 </label>
                 <div class="modal-actions">
                   <button class="modal-btn-secondary" onclick="PowerFund.closeQrModal()">Close</button>
                 </div>`
          }
        </div>
      </div>`;
    }

    // "Record a contribution" — pick which member you are
    if (payoutQrMemberId) {
      const pm = state.members.find((x) => x.id === payoutQrMemberId);
      const f = payoutQrFields || { bank: "", accountName: "", accountNumber: "" };
      const currentQr = pm && pm.payout_qr_url;
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closePayoutQrModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="pq-title" tabindex="-1">
          <h3 id="pq-title">Payout details${pm ? " — " + escapeHtml(pm.name) : ""}</h3>
          <p class="modal-sub">Where this member's ₱${C.GOAL_PER_ROUND.toLocaleString(
            "en-PH"
          )} payout gets sent. The account name is what lets you check you're paying the right person.</p>

          <label class="field-label" for="pq-bank">Bank or e-wallet</label>
          <input id="pq-bank" class="text-input" type="text" placeholder="GCash, Maya, BPI…" value="${escapeHtml(
            f.bank
          )}" oninput="PowerFund.setPayoutQrField('bank', this.value)">

          <label class="field-label" for="pq-name">Account name</label>
          <input id="pq-name" class="text-input" type="text" placeholder="Name on the account" value="${escapeHtml(
            f.accountName
          )}" oninput="PowerFund.setPayoutQrField('accountName', this.value)">

          <label class="field-label" for="pq-num">Account or mobile number</label>
          <input id="pq-num" class="text-input" type="text" inputmode="numeric" placeholder="09XX XXX XXXX" value="${escapeHtml(
            f.accountNumber
          )}" oninput="PowerFund.setPayoutQrField('accountNumber', this.value)">

          <label class="field-label">Receiving QR code</label>
          ${
            payoutQrPreview
              ? `<img class="qr-preview" src="${payoutQrPreview}" alt="New payout QR preview">`
              : currentQr
              ? `<img class="qr-preview" src="${escapeHtml(
                  currentQr
                )}" alt="Current payout QR">`
              : `<p class="qr-empty">No QR on file yet.</p>`
          }
          <input type="file" accept="image/*" class="file-input" onchange="PowerFund.onPayoutQrFileSelected(this)">

          <div class="modal-actions">
            <button class="modal-btn-primary" onclick="PowerFund.savePayoutDetails()" ${
              busy ? "disabled" : ""
            }>${busy ? "Saving…" : "Save"}</button>
            <button class="modal-btn-secondary" onclick="PowerFund.closePayoutQrModal()">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    if (contributePicker != null) {
      const cyc = contributePicker;
      const due = C.dueDateOf(state.cycles, cyc);
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeContributePicker()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">${unlocked ? "Record / review a payment" : "Record a contribution"}</h3>
          <p class="modal-sub">${
            due ? `Cycle due ${C.formatDate(due)}` : `Cycle ${cyc}`
          } · ${C.peso(C.CONTRIBUTION_AMOUNT)} each — ${
        unlocked ? "tap a member to record or review" : "tap your name"
      }</p>
          <div class="picker-list">
            ${members
              .map((m) => {
                const s = C.statusOf(state.contributions, m.id, cyc);
                const cls =
                  s === 2 ? "paid" : s === 1 ? "pending" : s === 3 ? "rejected" : "unpaid";
                let status =
                  s === 2
                    ? "✓ Paid"
                    : s === 1
                    ? "… Sent — awaiting review"
                    : s === 3
                    ? "✕ Rejected — send it again"
                    : "Not paid yet";
                // A rejected cycle is still owed, so a member has to be able to
                // pick it and resubmit — isOwed() keeps that in step with the
                // cycle grid, which routes both states to the same handler.
                const clickable = unlocked || C.isOwed(s);
                if (unlocked && s === 1) status += " · tap to review";
                else if (unlocked && s === 2) status += " · tap to undo";
                return `<button type="button" class="picker-row ${cls}" ${
                  clickable ? "" : "disabled"
                } onclick="PowerFund.pickContributor('${m.id}')">
                  <span class="picker-name">${escapeHtml(m.name)}</span>
                  <span class="picker-status">${status}</span>
                </button>`;
              })
              .join("")}
          </div>
          <div class="modal-actions">
            <button class="modal-btn-secondary" onclick="PowerFund.closeContributePicker()">Close</button>
          </div>
        </div>
      </div>`;
    }

    // "Which member are you?" — sets the "My status" card for this device only
    if (whoAmIPickerOpen) {
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeWhoAmIPicker()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Which member are you?</h3>
          <p class="modal-sub">Remembered only on this device — never sent anywhere. Used just to show your personal status at the top of the page.</p>
          <div class="picker-list">
            ${members
              .map(
                (m) => `<button type="button" class="picker-row ${
                  m.id === myMemberId ? "paid" : ""
                }" onclick="PowerFund.setMyMember('${m.id}')">
                  <span class="picker-name">${escapeHtml(m.name)}</span>
                  ${m.id === myMemberId ? `<span class="picker-status">✓ This is me</span>` : ""}
                </button>`
              )
              .join("")}
          </div>
          <div class="modal-actions">
            ${
              myMemberId
                ? `<button class="modal-btn-secondary" onclick="PowerFund.clearMyMember()">Not on this device</button>`
                : ""
            }
            <button class="modal-btn-secondary" onclick="PowerFund.closeWhoAmIPicker()">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    // Destructive-action confirmation (revert / undo release / reset / restore)
    if (confirmDialog) {
      const d = confirmDialog;
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeConfirm()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">${escapeHtml(d.title)}</h3>
          <div class="confirm-body">${d.bodyHtml}</div>
          ${
            d.requireType
              ? `<input type="text" class="pin-input confirm-type-input" autocomplete="off" autocapitalize="characters" spellcheck="false"
                     placeholder="Type ${escapeHtml(d.requireType)}" value="${escapeHtml(d.typeValue)}"
                     oninput="PowerFund.setConfirmType(this.value)">`
              : ""
          }
          ${
            d.requirePin
              ? `<input type="password" inputmode="numeric" autocomplete="off" class="pin-input"
                     placeholder="Treasurer PIN" value="${escapeHtml(d.pinValue)}"
                     oninput="PowerFund.setConfirmPin(this.value)"
                     onkeydown="if(event.key==='Enter') PowerFund.submitConfirm()">`
              : ""
          }
          ${d.error ? `<p class="pin-error">${escapeHtml(d.error)}</p>` : ""}
          <div class="modal-actions">
            <button class="modal-btn-primary confirm-yes" onclick="PowerFund.submitConfirm()" ${
              busy ? "disabled" : ""
            }>${escapeHtml(d.confirmLabel)}</button>
            <button class="modal-btn-secondary" onclick="PowerFund.closeConfirm()">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    // Zoom lightbox — sits above every modal
    if (lightboxSrc) {
      html += `<div class="lightbox-overlay" role="dialog" aria-modal="true" aria-label="Enlarged image" tabindex="-1" onclick="PowerFund.closeLightbox()">
        <button class="lightbox-close" onclick="PowerFund.closeLightbox()">✕ Close</button>
        <img src="${escapeHtml(
          lightboxSrc
        )}" alt="Enlarged image" class="lightbox-img" onclick="event.stopPropagation()">
      </div>`;
    }

    app.innerHTML = html;

    // Move focus into a dialog the first render it appears (a11y).
    const modalNow = isAnyModalOpen();
    // Lock the page behind an open sheet/dialog. overscroll-behavior stops
    // scroll CHAINING, but a touch that begins on the overlay itself still
    // scrolled the app underneath — the sheet appeared to stick while the
    // page moved. Class-based so the CSS keeps the rule.
    document.body.classList.toggle("modal-open", modalNow);
    if (modalNow && !modalWasOpen) {
      requestAnimationFrame(() => {
        const root =
          document.querySelector(".lightbox-overlay") ||
          document.querySelector(".modal-overlay");
        if (!root) return;
        const target =
          root.querySelector(
            'input:not([type="file"]):not([disabled]), textarea:not([disabled])'
          ) ||
          root.querySelector('[tabindex="-1"]') ||
          root;
        try {
          target.focus();
        } catch (e) {
          /* no-op */
        }
      });
    }
    modalWasOpen = modalNow;
  }

  // ===================================================================
  // Init + keeping devices in sync
  // ===================================================================
  async function init() {
    // Re-render when the layout breakpoint flips, so a view that renders
    // differently wide (rounds) switches shape on resize or rotation.
    const onWideChange = (e) => {
      if (e.matches === isWide) return;
      isWide = e.matches;
      if (state) render();
    };
    if (wideQuery.addEventListener) wideQuery.addEventListener("change", onWideChange);
    else if (wideQuery.addListener) wideQuery.addListener(onWideChange); // older Safari

    try {
      await loadAll();
      render();
    } catch (e) {
      showError(e.message);
      return;
    }

    // Realtime: refresh when another device changes something.
    try {
      window.DB.subscribeToChanges(() => {
        if (!isAnyModalOpen() && !busy) reload();
      });
    } catch (e) {
      console.warn("Realtime subscription failed:", e);
    }

    // Fallbacks: slow poll + refresh when the tab regains focus.
    setInterval(() => {
      if (!isAnyModalOpen() && !busy) reload();
    }, 30000);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !isAnyModalOpen() && !busy) {
        reload();
      }
    });

    // Esc closes the top dialog; Tab is trapped inside it.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (lightboxSrc || isAnyModalOpen()) {
          e.preventDefault();
          closeTopModal();
        }
        return;
      }
      if (e.key === "Tab" && (lightboxSrc || isAnyModalOpen())) {
        trapFocus(e);
        return;
      }
      // The PIN keypad has no text field, so a physical keyboard has to be
      // wired up explicitly — otherwise the modal is mouse-only on desktop.
      // Ignored while another control has focus so typing elsewhere (the
      // confirm dialog's own PIN field) still behaves normally.
      if (pinModalMode) {
        const tag = (document.activeElement && document.activeElement.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          pinKey(e.key);
        } else if (e.key === "Backspace") {
          e.preventDefault();
          pinKey("back");
        } else if (e.key === "Enter") {
          e.preventDefault();
          submitPin();
        }
      }
    });
  }

  // ===================================================================
  // Public API (referenced from inline onclick handlers)
  // ===================================================================
  window.PowerFund = {
    retry: () => {
      appError = null;
      appErrorRetry = null;
      render();
      init();
    },
    dismissError,
    dismissWarning,
    dismissSuccess,
    toggleUnlock,
    toggleRound,
    setActivityFilter,
    setActivityMember,
    setActivityRound,
    loadMoreActivity,
    setView,
    openMemberDetail,
    openPayoutQrModal,
    closePayoutQrModal,
    setPayoutQrField,
    onPayoutQrFileSelected,
    savePayoutDetails,
    closeMemberDetail,
    openLightbox,
    closeLightbox,
    openQrModal,
    closeQrModal,
    onQrFileSelected,
    confirmQrUpload,
    cancelQrSelection,
    cellClicked,
    openContributeModal,
    closeModal,
    openContributePicker,
    closeContributePicker,
    openWhoAmIPicker,
    closeWhoAmIPicker,
    setMyMember,
    clearMyMember,
    pickContributor,
    adjustModalCount,
    onProofSelected,
    markPending,
    openReviewModal,
    closeReviewModal,
    confirmReview,
    expandAttentionQueue,
    toggleOverdueList,
    cancelUndoPaid,
    confirmUndoPaid,
    cancelMarkPaid,
    confirmMarkPaid,
    rejectReview,
    setRejectNote: (v) => {
      rejectNoteValue = v;
      rejectError = null;
      // Toggle the button in place rather than calling render(): render()
      // rebuilds innerHTML, which would destroy the textarea being typed into
      // and drop focus after the first character.
      const btn = document.querySelector(".modal-actions .confirm-yes");
      if (btn) btn.disabled = busy || !v.trim();
    },
    cancelRejectConfirm,
    doRejectReview,
    moveMember,
    resetData,
    exportCsv,
    downloadBackup,
    pickRestoreFile,
    restoreBackup,
    closeConfirm,
    setConfirmType,
    setConfirmPin,
    submitConfirm,
    closePinModal,
    openChangePin,
    openMasterPin,
    submitPin,
    pinKey,
    openPayoutModal,
    closePayoutModal,
    markPayoutReleased,
    releaseWithoutReceipt,
    unmarkPayoutReleased,
    onPayoutReceiptSelected,
    removePayoutReceipt,
    askStartNextRound,
    cancelStartRound,
    confirmStartRound,
    setPayoutNote: (v) => {
      payoutNoteValue = v;
    },
    setPayoutAmount: (v) => {
      payoutAmountValue = v;
    },
    openShareModal,
    closeShareModal,
    copyShareText,
    copyPayoutReminder,
    retryLastAction,
    retrySubmit: () => {
      if (submitState && submitState.retry) submitState.retry();
    },
    closeRestoreState,
    chooseAnotherBackup,
    openReorderModal,
    closeReorderModal,
    openEditNamesModal,
    closeEditNamesModal,
    saveEditNames,
    setEditName: (id, v) => {
      editNamesValues[id] = v;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
