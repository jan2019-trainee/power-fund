/* ---------------------------------------------------------------------------
 * QA capture — renders the app across every scenario a reviewer needs to see
 * and writes a labelled screenshot for each.
 *
 * WHY THIS EXISTS
 *   Independent UI/UX QA (UX_QA_AGENT.md) has to look at real rendered screens,
 *   not at a description of them. The live fund is empty and must never be
 *   seeded with demo data to make screenshots, so this drives the real
 *   application against intercepted Supabase REST calls — the same mock harness
 *   the smoke suite uses. Nothing here touches the live project.
 *
 * WHAT THE REVIEWER IS LOOKING AT
 *   The real index.html / app.js / views / CSS, rendered by real Chromium at
 *   real viewport sizes. Only the DATA is fabricated, so layout, hierarchy,
 *   spacing, states and interaction are all genuine. Proof images are fake URLs
 *   and render as broken thumbnails — that is the harness, not a defect.
 *
 * USAGE
 *   python3 -m http.server 8791 &
 *   PF_CHROMIUM=/path/to/chrome node tests/qa-capture.js [outDir]
 * ------------------------------------------------------------------------- */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const M = require("./mock-data");

const BASE = process.env.PF_BASE_URL || "http://localhost:8791/index.html";
const OUT = process.argv[2] || path.join(__dirname, "..", "qa-shots");
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const PIN = "1234";

const shots = [];
const errors = [];
/* Some captures INDUCE a failure on purpose — the error toast has to come from
   a real failed write, not a poked state. Without this the harness reports the
   deliberate 500 as a page error and exits non-zero, which would train the
   next reader to ignore the error list. */
let expectErrors = false;

function uuid(n) {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

// --- Scenarios -------------------------------------------------------------
// Each is a complete Supabase snapshot. Named for the situation a reviewer
// needs to judge, not for the data that produces it.

const MASTER_PIN = "9999";
const SETTINGS = {
  ...M.SETTINGS,
  treasurer_pin: PIN,
  // A fund WITH a master PIN, so the recovery path is photographable. It must
  // differ from the treasurer PIN — the app refuses the two being the same,
  // since the master PIN exists for when the treasurer PIN is what is lost.
  master_pin: MASTER_PIN,
  fund_name: "ViTAMiN Fund 2027",
  qr_code_url: null,
};

/** Mid-fund: Round 1 paid out, Round 2 collecting, one claim in review. */
const midFund = {
  ...M.TABLE_DATA,
  app_settings: SETTINGS,
  members: M.MEMBERS.map((m, i) =>
    i === 0
      ? {
          ...m,
          payout_qr_url: null,
          payout_bank: "GCash",
          payout_account_name: "Regine S.",
          payout_account_number: "0917 000 0000",
        }
      : m
  ),
};

/** The member's claim was refused — rejection banner and Resubmit CTA. */
const rejected = {
  ...midFund,
  contributions: M.CONTRIBUTIONS.map((c) =>
    c.status === 1
      ? {
          ...c,
          status: 3,
          rejection_note:
            "Screenshot didn't show the amount or date clearly — please resend a clearer one.",
          rejected_at: new Date().toISOString(),
        }
      : c
  ),
};

/** Round 2 fully funded: the release path is open. */
const funded = (() => {
  const rows = [];
  let id = 8000;
  M.CYCLES.filter((c) => c.cycle_number <= 12).forEach((cy) =>
    M.MEMBERS.forEach((m) =>
      rows.push({
        id: uuid(id++),
        cycle_id: cy.id,
        member_id: m.id,
        status: 2,
        amount: 1000,
        proof_url: null,
        paid_at: new Date(cy.due_date).toISOString(),
      })
    )
  );
  return {
    ...midFund,
    contributions: rows,
    payouts: M.PAYOUTS.map((p) =>
      p.round_number === 2 ? { ...p, released: false } : p
    ),
  };
})();

/** Day one: the fund exists, nothing has happened. Also the empty Activity. */
const dayOne = {
  ...M.TABLE_DATA,
  app_settings: SETTINGS,
  contributions: [],
  activity_log: [],
  payouts: M.PAYOUTS.map((p) => ({
    ...p,
    released: false,
    released_on: null,
    amount: null,
    recipient_member_id: null,
    recipient_name: null,
    started_at: p.round_number === 1 ? new Date().toISOString() : null,
  })),
};

/** All five rounds collected and paid out — the terminal state. */
const complete = (() => {
  const rows = [];
  let id = 9000;
  M.CYCLES.forEach((cy) =>
    M.MEMBERS.forEach((m) =>
      rows.push({
        id: uuid(id++),
        cycle_id: cy.id,
        member_id: m.id,
        status: 2,
        amount: 1000,
        proof_url: null,
        paid_at: new Date(cy.due_date).toISOString(),
      })
    )
  );
  return {
    ...midFund,
    contributions: rows,
    payouts: M.PAYOUTS.map((p) => ({
      ...p,
      released: true,
      started_at: new Date().toISOString(),
      amount: 30000,
      recipient_member_id: M.MEMBERS[p.round_number - 1].id,
      recipient_name: M.MEMBERS[p.round_number - 1].name,
      released_on: "2027-11-30",
    })),
  };
})();

// --- Harness ---------------------------------------------------------------

async function serve(page, data, authMode) {
  // AUTH_MODE IS PINNED, NOT INHERITED. The shipped value is a deploy-time
  // decision, and it is now "required" — so without this every capture in this
  // file was a screenshot of the sign-in wall. That is not a hypothetical: it
  // is what this harness produced until it was noticed, ~40 identical images
  // handed to a reviewer as "the app".
  await page.route("**/js/config.js", async (route) => {
    const res = await route.fetch();
    return route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: (await res.text()).replace(
        /AUTH_MODE:\s*"[a-z]*"/,
        `AUTH_MODE: "${authMode || "off"}"`
      ),
    });
  });
  await page.route("**/rest/v1/**", (route) => {
    const url = new URL(route.request().url());
    // Real PostgREST 404s a function it does not have. Answering 200 [] makes
    // the app believe migration 010's PIN vault exists and returned nothing,
    // which is the one reading that must never be reported as "no PIN is set".
    if (url.pathname.includes("/rpc/")) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          code: "42883",
          message: "Could not find the function",
        }),
      });
    }
    const table = url.pathname.split("/").pop();
    const rows = data[table];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rows === undefined ? [] : rows),
    });
  });
  await page.route("**/realtime/v1/**", (route) => route.abort());
  // Fake proof/QR URLs would 404 noisily; serve a 1x1 so thumbnails render.
  await page.route("**/*.{jpg,jpeg,png,webp}", (route) => {
    if (route.request().url().startsWith(BASE.replace(/\/[^/]*$/, ""))) {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      ),
    });
  });
}

/** The Supabase auth storage key is derived from the project ref, so read it
 *  rather than hardcode one: a stale copy seeds the wrong key, the session is
 *  silently ignored, and the result looks exactly like "the account-gated
 *  surfaces are missing". */
let _ref = null;
function projectRef() {
  if (_ref) return _ref;
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "config.js"), "utf8");
  const m = src.match(/SUPABASE_URL:\s*"https:\/\/([^.]+)\./);
  if (!m) throw new Error("Couldn't read SUPABASE_URL from js/config.js");
  _ref = m[1];
  return _ref;
}
const FAKE_USER_ID = "11111111-1111-1111-1111-111111111111";

/**
 * opts.authMode  "off" (default) | "optional" | "required"
 * opts.signedInAs  a member row to seed a Google session for. The account-only
 *   surfaces (Member sign-in, Transfer role, Payment schedule) key off
 *   members.is_treasurer on a LINKED row, so `member` — which only writes the
 *   per-device pf_my_member_id preference — cannot reach them.
 * opts.fresh  leave the onboarding/sign-in-prompt keys unset.
 */
async function open(browser, data, viewport, member, opts) {
  const o = opts || {};
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    // The RPC 404 is deliberate (see serve()), and the realtime socket is not
    // available here. Reporting either drowns the errors that do matter.
    if (
      !expectErrors &&
      m.type() === "error" &&
      !/realtime|websocket/i.test(m.text()) &&
      !/404 \(Not Found\)/.test(m.text())
    ) {
      errors.push(`console: ${m.text()}`);
    }
  });
  await serve(page, data, o.authMode);
  await page.addInitScript((a) => {
    if (a.id) window.localStorage.setItem("pf_my_member_id", a.id);
    else window.localStorage.removeItem("pf_my_member_id");
    if (!a.fresh) {
      // Otherwise the intro, and then the sign-in prompt, front every capture.
      window.localStorage.setItem("pf_onboarded", "1");
      window.localStorage.setItem("pf_signin_skipped", "1");
    }
    if (a.email) {
      window.localStorage.setItem(`sb-${a.ref}-auth-token`, JSON.stringify({
        access_token: "qa-access-token",
        token_type: "bearer",
        expires_in: 31536000,
        expires_at: Math.floor(Date.now() / 1000) + 31536000,
        refresh_token: "qa-refresh-token",
        user: { id: a.uid, email: a.email, aud: "authenticated" },
      }));
    }
  }, {
    id: member || "",
    fresh: !!o.fresh,
    ref: projectRef(),
    uid: FAKE_USER_ID,
    email: o.signedInAs ? o.signedInAs.email : "",
  });
  if (o.signedInAs) {
    await page.route("**/auth/v1/**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  }
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(o.signedInAs ? 2400 : 1700);
  return page;
}

/** The roster as it looks after migration 008's one-off, with one member
 *  linked to the fake Google session. Returns the whole snapshot plus the
 *  linked row, so a caller can pass it straight to open()'s signedInAs. */
function withAccounts(data, linkedIndex) {
  const members = data.members.map((m, i) => ({
    ...m,
    email: `${m.name.toLowerCase()}@example.com`,
    auth_user_id: i === linkedIndex ? FAKE_USER_ID : null,
    is_treasurer: i === 0,
  }));
  return { data: { ...data, members }, me: members[linkedIndex] };
}

async function unlock(page) {
  await page.locator(".unlock-btn").click();
  await page.waitForTimeout(300);
  if (await page.locator(".modal-overlay").count()) {
    await page.keyboard.type(PIN);
    await page.locator(".modal-btn-primary").first().click();
    await page.waitForTimeout(800);
  }
}

/* Viewport screenshots, never fullPage. The app pins the tab bar and the
   floating CTA with position:fixed, and a fullPage capture renders those
   stranded in the middle of the image — which reads as a layout bug that
   isn't there. A viewport shot shows the screen as a person actually sees it.
   Where content continues below the fold, a second "-btm" shot is taken after
   scrolling, so nothing goes unreviewed. */
async function shot(page, name, note, keepScroll) {
  const file = `${name}.png`;
  // keepScroll: the caller has already scrolled something into view (an inline
  // panel that opens below the fold), so resetting here would photograph the
  // wrong part of the page and prove nothing.
  if (!keepScroll) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
  }
  await page.screenshot({ path: path.join(OUT, file) });
  shots.push({ file, note });
  process.stdout.write(`  ${file}\n`);

  const more = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight
  );
  if (more > 80) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(250);
    const f2 = `${name}-btm.png`;
    await page.screenshot({ path: path.join(OUT, f2) });
    shots.push({ file: f2, note: `${note} — scrolled to the bottom` });
    process.stdout.write(`  ${f2}\n`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
  }
}

async function tabs(page, prefix, list) {
  for (const t of list) {
    await page.evaluate((v) => window.PowerFund.setView(v), t.view);
    await page.waitForTimeout(600);
    await shot(page, `${prefix}-${t.view}`, t.note);
  }
}

// --- Run -------------------------------------------------------------------

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.PF_CHROMIUM || undefined,
    args: ["--no-sandbox"],
  });

  // EVERY PAGE GETS ITS OWN CONTEXT, WITH THE SERVICE WORKER BLOCKED.
  // page.route() does not intercept what a service worker fetches, and sw.js
  // claims the client on the first load — so from the second navigation on,
  // every mock here was bypassed and the page rendered the real config. A
  // fresh context per page, not one shared: each capture relies on its own
  // localStorage, and sharing would leak identity between scenarios.
  browser.newPage = async (opt) => {
    const context = await browser.newContext({ ...(opt || {}), serviceWorkers: "block" });
    return context.newPage();
  };

  const CORE = [
    { view: "home", note: "Home" },
    { view: "rounds", note: "Rounds & cycles" },
    { view: "activity", note: "Activity" },
    { view: "insights", note: "Insights" },
    { view: "menu", note: "Menu" },
  ];

  // ---- MEMBER, mobile ----
  console.log("\nMember · mobile · mid-fund");
  let p = await open(browser, midFund, MOBILE, M.MEMBERS[1].id);
  await tabs(p, "m-mobile", CORE);
  await p.evaluate(() => window.PowerFund.setView("members"));
  await p.waitForTimeout(500);
  await shot(p, "m-mobile-members", "Members, reached from Home's See all");
  // .member-row is the real class (js/views/members.js:133). A wrong selector
  // here previously produced a screenshot of the COLLAPSED state labelled as
  // the expanded one — so this asserts instead of swallowing the miss.
  await p.locator(".member-row").nth(1).click();
  await p.waitForTimeout(600);
  if ((await p.locator(".member-row-panel").count()) === 0) {
    throw new Error("Members accordion did not open — capture would be misleading");
  }
  await shot(p, "m-mobile-members-open", "Members accordion expanded");
  await p.close();

  console.log("\nMember · mobile · proof rejected");
  p = await open(browser, rejected, MOBILE, M.MEMBERS[1].id);
  await shot(p, "m-mobile-rejected", "Home after the treasurer rejects the proof");
  await p.close();

  console.log("\nMember · mobile · contribute sheet");
  p = await open(browser, midFund, MOBILE, M.MEMBERS[2].id);
  await p.evaluate(() => {
    const b = document.querySelector(".floating-cta .hero-cta");
    if (b) b.click();
  });
  await p.waitForTimeout(600);
  await shot(p, "m-mobile-contribute-picker", "Who is paying (contribute picker)");
  // Pick an enabled row (a member who still owes this cycle).
  const pick = p.locator(".picker-row:not([disabled])").first();
  if (await pick.count()) {
    await pick.click();
    await p.waitForTimeout(700);
    await shot(p, "m-mobile-contribute", "Contribute sheet — QR, stepper, proof");
  } else {
    // Fall back to opening it directly, so this screen is never missing.
    await p.evaluate((id) => window.PowerFund.openContributeModal(id, 7), M.MEMBERS[2].id);
    await p.waitForTimeout(700);
    await shot(p, "m-mobile-contribute", "Contribute sheet — QR, stepper, proof");
  }
  await p.close();

  // ---- MEMBER, desktop ----
  console.log("\nMember · desktop · mid-fund");
  p = await open(browser, midFund, DESKTOP, M.MEMBERS[1].id);
  await tabs(p, "m-desktop", CORE);
  await p.evaluate(() => window.PowerFund.setView("members"));
  await p.waitForTimeout(500);
  await shot(p, "m-desktop-members", "Members, desktop master-detail");
  await p.close();

  // ---- TREASURER, mobile ----
  console.log("\nTreasurer · mobile · mid-fund");
  p = await open(browser, midFund, MOBILE, M.MEMBERS[1].id);
  await unlock(p);
  await shot(p, "t-mobile-home", "Treasurer Home — attention panel collapsed");
  await p.locator(".attention-more").click().catch(() => {});
  await p.waitForTimeout(500);
  await shot(p, "t-mobile-home-queue", "Review queue expanded");
  const rev = p.locator(".queue-btn-review").first();
  if (await rev.count()) {
    await rev.click();
    await p.waitForTimeout(700);
    await shot(p, "t-mobile-review", "Review Payment sheet");
    const rej = p.locator(".modal-btn-secondary.reject");
    if (await rej.count()) {
      await rej.click();
      await p.waitForTimeout(500);
      await shot(p, "t-mobile-review-reject", "Reject — inline confirmation and note");
    }
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
  }
  await tabs(p, "t-mobile", CORE.filter((t) => t.view !== "home"));
  await p.close();

  console.log("\nTreasurer · mobile · cash gate + undo");
  p = await open(browser, midFund, MOBILE, null);
  await unlock(p);
  await p.evaluate(() => window.PowerFund.setView("rounds"));
  await p.waitForTimeout(500);
  const rounds = await p.locator(".round").count();
  for (let i = 0; i < rounds; i++) {
    await p.locator(".round").nth(i).click();
    await p.waitForTimeout(300);
    if (
      (await p
        .locator(".member-chip.editable:not(.paid):not(.pending):not(.rejected)")
        .count()) > 0
    )
      break;
  }
  const chip = p
    .locator(".member-chip.editable:not(.paid):not(.pending):not(.rejected)")
    .first();
  if (await chip.count()) {
    await chip.click();
    await p.waitForTimeout(500);
    // The panel opens inline, often below the fold — scroll to it or the shot
    // shows an unremarkable list and proves nothing.
    await p.locator(".mark-paid-panel").scrollIntoViewIfNeeded();
    await p.waitForTimeout(250);
    await shot(p, "t-mobile-cash-gate", "Recording a payment with no proof — confirmation", true);
    await p.locator(".mark-paid-panel button", { hasText: "Cancel" }).click();
    await p.waitForTimeout(300);
  }
  // A confirmed chip in a round that has NOT been paid out. Round 1 is
  // released in these fixtures, and reverting inside a released round is now
  // refused, so the panel would never open there. Find an open round whose
  // accordion has no release record, rather than taking the first paid chip
  // on the page.
  let paidChip = null;
  for (const head of await p.locator(".round-header").all()) {
    const card = head.locator("xpath=..");
    if (await card.locator(".payout-status-box").count()) continue; // released
    if (!/is-open/.test((await card.getAttribute("class")) || "")) {
      await head.click();
      await p.waitForTimeout(450);
    }
    const c = card.locator(".member-chip.paid").first();
    if (await c.count()) { paidChip = c; break; }
  }
  if (paidChip) {
    await paidChip.click();
    await p.waitForTimeout(500);
    if (!(await p.locator(".undo-paid-panel").count())) {
      throw new Error("undo panel did not open on an unreleased round");
    }
    await p.locator(".undo-paid-panel").scrollIntoViewIfNeeded();
    await p.waitForTimeout(250);
    await shot(p, "t-mobile-undo-paid", "Undo one confirmed payment, inline", true);
  }
  await p.close();

  console.log("\nTreasurer · mobile · round funded / release");
  p = await open(browser, funded, MOBILE, null);
  await unlock(p);
  await shot(p, "t-mobile-funded", "Home when a round is fully funded");
  const rel = p.locator(".release-card .payout-btn").first();
  if (await rel.count()) {
    await rel.click();
    await p.waitForTimeout(700);
    await shot(p, "t-mobile-release", "Release Payout — receipt required");
  }
  await p.close();

  // ---- TREASURER, desktop ----
  console.log("\nTreasurer · desktop · mid-fund");
  p = await open(browser, midFund, DESKTOP, M.MEMBERS[1].id);
  await unlock(p);
  await shot(p, "t-desktop-home", "Treasurer Home, sidebar shell");
  await tabs(p, "t-desktop", CORE.filter((t) => t.view !== "home"));
  await p.evaluate(() => window.PowerFund.setView("members"));
  await p.waitForTimeout(500);
  await shot(p, "t-desktop-members", "Members, desktop");
  await p.evaluate(() => window.PowerFund.setView("activity"));
  await p.waitForTimeout(500);
  await p.evaluate(() => window.PowerFund.setActivityRound("all"));
  await p.waitForTimeout(400);
  await shot(p, "t-desktop-activity-all", "Activity table, All rounds");
  await p.close();

  // ---- ACCOUNT-GATED SURFACES ----
  // These key off members.is_treasurer on a LINKED row, so pf_my_member_id and
  // the shared PIN cannot reach them at all. Without a seeded Google session
  // they were simply absent from the review — not deferred, just unphotographed.
  console.log("\nSigned-in treasurer · account-only surfaces");
  {
    const acct = withAccounts(midFund, 0); // Regine, flagged and linked
    for (const [label, vp] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
      p = await open(browser, acct.data, vp, null, {
        authMode: "optional",
        signedInAs: acct.me,
      });
      // A Google-verified treasurer unlocks with no PIN. If a modal appears the
      // session did not link, and every shot below would be a locked screen
      // labelled as a treasurer one.
      await p.locator(".unlock-btn").click();
      await p.waitForTimeout(600);
      if (await p.locator(".modal-overlay").count()) {
        throw new Error(
          "treasurer mode asked for a PIN — the seeded session did not link, " +
            "so these captures would be mislabelled"
        );
      }
      await p.evaluate(() => window.PowerFund.setView("menu"));
      await p.waitForTimeout(500);
      await shot(p, `a-${label}-menu`, "Menu, signed-in treasurer (no PIN needed to unlock)");

      const overlays = [
        ["schedule", "Payment schedule — the 30 due dates", () => window.PowerFund.openScheduleModal()],
        ["member-signin", "Member sign-in — the addresses a login is matched against", () => window.PowerFund.openMemberAccountsModal()],
        ["transfer-role", "Transfer treasurer role", () => window.PowerFund.openTransferRole()],
        ["change-pin", "Change PIN, step 1 of 3", () => window.PowerFund.openChangePin()],
        ["master-pin", "Set or change the master PIN", () => window.PowerFund.openMasterPin()],
        ["reset", "Reset all fund data — type RESET plus the PIN", () => window.PowerFund.resetData()],
      ];
      for (const [name, note, fn] of overlays) {
        await p.evaluate(fn);
        await p.waitForTimeout(600);
        await shot(p, `a-${label}-${name}`, note);
        // closeTopModal() is not exported; Escape is the public route, and the
        // PIN wizard can stack two.
        for (let i = 0; i < 4 && (await p.locator(".modal-overlay").count()); i++) {
          await p.keyboard.press("Escape").catch(() => {});
          await p.waitForTimeout(220);
        }
      }

      // The schedule with a shift applied — the state a reviewer has to judge,
      // since the untouched list says nothing about what the feature does.
      await p.evaluate(() => window.PowerFund.openScheduleModal());
      await p.waitForTimeout(600);
      const dates = p.locator(".schedule-date");
      const v = await dates.nth(2).inputValue();
      const d = new Date(v + "T00:00:00");
      d.setDate(d.getDate() + 14);
      const pad = (n) => String(n).padStart(2, "0");
      await dates.nth(2).fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
      await p.waitForTimeout(500);
      await shot(p, `a-${label}-schedule-moved`, "Payment schedule after a 14-day shift — settled-cycle warning");
      await p.close();
    }

    // A fund that never set a treasurer PIN. The verified treasurer unlocks
    // without one, so a PIN-gated action has nothing to type — this is the
    // dialog that used to answer "Incorrect PIN" forever.
    const noPin = {
      ...acct.data,
      app_settings: { ...acct.data.app_settings, treasurer_pin: null, master_pin: null },
    };
    p = await open(browser, noPin, MOBILE, null, {
      authMode: "optional",
      signedInAs: acct.me,
    });
    await p.locator(".unlock-btn").click();
    await p.waitForTimeout(600);
    await p.evaluate(() => window.PowerFund.setView("menu"));
    await p.waitForTimeout(450);
    await shot(p, "a-mobile-menu-no-pin", "Menu on a fund with no treasurer PIN — the Security row says so");
    await p.evaluate(() => window.PowerFund.resetData());
    await p.waitForTimeout(600);
    await shot(p, "a-mobile-no-pin-confirm", "A PIN-gated action with no PIN to type — offers to create one");
    await p.close();
  }

  // Unlocked with the MASTER PIN: Change PIN must not then demand the
  // treasurer PIN the person has just proved they have forgotten.
  console.log("\nMaster-PIN recovery");
  p = await open(browser, midFund, MOBILE, null);
  await p.locator(".unlock-btn").click();
  await p.waitForTimeout(400);
  await p.keyboard.type(MASTER_PIN);
  await p.locator(".modal-btn-primary").first().click();
  await p.waitForTimeout(900);
  await shot(p, "e-mobile-master-unlocked", "Unlocked with the master PIN — the nudge to set a new treasurer PIN");
  await p.evaluate(() => window.PowerFund.openChangePin());
  await p.waitForTimeout(500);
  await shot(p, "e-mobile-master-change-pin", "Change PIN after a master unlock — two steps, no current-PIN demand");
  await p.close();

  // The sign-in gate itself, which is what AUTH_MODE "required" actually ships.
  console.log("\nSign-in gate");
  for (const [label, vp] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
    p = await open(browser, midFund, vp, null, { authMode: "required" });
    await shot(p, `e-${label}-signin-gate`, "AUTH_MODE required, signed out — no way past");
    await p.close();
  }

  // ---- THE SCREENS THE FIRST QA PASS COULD NOT SEE ----
  // Everything here was classified J ("not yet verified") in the first report,
  // because it needs a LINKED ACCOUNT, a first-run device, an AUTH_MODE other
  // than "off", or a file — and the harness offered none of those. Unreviewed
  // is not approved, so these are captured rather than asserted about.
  console.log("\nMember-account surfaces (My payout details, profile)");
  {
    const acct = withAccounts(midFund, 2); // Jan: linked, NOT the treasurer
    for (const [label, vp] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
      p = await open(browser, acct.data, vp, null, {
        authMode: "optional",
        signedInAs: acct.me,
      });
      const gated = [
        ["payout-details", "My payout details — bank picker, account fields, QR (a PORT of MyPayoutQRManage)",
          () => window.PowerFund.openPayoutQrModal()],
        ["edit-profile", "Edit Profile — a port of EditProfile.dc.html",
          () => window.PowerFund.openProfileModal()],
        ["share", "Share fund status",
          () => window.PowerFund.openShareModal()],
      ];
      for (const [name, note, fn] of gated) {
        await p.evaluate(fn);
        await p.waitForTimeout(600);
        await shot(p, `acct-${label}-${name}`, note);
        if (name === "edit-profile") {
          // Change Photo opens OVER Edit Profile and is the one Escape closes
          // first — so it is captured here, from the screen it belongs to.
          await p.evaluate(() => window.PowerFund.openPhotoSheet());
          await p.waitForTimeout(600);
          await shot(p, `acct-${label}-change-photo`, "Change Photo, over Edit Profile (ProfilePhotoSheet.dc.html)");
        }
        for (let i = 0; i < 4 && (await p.locator(".modal-overlay").count()); i++) {
          await p.keyboard.press("Escape").catch(() => {});
          await p.waitForTimeout(220);
        }
      }
      await p.close();
    }
  }

  // "Received ✓" (migration 012) — NEW DESIGN, no mockup. Needs a LINKED
  // ACCOUNT and a released payout pointed at that member, so it was
  // unreachable to every earlier capture the way My-payout-details was.
  console.log("\nReceived ✓ — the recipient's payout acknowledgement");
  {
    const acct = withAccounts(midFund, 1); // Sarah: linked, not the treasurer
    const ackData = {
      ...acct.data,
      // Round 1 released TO SARAH and unacknowledged. Pointed by
      // recipient_member_id, which is what the app and 012's policy both key
      // off — not by payout order.
      payouts: acct.data.payouts.map((p) =>
        p.round_number === 1
          ? {
              ...p,
              released: true,
              released_on: "2026-09-20",
              amount: 30000,
              recipient_member_id: acct.me.id,
              recipient_name: acct.me.name,
              received_at: null,
              received_note: null,
            }
          : p
      ),
    };
    for (const [label, vp] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
      p = await open(browser, ackData, vp, null, {
        authMode: "optional",
        signedInAs: acct.me,
      });
      await shot(p, `ack-${label}-offered`, "Received ✓ card on Home — the recipient's own released payout");
      if (await p.locator(".ack-cta").count()) {
        await p.locator(".ack-cta").click();
        await p.waitForTimeout(500);
        await shot(p, `ack-${label}-panel`, "The note panel — one optional line, Confirm / Cancel");
      }
      // The record line the whole group reads, before anyone has confirmed.
      await p.locator(".tab-item, .sidebar-item", { hasText: "Rounds" }).first().click();
      await p.waitForTimeout(600);
      await p.locator(".round-head, .round").first().click().catch(() => {});
      await p.waitForTimeout(500);
      await shot(p, `ack-${label}-awaiting`, "Rounds — \"Awaiting Sarah's confirmation that it arrived\"");
      await p.close();
    }
    // ...and after.
    const doneData = {
      ...ackData,
      payouts: ackData.payouts.map((p) =>
        p.round_number === 1
          ? { ...p, received_at: "2026-09-21T04:00:00Z", received_note: "GCash, received in full" }
          : p
      ),
    };
    p = await open(browser, doneData, MOBILE, null, {
      authMode: "optional",
      signedInAs: acct.me,
    });
    await p.locator(".tab-item", { hasText: "Rounds" }).first().click();
    await p.waitForTimeout(600);
    await p.locator(".round-head, .round").first().click().catch(() => {});
    await p.waitForTimeout(500);
    await shot(p, "ack-mobile-received", "Rounds — \"Received by Sarah on <date> — <note>\"; no card on Home");
    await p.close();
  }

  // Turn swaps (013) — NEW DESIGN, no mockup. Needs two LINKED members with
  // unreleased rounds, which no earlier capture had.
  // Payout disputes (014) — NEW DESIGN, no mockup. Needs a linked recipient
  // on a RELEASED round, which is the same shape Received ✓ needed.
  console.log("\nPayout disputes — \"it never arrived\"");
  {
    const dp = withAccounts(midFund, 1); // Sarah, linked
    dp.data.payouts = dp.data.payouts.map((p) =>
      p.round_number === 1
        ? {
            ...p,
            released: true,
            released_on: "2026-09-20",
            amount: 30000,
            recipient_member_id: dp.me.id,
            recipient_name: dp.me.name,
            receipt_url: "https://example.invalid/receipt-r1.jpg",
            received_at: null,
            received_note: null,
            disputed_at: null,
            disputed_note: null,
          }
        : p
    );
    const withReport = {
      ...dp.data,
      payouts: dp.data.payouts.map((p) =>
        p.round_number === 1
          ? {
              ...p,
              disputed_at: new Date().toISOString(),
              disputed_note: "nothing in GCash as of today",
            }
          : p
      ),
    };
    for (const [label, vp] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
      // The card with BOTH answers, and the treasurer's receipt beside them.
      p = await open(browser, dp.data, vp, null, {
        authMode: "optional", signedInAs: dp.me,
      });
      await shot(p, `disp-${label}-both-answers`, "Received ✓ card — the receipt, plus \"No — it hasn't arrived\"");
      if (await p.locator(".ack-no").count()) {
        await p.locator(".ack-no").click();
        await p.waitForTimeout(500);
        await shot(p, `disp-${label}-report-panel`, "Reporting it — its own note field, and what happens next");
      }
      await p.close();
      // The reporter's own card afterwards.
      p = await open(browser, withReport, vp, null, {
        authMode: "optional", signedInAs: dp.me,
      });
      await shot(p, `disp-${label}-reported-mine`, "The reporter's own card — withdraw, or say it arrived after all");
      await p.close();
      // What the OTHER four see. The roster is rebuilt so exactly ONE row
      // carries this session's login: my first version left Sarah's row on
      // FAKE_USER_ID too, and editableMember() takes the first match — so the
      // capture resolved to Sarah and photographed the recipient's own view
      // under the group label. Real Supabase has auth_user_id UNIQUE, so a
      // fixture that duplicates it is testing a state that cannot exist.
      const groupRoster = withReport.members.map((m, i) => ({
        ...m,
        auth_user_id:
          i === 3 ? FAKE_USER_ID : `8888888${i}-0000-0000-0000-00000000000${i}`,
      }));
      p = await open(
        browser,
        { ...withReport, members: groupRoster },
        vp,
        null,
        { authMode: "optional", signedInAs: groupRoster[3] }
      );
      await shot(p, `disp-${label}-alert-group`, "What everyone else sees — the report leads the screen, blocking nothing");
      await p.close();
    }
    // The treasurer's view, which adds Undo release & re-send.
    p = await open(browser, withReport, MOBILE, null, { authMode: "off" });
    await unlock(p);
    await p.waitForTimeout(600);
    await shot(p, "disp-mobile-alert-treasurer", "Treasurer — the report with Undo release & re-send");
    await p.close();
  }

  console.log("\nTurn swaps — palit ng turno");
  {
    // Everyone signed in, with DISTINCT ids, and FAKE_USER_ID on whichever
    // member the shot is taken AS. Building the roster per viewer matters:
    // the first version set FAKE_USER_ID only on the object passed to
    // signedInAs and left the ROSTER row carrying another id, so the
    // requester's page resolved to somebody else and the "waiting" capture
    // photographed the incoming card instead.
    const swRoster = (meIndex) =>
      withAccounts(midFund, meIndex).data.members.map((m, i) => ({
        ...m,
        auth_user_id:
          i === meIndex ? FAKE_USER_ID : `9999999${i}-0000-0000-0000-00000000000${i}`,
      }));
    // Rounds 1-2 paid out, so only Jan (3), Clara (4) and Verdz (5) have a
    // turn left to trade — which is what pf_request_swap allows.
    const swPayouts = midFund.payouts.map((p) =>
      p.round_number <= 2
        ? { ...p, released: true, released_on: "2026-09-20", amount: 30000 }
        : { ...p, released: false, released_on: null }
    );
    const sw = { data: { ...midFund, members: swRoster(3), payouts: swPayouts } };
    const pending = {
      id: "55555555-0000-0000-0000-000000000001",
      from_member_id: sw.data.members[2].id, // Jan, order 3
      to_member_id: sw.data.members[3].id,   // Clara, order 4
      from_round: 3, to_round: 4, status: "pending",
      note: "hospital bill this month",
      created_at: new Date().toISOString(), resolved_at: null,
    };
    for (const [label, vp] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
      // The INCOMING ask, on the counterparty's Home.
      p = await open(browser, { ...sw.data, swap_requests: [pending] }, vp, null, {
        authMode: "optional", signedInAs: sw.data.members[3],
      });
      await shot(p, `swap-${label}-incoming`, "Home — another member asks to trade turns (Accept / Decline)");
      await p.close();
      // The OUTGOING side, on the REQUESTER's own page — its own roster, so
      // Jan's row is the one carrying this session's login.
      const asJan = swRoster(2);
      p = await open(
        browser,
        { ...sw.data, members: asJan, swap_requests: [pending] },
        vp,
        null,
        { authMode: "optional", signedInAs: asJan[2] }
      );
      await shot(p, `swap-${label}-waiting`, "Home — waiting on an answer, with Withdraw request");
      await p.close();
    }
    // The request sheet, empty and then filled in.
    p = await open(browser, { ...sw.data, swap_requests: [] }, MOBILE, null, {
      authMode: "optional", signedInAs: sw.data.members[3],
    });
    await p.evaluate(() => window.PowerFund.openSwapModal());
    await p.waitForTimeout(600);
    await shot(p, "swap-mobile-ask", "Swap my turn — nobody chosen yet, Send disabled");
    await p.evaluate((id) => window.PowerFund.setSwapTarget(id), sw.data.members[2].id);
    await p.waitForTimeout(600);
    await shot(p, "swap-mobile-ask-picked", "Swap my turn — both sides of the trade spelled out");
    await p.close();
  }

  console.log("\nOnboarding — first run, both frames");
  for (const [label, vp] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
    p = await open(browser, midFund, vp, null, { fresh: true });
    for (let i = 1; i <= 6; i++) {
      if (!(await p.locator(".onboarding").count())) break;
      await shot(p, `ob-${label}-${i}`, `Onboarding step ${i}`);
      const next = p.locator(".ob-next").first();
      if (await next.count()) {
        await next.click();
      } else {
        // The final step is the who-am-I picker, which has no Next.
        await shot(p, `ob-${label}-picker`, "Onboarding — which member are you");
        break;
      }
      await p.waitForTimeout(500);
    }
    await p.close();
  }

  console.log("\nAccount dead-ends (AUTH_MODE required)");
  {
    const linkedElsewhere = withAccounts(midFund, 0).data;
    linkedElsewhere.members = linkedElsewhere.members.map((m, i) =>
      i === 0 ? { ...m, auth_user_id: "99999999-9999-9999-9999-999999999999" } : m
    );
    const noEmails = {
      ...midFund,
      members: midFund.members.map((m) => ({ ...m, email: null, auth_user_id: null })),
    };
    const cases = [
      ["unknown", "Signed in with an address on no member row", withAccounts(midFund, 0).data,
        { email: "stranger@example.com" }],
      ["taken", "The matching member row belongs to another login", linkedElsewhere,
        { email: "regine@example.com" }],
      ["no-email", "The roster carries no addresses at all — migration 008's one-off never ran",
        noEmails, { email: "regine@example.com" }],
    ];
    for (const [name, note, data, who] of cases) {
      p = await open(browser, data, MOBILE, null, { authMode: "required", signedInAs: who });
      await shot(p, `e-mobile-account-${name}`, note);
      await p.close();
    }
  }

  console.log("\nTreasurer modals that had no capture");
  for (const [label, vp] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
    p = await open(browser, midFund, vp, null);
    await unlock(p);
    for (const [name, note, fn] of [
      ["payment-qr", "Payment QR code — what members scan", () => window.PowerFund.openQrModal()],
      ["edit-names", "Edit member names", () => window.PowerFund.openEditNamesModal()],
      ["reorder", "Reorder payout order", () => window.PowerFund.openReorderModal()],
    ]) {
      await p.evaluate(fn);
      await p.waitForTimeout(600);
      await shot(p, `t-${label}-${name}`, note);
      for (let i = 0; i < 4 && (await p.locator(".modal-overlay").count()); i++) {
        await p.keyboard.press("Escape").catch(() => {});
        await p.waitForTimeout(220);
      }
    }
    // The Security group, scrolled INTO VIEW. The existing menu captures stop
    // above it, so the first report could not see it at all.
    await p.evaluate(() => window.PowerFund.setView("menu"));
    await p.waitForTimeout(500);
    const sec = p.locator(".section-label", { hasText: "Security" }).first();
    if (await sec.count()) {
      await sec.scrollIntoViewIfNeeded();
      await p.waitForTimeout(300);
      await shot(p, `t-${label}-menu-security`, "Menu → Security, scrolled into view", true);
    }
    await p.close();
  }

  console.log("\nThe payment sheets as DESKTOP modals");
  {
    // Above 640px these become centred modals rather than bottom sheets, and
    // above 900px what is behind them blurs. Neither was ever captured.
    p = await open(browser, midFund, DESKTOP, M.MEMBERS[2].id);
    await p.evaluate((id) => window.PowerFund.openContributeModal(id, 7), M.MEMBERS[2].id);
    await p.waitForTimeout(700);
    await shot(p, "d-desktop-contribute", "Contribute as a centred desktop modal");
    await p.close();

    p = await open(browser, midFund, DESKTOP, null);
    await unlock(p);
    const pend = M.CONTRIBUTIONS.find((c) => c.status === 1);
    const pc = (M.CYCLES.find((c) => c.id === pend.cycle_id) || {}).cycle_number;
    await p.evaluate((a) => window.PowerFund.openReviewModal(a.id, a.c), { id: pend.member_id, c: pc });
    await p.waitForTimeout(700);
    await shot(p, "d-desktop-review", "Review Payment as a centred desktop modal");
    await p.close();

    p = await open(browser, funded, DESKTOP, null);
    await unlock(p);
    await p.evaluate(() => window.PowerFund.openPayoutModal(2));
    await p.waitForTimeout(700);
    await shot(p, "d-desktop-release", "Release Payout as a centred desktop modal");
    await p.close();
  }

  console.log("\nLightbox, restore, and the untested width");
  {
    p = await open(browser, midFund, MOBILE, M.MEMBERS[1].id);
    await p.evaluate(() => window.PowerFund.openLightbox("https://example.invalid/proof.jpg"));
    await p.waitForTimeout(600);
    await shot(p, "e-mobile-lightbox", "Proof zoom — close button below the image");
    await p.close();

    // Restore: both the invalid file and the REPLACE confirmation. pickRestoreFile
    // builds a detached <input> and clicks it, which Playwright sees as a
    // filechooser — so this drives the real path rather than poking state.
    for (const [name, note, body] of [
      ["restore-invalid", "Restore — the file is not a Power Fund backup", "{ not json"],
      ["restore-confirm", "Restore — type REPLACE to confirm",
        JSON.stringify({
          version: 2,
          exported_at: new Date().toISOString(),
          contributions: M.CONTRIBUTIONS.slice(0, 12),
          payouts: M.PAYOUTS,
          members: M.MEMBERS,
        })],
    ]) {
      p = await open(browser, midFund, MOBILE, null);
      await unlock(p);
      const chooser = p.waitForEvent("filechooser");
      await p.evaluate(() => window.PowerFund.pickRestoreFile());
      const fc = await chooser;
      await fc.setFiles({
        name: "power-fund-backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(body),
      });
      await p.waitForTimeout(800);
      await shot(p, `t-mobile-${name}`, note);
      await p.close();
    }

    // 641-899px: the mobile tab bar with desktop-sized touch targets and
    // desktop-positioned modals. No capture has ever fallen in this band.
    p = await open(browser, midFund, { width: 768, height: 1024 }, M.MEMBERS[1].id);
    await shot(p, "e-768-home", "Home at 768px — mobile shell, desktop sheet/touch rules");
    await p.evaluate(() => window.PowerFund.setView("menu"));
    await p.waitForTimeout(500);
    await shot(p, "e-768-menu", "Menu at 768px");
    await p.evaluate((id) => window.PowerFund.openContributeModal(id, 7), M.MEMBERS[1].id);
    await p.waitForTimeout(700);
    await shot(p, "e-768-contribute", "Contribute at 768px — sheet or modal?");
    await p.close();
  }

  console.log("\nBoot failure and the toast stack");
  {
    // NoConnection.dc.html. Every table fails, so the app never boots — and it
    // only claims "No connection" when the failure really looks like one.
    for (const [label, vp] of [["mobile", MOBILE], ["desktop", DESKTOP]]) {
      const q = await browser.newPage({ viewport: vp });
      await q.route("**/js/config.js", async (r) => {
        const res = await r.fetch();
        return r.fulfill({ status: 200, contentType: "application/javascript",
          body: (await res.text()).replace(/AUTH_MODE:\s*"[a-z]*"/, 'AUTH_MODE: "off"') });
      });
      await q.addInitScript(() => {
        try {
          localStorage.setItem("pf_onboarded", "1");
          localStorage.setItem("pf_signin_skipped", "1");
        } catch (e) {}
      });
      await q.route("**/rest/v1/**", (r) => r.abort("connectionfailed"));
      await q.route("**/realtime/v1/**", (r) => r.abort());
      await q.goto(BASE, { waitUntil: "domcontentloaded" });
      await q.waitForTimeout(2500);
      await shot(q, `e-${label}-boot-failure`, "Boot failure — the fund could not be loaded");
      await q.close();
    }

    // A real failed write, not a poked state: the toast has to carry Retry,
    // and it is bottom-anchored above the tab bar on the phone. The 500 below
    // is deliberate, so the error collector is muted for this one page.
    expectErrors = true;
    p = await open(browser, midFund, MOBILE, null);
    await unlock(p);
    await p.route("**/rest/v1/contributions**", (r) =>
      r.request().method() === "GET"
        ? r.fulfill({ status: 200, contentType: "application/json",
            body: JSON.stringify(midFund.contributions) })
        : r.fulfill({ status: 500, contentType: "application/json",
            body: JSON.stringify({ message: "Internal server error" }) })
    );
    const pend2 = M.CONTRIBUTIONS.find((c) => c.status === 1);
    const pc2 = (M.CYCLES.find((c) => c.id === pend2.cycle_id) || {}).cycle_number;
    await p.evaluate((a) => window.PowerFund.openReviewModal(a.id, a.c), { id: pend2.member_id, c: pc2 });
    await p.waitForTimeout(600);
    await p.locator(".modal-btn-confirm").click();
    await p.waitForTimeout(1500);
    await shot(p, "e-mobile-toast-error", "A failed write — error toast with Retry, above the tab bar");
    await p.close();
    expectErrors = false;

    // The success side of the same stack. Exporting used to save silently.
    p = await open(browser, midFund, DESKTOP, null);
    await unlock(p);
    await p.evaluate(() => window.PowerFund.exportCsv());
    await p.waitForTimeout(900);
    await shot(p, "e-desktop-toast-success", "Confirmation toast — bottom-right on desktop");
    await p.close();
  }

  // ---- EDGE STATES ----
  console.log("\nEdge states");
  p = await open(browser, dayOne, MOBILE, null);
  await shot(p, "e-mobile-dayone", "Day one — nothing collected yet");
  await p.evaluate(() => window.PowerFund.setView("activity"));
  await p.waitForTimeout(500);
  await shot(p, "e-mobile-activity-empty", "Activity, empty");
  await p.close();

  p = await open(browser, dayOne, DESKTOP, null);
  await unlock(p);
  await shot(p, "e-desktop-dayone", "Day one, desktop, treasurer");
  await p.evaluate(() => window.PowerFund.setView("activity"));
  await p.waitForTimeout(500);
  await shot(p, "e-desktop-activity-empty", "Activity table, empty");
  await p.close();

  p = await open(browser, complete, MOBILE, M.MEMBERS[1].id);
  await shot(p, "e-mobile-complete-member", "Fund complete — member");
  await unlock(p);
  await shot(p, "e-mobile-complete-treasurer", "Fund complete — treasurer");
  await p.close();

  p = await open(browser, midFund, MOBILE, null);
  await p.locator(".unlock-btn").click();
  await p.waitForTimeout(500);
  await shot(p, "e-mobile-pin", "Enter PIN");
  await p.close();

  // Narrowest supported width — the header pill and roster have failed here.
  p = await open(browser, midFund, { width: 360, height: 780 }, M.MEMBERS[1].id);
  await shot(p, "e-360-home", "Home at 360px");
  await p.close();

  await browser.close();

  fs.writeFileSync(
    path.join(OUT, "INDEX.md"),
    `# QA screenshots\n\n` +
      `Generated by \`tests/qa-capture.js\` against mocked Supabase data — the real\n` +
      `application, real Chromium, real viewports; only the data is fabricated.\n` +
      `The live fund is untouched and empty.\n\n` +
      `Mobile 390x844 · Desktop 1440x900 · one shot at 360px.\n` +
      `Shots are VIEWPORT-sized, as a person sees the screen — fixed elements\n` +
      `(tab bar, floating CTA) therefore sit where they really sit. Where a\n` +
      `screen continues below the fold there is a matching \`-btm\` shot.\n` +
      `Proof/QR images are placeholder pixels, not design assets.\n\n` +
      shots.map((s) => `- \`${s.file}\` — ${s.note}`).join("\n") +
      `\n`
  );

  console.log(`\n${shots.length} screenshots -> ${OUT}`);
  if (errors.length) {
    console.log(`\n${errors.length} page error(s):`);
    [...new Set(errors)].slice(0, 20).forEach((e) => console.log("  " + e));
    process.exit(1);
  }
  console.log("No page errors.");
})().catch((e) => {
  console.error("CAPTURE FAILED", e);
  process.exit(1);
});
