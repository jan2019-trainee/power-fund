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

  // ---- Data cache (filled by loadAll) ---------------------------------
  let state = null; // { members, cycles, contributions, payouts, activityLog, settings }
  let cycleIdByNumber = {}; // cycle_number -> cycle uuid  (for writes)

  // ---- UI state (not persisted) -------------------------------------
  let unlocked = false; // treasurer mode
  let busy = false; // a write is in flight — block double clicks
  let appError = null; // string shown in the red banner
  let openRound = null;
  let hasAutoOpened = false;

  let modalTarget = null; // { memberId, cycleNumber }
  let modalCount = 1;
  let modalProofFile = null; // File chosen in the contribute modal
  let modalProofPreview = null; // object URL for the local preview

  let reviewTarget = null; // { memberId, cycleNumber }
  let rejectConfirming = false;
  let resetConfirming = false;
  let startRoundConfirming = false; // inline confirm for "Start Next Round"

  let pinModalMode = null; // null | 'setup' | 'enter' | 'change'
  let pinInputValue = "";
  let pinError = null;

  let payoutModalRound = null;
  let payoutNoteValue = "";

  let activityLogOpen = false;
  let shareModalOpen = false;
  let copyFeedback = null;

  let editNamesModalOpen = false;
  let editNamesValues = {};
  let editNamesError = null;

  let lightboxSrc = null; // image URL shown full-screen in the zoom lightbox

  let qrModalOpen = false; // treasurer "Payment QR code" panel
  let qrNewFile = null; // File the treasurer picked
  let qrNewPreview = null; // object URL for the preview
  let qrUploadMsg = null; // success / info line inside the QR panel

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
      }
    );
  }

  function payoutDateText(released_on) {
    if (!released_on) return "";
    return C.formatDate(C.parseDueDate(released_on));
  }

  function showError(msg) {
    appError = msg || "Something went wrong. Please try again.";
    console.error("App error:", msg);
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
    await window.DB.addActivityLog(message);
  }

  // ===================================================================
  // Load / reload
  // ===================================================================
  async function loadAll() {
    const data = await window.DB.loadEverything();

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
    if (appError && /database|connection|internet/i.test(appError)) appError = null;
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
    modalTarget = { memberId, cycleNumber };
    modalCount = 1;
    clearProofSelection();
    render();
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
      await logActivity(`${memberName(memberId)} marked ${range} as sent`);
      closeModal();
      await reload();
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

    busy = true;
    render();
    try {
      const cycleId = cycleIdByNumber[cycleNumber];
      if (status === C.STATUS_PAID) {
        const row = C.contributionFor(state.contributions, memberId, cycleNumber);
        await window.DB.deleteContribution(memberId, cycleId);
        if (row && row.proof_url) await window.DB.deleteProof(row.proof_url);
        await logActivity(
          `Treasurer reverted ${memberName(memberId)}'s cycle ${cycleNumber} to unpaid`
        );
      } else {
        await window.DB.upsertContribution({
          cycleId,
          memberId,
          amount: C.CONTRIBUTION_AMOUNT,
          status: C.STATUS_PAID,
        });
        await logActivity(
          `Treasurer recorded ${memberName(memberId)}'s cycle ${cycleNumber} as paid (direct)`
        );
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
  // Review modal (treasurer confirms / rejects a pending claim)
  // ===================================================================
  function openReviewModal(memberId, cycleNumber) {
    reviewTarget = { memberId, cycleNumber };
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
    const { memberId, cycleNumber } = reviewTarget;
    busy = true;
    render();
    try {
      const row = C.contributionFor(state.contributions, memberId, cycleNumber);
      if (row) {
        await window.DB.updateContribution(row.id, {
          status: C.STATUS_PAID,
          paid_at: new Date().toISOString(),
        });
      }
      await logActivity(
        `Treasurer confirmed ${memberName(memberId)}'s cycle ${cycleNumber} as paid`
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
    const { memberId, cycleNumber } = reviewTarget;
    busy = true;
    render();
    try {
      const row = C.contributionFor(state.contributions, memberId, cycleNumber);
      await window.DB.deleteContribution(memberId, cycleIdByNumber[cycleNumber]);
      if (row && row.proof_url) await window.DB.deleteProof(row.proof_url);
      await logActivity(
        `Treasurer rejected ${memberName(memberId)}'s cycle ${cycleNumber} claim`
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
    resetConfirming = true;
    render();
  }
  function cancelResetConfirm() {
    resetConfirming = false;
    render();
  }
  async function doReset() {
    if (busy) return;
    busy = true;
    resetConfirming = false;
    render();
    try {
      await window.DB.resetAll();
      await logActivity("Fund was reset — all contributions cleared");
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

  function todayStamp() {
    return new Date().toISOString().slice(0, 10);
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
    const ok = window.confirm(
      "Restore from this backup?\n\nThis REPLACES all current contributions and payout status with the contents of the file. This cannot be undone."
    );
    if (!ok) return;

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
    payoutNoteValue = getPayout(round).note || "";
    render();
  }
  function closePayoutModal() {
    payoutModalRound = null;
    payoutNoteValue = "";
    render();
  }

  async function markPayoutReleased() {
    if (!payoutModalRound || busy) return;
    const round = payoutModalRound;
    const recipient = sortedMembers().find((m) => m.member_order === round);
    busy = true;
    render();
    try {
      await window.DB.updatePayout(round, {
        released: true,
        note: payoutNoteValue || null,
        released_on: todayStamp(),
      });
      await logActivity(
        `Payout released — Round ${round} (${recipient ? recipient.name : "—"})` +
          (payoutNoteValue ? ": " + payoutNoteValue : "")
      );
      closePayoutModal();
      await reload();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      render();
    }
  }

  async function unmarkPayoutReleased(round) {
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
      qrModalOpen
    );
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
        : `<div class="loading">Loading fund data…</div>`;
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
    const pct = allDone ? 100 : C.progressPercentRound(state.contributions, curRound);
    const prevPendingRounds = C.pendingPayoutRounds(state.contributions, rounds);
    const canStartNext = C.canStartNextRound(state.contributions, rounds);

    const pendingCount = C.pendingCount(state.contributions);
    const overdueCount = C.totalOverdueCount(state.contributions, state.cycles, state.members);

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

    // due countdown (only while the active round is still collecting)
    html += (function () {
      if (allDone || curStatus !== "collecting") return "";
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

    // Previous round(s) still waiting for their payout — shown separately so
    // nobody confuses last round's ₱30,000 with the active round's progress.
    // Starting the next round never releases these; the treasurer still uses
    // "Mark payout released" here (same modal as always).
    prevPendingRounds.forEach((r) => {
      const collected = C.roundCollected(state.contributions, r);
      const recip = members.find((m) => m.member_order === r);
      html += `<div class="prev-round">
        <div class="prev-round-label">Previous round — awaiting payout</div>
        <div class="prev-round-title">Round ${r}${
        recip ? ` — ${escapeHtml(recip.name)}` : ""
      } ${ROUND_PILL.payout_pending}</div>
        <div class="prev-round-meta">${C.peso(collected)} / ${C.peso(C.GOAL_PER_ROUND)}</div>
        ${
          unlocked
            ? `<div class="prev-round-actions">
                 <button class="contribute-btn payout-btn" onclick="PowerFund.openPayoutModal(${r})">Mark payout released</button>
               </div>`
            : ""
        }
      </div>`;
    });

    html += `<div class="battery-hero">
      <div class="battery-hero-top">
        <div class="battery-amount">${
          allDone
            ? `${C.peso(C.TARGET_AMOUNT)} <span>/ ${C.peso(C.TARGET_AMOUNT)}</span>`
            : `${C.peso(curCollected)} <span>/ ${C.peso(C.GOAL_PER_ROUND)}</span>`
        }</div>
        <div class="battery-meta">${
          allDone
            ? "✅ All 5 Rounds Completed"
            : `Round ${curRound} of ${C.TOTAL_ROUNDS} &nbsp; ${ROUND_PILL[curStatus]}`
        }</div>
      </div>
      <div class="battery-shell"><div class="battery-fill" style="width:${pct}%"></div></div>
      <div class="cycle-note">${C.peso(C.CONTRIBUTION_AMOUNT)} per person via QR to treasurer${
      pendingCount
        ? ` · <b style="color:var(--accent)">${pendingCount} pending review</b>`
        : ""
    }${overdueCount ? ` · <b style="color:#E15353">${overdueCount} overdue</b>` : ""}</div>
      ${
        !allDone && unlocked && curStatus === "payout_pending"
          ? `<div class="hero-payout-actions">
               <span class="prev-round-meta">🟡 ${C.peso(
                 C.GOAL_PER_ROUND
               )} target reached — release the payout or start the next round.</span>
               <div class="prev-round-actions">
                 <button class="contribute-btn payout-btn" onclick="PowerFund.openPayoutModal(${curRound})">Mark payout released</button>
               </div>
             </div>`
          : ""
      }
      ${
        !allDone && unlocked && canStartNext
          ? startRoundConfirming
            ? `<div class="start-round-confirm">
                 <p class="reset-confirm-text">Round ${curRound} has reached ${C.peso(
                C.GOAL_PER_ROUND
              )} and payout is still pending. Start Round ${curRound + 1}?</p>
                 <div class="start-round-confirm-btns">
                   <button class="modal-btn-secondary" onclick="PowerFund.cancelStartRound()">Cancel</button>
                   <button class="modal-btn-primary" onclick="PowerFund.confirmStartRound()" ${
                     busy ? "disabled" : ""
                   }>Start Round ${curRound + 1}</button>
                 </div>
               </div>`
            : `<button class="contribute-btn" onclick="PowerFund.askStartNextRound()">▶ Start Round ${
                curRound + 1
              }</button>`
          : ""
      }
      <button class="share-btn" onclick="PowerFund.openShareModal()">📋 Copy status update</button>
    </div>`;

    // member cards
    html += `<p class="section-label">Members</p><div class="member-grid">`;
    members.forEach((m) => {
      const total = C.totalPerMember(state.contributions, m.id);
      const payoutCycle = m.member_order * C.CYCLES_PER_ROUND;
      const payoutDue = C.dueDateOf(state.cycles, payoutCycle);
      const mOverdue = C.memberOverdueCount(state.contributions, state.cycles, m.id);
      const paidOut = getPayout(m.member_order).released;
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
        <div class="round-header" onclick="PowerFund.toggleRound(${r})">
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
                    return `<span class="member-chip ${cls} ${
                      clickable ? "editable" : ""
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
                   <div>✅ Payout released ${
                     payout.released_on ? `on ${payoutDateText(payout.released_on)}` : ""
                   }${payout.note ? ` — ${escapeHtml(payout.note)}` : ""}</div>
                   ${
                     unlocked
                       ? `<button class="reset-btn" onclick="PowerFund.unmarkPayoutReleased(${r})">Undo</button>`
                       : ""
                   }
                 </div>`
              : unlocked && fullyFunded
              ? `<div class="payout-status-box pending-box">
                   <div>🟡 Payout Pending — ${C.peso(C.GOAL_PER_ROUND)} reached</div>
                   <button class="contribute-btn payout-btn" onclick="PowerFund.openPayoutModal(${r})">Mark payout released</button>
                 </div>`
              : fullyFunded
              ? `<div class="payout-status-box pending-box"><div>🟡 Payout Pending — ${C.peso(
                  C.GOAL_PER_ROUND
                )} reached</div></div>`
              : ""
          }
        </div>
      </div>`;
    }

    // activity log
    html += (function () {
      const log = state.activityLog || [];
      return `<div class="round activity-section">
        <div class="round-header" onclick="PowerFund.toggleActivityLog()">
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
                  <span class="activity-time">${formatDateTime(e.created_at)}</span>
                  <span class="activity-text">${escapeHtml(e.message)}</span>
                </div>`
                  )
                  .join("")}</div>`
          }
        </div>
      </div>`;
    })();

    html += `<div class="footer-note">
      <b>How this works</b>
      <ul class="how-it-works-list">
        <li>Tap a cycle box → scan the QR → mark "I've sent this"</li>
        <li>Treasurer reviews the screenshot, then confirms or rejects</li>
        <li><span style="color:#E15353">Red</span> = overdue (still OK to pay late) · <span style="color:var(--accent)">Amber</span> = pending review</li>
        <li>Once a round hits ${C.peso(
          C.GOAL_PER_ROUND
        )}, the treasurer marks the payout released</li>
      </ul>
    </div>`;

    if (unlocked) {
      html += `<div class="reset-row">
        ${
          resetConfirming
            ? `<span class="reset-confirm-text">Reset everything?</span>
               <button class="reset-btn confirm-yes" onclick="PowerFund.doReset()">Yes, reset</button>
               <button class="reset-btn" onclick="PowerFund.cancelResetConfirm()">Cancel</button>`
            : `<button class="reset-btn" onclick="PowerFund.openQrModal()">Payment QR</button>
               <button class="reset-btn" onclick="PowerFund.openEditNamesModal()">Edit names</button>
               <button class="reset-btn" onclick="PowerFund.exportCsv()">Export CSV</button>
               <button class="reset-btn" onclick="PowerFund.downloadBackup()">Download backup</button>
               <button class="reset-btn" onclick="PowerFund.pickRestoreFile()">Restore backup</button>
               <button class="reset-btn" onclick="PowerFund.openChangePin()">Change PIN</button>
               <button class="reset-btn" onclick="PowerFund.resetData()">Reset all data</button>`
        }
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
        <div class="modal">
          <h3>Contribute — ${member ? escapeHtml(member.name) : ""}</h3>
          <p class="modal-sub">${
            modalCount === 1
              ? `Cycle due ${due ? C.formatDate(due) : "—"}`
              : `Cycles ${due ? C.formatDate(due) : "—"} – ${
                  lastDue ? C.formatDate(lastDue) : "—"
                }`
          }</p>
          <p class="qr-scan-label">Scan to Pay</p>
          <div class="qr-box">
            ${
              qrUrl
                ? `<img src="${escapeHtml(
                    qrUrl
                  )}" alt="Payment QR code - tap to enlarge" class="zoomable" onclick="PowerFund.openLightbox('${inlineArg(
                    qrUrl
                  )}')" onerror="this.onerror=null;this.src='${inlineArg(
                    FALLBACK_QR_URL
                  )}'">`
                : "QR code goes here - the treasurer needs to add the InstaPay/GCash QR image"
            }
          </div>
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
      const due = C.dueDateOf(state.cycles, reviewTarget.cycleNumber);
      const proof = C.proofOf(
        state.contributions,
        reviewTarget.memberId,
        reviewTarget.cycleNumber
      );
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeReviewModal()">
        <div class="modal">
          <h3>Review payment — ${member ? escapeHtml(member.name) : ""}</h3>
          <p class="modal-sub">Cycle due ${
            due ? C.formatDate(due) : "—"
          } · ${C.peso(C.CONTRIBUTION_AMOUNT)}</p>
          <div class="qr-box">
            ${
              proof
                ? `<img src="${escapeHtml(
                    proof
                  )}" alt="Submitted payment screenshot — tap to enlarge" class="zoomable" onclick="PowerFund.openLightbox('${inlineArg(
                    proof
                  )}')">`
                : "No screenshot attached — member confirmed by text only"
            }
          </div>
          <div class="modal-meta">${
            proof ? "Tap the screenshot to enlarge it. " : ""
          }Check it matches ${C.peso(
            C.CONTRIBUTION_AMOUNT
          )} sent to the right account before confirming.</div>
          <div class="modal-actions">
            ${
              rejectConfirming
                ? `<p class="reject-confirm-text">Reject this claim? It goes back to unpaid and the screenshot is removed.</p>
                   <button class="modal-btn-primary confirm-yes" onclick="PowerFund.doRejectReview()" ${
                     busy ? "disabled" : ""
                   }>Yes, reject</button>
                   <button class="modal-btn-secondary" onclick="PowerFund.cancelRejectConfirm()">Never mind</button>`
                : `<button class="modal-btn-primary" onclick="PowerFund.confirmReview()" ${
                    busy ? "disabled" : ""
                  }>${busy ? "Working…" : "Confirm as paid"}</button>
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
        <div class="modal">
          <h3>${titles[pinModalMode]}</h3>
          <p class="modal-sub">${subs[pinModalMode]}</p>
          <input type="password" inputmode="numeric" class="pin-input" placeholder="PIN" value="${escapeHtml(
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
        <div class="modal">
          <h3>Mark payout released</h3>
          <p class="modal-sub">Round ${payoutModalRound} — ${
        recipient ? escapeHtml(recipient.name) : ""
      } · ${C.peso(C.GOAL_PER_ROUND)}</p>
          <textarea class="payout-note-input" placeholder="Optional: what did they buy? (e.g. BLUETTI AC70P, ₱32,000)"
                    oninput="PowerFund.setPayoutNote(this.value)">${escapeHtml(
                      payoutNoteValue
                    )}</textarea>
          <div class="modal-actions">
            <button class="modal-btn-primary" onclick="PowerFund.markPayoutReleased()" ${
              busy ? "disabled" : ""
            }>Confirm released</button>
            <button class="modal-btn-secondary" onclick="PowerFund.closePayoutModal()">Cancel</button>
          </div>
        </div>
      </div>`;
    }

    if (shareModalOpen) {
      html += `<div class="modal-overlay" onclick="if(event.target===this) PowerFund.closeShareModal()">
        <div class="modal">
          <h3>Status update</h3>
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
        <div class="modal edit-names-modal">
          <h3>Edit member names</h3>
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
        <div class="modal">
          <h3>Payment QR code</h3>
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

    // Zoom lightbox — sits above every modal
    if (lightboxSrc) {
      html += `<div class="lightbox-overlay" onclick="PowerFund.closeLightbox()">
        <button class="lightbox-close" onclick="PowerFund.closeLightbox()">✕ Close</button>
        <img src="${escapeHtml(
          lightboxSrc
        )}" alt="Enlarged image" class="lightbox-img" onclick="event.stopPropagation()">
      </div>`;
    }

    app.innerHTML = html;
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

    // Esc closes the zoom lightbox.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && lightboxSrc) closeLightbox();
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
    toggleUnlock,
    toggleRound,
    toggleActivityLog,
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
    adjustModalCount,
    onProofSelected,
    markPending,
    openReviewModal,
    closeReviewModal,
    confirmReview,
    rejectReview,
    cancelRejectConfirm,
    doRejectReview,
    moveMember,
    resetData,
    cancelResetConfirm,
    doReset,
    exportCsv,
    downloadBackup,
    pickRestoreFile,
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
    askStartNextRound,
    cancelStartRound,
    confirmStartRound,
    setPayoutNote: (v) => {
      payoutNoteValue = v;
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
