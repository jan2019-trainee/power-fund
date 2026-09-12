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
// Read the listener's actual body rather than guessing a character window —
// the first version used {0,400} and failed on a comment inside it.
const whoListener = (function () {
  const i = demo.indexOf('getElementById("pf-demo-who").addEventListener');
  if (i < 0) return "";
  return demo.slice(i, demo.indexOf("});", i));
})();
check(
  "switching member reloads rather than only re-rendering",
  /location\.reload\(\)/.test(whoListener) &&
    /setItem\("pf_my_member_id"/.test(whoListener),
  whoListener ? "sets the preference then reloads" : "no listener found"
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

// ---- the seed has to be worth demoing ---------------------------------
const win = {};
new Function("window", seedSrc)(win);
const seed = win.PF_DEMO_SEED;
check("the seed loads", !!seed && seed.members.length === 5, seed ? seed.members.length + " members" : "no");
check(
  "every table the app reads is seeded",
  ["members", "cycles", "contributions", "payouts", "activity_log", "swap_requests", "app_settings"]
    .every((k) => seed[k] !== undefined),
  Object.keys(seed).join(", ")
);
check("30 cycles", seed.cycles.length === 30, String(seed.cycles.length));
// The whole point of the seed: the newest features have something to show.
check(
  "a round is released AND confirmed received",
  seed.payouts.some((p) => p.released && p.received_at)
);
check(
  "a round is released AND DISPUTED — the newest feature (014)",
  seed.payouts.some((p) => p.released && p.disputed_at && !p.received_at)
);
check(
  "no payout is both received and disputed (014's invariant)",
  !seed.payouts.some((p) => p.received_at && p.disputed_at)
);
check(
  "a released round has a receipt to view",
  seed.payouts.filter((p) => p.released).every((p) => !!p.receipt_url)
);
check(
  "there is a claim in review, so the treasurer has a queue",
  seed.contributions.some((c) => c.status === 1)
);
check(
  "there is a REJECTED claim, with a reason",
  seed.contributions.some((c) => c.status === 3 && c.rejection_note)
);
check(
  "there is a pending turn swap (013)",
  seed.swap_requests.some((r) => r.status === "pending")
);
// A rejected cycle only reads RED if it is genuinely past due; a refused
// advance is deliberately not red. The demo wants the red one.
const today = new Date().toISOString().slice(0, 10);
const rejected = seed.contributions.find((c) => c.status === 3);
const rejCycle = seed.cycles.find((c) => c.id === rejected.cycle_id);
check(
  "the rejected cycle is PAST DUE, so it reads red rather than as a refused advance",
  rejCycle.due_date < today,
  rejCycle.due_date + " vs " + today
);
check(
  "member_order is 1..5 with no duplicates (the column is UNIQUE)",
  new Set(seed.members.map((m) => m.member_order)).size === 5
);
check(
  "exactly one treasurer is flagged",
  seed.members.filter((m) => m.is_treasurer).length === 1,
  (seed.members.find((m) => m.is_treasurer) || {}).name
);
// The repo is public. A demo seed must not carry anyone's real address.
check(
  "every seeded member is linked by auth_user_id",
  seed.members.every((m) => !!m.auth_user_id) &&
    new Set(seed.members.map((m) => m.auth_user_id)).size === 5,
  "5 distinct ids"
);
check(
  "the seed carries NO email addresses (this repo is public)",
  seed.members.every((m) => !m.email) && !/@(gmail|yahoo|outlook|icloud)\./i.test(seedSrc),
  "none"
);
check(
  "the fund name says DEMO, on every screen",
  /DEMO/i.test(seed.app_settings.fund_name),
  seed.app_settings.fund_name
);

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

console.log("");
if (failed) {
  console.log(failed + " check(s) FAILED");
  process.exit(1);
}
console.log("all demo checks passed");
