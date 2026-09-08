/* ---------------------------------------------------------------------------
 * View: menu
 *
 * Settings, exports and the how-it-works explainer — the same tab showing two
 * quite different things depending on whether treasurer mode is unlocked.
 *
 * Grouped the way the design groups it (canvas.json, menu-pin-notes): Payments,
 * Data, Group, Security, and a Danger zone kept visibly apart, "matching the
 * real app's existing pattern of never making destructive actions one
 * accidental tap away".
 *
 * Returns an HTML string; it never touches the DOM and never writes. Everything
 * it needs arrives on `ctx`, rebuilt by render() each pass, so a view is a pure
 * function of the state at that moment.
 * ------------------------------------------------------------------------- */
window.PFViews = window.PFViews || {};

window.PFViews.menu = function (ctx) {
  const { members, unlocked, myMember, escapeHtml, icon, memberAvatar, C } = ctx;

  /** One tappable settings row. `note` is the quiet second line. */
  const row = (iconName, label, action, note) =>
    `<button type="button" class="menu-row" onclick="${action}">
      <span class="menu-row-main">${icon(iconName, 17)}<span class="menu-row-text">
        <span class="menu-row-label">${label}</span>
        ${note ? `<span class="menu-row-note">${note}</span>` : ""}
      </span></span>
      <span class="menu-row-chevron">›</span>
    </button>`;

  const group = (label, rows) =>
    `<p class="section-label">${label}</p><div class="menu-list">${rows.join("")}</div>`;

  let html = `<div class="view-head">
    <h2 class="view-title">Menu</h2>
    <p class="view-sub">${
      unlocked ? "Treasurer tools &amp; settings" : "You &amp; this app"
    }</p>
  </div>`;

  if (unlocked) {
    // States which side of the gate you are on, and is the way back through it.
    html += `<div class="mode-card on">
      <div class="mode-card-main">
        ${icon("unlocked", 16)}
        <div>
          <div class="mode-card-title">Treasurer mode</div>
          <div class="mode-card-note">Unlocked on this device</div>
        </div>
      </div>
      <span class="mode-card-state">Active</span>
    </div>`;

    html += group("Payments", [
      row("qr", "Payment QR code", "PowerFund.openQrModal()", "What members scan to pay"),
    ]);

    html += group("Data", [
      row("sheet", "Export CSV summary", "PowerFund.exportCsv()"),
      row("download", "Backup data (JSON)", "PowerFund.downloadBackup()"),
      row("upload", "Restore from backup", "PowerFund.pickRestoreFile()"),
    ]);

    html += group("Group", [
      row("users", "Edit member names", "PowerFund.openEditNamesModal()"),
      row(
        "rounds",
        "Reorder payout order",
        "PowerFund.openReorderModal()",
        "Round N always pays whoever is in position N"
      ),
      row("share", "Share fund status", "PowerFund.openShareModal()"),
    ]);

    html += group("Security", [
      row("key", "Change PIN", "PowerFund.openChangePin()"),
      row("lock", "Lock treasurer mode", "PowerFund.toggleUnlock()"),
    ]);

    html += `<div class="danger-zone">
      <span class="danger-zone-label">⚠ Danger zone</span>
      <button class="reset-btn danger" onclick="PowerFund.resetData()">${icon(
        "trash",
        15
      )}<span>Reset all fund data</span></button>
    </div>`;
  } else {
    // Who this device belongs to. The name itself is not editable here: with no
    // per-member authentication any device could rename anyone, so renaming
    // stays a treasurer action — same reasoning as the payout QR.
    html += myMember
      ? `<div class="profile-card">
           ${memberAvatar(myMember.name, "idle", 44)}
           <div class="profile-card-main">
             <div class="profile-card-label">You are</div>
             <div class="profile-card-name">${escapeHtml(myMember.name)}</div>
             <div class="profile-card-note">Payout order #${myMember.member_order}</div>
           </div>
           <button type="button" class="profile-card-change" onclick="PowerFund.openWhoAmIPicker()">Not you?</button>
         </div>`
      : `<button type="button" class="my-status-setup" onclick="PowerFund.openWhoAmIPicker()">👋 Which member are you? Tap to personalise this app.</button>`;

    const general = [
      row(
        "qr",
        "Payment QR code",
        "PowerFund.openQrModal()",
        "View only · the treasurer manages this"
      ),
    ];
    if (myMember) {
      general.push(
        row(
          "members",
          "My payout destination",
          `PowerFund.openMemberDetail('${String(myMember.id).replace(/'/g, "\\'")}')`,
          "Where you receive money when it's your turn"
        )
      );
    }
    general.push(row("share", "Share fund status", "PowerFund.openShareModal()"));
    html += group("General", general);

    html += `<p class="menu-locked-note">Payment tools, exports and fund settings are only available in treasurer mode.</p>`;
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
      <li><b>Treasurer:</b> reviews the screenshot, then <b>Confirm</b> or <b>Reject</b>. A rejected payment keeps its record and says why, so it can be sent again. Paying several cycles in one transfer is reviewed together</li>
      <li><b>Cycle status:</b> ✓ paid · … waiting for treasurer review · ✕ rejected, send again · not paid (overdue is still fine to pay late)</li>
      <li><b>Round status:</b> each round targets ${C.peso(
        C.GOAL_PER_ROUND
      )} — Collecting → Payout Pending → Completed. "Release payout" and "Start next round" are separate steps, so a previous round can stay Payout Pending while a new one collects</li>
    </ul>
  </div>`;

  return html;
};
