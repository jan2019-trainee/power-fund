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
  const {
    members, unlocked, myMember, escapeHtml, icon, memberAvatar, C, hasMasterPin,
    authMode, sessionEmail, identityLocked, signInStatus, isTreasurerAccount,
    hasTreasurerPin,
    payoutOwner, maskAccount
  } = ctx;

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
          <div class="mode-card-note">${
            // Says WHY it is open. A flagged treasurer did not type anything, and
            // "Unlocked on this device" would misdescribe a permission that
            // actually follows their account across devices.
            isTreasurerAccount && identityLocked
              ? "Open because you're signed in as the fund's treasurer"
              : "Unlocked on this device"
          }</div>
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
      // FLAGGED TREASURER ONLY. Migration 011 makes `cycles` treasurer-only by
      // members.is_treasurer, which the shared PIN cannot express — so showing
      // this to a PIN-unlocked member would offer a button Postgres refuses.
      ...(isTreasurerAccount
        ? [
            row(
              "calendar",
              "Payment schedule",
              "PowerFund.openScheduleModal()",
              "When each cycle falls due \u2014 what marks a payment overdue"
            ),
          ]
        : []),
      row("share", "Share fund status", "PowerFund.openShareModal()"),
    ]);

    html += group("Security", [
      // Says when there ISN'T one. A Google-verified treasurer unlocks without
      // a PIN, so nothing else in the app would ever mention that the fund has
      // none — until a destructive action asks for it and cannot be satisfied.
      row(
        "key",
        hasTreasurerPin ? "Change PIN" : "Set a treasurer PIN",
        "PowerFund.openChangePin()",
        hasTreasurerPin
          ? "The PIN that unlocks treasurer mode"
          : "Not set \u2014 Reset all data, Transfer role and Remove treasurer all need it"
      ),
      // The recovery PIN had no UI at all — it existed only as a one-off SQL
      // statement, so a fund deployed without it had no way back from a
      // forgotten treasurer PIN and nothing anywhere said so.
      row(
        "lock",
        hasMasterPin ? "Change the master PIN" : "Set a master PIN",
        "PowerFund.openMasterPin()",
        hasMasterPin
          ? "The group's way back in if the treasurer PIN is forgotten"
          : "Not set — there is currently no way back from a forgotten PIN"
      ),
      // FLAGGED TREASURER ONLY. The role is `members.is_treasurer`, which Postgres checks
      // and the PIN cannot express — so handing over the PIN hands over the
      // buttons and none of the power once migration 011 is applied.
      ...(isTreasurerAccount
        ? [
            row(
              "users",
              "Transfer treasurer role",
              "PowerFund.openTransferRole()",
              "Hand the role to another member who has signed in"
            ),
          ]
        : []),
      row(
        "lock",
        "Lock treasurer mode",
        "PowerFund.toggleUnlock()",
        isTreasurerAccount && identityLocked
          ? "See the app as a member does. Tap Treasurer to come back — no PIN"
          : undefined
      ),
    ]);

    html += `<div class="danger-zone">
      <span class="danger-zone-label">⚠ Danger zone</span>
      <button class="reset-btn danger" onclick="PowerFund.resetData()">${icon(
        "trash",
        15
      )}<span>Reset all fund data</span></button>
    </div>`;
  } else {
    // Who this device belongs to. Editing your own name and photo needs a
    // LINKED ACCOUNT (migration 008): the who-am-I preference is unverified
    // and per-device, so honouring it here would let anyone with the site URL
    // pick any member and rename them. Signed in, "Edit" opens the design's
    // Edit Profile sheet; not signed in, this stays a treasurer action.
    html += myMember
      ? `<div class="profile-card">
           ${memberAvatar(myMember.name, "idle", 44, myMember.avatar_url)}
           <div class="profile-card-main">
             <div class="profile-card-label">You are</div>
             <div class="profile-card-name">${escapeHtml(myMember.name)}</div>
             <div class="profile-card-note">Payout order #${myMember.member_order}</div>
           </div>
           ${
             // Signed in? Then this is not a preference to change — the member
             // row belongs to the account. Sign out to be somebody else.
             identityLocked
               ? `<button type="button" class="profile-card-change" onclick="PowerFund.openProfileModal()">Edit</button>`
               : `<button type="button" class="profile-card-change" onclick="PowerFund.openWhoAmIPicker()">Not you?</button>`
           }
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
    // MY PAYOUT QR CODE — the design's own row, "right after the existing
    // view-only Payment QR code row" (canvas.json, my-payout-qr-notes).
    //
    // Needs a LINKED ACCOUNT, not the who-am-I preference: this is where a
    // member's ₱30,000 gets sent, and the preference is unverified and
    // per-device. `payoutOwner` is editableMember() — the same gate as Edit
    // Profile. Without it, the row still appears but explains itself rather
    // than opening a sheet that would be refused.
    if (payoutOwner) {
      const acct = [payoutOwner.payout_bank, maskAccount(payoutOwner.payout_account_number)]
        .filter(Boolean)
        .join(" · ");
      general.push(
        row(
          "qr",
          "My Payout QR Code",
          "PowerFund.openPayoutQrModal()",
          acct ||
            (payoutOwner.payout_qr_url
              ? "QR code saved"
              : "Not added yet — the treasurer sends your payout here")
        )
      );
    } else if (myMember && authMode !== "off") {
      general.push(
        row(
          "qr",
          "My Payout QR Code",
          "PowerFund.signIn()",
          "Sign in to set where your payout is sent"
        )
      );
    }
    if (myMember) {
      general.push(
        row(
          "members",
          "My standing",
          `PowerFund.openMemberDetail('${String(myMember.id).replace(/'/g, "\\'")}')`,
          "Your payments, round by round"
        )
      );
    }
    general.push(row("share", "Share fund status", "PowerFund.openShareModal()"));
    html += group("General", general);

    html += `<p class="menu-locked-note">Payment tools, exports and fund settings are only available in treasurer mode.</p>`;
  }

  // Account (migration 008). Hidden entirely while AUTH_MODE is "off", so a
  // fund that has not switched accounts on sees no trace of them. In
  // "optional" this is the only way in, which is the point: it lets one person
  // test Google sign-in without the other four hitting a gate.
  if (authMode !== "off") {
    const account = [];
    // Also here, not only on the member card above: the treasurer branch has
    // no "You are" card, so this is a signed-in treasurer's only route to
    // their own name and photo.
    if (identityLocked) {
      account.push(
        row(
          "members",
          "Edit my profile",
          "PowerFund.openProfileModal()",
          "Your display name and photo"
        )
      );
      // The treasurer branch above has no General group, so this is a
      // signed-in treasurer's only route to their OWN payout QR — they are a
      // member too, and their round comes round like everyone's. The member
      // branch gets this row under General instead, where the design puts it.
      if (unlocked && payoutOwner) {
        const own = [payoutOwner.payout_bank, maskAccount(payoutOwner.payout_account_number)]
          .filter(Boolean)
          .join(" · ");
        account.push(
          row(
            "qr",
            "My Payout QR Code",
            "PowerFund.openPayoutQrModal()",
            own ||
              (payoutOwner.payout_qr_url
                ? "QR code saved"
                : "Not added yet — where your own payout is sent")
          )
        );
      }
    }
    // FLAGGED TREASURER ONLY — gated on isTreasurerAccount (a login owning that row),
    // not on `unlocked`. The treasurer PIN is shared with all five members by
    // design, so gating this on the PIN would let any of them put their own
    // address on somebody else's row. Deciding WHO CAN SIGN IN is not a
    // day-to-day treasurer tool; it is administration.
    if (isTreasurerAccount) {
      const st = signInStatus || { total: 0, withEmail: 0, linked: 0 };
      account.push(
        row(
          "users",
          "Member sign-in",
          "PowerFund.openMemberAccountsModal()",
          st.withEmail < st.total
            ? `${st.withEmail} of ${st.total} addresses on file`
            : `${st.linked} of ${st.total} have signed in`
        )
      );
    }
    account.push(
      sessionEmail
        ? row(
            "unlocked",
            "Sign out",
            "PowerFund.signOut()",
            `Signed in as ${escapeHtml(sessionEmail)}`
          )
        : row(
            "lock",
            "Sign in with Google",
            "PowerFund.signIn()",
            "Use the account the treasurer has on file for you"
          )
    );
    html += group("Account", account);
  }

  // The design gives this flow no re-entry point at all, which makes it
  // unreachable — and untestable by the group — after its one showing.
  html += group("Learn", [
    row(
      "party",
      "Replay the intro",
      "PowerFund.replayOnboarding()",
      "The five-screen walkthrough of how the fund works"
    ),
  ]);

  html += `<div class="footer-note">
    <b>How this works</b>
    <ul class="how-it-works-list">
      <li><b>The fund:</b> ${members.length} members × ${C.peso(
    C.CONTRIBUTION_AMOUNT
  )} on the 15th &amp; end of every month → ${C.peso(
    C.GOAL_PER_ROUND
  )} payout per round, ${C.TOTAL_ROUNDS} rounds in total (${C.peso(
    C.TARGET_AMOUNT
  )} overall). Pay via the QR shown when you tap <b>Pay this cycle</b> — every payment needs a screenshot as proof</li>
      <li><b>Members:</b> tap <b>＋ Pay this cycle</b> → scan the QR → attach your payment screenshot (required) → <b>I've sent this</b></li>
      <li><b>Treasurer:</b> reviews the screenshot, then <b>Confirm</b> or <b>Reject</b>. A rejected payment keeps its record and says why, so it can be sent again. Paying several cycles in one transfer is reviewed together</li>
      <li><b>Cycle status:</b> ✓ paid · ⋯ waiting for treasurer review · ✕ rejected, send again · ! overdue (still fine to pay late) · no mark, not due yet</li>
      <li><b>Round status:</b> each round targets ${C.peso(
        C.GOAL_PER_ROUND
      )} — Collecting → Payout Pending → Completed. "Release payout" and "Start next round" are separate steps, so a previous round can stay Payout Pending while a new one collects</li>
    </ul>
  </div>`;

  return html;
};
