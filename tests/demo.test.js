/* ---------------------------------------------------------------------------
 * DEMO BUILD — static checks. No browser, no network.  (branch: demo/…)
 *
 * The demo data layer stands in for js/database.js, so the one thing that
 * matters is that the two AGREE: same function names, same argument order. A
 * mismatch does not fail loudly — it fails halfway through a walkthrough, in
 * front of the group, as an undefined or a silently ignored argument.
 *
 * Eyeballing 53 functions is exactly how the two argument-order bugs in the
 * first draft got in (uploadMemberPayoutQr and uploadMemberAvatar both take
 * the FILE first), so this reads both files instead.
 *
 *   node tests/demo.test.js
 * ------------------------------------------------------------------------- */

const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let failed = 0;
function check(label, pass, detail) {
  if (pass) console.log("  ok   " + label + (detail ? " — " + detail : ""));
  else {
    console.log("  FAIL " + label + (detail ? " — " + detail : ""));
    failed++;
  }
}

const real = read("js/database.js");
const demo = read("js/demo-db.js");
const seedSrc = read("js/demo-seed.js");
const cfg = read("js/config.js");
const html = read("index.html");

// ---- what the real layer exports -------------------------------------
const realExportBlock = real.slice(real.lastIndexOf("  return {"));
const realNames = [...realExportBlock.matchAll(/^\s{4}([A-Za-z_$][\w$]*),\s*$/gm)]
  .map((m) => m[1])
  .filter((n) => n !== "client");
check("read the real DB surface", realNames.length > 40, realNames.length + " functions");

// ---- what the demo layer exposes -------------------------------------
const demoBlock = demo.slice(demo.indexOf("window.DB = {"));
const demoNames = new Set(
  [...demoBlock.matchAll(/([A-Za-z_$][\w$]*)\s*(?::|,)/g)].map((m) => m[1])
);
const missing = realNames.filter((n) => !demoNames.has(n));
check(
  "the demo implements every function the real layer exports",
  missing.length === 0,
  missing.length ? "missing: " + missing.join(", ") : realNames.length + " covered"
);

// ---- ARGUMENT ORDER, which is where the real bugs were ---------------
function params(src, name) {
  const re = new RegExp(
    "(?:async\\s+)?function\\s+" + name + "\\s*\\(([^)]*)\\)"
  );
  const m = src.match(re);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/=.*$/, "").trim())
    .filter(Boolean);
}
// Only the ones whose arguments carry MEANING by position. A name difference
// is fine (blob vs file); an order difference is the bug.
const SHAPES = {
  uploadProof: ["file"],
  uploadPaymentQr: ["file"],
  uploadPayoutReceipt: ["file"],
  uploadMemberPayoutQr: ["file", "memberId"],
  uploadMemberAvatar: ["blob|file", "memberId"],
  removeMemberAvatar: ["memberId"],
  saveMemberPayoutDetails: ["memberId", "fields"],
  updateMember: ["id", "fields"],
  updatePayout: ["roundNumber|round", "fields"],
  confirmPayoutReceived: ["roundNumber|round", "note"],
  disputePayout: ["roundNumber|round", "note"],
  clearPayoutDispute: ["roundNumber|round"],
  swapMemberOrder: ["aId", "bId"],
  requestSwap: ["toMemberId", "note"],
  addActivityLog: ["message", "meta|extra"],
  verifyPin: ["kind", "pin"],
  setPin: ["kind", "pin"],
  rejectContributions: ["ids", "note"],
  updateContribution: ["id", "fields"],
};
let shapeProblems = [];
Object.keys(SHAPES).forEach((name) => {
  const r = params(real, name);
  const d = params(demo, name);
  if (!r || !d) {
    shapeProblems.push(name + " (not found in " + (!r ? "real" : "demo") + ")");
    return;
  }
  // Compare POSITION BY POSITION over the arguments the demo accepts: the
  // real layer may take extra trailing ones the demo ignores (a third
  // `status`, a `cycleNumber` used only to name the storage path), and that
  // is fine. Taking them in a different ORDER is not.
  for (let i = 0; i < d.length; i++) {
    const want = String(SHAPES[name][i] || "").split("|");
    if (want.length && want[0] && !want.includes(d[i])) {
      shapeProblems.push(
        name + " arg " + (i + 1) + ': demo has "' + d[i] + '", expected ' + want.join(" or ")
      );
    }
    if (r[i] !== undefined && want.length && want[0] && !want.includes(r[i])) {
      shapeProblems.push(
        name + " arg " + (i + 1) + ': REAL has "' + r[i] + '" — this table is stale'
      );
    }
  }
});
check(
  "argument order agrees, position by position",
  shapeProblems.length === 0,
  shapeProblems.length ? shapeProblems.join(" | ") : Object.keys(SHAPES).length + " signatures"
);

// ---- pinStatus's SHAPE, which broke silently --------------------------
// app.js reads hasTreasurer / hasMaster. Returning the column names read as
// "no PIN is set", and the app offers to CREATE one when none exists.
check(
  "the demo's pinStatus returns hasTreasurer/hasMaster, not the column names",
  /hasTreasurer/.test(demo) && /hasMaster/.test(demo) &&
    !/has_treasurer:/.test(demo),
  /has_treasurer:/.test(demo) ? "still returns has_treasurer" : "camelCase"
);

// ---- the fences --------------------------------------------------------
check(
  "demo-db does nothing unless DEMO_MODE is on",
  /if\s*\(!cfg\.DEMO_MODE\)\s*return;/.test(demo)
);
check(
  "the demo layer cannot reach the network (no Supabase client)",
  /client:\s*null/.test(demoBlock) && !/window\.supabase|createClient/.test(demo),
  "client: null"
);
// "optional", not "off": half the app is gated on a LINKED ACCOUNT (Received
// ✓, reporting a payout as not arrived, My payout details, turn swaps) and
// renders inert without one. The demo fakes a session instead.
check(
  "AUTH_MODE is optional, so the member-gated half of the app is drivable",
  /AUTH_MODE:\s*"optional"/.test(cfg)
);
check(
  "the demo fakes a session for the SELECTED member",
  /function getSession\(\)/.test(demo) &&
    /selectedMemberId\(\)/.test(demo) &&
    /auth_user_id/.test(demo),
  "getSession → selected member's auth_user_id"
);
check(
  "the banner carries the member switcher",
  /pf-demo-who/.test(demo) && /location\.reload\(\)/.test(demo),
  "select + reload"
);
// A linked member has identityLocked, so the app's own "Not you?" is hidden.
// Switching MUST reload: identity is read once at boot, so writing
// localStorage alone would leave the previous member on screen.
// Scoped to mountBanner's whole body rather than to one call shape. The
// first version matched `getElementById("pf-demo-who").addEventListener` and
// broke the moment that was refactored to a local — a check pinned to a
// spelling rather than to the property it is meant to hold.
const banner = (function () {
  const i = demo.indexOf("function mountBanner()");
  if (i < 0) return "";
  return demo.slice(i, demo.indexOf("\n  }", i));
})();
check(
  "switching member writes the preference and RELOADS",
  /location\.reload\(\)/.test(banner) &&
    /setItem\("pf_my_member_id"/.test(banner) &&
    /addEventListener\("change"/.test(banner),
  banner ? "sets the preference then reloads" : "mountBanner not found"
);
check(
  "sign-in is refused with a message that says where to switch instead",
  /there is no Google sign-in/i.test(demo) && /DEMO bar/i.test(demo)
);
check(
  "a first run picks a member, or optional-mode would front a dead sign-in",
  /function ensureSelection\(\)/.test(demo) &&
    /pf_signin_skipped/.test(demo)
);
check(
  "DEMO_MODE is on",
  /DEMO_MODE:\s*true/.test(cfg)
);
check(
  "index.html loads the seed and the layer AFTER database.js",
  html.indexOf("js/demo-seed.js") > html.indexOf("js/database.js") &&
    html.indexOf("js/demo-db.js") > html.indexOf("js/demo-seed.js") &&
    html.indexOf("js/demo-db.js") < html.indexOf("js/app.js"),
  "seed → demo-db → app"
);

// ---- the seed, in BOTH modes -------------------------------------------
// DEMO_SEED picks the starting state, and the two have opposite invariants:
// "empty" must have nothing, "midfund" must have everything. Loading one and
// assuming the other is how a mode-specific check passes for the wrong reason.
function loadSeed(mode) {
  const win = { APP_CONFIG: mode ? { DEMO_SEED: mode } : {} };
  new Function("window", seedSrc)(win);
  return win.PF_DEMO_SEED;
}
const empty = loadSeed("empty");
const mid = loadSeed("midfund");
const dflt = loadSeed(null);

check("the seed loads in both modes", !!empty && !!mid, empty.mode + " / " + mid.mode);
check(
  "an unset DEMO_SEED defaults to empty",
  dflt.mode === "empty",
  dflt.mode
);
check(
  "config.js asks for the empty seed",
  /DEMO_SEED:\s*"empty"/.test(cfg)
);

[["empty", empty], ["midfund", mid]].forEach(function (pair) {
  const mode = pair[0], sd = pair[1];
  check(
    mode + ": every table the app reads is seeded",
    ["members", "cycles", "contributions", "payouts", "activity_log", "swap_requests", "app_settings"]
      .every((k) => sd[k] !== undefined)
  );
  check(mode + ": 5 members, 30 cycles", sd.members.length === 5 && sd.cycles.length === 30);
  check(
    mode + ": member_order is 1..5 with no duplicates (the column is UNIQUE)",
    new Set(sd.members.map((m) => m.member_order)).size === 5
  );
  check(
    mode + ": exactly one treasurer is flagged",
    sd.members.filter((m) => m.is_treasurer).length === 1,
    (sd.members.find((m) => m.is_treasurer) || {}).name
  );
  check(
    mode + ": every member is linked by a distinct auth_user_id",
    sd.members.every((m) => !!m.auth_user_id) &&
      new Set(sd.members.map((m) => m.auth_user_id)).size === 5
  );
  check(
    mode + ": no email addresses (this repo is public)",
    sd.members.every((m) => !m.email)
  );
  check(
    mode + ": round 1 is started, so the fund has a live round",
    !!sd.payouts.find((p) => p.round_number === 1).started_at
  );
  check(
    mode + ": no payout is both received and disputed (014's invariant)",
    !sd.payouts.some((p) => p.received_at && p.disputed_at)
  );
  check(
    mode + ": the fund name says DEMO, on every screen",
    /DEMO/i.test(sd.app_settings.fund_name)
  );
});

// ---- "empty" means day one, and nothing accusing anybody -----------------
check(
  "empty: no contributions, no activity, no swap requests",
  empty.contributions.length === 0 &&
    empty.activity_log.length === 0 &&
    empty.swap_requests.length === 0
);
check(
  "empty: nothing is released",
  !empty.payouts.some((p) => p.released)
);
check(
  "empty: only round 1 has started",
  empty.payouts.filter((p) => p.started_at).length === 1
);
// THE POINT OF A SEPARATE SCHEDULE. midfund's dates run into the past, and
// reusing them for an empty fund would open the demo with thirteen overdue
// cycles across five members — 65 red chips and nobody at fault.
const today = new Date().toISOString().slice(0, 10);
check(
  "empty: NOTHING is already overdue on arrival",
  !empty.cycles.some((c) => c.due_date < today),
  "first cycle due " + empty.cycles[0].due_date + " (today " + today + ")"
);
check(
  "empty: cycle 1 is close enough to be the one you pay in the demo",
  new Date(empty.cycles[0].due_date) - new Date(today) < 20 * 86400000,
  empty.cycles[0].due_date
);
check(
  "empty: the schedule is strictly increasing (currentCycle depends on it)",
  empty.cycles.every((c, i) => i === 0 || c.due_date > empty.cycles[i - 1].due_date)
);
check(
  "midfund: its schedule DOES reach into the past, which is why it is separate",
  mid.cycles.some((c) => c.due_date < today)
);

// ---- "midfund" has to reach every feature without setup ------------------
check(
  "midfund: a round is released AND confirmed received",
  mid.payouts.some((p) => p.released && p.received_at)
);
check(
  "midfund: a round is released AND DISPUTED (014)",
  mid.payouts.some((p) => p.released && p.disputed_at && !p.received_at)
);
check(
  "midfund: every released round has a receipt to view",
  mid.payouts.filter((p) => p.released).every((p) => !!p.receipt_url)
);
check("midfund: a claim is in review", mid.contributions.some((c) => c.status === 1));
check(
  "midfund: a claim is REJECTED, with a reason",
  mid.contributions.some((c) => c.status === 3 && c.rejection_note)
);
check("midfund: a turn swap is pending (013)", mid.swap_requests.some((r) => r.status === "pending"));
// A rejected cycle only reads RED if it is genuinely past due; a refused
// advance is deliberately not red. The demo wants the red one.
const rej = mid.contributions.find((c) => c.status === 3);
const rejCycle = mid.cycles.find((c) => c.id === rej.cycle_id);
check(
  "midfund: the rejected cycle is PAST DUE, so it reads red rather than as a refused advance",
  rejCycle.due_date < today,
  rejCycle.due_date
);

// ---- THE SHAPE of an object argument, which the signature table cannot see
//
// js/database.js takes camelCase and maps it to columns:
// {cycleId, memberId, proofUrl} -> {cycle_id, member_id, proof_url}. The
// demo stored the caller's keys RAW, so the row it wrote was unreadable by
// everything downstream — the Review Payment sheet showed "?" for the member,
// "Cycle undefined", and "No screenshot attached" for a claim that had one.
//
// The argument-order table above cannot catch that: the arity and order were
// right, the object's keys were not. So this RUNS the demo layer against a
// stub window and checks what it actually stored.
(function () {
  const store = {};
  const el = () => ({
    innerHTML: "",
    style: {},
    classList: { add() {}, contains: () => false },
    setAttribute() {},
    addEventListener() {},
    appendChild() {},
    querySelector: () => null,
  });
  const win = {
    APP_CONFIG: { DEMO_MODE: true, DEMO_SEED: "empty" },
    PF_DEMO_SEED: null,
    confirm: () => false,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
  };
  const doc = {
    readyState: "complete",
    // null for the banner itself (so mountBanner proceeds), an element for the
    // controls it then wires up.
    getElementById: (id) => (id === "pf-demo-banner" ? null : el()),
    createElement: el,
    body: { insertBefore() {}, firstChild: null, classList: { add() {} } },
    addEventListener() {},
  };
  new Function("window", seedSrc)(win);
  new Function("window", "document", "localStorage", "console", "URL", "Image", demo)(
    win,
    doc,
    win.localStorage,
    { info() {}, warn() {}, error() {} },
    { createObjectURL: () => "blob:", revokeObjectURL() {} },
    function Image() {}
  );
  const DB = win.DB;
  check("the demo layer loads outside a browser", !!DB && typeof DB.upsertContribution === "function");
  if (!DB) return;

  const seedNow = win.PF_DEMO_SEED;
  const cycle1 = seedNow.cycles[0].id;
  const sarah = seedNow.members[1].id;

  let stored = null;
  DB.upsertContribution({
    cycleId: cycle1,
    memberId: sarah,
    amount: 1000,
    status: 1,
    proofUrl: "data:image/jpeg;base64,AAA",
  })
    .then((rows) => (stored = rows[0]))
    .catch((e) => (stored = { error: String(e) }));

  // The demo layer is synchronous under the hood; the promise resolves on the
  // microtask queue, so one tick is enough.
  Promise.resolve().then(() => {
    check(
      "a contribution is stored with COLUMN names, not the caller's camelCase",
      !!stored &&
        stored.cycle_id === cycle1 &&
        stored.member_id === sarah &&
        stored.proof_url === "data:image/jpeg;base64,AAA" &&
        stored.cycleId === undefined &&
        stored.memberId === undefined &&
        stored.proofUrl === undefined,
      stored ? Object.keys(stored).join(",") : "nothing stored"
    );
    check(
      "paid_at is stamped only for a confirmed payment (status 2)",
      !!stored && stored.paid_at === null,
      stored ? String(stored.paid_at) : "?"
    );
    DB.upsertContribution({ cycleId: cycle1, memberId: sarah, status: 2 }).then((r2) => {
      check(
        "confirming the same cycle UPDATES the row and stamps paid_at",
        r2[0].status === 2 && !!r2[0].paid_at && r2[0].cycle_id === cycle1,
        r2.length + " row(s), paid_at " + (r2[0].paid_at ? "set" : "null")
      );
      finish();
    });
  });
})();

function finish() {
  console.log("");
  if (failed) {
    console.log(failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("all demo checks passed");
}

// ---- the suites must keep testing the APP, not the demo ---------------
// index.html loads the demo layer unconditionally and config.js ships
// DEMO_MODE true on this branch, so anything that serves config.js has to pin
// it off — or it silently starts exercising the demo store against the demo
// seed. That is how it was found: tests/smoke.js blew up on a strict-mode
// violation because the demo seed has both a review queue AND an overdue
// cycle, so `.attention-more` matched two buttons.
const smoke = read("tests/smoke.js");
const cap = read("tests/qa-capture.js");
check(
  "tests/smoke.js pins DEMO_MODE off",
  smoke.includes('DEMO_MODE: false'),
  "pinned"
);
check(
  "tests/qa-capture.js pins DEMO_MODE off",
  cap.includes('DEMO_MODE: false'),
  "pinned"
);
// EVERY route that serves config.js, not just the two helpers. Playwright
// matches the most recently registered route first, so a later hand-rolled one
// silently overrides the helper's pin — which is exactly how withAuthMode()
// put ~40 checks back on the demo store.
[["tests/smoke.js", smoke], ["tests/qa-capture.js", cap]].forEach(function (pair) {
  const file = pair[0], src = pair[1];
  const routes = src.split('route("**/js/config.js"').length - 1;
  const pins = src.split("DEMO_MODE: false").length - 1;
  check(
    file + ": every config.js route pins DEMO_MODE",
    routes > 0 && pins >= routes,
    pins + " pin(s) for " + routes + " route(s)"
  );
});

// A demo on a phone is the likeliest thing to be run with no signal.
const sw = read("sw.js");
check(
  "sw.js precaches the demo layer, so the walkthrough works offline",
  sw.includes('"/js/demo-seed.js"') && sw.includes('"/js/demo-db.js"')
);
// The shell changed, so the cache name has to, or phones keep the old one.
check(
  "sw.js's CACHE is distinct from main's, so a demo device does not serve main's shell",
  /const CACHE = "[^"]*demo[^"]*"/.test(sw),
  (sw.match(/const CACHE = "([^"]*)"/) || [])[1]
);

// The last checks are asynchronous, so finish() is called from there rather
// than here — otherwise the summary prints before they have run.
