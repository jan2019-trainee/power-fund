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
  let unlocked = false; // treasurer mode
  let busy = false; // a write is in flight — block double clicks
  let appError = null; // string shown in the red banner
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
  let rejectConfirming = false;
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

  let payoutModalRound = null;
  let payoutNoteValue = "";
  let payoutAmountValue = ""; // string in the release modal; blank => the ₱30,000 default
  let payoutReceiptFile = null; // optional receipt image the treasurer attaches
  let payoutReceiptPreview = null; // object URL for its preview

  let activityLogOpen = false;
  let activityLogLimit = 30; // grows when the treasurer taps "Show older"
  let shareModalOpen = false;
  let copyFeedback = null;

  let attentionQueueExpanded = false; // "show N more" in the review queue
  let overdueListOpen = false; // overdue detail list in the attention panel

  let editNamesModalOpen = false;
  let editNamesValues = {};
  let editNamesError = null;

  let lightboxSrc = null; // image URL shown full-screen in the zoom lightbox

  let qrModalOpen = false; // treasurer "Payment QR code" panel
  let qrNewFile = null; // File the treasurer picked
  let qrNewPreview = null; // object URL for the preview
  let qrUploadMsg = null; // success / info line inside the QR panel

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

  function showError(msg) {
    appError = msg || "Something went wrong. Please try again.";
    appWarning = null; // a hard error supersedes a soft warning
    appSuccess = null; // ...and a stale success notice
    clearTimeout(successTimer);
    console.error("App error:", msg);
    render();
  }

  /** A softer banner: the main action worked, but something alongside it didn't. */
  function showWarning(msg) {
    appWarning = msg || null;
    if (msg) console.warn("App warning:", msg);
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
      }, 6000);
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

  async function logActivity(message) {
    const ok = await window.DB.addActivityLog(message);
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

    busy = true;
    render();
    try {
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
        )}`
      );
      closeModal();
      await reload();
      showSuccess(
        `✅ Payment submitted — ${C.peso(
          count * C.CONTRIBUTION_AMOUNT
        )} is waiting for treasurer verification.`
      );
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  // ===================================================================
  // Clicking a member chip in a cycle row
  // ===================================================================
  async function cellClicked(memberId, cycleNumber) {
    if (busy) return;
    const status = C.statusOf(state.contributions, memberId, cycleNumber);

    if (!unlocked) {
      if (status === C.STATUS_UNPAID) {
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
      openConfirm({
        kind: "revert",
        title: "Mark this contribution as unpaid?",
        bodyHtml:
          `Move <b>${escapeHtml(memberName(memberId))}</b>'s ` +
          `<b>${due ? escapeHtml(C.formatDate(due)) : "cycle " + cycleNumber}</b> ` +
          `contribution back to unpaid?<br><br>` +
          `This removes <b>${C.peso(C.CONTRIBUTION_AMOUNT)}</b> from Round ` +
          `${C.roundOfCycle(cycleNumber)}'s total. Any payment screenshot is ` +
          `kept in the archive, not deleted.`,
        confirmLabel: "Yes, mark unpaid",
        ctx: { memberId, cycleNumber },
      });
      return;
    }

    // Unpaid → treasurer records it as paid directly (cash). Not destructive.
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
        )}`
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
          outcome.logSuffix
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
    render();
  }

  function closeReviewModal() {
    reviewTarget = null;
    rejectConfirming = false;
    render();
  }

  async function confirmReview() {
    if (!reviewTarget || busy) return;
    const { memberId, cycles } = reviewTarget;
    await confirmCycles(memberId, cycles);
  }

  /** Confirm a batch straight from the review queue (skips opening the modal). */
  async function confirmBatch(memberId, firstCycle) {
    if (busy) return;
    const cycles = C.pendingRun(state.contributions, memberId, firstCycle);
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
        )} as paid — ${C.peso(total)}`
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
  function cancelRejectConfirm() {
    rejectConfirming = false;
    render();
  }

  async function doRejectReview() {
    if (!reviewTarget || busy) return;
    const { memberId, cycles } = reviewTarget;
    busy = true;
    render();
    try {
      const rows = cycles
        .map((c) => C.contributionFor(state.contributions, memberId, c))
        .filter(Boolean);
      const proof =
        (rows[0] && rows[0].proof_url) ||
        C.proofOf(state.contributions, memberId, cycles[0]);
      const removedIds = rows.map((r) => r.id);

      for (const c of cycles) {
        await window.DB.deleteContribution(memberId, cycleIdByNumber[c]);
      }

      // The batch shares one screenshot — keep it (archive), don't delete it.
      const outcome = await preserveProof(proof, removedIds);

      await logActivity(
        `Treasurer rejected ${memberName(memberId)}'s ${cycleRangeLabel(
          cycles
        )} claim` + outcome.logSuffix
      );
      closeReviewModal();
      await reload();
      if (outcome.warning) {
        showWarning(
          "The claim was rejected, but its payment screenshot could not be " +
            "archived — it is still at its original URL. See the activity log."
        );
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
        `Payout order: ${a.name} swapped positions with ${b.name}`
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
      await logActivity("Fund was reset — all contributions cleared");
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
      return showError("That file isn't valid JSON.");
    }
    if (!data || !Array.isArray(data.contributions)) {
      return showError("That file doesn't look like a Power Fund backup.");
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
    busy = true;
    render();
    try {
      await window.DB.restoreFromBackup(data);
      await logActivity("Fund data restored from a backup file");
      await reload();
    } catch (e) {
      showError(e.message);
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

  function openChangePin() {
    pinInputValue = "";
    pinError = null;
    pinModalMode = "change";
    render();
  }

  async function submitPin() {
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
            : "Treasurer PIN was set for the first time"
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
      if (pinInputValue === (state.settings && state.settings.treasurer_pin)) {
        unlocked = true;
        closePinModal();
      } else {
        pinError = "Incorrect PIN. Try again.";
        pinInputValue = "";
        render();
      }
    }
  }

  // ===================================================================
  // Payout release
  // ===================================================================
  function openPayoutModal(round) {
    payoutModalRound = round;
    const existing = getPayout(round);
    payoutNoteValue = existing.note || "";
    payoutAmountValue =
      existing.amount != null ? String(existing.amount) : String(C.GOAL_PER_ROUND);
    clearPayoutReceipt();
    render();
  }
  function closePayoutModal() {
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

  async function markPayoutReleased() {
    if (!payoutModalRound || busy) return;
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
      // The receipt image is optional — if its upload fails (e.g. the storage
      // bucket isn't set up), the payout must STILL be releasable. Degrade to
      // a warning, don't abort.
      let receiptUrl = null;
      let receiptWarning = false;
      if (payoutReceiptFile) {
        try {
          receiptUrl = await window.DB.uploadPayoutReceipt(payoutReceiptFile, round);
        } catch (e) {
          receiptWarning = true;
          console.warn("Payout receipt upload failed:", e.message);
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
          (receiptWarning ? " — receipt image was NOT saved" : "")
      );
      closePayoutModal();
      await reload();

      const problems = [];
      if (receiptWarning) {
        problems.push(
          "the receipt image could not be uploaded — the 'payment-assets' " +
            "storage bucket isn't set up (run supabase/migrations/003)"
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
        `The round returns to <b>🟡 Payout Pending</b>. The recorded release date, ` +
        `note, amount and recipient are cleared.`,
      confirmLabel: "Yes, undo release",
      ctx: { round },
    });
  }

  async function doUnmarkPayoutReleased(round) {
    if (busy) return;
    const recipient = sortedMembers().find((m) => m.member_order === round);
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
        `Payout release undone — Round ${round} (${recipient ? recipient.name : "—"})`
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
  // This is a SEPARATE action from "Mark payout released" — starting round
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
        await logActivity(`Treasurer started Round ${next}`);
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
      await logActivity(`Name(s) updated: ${changes.join(", ")}`);
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
  function toggleActivityLog() {
    activityLogOpen = !activityLogOpen;
    render();
  }
  function expandAttentionQueue() {
    attentionQueueExpanded = true;
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

  async function confirmQrUpload() {
    if (!unlocked || !qrNewFile || busy) return;
    busy = true;
    render();
    try {
      await window.DB.uploadPaymentQr(qrNewFile, "treasurer");
      await logActivity("Treasurer updated the payment QR code");
      clearQrSelection();
      qrUploadMsg = "Payment QR code updated successfully.";
      await reload();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
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

    let text = `⚡ Power Fund Update — ${C.formatDate(now)}\n`;
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

  function render() {
    const app = document.getElementById("app");
    if (!app) return;

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
    const curCycle = C.currentCycle(state.cycles); // date-driven: due countdown + row highlight only

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
          label: `🎉 All ${C.TOTAL_ROUNDS} rounds complete — thanks, ${escapeHtml(
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
          label: `🟢 You're paid up — Round ${curRound} is fully funded`,
          actionCycle: null,
        };
      } else {
        const myOverdue = C.memberOverdueCount(state.contributions, state.cycles, myMember.id);
        const myCycleStatus = C.statusOf(state.contributions, myMember.id, payCycle);
        const canAct = myCycleStatus === C.STATUS_UNPAID;
        if (myOverdue > 0) {
          myStatus = {
            kind: "overdue",
            label: `🔴 Payment overdue — ${myOverdue} cycle${
              myOverdue === 1 ? "" : "s"
            } unpaid past due`,
            actionCycle: canAct ? payCycle : null,
          };
        } else if (myCycleStatus === C.STATUS_PENDING) {
          myStatus = {
            kind: "pending",
            label: "🟣 Submitted — awaiting treasurer verification",
            actionCycle: null,
          };
        } else if (myCycleStatus === C.STATUS_PAID) {
          myStatus = { kind: "paid", label: "🟢 You're paid up", actionCycle: null };
        } else {
          myStatus = {
            kind: "due",
            label: `🟡 Payment due${payCycleDue ? " " + C.formatDate(payCycleDue) : ""}`,
            actionCycle: payCycle,
          };
        }
      }
    }

    if (!hasAutoOpened) {
      openRound = curRound;
      hasAutoOpened = true;
    }

    const ROUND_PILL = {
      not_started: '<span class="round-state not-started">⚪ Not started</span>',
      collecting: '<span class="round-state collecting">🟢 Collecting</span>',
      payout_pending: '<span class="round-state pending">🟡 Payout Pending</span>',
      completed: '<span class="round-state completed">✅ Completed</span>',
    };

    let html = "";

    html += `<div class="header">
      <div>
        <p class="title">⚡ Power Fund</p>
        <p class="subtitle">${members.length}-member sinking fund · ${C.peso(
      C.CONTRIBUTION_AMOUNT
    )} on the 15th &amp; end of every month</p>
      </div>
      <button class="unlock-btn ${unlocked ? "unlocked" : ""}" onclick="PowerFund.toggleUnlock()">
        ${unlocked ? "🔓 Treasurer mode on" : "🔒 Unlock treasurer mode"}
      </button>
    </div>`;

    // ---- My status: personalized, only shown once a member has set "who
    // am I on this device" — never forced, never gates anything. ----------
    html += (function () {
      if (myMember && myStatus) {
        return `<div class="my-status-card my-status-${myStatus.kind}">
          <div class="my-status-row">
            <span class="my-status-text"><b>${escapeHtml(
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

    // due countdown (only while the active round is still collecting)
    html += (function () {
      if (allDone || curStatus !== "collecting") return "";
      // Skip when the My-status card above is already announcing this exact
      // same cycle's due date ("🟡 Payment due ..."). They only diverge when
      // this member (or the whole group) has moved ahead of the fund's
      // date-driven "current" cycle — e.g. everyone already paid it early —
      // in which case payCycle != curCycle and both banners stay, because
      // they're then reporting genuinely different dates.
      if (myMember && myStatus && myStatus.kind === "due" && payCycle === curCycle) {
        return "";
      }
      const today = C.startOfDay(new Date());
      const due = C.dueDateOf(state.cycles, curCycle);
      if (!due) return "";
      const daysUntil = Math.round((due - today) / 86400000);
      let label, cls;
      if (daysUntil <= 0) {
        label = "Due today";
        cls = "due-urgent";
      } else if (daysUntil === 1) {
        label = "Due tomorrow";
        cls = "due-urgent";
      } else if (daysUntil <= 3) {
        label = `Due in ${daysUntil} days`;
        cls = "due-soon";
      } else {
        label = `Due in ${daysUntil} days`;
        cls = "due-normal";
      }
      return `<div class="due-countdown ${cls}">⏰ ${label} — ${C.formatDate(due)}</div>`;
    })();

    if (appError) {
      html += `<div class="save-error-banner">⚠️ ${escapeHtml(appError)}</div>`;
    }
    if (appWarning) {
      html += `<div class="save-warning-banner">⚠️ ${escapeHtml(
        appWarning
      )} <button type="button" class="warn-dismiss" onclick="PowerFund.dismissWarning()" aria-label="Dismiss">✕</button></div>`;
    }
    if (appSuccess) {
      html += `<div class="save-success-banner" role="status">${escapeHtml(
        appSuccess
      )} <button type="button" class="warn-dismiss" onclick="PowerFund.dismissSuccess()" aria-label="Dismiss">✕</button></div>`;
    }

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
            ? "Fund complete ✅"
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

      if (batches.length || releaseRounds.length || canStartNext || overdueCount) {
        html += `<div class="attention-panel">
          <p class="attention-title">⚠ Needs your attention</p>`;

        // 1) pending review queue
        if (batches.length) {
          const shown = attentionQueueExpanded ? batches : batches.slice(0, 6);
          html += `<div class="attention-group">
            <p class="attention-group-label">🔔 ${
              batches.length === 1
                ? "1 payment"
                : batches.length + " payments"
            } waiting for your review</p>
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
            <p class="attention-group-label">🟡 Round ${r}${
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
    html += `<div class="battery-hero">
      <div class="hero-round-line">
        ${
          allDone
            ? `<span class="hero-round-num">✅ All ${C.TOTAL_ROUNDS} Rounds Completed</span>`
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
      <div class="battery-shell" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(
        pct
      )}" aria-label="Round ${
      allDone ? C.TOTAL_ROUNDS : curRound
    } funding progress"><div class="battery-fill" style="width:${pct}%"></div></div>
      <div class="hero-progress-meta">${
        allDone
          ? "Fund fully funded"
          : `<b>${C.peso(remainingToGo)}</b> to go · ${Math.round(pct)}%`
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

    // member cards
    html += `<p class="section-label">Members</p><div class="member-grid">`;
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
        <p class="member-name">${escapeHtml(m.name)}</p>
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
        }${paidOut ? ' <span class="payout-done-tag">✅ done</span>' : ""}</div>
        ${mOverdue ? `<div class="overdue-badge">⚠ ${mOverdue} overdue</div>` : ""}
      </div>`;
    });
    html += `</div>`;

    // rounds & cycles
    html += `<p class="section-label">Rounds &amp; cycles</p>`;
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
                   <div>✅ Payout released to <b>${escapeHtml(
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
                      )}')">🧾 receipt</button>`
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
                `<div class="payout-status-box pending-box"><div>🟡 Payout Pending — ${C.peso(
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
                )}')">🧾 View receipt</button>`
              : ""
          }
        </div>`;
      });
      html += `</div>`;
    })();

    // activity log
    html += (function () {
      const log = state.activityLog || [];
      return `<div class="round activity-section">
        <div class="round-header" role="button" tabindex="0" aria-expanded="${
          activityLogOpen ? "true" : "false"
        }" onclick="PowerFund.toggleActivityLog()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();PowerFund.toggleActivityLog()}">
          <div class="round-title"><span class="round-chevron ${
            activityLogOpen ? "open" : ""
          }">▸</span> Activity log</div>
          <div class="round-status">${log.length} ${
        log.length === 1 ? "entry" : "entries"
      }</div>
        </div>
        <div class="round-body ${activityLogOpen ? "open" : ""}">
          ${
            log.length === 0
              ? '<p class="activity-empty">No activity yet — actions will show up here as your group uses the tracker.</p>'
              : `<div class="activity-list">${log
                  .map(
                    (e) => `
                <div class="activity-item">
                  <span class="activity-time">${escapeHtml(
                    activityTimeLabel(e.created_at)
                  )}</span>
                  <span class="activity-text">${escapeHtml(e.message)}</span>
                </div>`
                  )
                  .join("")}</div>
                ${
                  log.length >= activityLogLimit
                    ? `<button type="button" class="attention-more activity-more" onclick="PowerFund.loadMoreActivity()">Show older entries</button>`
                    : ""
                }`
          }
        </div>
      </div>`;
    })();

    html += `<div class="footer-note">
      <b>How this works</b>
      <ul class="how-it-works-list">
        <li><b>The fund:</b> ${members.length} members × ${C.peso(
      C.CONTRIBUTION_AMOUNT
    )} on the 15th &amp; end of every month → ${C.peso(
      C.GOAL_PER_ROUND
    )} payout per round, ${C.TOTAL_ROUNDS} rounds in total (${C.peso(
      C.TARGET_AMOUNT
    )} overall). Pay via the QR shown in "Record a contribution" — every payment needs a screenshot as proof</li>
        <li><b>Members:</b> tap <b>＋ Record a contribution</b> → scan the QR → attach your payment screenshot (required) → <b>I've sent this</b></li>
        <li><b>Treasurer:</b> reviews the screenshot, then <b>Confirm</b> or <b>Reject</b>. Paying several cycles in one transfer is reviewed together</li>
        <li><b>Cycle status:</b> ✓ paid · … waiting for treasurer review · ✕ not paid (overdue is still fine to pay late)</li>
        <li><b>Round status:</b> each round targets ${C.peso(
          C.GOAL_PER_ROUND
        )} — 🟢 Collecting → 🟡 Payout Pending → ✅ Completed. "Mark payout released" and "Start next round" are separate steps, so a previous round can stay Payout Pending while a new one collects</li>
      </ul>
    </div>`;

    if (unlocked) {
      html += `<div class="reset-row">
        <button class="reset-btn" onclick="PowerFund.openQrModal()">Payment QR</button>
        <button class="reset-btn" onclick="PowerFund.openEditNamesModal()">Edit names</button>
        <button class="reset-btn" onclick="PowerFund.exportCsv()">Export CSV</button>
        <button class="reset-btn" onclick="PowerFund.downloadBackup()">Download backup</button>
        <button class="reset-btn" onclick="PowerFund.pickRestoreFile()">Restore backup</button>
        <button class="reset-btn" onclick="PowerFund.openChangePin()">Change PIN</button>
      </div>
      <div class="danger-zone">
        <span class="danger-zone-label">⚠ Danger zone</span>
        <button class="reset-btn danger" onclick="PowerFund.resetData()">Reset all data</button>
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
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeModal()">
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
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeReviewModal()">
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
                  } back to unpaid. The screenshot is kept in the archive.</p>
                   <button class="modal-btn-primary confirm-yes" onclick="PowerFund.doRejectReview()" ${
                     busy ? "disabled" : ""
                   }>Yes, reject</button>
                   <button class="modal-btn-secondary" onclick="PowerFund.cancelRejectConfirm()">Never mind</button>`
                : `<button class="modal-btn-primary" onclick="PowerFund.confirmReview()" ${
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
      };
      const subs = {
        setup:
          "This protects treasurer actions. Anyone with the PIN can edit — share it only with whoever holds that role.",
        enter: "Enter the PIN to unlock treasurer actions.",
        change: "Set a new PIN. This replaces the current one for everyone.",
      };
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closePinModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">${titles[pinModalMode]}</h3>
          <p class="modal-sub">${subs[pinModalMode]}</p>
          <input type="password" inputmode="numeric" autocomplete="off" class="pin-input" placeholder="PIN" value="${escapeHtml(
            pinInputValue
          )}"
                 oninput="PowerFund.setPinInput(this.value)" onkeydown="if(event.key==='Enter') PowerFund.submitPin()">
          ${pinError ? `<p class="pin-error">${escapeHtml(pinError)}</p>` : ""}
          <div class="modal-actions">
            <button class="modal-btn-primary" onclick="PowerFund.submitPin()">${
              pinModalMode === "enter" ? "Unlock" : "Save PIN"
            }</button>
            <button class="modal-btn-secondary" onclick="PowerFund.closePinModal()">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    if (payoutModalRound) {
      const recipient = members.find((m) => m.member_order === payoutModalRound);
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closePayoutModal()">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title" tabindex="-1">
          <h3 id="dlg-title">Mark payout released</h3>
          <p class="modal-sub">Round ${payoutModalRound} — ${
        recipient ? escapeHtml(recipient.name) : "—"
      } · recorded now so it stays correct if the order changes later</p>

          <label class="payout-field-label" for="payout-amount">Amount paid out</label>
          <input id="payout-amount" class="pin-input payout-amount-input" type="text"
                 inputmode="decimal" value="${escapeHtml(payoutAmountValue)}"
                 oninput="PowerFund.setPayoutAmount(this.value)"
                 placeholder="${C.GOAL_PER_ROUND}">
          <p class="payout-field-hint">Defaults to ${C.peso(
            C.GOAL_PER_ROUND
          )} (the round target). This is a record only — it never changes funding.</p>

          <label class="payout-field-label" for="payout-note">Note (optional)</label>
          <textarea id="payout-note" class="payout-note-input" placeholder="What did they buy? (e.g. BLUETTI AC70P, ₱32,000)"
                    oninput="PowerFund.setPayoutNote(this.value)">${escapeHtml(
                      payoutNoteValue
                    )}</textarea>

          <label class="proof-upload">
            ${
              payoutReceiptPreview
                ? `<img src="${payoutReceiptPreview}" class="proof-preview" alt="Receipt preview">`
                : `<span class="proof-upload-label">🧾 Attach a receipt (optional)</span>`
            }
            <input type="file" accept="image/*" onchange="PowerFund.onPayoutReceiptSelected(this)" hidden>
          </label>
          ${
            payoutReceiptPreview
              ? `<button type="button" class="zoom-link" onclick="PowerFund.removePayoutReceipt()">Remove receipt</button>`
              : ""
          }

          <div class="modal-actions">
            <button class="modal-btn-primary" onclick="PowerFund.markPayoutReleased()" ${
              busy ? "disabled" : ""
            }>${busy ? "Working…" : "Confirm released"}</button>
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
              ? `<p class="copy-feedback">✅ ${escapeHtml(qrUploadMsg)}</p>`
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
                const cls = s === 2 ? "paid" : s === 1 ? "pending" : "unpaid";
                let status =
                  s === 2
                    ? "✓ Paid"
                    : s === 1
                    ? "… Sent — awaiting review"
                    : "Not paid yet";
                const clickable = unlocked || s === 0;
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
      }
    });
  }

  // ===================================================================
  // Public API (referenced from inline onclick handlers)
  // ===================================================================
  window.PowerFund = {
    retry: () => {
      appError = null;
      render();
      init();
    },
    dismissWarning,
    dismissSuccess,
    toggleUnlock,
    toggleRound,
    toggleActivityLog,
    loadMoreActivity,
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
    confirmBatch,
    expandAttentionQueue,
    toggleOverdueList,
    rejectReview,
    cancelRejectConfirm,
    doRejectReview,
    moveMember,
    resetData,
    exportCsv,
    downloadBackup,
    pickRestoreFile,
    closeConfirm,
    setConfirmType,
    setConfirmPin,
    submitConfirm,
    closePinModal,
    openChangePin,
    submitPin,
    setPinInput: (v) => {
      pinInputValue = v;
    },
    openPayoutModal,
    closePayoutModal,
    markPayoutReleased,
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
