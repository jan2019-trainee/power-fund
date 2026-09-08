/* ---------------------------------------------------------------------------
 * View: menu
 *
 * Settings, exports and the how-it-works explainer.
 *
 * Returns an HTML string; it never touches the DOM and never writes. Everything
 * it needs arrives on `ctx`, rebuilt by render() each pass, so a view is a pure
 * function of the state at that moment.
 * ------------------------------------------------------------------------- */
window.PFViews = window.PFViews || {};

window.PFViews.menu = function (ctx) {
  const {
    members, rounds, unlocked, icon, C
  } = ctx;
  let html = "";


  html += `<div class="view-head">
    <h2 class="view-title">Menu</h2>
    <p class="view-sub">${
      unlocked
        ? "Fund settings, exports and backups"
        : "How the fund works · unlock treasurer mode for settings"
    }</p>
  </div>`;

  if (!unlocked) {
    html += `<p class="menu-locked-note">Payment tools, exports and fund settings are only available in treasurer mode.</p>`;
  }

  if (unlocked) {
    html += `<div class="menu-list">
      <button class="menu-row" onclick="PowerFund.openQrModal()"><span class="menu-row-main">${icon("qr", 17)}<span>Payment QR code</span></span><span class="menu-row-chevron">›</span></button>
      <button class="menu-row" onclick="PowerFund.openEditNamesModal()"><span class="menu-row-main">${icon("users", 17)}<span>Edit member names</span></span><span class="menu-row-chevron">›</span></button>
      <button class="menu-row" onclick="PowerFund.openChangePin()"><span class="menu-row-main">${icon("key", 17)}<span>Change PIN</span></span><span class="menu-row-chevron">›</span></button>
    </div>
    <p class="section-label">Data</p>
    <div class="menu-list">
      <button class="menu-row" onclick="PowerFund.exportCsv()"><span class="menu-row-main">${icon("sheet", 17)}<span>Export CSV summary</span></span><span class="menu-row-chevron">›</span></button>
      <button class="menu-row" onclick="PowerFund.downloadBackup()"><span class="menu-row-main">${icon("download", 17)}<span>Download backup</span></span><span class="menu-row-chevron">›</span></button>
      <button class="menu-row" onclick="PowerFund.pickRestoreFile()"><span class="menu-row-main">${icon("upload", 17)}<span>Restore from backup</span></span><span class="menu-row-chevron">›</span></button>
    </div>
    <div class="danger-zone">
      <span class="danger-zone-label">⚠ Danger zone</span>
      <button class="reset-btn danger" onclick="PowerFund.resetData()">${icon("trash", 15)}<span>Reset all data</span></button>
    </div>`;
  }

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
      )} — Collecting → Payout Pending → Completed. "Mark payout released" and "Start next round" are separate steps, so a previous round can stay Payout Pending while a new one collects</li>
    </ul>
  </div>`;

  return html;
};
