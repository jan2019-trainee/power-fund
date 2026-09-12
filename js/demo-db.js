/* ---------------------------------------------------------------------------
 * Power Fund — DEMO DATA LAYER  (branch: demo/group-walkthrough)
 *
 * Replaces `window.DB` with an in-browser store when APP_CONFIG.DEMO_MODE is
 * true, and does NOTHING otherwise — so this file being present does not
 * change the app. Loaded after js/database.js, which is left untouched.
 *
 * WHY THIS EXISTS. The ask was "auth optional so I can switch members without
 * their Google accounts". Against the live project that cannot work:
 * migration 011 revokes `anon`, so signed out reads nothing; and signed in
 * sets `identityLocked`, so the who-am-I picker is refused. See the note in
 * js/config.js. With the data in the browser there is no auth to satisfy and
 * no identity to lock, so every member is switchable from Menu -> "Not you?".
 *
 * WHAT IT GUARANTEES
 *   * No network. The Supabase client is never called, so a demo cannot write
 *     to the real fund no matter which button is pressed.
 *   * It persists (localStorage), so the demo survives a reload and a phone
 *     locking itself mid-sentence.
 *   * Every one of the 53 functions js/database.js exports is implemented, so
 *     no screen can hit an undefined and take the app down mid-demo.
 *
 * WHAT IT IS NOT
 *   * Not a second implementation of the business rules. The rules live in
 *     js/calculations.js and in Postgres; this is a dumb store. Where the real
 *     database would REFUSE something (011's policies, 010's guard trigger,
 *     013/014's functions), the demo does not — a demo is not where
 *     permissions get tested, tests/sql/run.sh is.
 * ------------------------------------------------------------------------- */

(function () {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  if (!cfg.DEMO_MODE) return; // main behaviour, untouched

  const KEY = "pf_demo_v1";
  const seed = window.PF_DEMO_SEED;
  if (!seed) {
    console.error("DEMO_MODE is on but js/demo-seed.js did not load.");
    return;
  }

  // ---- the store -----------------------------------------------------
  let db = null;

  function fresh() {
    return JSON.parse(JSON.stringify(seed));
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // A seed that gained a table since this browser last ran the demo
        // must not leave that table undefined — every reader would throw.
        Object.keys(seed).forEach((k) => {
          if (parsed[k] === undefined) parsed[k] = fresh()[k];
        });
        return parsed;
      }
    } catch (e) {
      console.warn("Demo store unreadable — starting from the seed.", e);
    }
    return fresh();
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (e) {
      // Quota, usually an uploaded image. The demo keeps working from memory
      // for this session rather than dying on a save.
      console.warn("Demo store is full — this session only from here.", e);
    }
  }
  db = load();

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const uuid = () =>
    "d" + Date.now().toString(16) + "-0000-4000-8000-" +
    Math.floor(Math.random() * 1e12).toString().padStart(12, "0").slice(0, 12);
  const nowIso = () => new Date().toISOString();

  /** Every read goes through this, so a caller can never hold a reference
   *  into the store and mutate it by accident — the same isolation a real
   *  network round-trip gives for free. */
  const rows = (t) => clone(db[t] || []);

  function requireRow(list, pred, what) {
    const row = list.find(pred);
    if (!row) throw new Error(what + " — that record no longer exists.");
    return row;
  }

  // ---- images --------------------------------------------------------
  /**
   * Uploads become data URLs so a demo of the proof flow actually shows the
   * screenshot. DOWNSCALED HARD first: a phone screenshot is 2–5 MB and
   * localStorage is ~5 MB total, so storing one raw would fill the store and
   * every later write would fail.
   */
  function toDataUrl(file, maxPx) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type || "")) {
        return reject(new Error("Please choose an image file."));
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        try {
          const max = maxPx || 720;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement("canvas");
          cv.width = w;
          cv.height = h;
          cv.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL("image/jpeg", 0.6));
        } catch (e) {
          reject(e);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("That image could not be read."));
      };
      img.src = url;
    });
  }

  // ---- members -------------------------------------------------------
  function getMembers() {
    return Promise.resolve(
      rows("members").sort((a, b) => a.member_order - b.member_order)
    );
  }
  function addMember(name, memberOrder) {
    const row = {
      id: uuid(),
      name: String(name).trim(),
      member_order: memberOrder,
      email: null,
      auth_user_id: null,
      is_treasurer: false,
      avatar_url: null,
      payout_bank: null,
      payout_account_name: null,
      payout_account_number: null,
      payout_qr_url: null,
      payout_updated_at: null,
    };
    db.members.push(row);
    save();
    return Promise.resolve(clone(row));
  }
  function updateMember(id, fields) {
    const row = requireRow(db.members, (m) => m.id === id, "Couldn't update member");
    Object.assign(row, fields);
    save();
    return Promise.resolve([clone(row)]);
  }
  function unlinkMemberAccount(id) {
    return updateMember(id, { auth_user_id: null });
  }
  function deleteMember(id) {
    db.members = db.members.filter((m) => m.id !== id);
    save();
    return Promise.resolve();
  }
  function swapMemberOrder(aId, bId) {
    const a = requireRow(db.members, (m) => m.id === aId, "Couldn't change payout order");
    const b = requireRow(db.members, (m) => m.id === bId, "Couldn't change payout order");
    const t = a.member_order;
    a.member_order = b.member_order;
    b.member_order = t;
    addActivityLog(
      "Payout order: " + a.name + " swapped positions with " + b.name,
      { type: "admin", memberId: a.id, round: Math.min(a.member_order, b.member_order) }
    );
    save();
    return getMembers();
  }

  // ---- swap requests (013) -------------------------------------------
  function getSwapRequests() {
    return Promise.resolve(
      rows("swap_requests").sort((x, y) =>
        String(y.created_at).localeCompare(String(x.created_at))
      )
    );
  }
  function swapsAvailable() {
    return true;
  }
  /** The demo's "who am I" is the per-device preference, which is exactly
   *  what makes member switching work here. */
  function demoMe() {
    let id = null;
    try {
      id = localStorage.getItem("pf_my_member_id");
    } catch (e) {}
    return db.members.find((m) => m.id === id) || null;
  }
  function requestSwap(toMemberId, note) {
    const me = demoMe();
    if (!me) throw new Error("Pick which member you are first (Menu → Not you?).");
    const them = requireRow(db.members, (m) => m.id === toMemberId, "Couldn't send that");
    db.swap_requests.forEach((r) => {
      if (r.from_member_id === me.id && r.status === "pending") {
        r.status = "cancelled";
        r.resolved_at = nowIso();
      }
    });
    const row = {
      id: uuid(),
      from_member_id: me.id,
      to_member_id: them.id,
      from_round: me.member_order,
      to_round: them.member_order,
      status: "pending",
      note: (note || "").trim() || null,
      created_at: nowIso(),
      resolved_at: null,
    };
    db.swap_requests.push(row);
    save();
    return Promise.resolve(clone(row));
  }
  function acceptSwap(id) {
    const r = requireRow(db.swap_requests, (x) => x.id === id, "Couldn't accept that swap");
    const a = db.members.find((m) => m.id === r.from_member_id);
    const b = db.members.find((m) => m.id === r.to_member_id);
    // The same staleness rule 013 enforces, because the app branches on it.
    if (!a || !b || a.member_order !== r.from_round || b.member_order !== r.to_round) {
      r.status = "stale";
      r.resolved_at = nowIso();
      save();
      return Promise.resolve(clone(r));
    }
    const t = a.member_order;
    a.member_order = b.member_order;
    b.member_order = t;
    r.status = "accepted";
    r.resolved_at = nowIso();
    addActivityLog(
      a.name + " and " + b.name + " swapped turns — Round " + r.from_round +
        " ↔ Round " + r.to_round + " (both agreed)",
      { type: "admin", memberId: a.id, round: Math.min(r.from_round, r.to_round) }
    );
    save();
    return Promise.resolve(clone(r));
  }
  const resolveSwap = (status) => (id) => {
    const r = requireRow(db.swap_requests, (x) => x.id === id, "Couldn't update that");
    r.status = status;
    r.resolved_at = nowIso();
    save();
    return Promise.resolve(clone(r));
  };
  const declineSwap = resolveSwap("declined");
  const cancelSwap = resolveSwap("cancelled");

  // ---- cycles --------------------------------------------------------
  function getCycles() {
    return Promise.resolve(
      rows("cycles").sort((a, b) => a.cycle_number - b.cycle_number)
    );
  }
  function updateCycleDueDates(updates) {
    (updates || []).forEach((u) => {
      const c = db.cycles.find((x) => x.cycle_number === u.cycle_number || x.id === u.id);
      if (c) c.due_date = u.due_date;
    });
    save();
    return Promise.resolve();
  }

  // ---- contributions -------------------------------------------------
  function getContributions() {
    return Promise.resolve(rows("contributions"));
  }
  function getContributionsForCycle(cycleId) {
    return Promise.resolve(rows("contributions").filter((c) => c.cycle_id === cycleId));
  }
  function oneContribution(row) {
    const existing = db.contributions.find(
      (c) => c.cycle_id === row.cycle_id && c.member_id === row.member_id
    );
    if (existing) {
      Object.assign(existing, row);
      return existing;
    }
    const made = Object.assign(
      {
        id: uuid(),
        amount: 1000,
        proof_url: null,
        paid_at: null,
        created_at: nowIso(),
        rejection_note: null,
        rejected_at: null,
      },
      row
    );
    db.contributions.push(made);
    return made;
  }
  function upsertContribution(row) {
    const made = oneContribution(row);
    save();
    return Promise.resolve([clone(made)]);
  }
  function upsertContributions(list) {
    const out = (list || []).map(oneContribution);
    save();
    return Promise.resolve(clone(out));
  }
  function updateContribution(id, fields) {
    const row = requireRow(db.contributions, (c) => c.id === id, "Couldn't update that payment");
    Object.assign(row, fields);
    save();
    return Promise.resolve([clone(row)]);
  }
  function deleteContribution(id) {
    db.contributions = db.contributions.filter((c) => c.id !== id);
    save();
    return Promise.resolve();
  }
  function rejectContributions(ids, note) {
    const out = [];
    (ids || []).forEach((id) => {
      const row = db.contributions.find((c) => c.id === id);
      if (!row) return;
      row.status = 3;
      row.rejection_note = (note || "").trim() || null;
      row.rejected_at = nowIso();
      row.paid_at = null;
      out.push(row);
    });
    save();
    return Promise.resolve(clone(out));
  }

  // ---- storage -------------------------------------------------------
  // Written out as NAMED functions with their arguments spelled, rather than
  // `const uploadProof = upload(720)`. A closure hides the signature, and the
  // signature is the one thing about this file that has to match
  // js/database.js — tests/demo.test.js can only compare what it can read.
  function uploadProof(file, memberId, cycleNumber) {
    return toDataUrl(file, 720);
  }
  function uploadPaymentQr(file, updatedBy) {
    return toDataUrl(file, 900); // a QR has to stay scannable
  }
  function uploadPayoutReceipt(file, roundNumber) {
    return toDataUrl(file, 720);
  }
  // FILE FIRST, matching js/database.js — uploadMemberPayoutQr(file, memberId)
  // and uploadMemberAvatar(blob, memberId). Reversing these read the member id
  // as the image and every upload failed with "choose an image file".
  function uploadMemberPayoutQr(file, memberId) {
    return toDataUrl(file, 900);
  }
  function uploadMemberAvatar(blob, memberId) {
    return toDataUrl(blob, 256);
  }
  const noopUrl = () => Promise.resolve();
  const deleteProof = noopUrl;
  const archiveProof = noopUrl;
  const deletePaymentAsset = noopUrl;
  function removeMemberAvatar(memberId) {
    return updateMember(memberId, { avatar_url: null }).then(() => undefined);
  }
  function saveMemberPayoutDetails(memberId, fields) {
    return updateMember(
      memberId,
      Object.assign({ payout_updated_at: nowIso() }, fields)
    );
  }

  // ---- payouts -------------------------------------------------------
  function getPayouts() {
    return Promise.resolve(
      rows("payouts").sort((a, b) => a.round_number - b.round_number)
    );
  }
  function payoutRow(round) {
    return requireRow(
      db.payouts,
      (p) => Number(p.round_number) === Number(round),
      "Couldn't update that round"
    );
  }
  function updatePayout(round, fields) {
    const row = payoutRow(round);
    Object.assign(row, fields);
    save();
    return Promise.resolve([clone(row)]);
  }
  function confirmPayoutReceived(round, note) {
    const row = payoutRow(round);
    row.received_at = nowIso();
    row.received_note = (note || "").trim() || null;
    // 014's guard clears the dispute server-side, and the app relies on that.
    row.disputed_at = null;
    row.disputed_note = null;
    save();
    return Promise.resolve([clone(row)]);
  }
  function disputePayout(round, note) {
    const row = payoutRow(round);
    row.disputed_at = nowIso();
    row.disputed_note = (note || "").trim() || null;
    save();
    return Promise.resolve([clone(row)]);
  }
  function clearPayoutDispute(round) {
    const row = payoutRow(round);
    row.disputed_at = null;
    row.disputed_note = null;
    save();
    return Promise.resolve([clone(row)]);
  }
  function startRound(round) {
    const row = payoutRow(round);
    if (row.started_at) return Promise.resolve([]); // already started
    row.started_at = nowIso();
    save();
    return Promise.resolve([clone(row)]);
  }

  // ---- activity log --------------------------------------------------
  function getActivityLog(limit) {
    return Promise.resolve(
      rows("activity_log")
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit || 30)
    );
  }
  /** `meta` is the app's shape — {type, amount, refStatus, memberId, round} —
   *  and NOT the column names. Mapped here exactly as js/database.js maps it,
   *  or every logged entry would arrive untyped and unattributed and the
   *  Activity table's filters would have nothing to filter on. */
  function addActivityLog(message, meta) {
    const m = meta || {};
    const row = {
      id: uuid(),
      message: String(message),
      created_at: nowIso(),
      event_type: m.type != null ? String(m.type) : null,
      amount: m.amount != null ? m.amount : null,
      ref_status: m.refStatus != null ? m.refStatus : null,
      member_id: m.memberId != null ? m.memberId : null,
      round_number: m.round != null ? m.round : null,
    };
    db.activity_log.unshift(row);
    save();
    return Promise.resolve(clone(row));
  }

  // ---- settings and PINs ---------------------------------------------
  function getSettings() {
    return Promise.resolve(clone(db.app_settings));
  }
  function saveQrAccount(fields) {
    Object.assign(db.app_settings, fields);
    save();
    return Promise.resolve([clone(db.app_settings)]);
  }
  // The SHAPE matters: app.js reads `hasTreasurer` / `hasMaster`, not the
  // column names. Returning snake_case here read as "no PIN is set", which
  // js/database.js's own note calls the one thing never to get wrong — the app
  // offers to CREATE a treasurer PIN when none exists.
  function pinStatus() {
    return Promise.resolve({
      source: "demo",
      hasTreasurer: !!db.demo_pins.treasurer,
      hasMaster: !!db.demo_pins.master,
    });
  }
  function verifyPin(kind, pin) {
    const want = kind === "master" ? db.demo_pins.master : db.demo_pins.treasurer;
    return Promise.resolve(!!want && String(pin) === String(want));
  }
  function setPin(kind, pin) {
    db.demo_pins[kind === "master" ? "master" : "treasurer"] = String(pin);
    save();
    return Promise.resolve(); // resolves undefined, like the real one
  }

  // ---- bulk ----------------------------------------------------------
  function loadEverything(activityLimit) {
    return Promise.all([
      getMembers(),
      getCycles(),
      getContributions(),
      getPayouts(),
      getActivityLog(activityLimit || 30),
      getSettings(),
      getSwapRequests(),
      pinStatus(),
    ]).then(function (r) {
      return {
        members: r[0],
        cycles: r[1],
        contributions: r[2],
        payouts: r[3],
        activityLog: r[4],
        settings: r[5],
        swapRequests: r[6],
        pins: r[7],
      };
    });
  }

  function resetAll() {
    db.contributions = [];
    db.activity_log = [];
    db.swap_requests = [];
    db.payouts = fresh().payouts.map((p) =>
      Object.assign(p, {
        released: false,
        released_on: null,
        amount: null,
        recipient_member_id: null,
        recipient_name: null,
        receipt_url: null,
        released_by: null,
        received_at: null,
        received_note: null,
        disputed_at: null,
        disputed_note: null,
        started_at: null,
        note: null,
      })
    );
    save();
    return Promise.resolve();
  }

  function restoreFromBackup(data) {
    // Deliberately narrow: a demo restore puts the SEED back, which is what
    // anyone pressing it during a walkthrough actually wants. Parsing a real
    // backup file here would be a second implementation of the restore rules
    // with none of the real one's guards.
    db = fresh();
    save();
    return Promise.resolve({ demo: true });
  }

  /** No realtime. The app already polls every 30s and falls back to it when
   *  a socket is unavailable, so the demo simply never pushes. */
  function subscribeToChanges() {
    return function () {};
  }

  // ---- auth: a session faked for the selected member -------------------
  //
  // This is what makes the demo worth having. Half the app is gated on a
  // LINKED ACCOUNT — Received ✓, reporting a payout as not arrived, My payout
  // details, turn swaps — because those decide where ₱30,000 goes and the
  // per-device who-am-I preference is unverified. With no session they render
  // inert, so a demo could show them but never drive them.
  //
  // So `getSession()` answers with a session whose `user.id` is the selected
  // member's `auth_user_id`. resolveAccount() matches that BEFORE it looks at
  // any email, resolves to `linked`, and every member-gated surface comes
  // alive — for whichever member the banner's switcher names, with nobody's
  // real Google account involved.
  //
  // NOTHING HERE REACHES AN AUTH SERVER. The one honest consequence is that a
  // linked member has `identityLocked`, so the app's own "Not you?" control is
  // hidden — which is exactly why the banner carries the switcher.
  function selectedMemberId() {
    try {
      return localStorage.getItem("pf_my_member_id");
    } catch (e) {
      return null;
    }
  }
  function getSession() {
    const me = db.members.find((m) => m.id === selectedMemberId());
    if (!me || !me.auth_user_id) return Promise.resolve(null);
    return Promise.resolve({
      user: { id: me.auth_user_id, email: me.email || null, aud: "authenticated" },
      access_token: "demo",
      demo: true,
    });
  }
  function onAuthChange() {
    return function () {};
  }
  function signInWithGoogle() {
    return Promise.reject(
      new Error(
        "This is the demo build — there is no Google sign-in. Switch member from the DEMO bar at the top."
      )
    );
  }
  /** Signing out drops back to "no member selected", which is a real state the
   *  app handles (the who-am-I picker). It does not clear the demo's data. */
  function signOut() {
    try {
      localStorage.removeItem("pf_my_member_id");
    } catch (e) {}
    return Promise.resolve();
  }
  /** The seed ships every row already linked, so a claim is a no-op rather
   *  than a path the demo can get stuck in. */
  function linkMemberAccount(memberId) {
    const row = db.members.find((m) => m.id === memberId);
    return Promise.resolve(row ? [clone(row)] : []);
  }

  // ---- what the demo adds for the person driving it --------------------
  function demoReset() {
    db = fresh();
    save();
  }

  window.DB = {
    client: null, // nothing here may touch the network
    getMembers, addMember, updateMember, unlinkMemberAccount, deleteMember,
    swapMemberOrder, getSwapRequests, swapsAvailable, requestSwap, acceptSwap,
    declineSwap, cancelSwap,
    getCycles, updateCycleDueDates,
    getContributions, getContributionsForCycle, upsertContribution,
    upsertContributions, updateContribution, deleteContribution,
    rejectContributions,
    uploadProof, deleteProof, archiveProof, uploadPaymentQr,
    uploadMemberPayoutQr, saveMemberPayoutDetails, uploadPayoutReceipt,
    deletePaymentAsset,
    getPayouts, updatePayout, confirmPayoutReceived, disputePayout,
    clearPayoutDispute, startRound,
    getActivityLog, addActivityLog,
    getSettings, pinStatus, verifyPin, setPin, saveQrAccount,
    loadEverything, resetAll, restoreFromBackup, subscribeToChanges,
    linkMemberAccount, uploadMemberAvatar, removeMemberAvatar,
    getSession, onAuthChange, signInWithGoogle, signOut,
    // demo-only
    demoReset,
  };

  /* ---- the banner ---------------------------------------------------
   * Every screen, unmissable, and it says the one thing that matters: this
   * is not the real fund. Injected from here rather than written into
   * index.html, so the markup can never say DEMO while DEMO_MODE is off.
   *
   * IN THE DOCUMENT FLOW as body's FIRST CHILD — `position: sticky`, not
   * `fixed`. The first version was fixed with `body.pf-demo { padding-top }`
   * to make room, and that was wrong twice over, both caught by measuring it
   * in a browser rather than by reading it:
   *
   *   1. Onboarding and the sign-in gate set `body.auth-gate`, which is
   *      `padding: 0 !important` — deliberately, to cancel the shell's
   *      offsets for a full-screen layer. So the padding was discarded and
   *      the banner sat ON TOP of the intro's Skip button, which could not be
   *      tapped at all. A demo that cannot get past its own first screen.
   *   2. The reserved 34px was a guess. The bar measures 81px at 430px wide,
   *      because the text wrapped to two lines and the safe-area inset is on
   *      top of that. The same "three numbers disagreed" shape as the
   *      floating CTA.
   *
   * Sticky in flow needs no reserved space at all: it pushes the page down by
   * its own real height at every breakpoint, and stays put while scrolling.
   * `app.js` only ever reassigns `#app`'s innerHTML, so the banner survives
   * every render.
   */
  /** First run: be somebody. Without a selection getSession() answers null,
   *  and AUTH_MODE "optional" would then front the sign-in prompt with a
   *  "Continue with Google" that cannot complete in a demo. Defaults to the
   *  flagged treasurer, who is the person giving the demo. */
  function ensureSelection() {
    try {
      if (localStorage.getItem("pf_my_member_id")) return;
      const tre = db.members.find((m) => m.is_treasurer) || db.members[0];
      if (tre) localStorage.setItem("pf_my_member_id", tre.id);
      // Belt and braces: if the selection is ever cleared (Sign out), the
      // prompt still must not appear, because it cannot be satisfied.
      localStorage.setItem("pf_signin_skipped", "1");
    } catch (e) {}
  }

  function mountBanner() {
    if (document.getElementById("pf-demo-banner")) return;
    const meId = selectedMemberId();
    const bar = document.createElement("div");
    bar.id = "pf-demo-banner";
    bar.setAttribute("role", "note");
    // THE SWITCHER IS THE POINT OF THIS BAR, not the warning. A linked member
    // has `identityLocked`, so the app's own "Not you?" is hidden and
    // openWhoAmIPicker() refuses — correctly, since that preference must not
    // be able to move somebody's payout. This is the demo's way in.
    bar.innerHTML =
      '<b>DEMO</b>' +
      '<label class="pf-demo-as">as' +
      ' <select id="pf-demo-who" aria-label="Demo as which member">' +
      db.members
        .slice()
        .sort(function (a, b) {
          return a.member_order - b.member_order;
        })
        .map(function (m) {
          return (
            '<option value="' + m.id + '"' + (m.id === meId ? " selected" : "") + ">" +
            m.name.replace(/[<>&]/g, "") +
            (m.is_treasurer ? " (treasurer)" : "") +
            "</option>"
          );
        })
        .join("") +
      "</select></label>" +
      '<button type="button" id="pf-demo-reset">Reset</button>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.classList.add("pf-demo");

    document.getElementById("pf-demo-who").addEventListener("change", function (e) {
      try {
        localStorage.setItem("pf_my_member_id", e.target.value);
      } catch (err) {}
      // A RELOAD, not a re-render. Identity is read once at boot into
      // `session` / `accountMemberId`, so nudging localStorage alone would
      // leave the app showing the previous member until something else
      // happened to reload it — the worst kind of demo bug, because it looks
      // like the switch silently failed.
      location.reload();
    });
    document.getElementById("pf-demo-reset").addEventListener("click", function () {
      // Confirmed: somebody mid-walkthrough should not lose the state they
      // were talking about to a stray tap.
      if (!window.confirm("Put the demo back to its starting state?")) return;
      demoReset();
      location.reload();
    });
  }
  ensureSelection();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountBanner);
  } else {
    mountBanner();
  }

  console.info(
    "%cPOWER FUND — DEMO BUILD",
    "background:#F5A623;color:#14213D;font-weight:700;padding:2px 6px;border-radius:4px",
    "\nData is in this browser only. Nothing reaches the real fund."
  );
})();
