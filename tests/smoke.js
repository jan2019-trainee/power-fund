/* ---------------------------------------------------------------------------
 * Power Fund — UI smoke test
 *
 * The app is a static site with no build step and no unit tests, so this is a
 * headless-browser pass over the things that would be embarrassing to break:
 * every tab renders, treasurer mode unlocks, the money states appear, and
 * nothing throws.
 *
 * It never touches the live Supabase project. Every REST call is intercepted
 * and answered from tests/mock-data.js, so a run is safe from any machine and
 * gives the same result every time.
 *
 * RUN:
 *   python3 -m http.server 8791 &        # from the repo root
 *   node tests/smoke.js
 *
 * Needs Playwright available to node (globally installed is fine):
 *   NODE_PATH=$(npm root -g) node tests/smoke.js
 * ------------------------------------------------------------------------- */
const path = require("path");
const { chromium } = require("playwright");
const M = require(path.join(__dirname, "mock-data"));

const BASE = process.env.PF_BASE_URL || "http://localhost:8791/index.html";
const SHOTS = process.env.PF_SHOT_DIR || null; // set to a dir to save screenshots
// The two shells carry different nav items on purpose (see renderTabBar).
// Members is a Home drill-down on mobile; Menu is the profile row on desktop.
const TABS_MOBILE = ["Home", "Rounds", "Activity", "Insights", "Menu"];
const TABS_DESKTOP = ["Home", "Rounds", "Members", "Activity", "Insights"];

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

function uuid(n) {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

/** Serve one fixed dataset for every table the app asks for.
 *
 *  RPCs get a 404 with PostgREST's undefined-function code unless a test
 *  routes them explicitly. That is what a database WITHOUT migration 010 does,
 *  which is the world these fixtures describe — they still carry the plaintext
 *  PIN columns. Answering an unknown function with 200 [] instead would be a
 *  lie no real deployment tells, and it hid a bug once: the app read the empty
 *  answer as "no PIN is set" and offered to create one. */
/** Onboarding shows once per device and would otherwise front every single
 *  test in this file. serve() marks it seen by default; a test that builds its
 *  own routes instead of calling serve() must call this itself. */
/** Mark this device as past BOTH first-run screens: the intro, and — in
 *  "optional" mode — the sign-in prompt. Either one fronts the whole app, so
 *  without this every check below would be looking at the wrong screen. */
async function markOnboarded(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf_onboarded", "1");
      localStorage.setItem("pf_signin_skipped", "1");
    } catch (e) {}
  });
}

/** Past the sign-in prompt but NOT the intro — what the onboarding tests need
 *  now that "optional" mode asks first. Keeps them testing the intro rather
 *  than accidentally testing the prompt in front of it. */
async function markSignInSkipped(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pf_signin_skipped", "1");
    } catch (e) {}
  });
}

async function serve(page, data, opts) {
  // Pass { freshDevice: true } for a first-run browser — what the onboarding
  // test itself needs. That still skips the sign-in prompt: it fronts the
  // intro in "optional" mode, and the onboarding tests are not about it.
  if (opts && opts.freshDevice) await markSignInSkipped(page);
  else await markOnboarded(page);

  // AUTH_MODE is pinned to a NON-GATING default for every page, rather than
  // inheriting whatever js/config.js currently ships. The shipped value is a
  // deploy-time decision the treasurer makes; a test that reads it is testing
  // the deployment, not the code — and the day it became "required" every
  // check that had not opted in met the sign-in wall instead of the app.
  //
  // A test that cares about auth calls withAuthMode() AFTER this and wins:
  // Playwright matches the most recently registered route first.
  await page.route("**/js/config.js", async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(
      /AUTH_MODE:\s*"[a-z]*"/,
      'AUTH_MODE: "off"'
    );
    return route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body,
    });
  });

  await page.route("**/rest/v1/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/rpc/")) {
      const fn = url.pathname.split("/").pop();
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          code: "42883",
          message: `Could not find the function public.${fn}`,
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
  // Realtime needs a socket we neither have nor need here.
  await page.route("**/realtime/v1/**", (route) => route.abort());
}

async function unlockTreasurer(page) {
  await page.locator(".unlock-btn").click();
  await page.waitForTimeout(300);
  if (!(await page.locator(".modal-overlay").count())) return;
  // Setting a PIN is a wizard now (choose → confirm), so walk the steps until
  // the modal closes rather than assuming one submit is enough. Entering an
  // existing PIN is still a single step and exits on the first pass.
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator(".modal-overlay").count())) return;
    await page.keyboard.type("1234");
    const primary = page.locator(".modal-btn-primary").first();
    if (!(await primary.count())) return;
    await primary.click();
    await page.waitForTimeout(500);
    // A "PIN changed" confirmation ends the flow. After a FIRST setup with no
    // master PIN on file the app offers to set one there — "Not now" is the
    // way past it; otherwise the only button is Done.
    if (await page.locator(".pin-done").count()) {
      const notNow = page.locator(".modal-btn-secondary", { hasText: "Not now" });
      if (await notNow.count()) await notNow.first().click();
      else await page.locator(".modal-btn-primary").first().click();
      await page.waitForTimeout(400);
      return;
    }
  }
}

/** Every tab renders its own content, with the shared chrome, in both shells. */
async function tabsRender(browser, label, viewport, errors, wide) {
  const page = await browser.newPage({ viewport });
  page.on("console", (m) => {
    // Two expected noises: the blocked realtime socket (we are offline), and
    // ONE 404 as the app probes for migration 010's pf_pin_status() against
    // fixtures that deliberately predate it. Both are what a real pre-010
    // deployment logs; anything else is a genuine error.
    const text = m.text();
    const expected = /WebSocket|ERR_TUNNEL/.test(text) || /404 \(Not Found\)/.test(text);
    if (m.type() === "error" && !expected) errors.push(`${label}: ${text}`);
  });
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  // A fund that HAS a treasurer PIN. The Security row names the missing one
  // when there is none ("Set a treasurer PIN"), and the mock does not persist
  // the wizard's write — so the default fixture would leave this check reading
  // a menu that disagrees with the PIN the test just set.
  await serve(page, {
    ...M.TABLE_DATA,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // The nav shows only its own shell's items — the other shell's are not
  // rendered at all, rather than hidden, so they stay out of the tab order.
  const navCount = await page.locator(".tab-item:not(.nav-profile)").count();
  check(
    `${label}/nav item count`,
    navCount === (wide ? TABS_DESKTOP : TABS_MOBILE).length,
    `items=${navCount}`
  );
  const navText = (await page.locator(".tab-bar").innerText()).replace(/\s+/g, " ");
  check(
    `${label}/Members in nav = ${wide}`,
    /Members/.test(navText) === wide,
    JSON.stringify(navText)
  );
  check(
    `${label}/desktop-only chrome = ${wide}`,
    (await page.locator(".nav-mode").count()) === (wide ? 1 : 0) &&
      (await page.locator(".nav-profile").count()) === (wide ? 1 : 0)
  );

  for (const tab of wide ? TABS_DESKTOP : TABS_MOBILE) {
    await page.locator(".tab-item", { hasText: tab }).click();
    await page.waitForTimeout(200);
    const header = await page.locator(".header .title").count();
    const nav = await page.locator(".tab-bar").count();
    const stub = await page.locator(".view-placeholder").count();
    const chars = (await page.locator("#app").innerText()).trim().length;
    check(
      `${label}/${tab}`,
      header === 1 && nav === 1 && stub === 0 && chars > 120,
      `header=${header} nav=${nav} stub=${stub} chars=${chars}`
    );
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${label}-${tab.toLowerCase()}.png` });
  }

  await unlockTreasurer(page);
  await (wide
    ? page.locator(".nav-profile")
    : page.locator(".tab-item", { hasText: "Menu" })
  ).click();
  await page.waitForTimeout(250);
  // The treasurer menu is grouped, and every action the design lists is
  // present. Counting rows alone would pass a menu missing the right ones.
  const menuText = (await page.locator(".view-menu").innerText()).replace(/\s+/g, " ");
  const wantRows = [
    "Payment QR code", "Export CSV summary", "Backup data", "Restore from backup",
    "Edit member names", "Reorder payout order", "Share fund status",
    "Change PIN", "Lock treasurer mode",
  ];
  const missingRows = wantRows.filter((r) => !menuText.includes(r));
  check(`${label}/treasurer menu rows`, missingRows.length === 0, missingRows.join(", "));
  const wantGroups = ["Payments", "Data", "Group", "Security"];
  const missingGroups = wantGroups.filter((g) => !menuText.includes(g));
  check(`${label}/treasurer menu groups`, missingGroups.length === 0, missingGroups.join(", "));
  check(
    `${label}/treasurer mode card + danger zone`,
    (await page.locator(".mode-card.on").count()) === 1 &&
      (await page.locator(".danger-zone").count()) === 1
  );

  await page.locator(".tab-item", { hasText: "Home" }).click();
  await page.waitForTimeout(250);
  const attention = await page.locator(".attention-panel").count();
  check(`${label}/attention panel`, attention === 1, `panels=${attention}`);

  // The panel opens collapsed to a summary line (the design's shape), so the
  // queue cards — and the code under test below — are one tap in.
  const collapsedText = (await page.locator(".attention-panel").innerText()).replace(/\s+/g, " ");
  check(
    `${label}/attention panel opens as a summary, not the whole queue`,
    (await page.locator(".attention-panel .queue-card").count()) === 0 &&
      (await page.locator(".attention-count").count()) === 1,
    JSON.stringify(collapsedText.slice(0, 120))
  );
  await page.locator(".attention-more").click();
  await page.waitForTimeout(250);
  check(
    `${label}/expanding reveals the queue cards`,
    (await page.locator(".attention-panel .queue-card").count()) >= 1
  );

  // The review queue formats a submission time. That call lived in app.js's
  // closure while the view could not see it, and the branch only runs when the
  // pending row carries a timestamp — so it rendered fine here and threw in
  // production. Assert the formatted time actually appears.
  const queueText = (await page.locator(".attention-panel").innerText()).replace(/\s+/g, " ");
  check(
    `${label}/review queue renders its timestamp`,
    /\d{1,2}:\d{2}\s*(AM|PM)?/i.test(queueText) || /\b\w{3}\s+\d{1,2}\b/.test(queueText),
    JSON.stringify(queueText.slice(0, 140))
  );

  // MONEY SAFETY: confirming a payment must never be reachable from Home.
  // A one-tap "Confirm 6" here approved ₱6,000 without the proof ever being
  // shown — the design puts confirmation inside the review sheet, after the
  // screenshot. Guard both the button and the global that backed it.
  check(
    `${label}/no confirm action in the review queue`,
    (await page.locator(".attention-panel .queue-btn-confirm").count()) === 0 &&
      !/\bConfirm\b/.test(queueText),
    JSON.stringify(queueText.slice(0, 140))
  );
  check(
    `${label}/confirmBatch is not exposed globally`,
    (await page.evaluate(() => typeof window.PowerFund.confirmBatch)) === "undefined"
  );

  // Members has to stay reachable on mobile even though it left the bar:
  // Home's roster "See all" is its entry point, and it opens with a way back.
  if (!wide) {
    await page.locator(".roster-strip-all").click();
    await page.waitForTimeout(300);
    const onMembers = await page.locator(".view-members").count();
    const back = await page.locator(".detail-back").count();
    const activeTabs = await page.locator(".tab-item.active").count();
    check(
      `${label}/Members via See all`,
      onMembers === 1 && back === 1 && activeTabs === 0,
      `view=${onMembers} back=${back} activeTabs=${activeTabs}`
    );
    await page.locator(".detail-back").click();
    await page.waitForTimeout(250);
    check(
      `${label}/back returns Home`,
      (await page.locator(".view-home").count()) === 1
    );
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${label}-nav.png` });

  await page.close();
}

/** The two money states that are easy to regress and hard to notice. */
async function moneyStates(browser, errors) {
  const confirmedOnly = M.CONTRIBUTIONS.filter((c) => c.status === 2);
  const caughtUp = { ...M.TABLE_DATA, contributions: confirmedOnly };

  const everyCyclePaid = [];
  let id = 9000;
  M.CYCLES.forEach((cy) =>
    M.MEMBERS.forEach((m) =>
      everyCyclePaid.push({
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
  const complete = {
    ...M.TABLE_DATA,
    contributions: everyCyclePaid,
    payouts: M.PAYOUTS.map((p) => ({
      ...p,
      released: true,
      released_on: "2027-01-05",
      started_at: new Date().toISOString(),
      amount: 30000,
    })),
  };

  for (const [name, data, expect] of [
    ["caught up", caughtUp, { caught: 1, complete: 0 }],
    ["fund complete", complete, { caught: 0, complete: 1 }],
  ]) {
    const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
    page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
    await serve(page, data);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1400);
    await unlockTreasurer(page);
    // "All caught up" (mid-fund, nothing waiting) and "Fund complete" (the
    // terminal state) are different answers and must not share a marker.
    const caught = await page.locator(
      ".attention-panel.caught-up:not(.fund-complete-panel)"
    ).count();
    const done = await page.locator(".battery-hero.fund-complete").count();
    const panel = await page.locator(".fund-complete-panel").count();
    check(
      `state: ${name}`,
      caught === expect.caught && done === expect.complete && panel === expect.complete,
      `caughtUp=${caught} fundComplete=${done} panel=${panel}`
    );
    if (expect.complete) {
      // The terminal state needs a closing action, not just a silent screen.
      const cta = (await page.locator(".floating-cta .hero-cta").innerText().catch(() => "")) || "";
      check(
        "state: fund complete offers the treasurer a final report",
        /export final report/i.test(cta),
        JSON.stringify(cta)
      );
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/state-${name.replace(/\s/g, "-")}.png` });
    await page.close();
  }
}

/** Decorative motion must disappear under prefers-reduced-motion, and content
 *  must stay visible when it does — a fade-up that starts at zero opacity
 *  would otherwise strand it. */
async function reducedMotion(browser) {
  for (const mode of ["no-preference", "reduce"]) {
    const ctx = await browser.newContext({
      viewport: { width: 430, height: 900 },
      reducedMotion: mode,
    });
    const page = await ctx.newPage();
    await serve(page, M.TABLE_DATA);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1600);
    const state = await page.evaluate(() => {
      const hero = document.querySelector(".battery-hero");
      return {
        anim: hero ? getComputedStyle(hero).animationName : "n/a",
        opacity: hero ? getComputedStyle(hero).opacity : "0",
      };
    });
    const wantNone = mode === "reduce";
    check(
      `reduced-motion=${mode}`,
      (wantNone ? state.anim === "none" : state.anim !== "none") && state.opacity === "1",
      `animation=${state.anim} opacity=${state.opacity}`
    );
    await ctx.close();
  }
}


/** Rejection (migration 006) and the master-PIN recovery, both new in phase 2. */
async function rejectionAndMasterPin(browser, errors) {
  const MEMBER = M.MEMBERS[2]; // Jan
  // Cycle 7's due date is pushed into the PAST for this fixture. Every date in
  // mock-data is in the future, so without this the rejection here is a refused
  // ADVANCE — nothing was owed — and it correctly no longer paints red. This
  // test is about a refused DEBT, which is the case that must still read red.
  const pastDue = M.CYCLES.map((c) =>
    c.cycle_number === 7 ? { ...c, due_date: "2026-01-15" } : c
  );
  const rejected = {
    ...M.TABLE_DATA,
    cycles: pastDue,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234", master_pin: "999111" },
    contributions: [
      ...M.CONTRIBUTIONS,
      {
        id: "00000000-0000-0000-0000-000000009999",
        cycle_id: M.CYCLES[6].id,
        member_id: MEMBER.id,
        status: 3,
        amount: 1000,
        proof_url: "https://example.invalid/rejected.jpg",
        paid_at: null,
        rejection_note: "Screenshot didn't show the amount clearly.",
        rejected_at: "2026-09-21T10:00:00Z",
      },
    ],
  };

  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`rejection: ${e}`));
  await serve(page, rejected);
  // Identify this device as the rejected member, so Home shows their banner.
  await page.addInitScript((id) => {
    try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
  }, MEMBER.id);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // The member is told, and told why.
  const card = page.locator(".rejected-card");
  check("rejection: banner shown", (await card.count()) === 1);
  const noteText = (await page.locator(".rejected-note-text").innerText().catch(() => "")).trim();
  check(
    "rejection: treasurer's note shown",
    noteText.includes("amount clearly"),
    JSON.stringify(noteText)
  );
  check("rejection: resubmit CTA", (await page.locator(".rejected-cta").count()) === 1);
  // MainMemberRejected draws ONE red card: the identity line moved into it and
  // the status card is suppressed, so the screen no longer stacks two.
  check(
    "rejection: one red card, not two",
    (await page.locator(".my-status-card").count()) === 0 &&
      (await page.locator(".rejected-ident").count()) === 1
  );
  check(
    "rejection: the card names who it is about",
    (await page.locator(".rejected-who").innerText()).includes(M.MEMBERS[2].name),
    await page.locator(".rejected-who").innerText()
  );

  // Resubmitting opens the contribute sheet rather than dead-ending.
  await page.locator(".rejected-cta").click();
  await page.waitForTimeout(300);
  check("rejection: resubmit opens contribute", (await page.locator(".modal-overlay").count()) >= 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // The rejected cycle reads as its own state in the Rounds grid, and the
  // member's ring goes red rather than looking idle.
  await page.locator(".tab-item", { hasText: "Rounds" }).click();
  await page.waitForTimeout(400);
  check(
    "rejection: a refused DEBT is still marked red in Rounds",
    (await page.locator(".member-chip.rejected").count()) >= 1,
    `${await page.locator(".member-chip.rejected").count()} red chips`
  );
  // Members is a Home drill-down on this shell, not a tab.
  await page.locator(".tab-item", { hasText: "Home" }).click();
  await page.waitForTimeout(300);
  await page.locator(".roster-strip-all").click();
  await page.waitForTimeout(300);
  check(
    "rejection: roster ring is red",
    (await page.locator(".avatar-rejected").count()) >= 1
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/rejection.png` });

  // --- master PIN -------------------------------------------------------
  // The keypad replaced the text field, so entry is dots + keys.
  await page.locator(".unlock-btn").click();
  await page.waitForTimeout(400);
  check("pin: keypad rendered", (await page.locator(".pin-key").count()) === 12);
  check(
    // This fund already has a master PIN, so it must NOT be offered again.
    "pin: no master-PIN offer when one is already set",
    (await page.locator(".pin-master-offer").count()) === 0
  );
  check("pin: dots rendered", (await page.locator(".pin-dot").count()) >= 4);

  // A wrong PIN is refused and clears the dots.
  await page.keyboard.type("0000");
  await page.locator(".modal-btn-primary").first().click();
  await page.waitForTimeout(300);
  check("pin: wrong PIN refused", (await page.locator(".pin-error").count()) === 1);
  check("pin: dots cleared", (await page.locator(".pin-dot.filled").count()) === 0);

  // The master PIN is the way back in when the group's own is forgotten.
  await page.keyboard.type("999111");
  await page.locator(".modal-btn-primary").first().click();
  await page.waitForTimeout(700);
  check(
    "pin: master PIN unlocks",
    (await page.locator(".unlock-btn.unlocked").count()) === 1
  );
  const warn = (await page.locator(".save-warning-banner").allInnerTexts().catch(() => [])).join(" ");
  check(
    "pin: master unlock nudges toward a new PIN",
    /master PIN/i.test(warn),
    JSON.stringify(warn.slice(0, 120))
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/master-pin.png` });

  await page.close();
}


/** Crossing the 900px breakpoint swaps the shell, and must not strand state.
 *  This is the whole risk of having two different nav item sets. */
async function breakpointCrossing(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(`breakpoint: ${e}`));
  await serve(page, M.TABLE_DATA);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const nav = async () => (await page.locator(".tab-bar").innerText()).replace(/\s+/g, " ");
  check("breakpoint: starts as sidebar", /Members/.test(await nav()));

  // Members is a desktop nav item. Narrowing has to keep the VIEW while
  // dropping the item from the bar, not strand the user on a screen the
  // shell can no longer describe.
  await page.locator(".tab-item", { hasText: "Members" }).click();
  await page.waitForTimeout(300);
  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(500);
  const narrowNav = await nav();
  check(
    "breakpoint: narrowing keeps Members open",
    (await page.locator(".view-members").count()) === 1 &&
      !/Members/.test(narrowNav) &&
      (await page.locator(".detail-back").count()) === 1,
    JSON.stringify(narrowNav)
  );
  check(
    "breakpoint: sidebar chrome gone",
    (await page.locator(".nav-mode").count()) === 0 &&
      (await page.locator(".nav-profile").count()) === 0
  );

  // Menu is a mobile tab but the desktop profile row. Widening from it must
  // keep it selected in its new home rather than losing the highlight.
  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(300);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  check(
    "breakpoint: Menu stays selected as the profile row",
    (await page.locator(".view-menu").count()) === 1 &&
      (await page.locator(".nav-profile.active").count()) === 1
  );

  await page.close();
}


/** Home composes itself differently per shell — a column on mobile, a
 *  dashboard on desktop — and the release card outranks the review queue. */
async function homeComposition(browser, errors) {
  // Desktop dashboard.
  const wide = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  wide.on("pageerror", (e) => errors.push(`home/desktop: ${e}`));
  await serve(wide, M.TABLE_DATA);
  await wide.goto(BASE, { waitUntil: "domcontentloaded" });
  await wide.waitForTimeout(1500);
  await unlockTreasurer(wide);
  await wide.waitForTimeout(400);

  check("home/desktop: greeting", (await wide.locator(".home-greet").count()) === 1);
  check(
    "home/desktop: main + rail",
    (await wide.locator(".home-grid > .home-main").count()) === 1 &&
      (await wide.locator(".home-grid > .home-rail").count()) === 1
  );
  check(
    "home/desktop: rail panels",
    (await wide.locator(".home-rail .home-rounds-strip").count()) === 1 &&
      (await wide.locator(".home-rail .home-quick").count()) === 1
  );
  check(
    "home/desktop: recent activity in main",
    (await wide.locator(".home-main .home-recent-row").count()) > 0
  );
  check(
    "home/desktop: attention is in the rail, hero in main",
    (await wide.locator(".home-rail .attention-panel").count()) === 1 &&
      (await wide.locator(".home-main .battery-hero").count()) === 1
  );
  // Nothing must scroll sideways at this width.
  const overflow = await wide.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  check("home/desktop: no horizontal overflow", overflow <= 1, `overflow=${overflow}px`);
  await wide.close();

  // Mobile stays a single column with none of that furniture.
  const narrow = await browser.newPage({ viewport: { width: 430, height: 950 } });
  narrow.on("pageerror", (e) => errors.push(`home/mobile: ${e}`));
  await serve(narrow, M.TABLE_DATA);
  await narrow.goto(BASE, { waitUntil: "domcontentloaded" });
  await narrow.waitForTimeout(1500);
  check(
    "home/mobile: no dashboard chrome",
    (await narrow.locator(".home-grid").count()) === 0 &&
      (await narrow.locator(".home-greet").count()) === 0
  );
  check("home/mobile: floating CTA kept", (await narrow.locator(".floating-cta").count()) === 1);
  await narrow.close();

  // A funded round outranks the review queue: the design settles the stacking
  // order explicitly, so assert release comes BEFORE attention in the DOM.
  const everyCyclePaidR1 = [];
  let id = 7000;
  M.CYCLES.filter((c) => c.cycle_number <= 6).forEach((cy) =>
    M.MEMBERS.forEach((m) =>
      everyCyclePaidR1.push({
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
  const funded = {
    ...M.TABLE_DATA,
    contributions: [...everyCyclePaidR1, ...M.CONTRIBUTIONS.filter((c) => c.status === 1)],
    payouts: M.PAYOUTS.map((p) => (p.round_number === 1 ? { ...p, released: false } : p)),
  };
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`home/release: ${e}`));
  await serve(page, funded);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await unlockTreasurer(page);
  await page.waitForTimeout(400);

  const order = await page.evaluate(() => {
    const rel = document.querySelector(".release-card");
    const att = document.querySelector(".attention-panel");
    if (!rel || !att) return { rel: !!rel, att: !!att, before: null };
    // Node.compareDocumentPosition: 4 == att follows rel.
    return { rel: true, att: true, before: !!(rel.compareDocumentPosition(att) & 4) };
  });
  check(
    "home/release card sits above the review queue",
    order.rel && order.att && order.before === true,
    JSON.stringify(order)
  );
  check(
    "home/release card is not inside the attention panel",
    (await page.locator(".attention-panel .release-card").count()) === 0
  );
  await page.close();
}


/** Members is an accordion on mobile and a master-detail pair on desktop, and
 *  the Menu splits by role. Both are phase-5 rewrites. */
async function membersAndMenu(browser, errors) {
  const ME = M.MEMBERS[2];

  // --- mobile: rows expand in place, no separate screen ------------------
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`members: ${e}`));
  await serve(page, M.TABLE_DATA);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator(".roster-strip-all").click();
  await page.waitForTimeout(350);

  check(
    "members/mobile: one row per member",
    (await page.locator(".member-row").count()) === M.MEMBERS.length
  );
  check("members/mobile: starts collapsed", (await page.locator(".member-row-panel").count()) === 0);

  await page.locator(".member-row").first().click();
  await page.waitForTimeout(300);
  check(
    "members/mobile: row expands in place",
    (await page.locator(".member-row-panel").count()) === 1 &&
      (await page.locator(".member-row-panel .round-line").count()) > 0
  );
  check(
    "members/mobile: expanded row is marked open",
    (await page.locator(".member-row[aria-expanded='true']").count()) === 1
  );

  // Tapping the same row again closes it — what an accordion has to do.
  await page.locator(".member-row").first().click();
  await page.waitForTimeout(300);
  check("members/mobile: tapping again collapses", (await page.locator(".member-row-panel").count()) === 0);

  // The design dropped the full-screen detail; it must not come back.
  check(
    "members/mobile: no drill-down screen",
    (await page.locator(".members-split").count()) === 0
  );
  await page.close();

  // --- desktop: master list beside a detail pane -------------------------
  const wide = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  wide.on("pageerror", (e) => errors.push(`members/desktop: ${e}`));
  await serve(wide, M.TABLE_DATA);
  await wide.goto(BASE, { waitUntil: "domcontentloaded" });
  await wide.waitForTimeout(1500);
  await wide.locator(".tab-item", { hasText: "Members" }).click();
  await wide.waitForTimeout(350);

  check("members/desktop: split layout", (await wide.locator(".members-split").count()) === 1);
  // POPULATED ON ARRIVAL. It used to open empty — ~750x780px of "Pick a
  // member" where the artboard ships with a member selected, and where this
  // screen's own sibling (Rounds) already auto-opens. With nobody identified
  // the pick is the collecting round's recipient.
  check(
    "members/desktop: the pane is populated on arrival",
    (await wide.locator(".members-detail .detail-name").count()) === 1 &&
      (await wide.locator(".members-detail-empty").count()) === 0,
    await wide.locator(".members-detail").innerText().catch(() => "")
  );
  check(
    "members/desktop: and it picks the current round's recipient",
    /Sarah/.test(await wide.locator(".members-detail .detail-name").innerText()),
    await wide.locator(".members-detail .detail-name").innerText()
  );
  // A DIFFERENT row, deliberately: nth(1) is the auto-selected one, and
  // clicking the open row toggles it shut — which is how the auto-select
  // first broke this check.
  await wide.locator(".member-row").nth(3).click();
  await wide.waitForTimeout(300);
  check(
    "members/desktop: picking fills the pane",
    (await wide.locator(".members-detail .detail-name").count()) === 1 &&
      (await wide.locator(".members-detail .round-line").count()) > 0
  );
  // The empty state is still reachable, and must still explain itself — the
  // auto-select must not be re-applied on the render after a deselect, or
  // clicking the open row would look like a dead button.
  await wide.locator(".member-row").nth(3).click();
  await wide.waitForTimeout(300);
  check(
    "members/desktop: deselecting empties the pane and it explains itself",
    (await wide.locator(".members-detail-empty").count()) === 1
  );
  check(
    "members/desktop: history not duplicated inline",
    (await wide.locator(".member-row-panel").count()) === 0
  );
  await wide.close();

  // --- member menu -------------------------------------------------------
  const mem = await browser.newPage({ viewport: { width: 430, height: 950 } });
  mem.on("pageerror", (e) => errors.push(`menu/member: ${e}`));
  await serve(mem, M.TABLE_DATA);
  // States its own mode. serve() pins AUTH_MODE to "off", and with accounts
  // off there is deliberately no "My Payout QR Code" row — nobody can own
  // payout details, so offering it would be a dead end. This test is about
  // the member menu WITH accounts on, which is where that row lives.
  await withAuthMode(mem, "optional");
  await mem.addInitScript((id) => {
    try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
  }, ME.id);
  await mem.goto(BASE, { waitUntil: "domcontentloaded" });
  await mem.waitForTimeout(1500);
  await mem.locator(".tab-item", { hasText: "Menu" }).click();
  await mem.waitForTimeout(300);

  const memText = (await mem.locator(".view-menu").innerText()).replace(/\s+/g, " ");
  check(
    "menu/member: profile card names them",
    (await mem.locator(".profile-card").count()) === 1 && memText.includes(ME.name)
  );
  check(
    // "Payout destination" became "My Payout QR Code" when the row stopped
    // being a read-only link into the member record and became the sheet where
    // a member sets it themselves. This page is not signed in, so that row
    // offers sign-in rather than opening a sheet that would be refused.
    "menu/member: view-only fund QR + a route to their own payout QR",
    /the treasurer manages this/i.test(memText) && /My Payout QR Code/i.test(memText)
  );
  // Nothing a member cannot act on should be reachable here.
  const forbidden = ["Export CSV", "Backup data", "Restore from backup", "Change PIN",
                     "Reset all fund data", "Edit member names", "Reorder payout order"];
  const leaked = forbidden.filter((f) => memText.includes(f));
  check("menu/member: no treasurer tools", leaked.length === 0, leaked.join(", "));
  check("menu/member: no danger zone", (await mem.locator(".danger-zone").count()) === 0);
  await mem.close();

  // --- reorder screen ----------------------------------------------------
  const tre = await browser.newPage({ viewport: { width: 430, height: 950 } });
  tre.on("pageerror", (e) => errors.push(`menu/reorder: ${e}`));
  await serve(tre, M.TABLE_DATA);
  await tre.goto(BASE, { waitUntil: "domcontentloaded" });
  await tre.waitForTimeout(1500);
  await unlockTreasurer(tre);
  await tre.locator(".tab-item", { hasText: "Menu" }).click();
  await tre.waitForTimeout(300);
  await tre.locator(".menu-row", { hasText: "Reorder payout order" }).click();
  await tre.waitForTimeout(350);
  check(
    "menu/reorder opens its own screen",
    (await tre.locator(".reorder-list .reorder-row").count()) === M.MEMBERS.length
  );
  check(
    "menu/reorder: end arrows disabled",
    (await tre.locator(".reorder-row").first().locator("button").first().isDisabled()) === true &&
      (await tre.locator(".reorder-row").last().locator("button").last().isDisabled()) === true
  );
  await tre.close();
}


/** Phase 7: Activity grouped and amount-forward, Insights' status donut, and
 *  the fund name reaching the header. */
async function activityAndInsights(browser, errors) {
  const named = {
    ...M.TABLE_DATA,
    app_settings: { ...M.SETTINGS, fund_name: "ViTAMiN Fund 2027" },
  };
  const page = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`p7: ${e}`));
  await serve(page, named);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // --- fund name -------------------------------------------------------
  const title = (await page.locator(".header .title").innerText()).trim();
  // Two subtitles exist (long for desktop, short for phones); neither may
  // repeat the fund name.
  const subs = await page.locator(".header .subtitle").allInnerTexts();
  const sub = subs.join(" · ").trim();
  check("p7/header shows the stored fund name", /ViTAMiN Fund 2027/.test(title), title);
  // The group's name used to live in the config subtitle; with both set the
  // header printed it twice.
  check(
    "p7/header does not repeat the name",
    !/ViTAMiN Fund 2027/i.test(sub),
    JSON.stringify(sub)
  );

  // --- activity --------------------------------------------------------
  await page.locator(".tab-item", { hasText: "Activity" }).click();
  await page.waitForTimeout(400);

  const days = await page.locator(".activity-day").allInnerTexts();
  check(
    "p7/activity groups by day",
    days.length >= 3 && days[0] === "Today" && days[1] === "Yesterday",
    JSON.stringify(days)
  );
  check(
    "p7/activity rows carry icons",
    (await page.locator(".activity-row .activity-mark").count()) ===
      (await page.locator(".activity-row").count())
  );
  const amounts = await page.locator(".activity-amt").allInnerTexts();
  check(
    "p7/amount column is signed by direction",
    amounts.some((a) => a.startsWith("+")) && amounts.some((a) => a.startsWith("−")),
    JSON.stringify(amounts)
  );
  const chips = (await page.locator(".activity-chip-state").allInnerTexts()).join("|");
  check(
    // "In review", not "Pending review" — one label for one state. The desktop
    // Activity column, the Insights donut, the roster and the Members
    // accordion all said "In review" while this chip said "Pending review".
    "p7/status chips shown",
    /In review/i.test(chips) && /Rejected/i.test(chips),
    chips
  );
  // Rows written before migration 006 have no typed data and must simply show
  // no amount, rather than an empty column that looks like missing data.
  const rows = await page.locator(".activity-row").count();
  check(
    "p7/untyped rows degrade to message only",
    amounts.length > 0 && amounts.length < rows,
    `rows=${rows} amounts=${amounts.length}`
  );

  // Filtering must collapse a day group that has nothing left in it.
  await page.locator(".activity-chip", { hasText: "Payouts" }).click();
  await page.waitForTimeout(300);
  const payoutDays = await page.locator(".activity-day").allInnerTexts();
  check(
    "p7/filter collapses empty day groups",
    payoutDays.length === 1 && payoutDays[0] === "Yesterday",
    JSON.stringify(payoutDays)
  );
  await page.locator(".activity-chip", { hasText: "All" }).click();
  await page.waitForTimeout(250);

  // --- insights --------------------------------------------------------
  await page.locator(".tab-item", { hasText: "Insights" }).click();
  await page.waitForTimeout(400);

  check("p7/status donut rendered", (await page.locator(".donut").count()) === 1);
  const legend = await page.locator(".donut-legend-row").count();
  const arcs = await page.locator(".donut g circle").count();
  check(
    "p7/every arc is named in the legend",
    legend > 0 && legend === arcs,
    `legend=${legend} arcs=${arcs}`
  );
  // Identity must not be colour-alone: the donut carries a text label for
  // screen readers as well as the visible legend.
  const label = await page.locator(".donut").getAttribute("aria-label");
  check("p7/donut has a text alternative", !!label && /\d/.test(label), label);
  check(
    "p7/overdue tile names who is behind",
    /nobody behind|,|\w/.test(
      (await page.locator(".view-insights .stat-label").allInnerTexts()).join(" ")
    )
  );
  await page.close();

  // Desktop Activity is a TABLE, not the phone list at a wider measure — the
  // one place the design gives desktop its own treatment and the app had been
  // reflowing instead.
  const wide = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  wide.on("pageerror", (e) => errors.push(`p2/activity-table: ${e}`));
  await serve(wide, M.TABLE_DATA);
  await wide.goto(BASE, { waitUntil: "domcontentloaded" });
  await wide.waitForTimeout(1500);
  await wide.locator(".tab-item", { hasText: "Activity" }).click();
  await wide.waitForTimeout(400);
  check(
    "p2/desktop activity renders a table",
    (await wide.locator(".activity-table").count()) === 1 &&
      (await wide.locator(".at-row").count()) >= 1
  );
  check(
    "p2/desktop activity drops the phone list",
    (await wide.locator(".activity-list-tab").count()) === 0
  );
  check(
    "p2/table carries the design's columns",
    (await wide.locator(".activity-table thead th").allInnerTexts())
      .map((t) => t.trim().toLowerCase())
      .join("|") === "when|member|type|round|detail|amount|status"
  );
  // Migration 007: attribution comes from real columns. The round dropdown
  // defaults to the fund's CURRENT round, as the design does.
  check(
    "p2/round filter defaults to the current round",
    (await wide.locator(".activity-select select").nth(1).inputValue()) === "2"
  );
  check(
    "p2/member column shows who, not a parsed name",
    (await wide.locator(".at-row .at-who").allInnerTexts()).length >= 1
  );
  // Entries written before 007 have no attribution. They must never be
  // silently dropped from a filtered view of financial history.
  // Every row the filters hold back is accounted for, not just the untagged
  // ones — the default round filter was hiding a released payout silently.
  check(
    "p2/hidden rows are all declared, with the untagged ones explained",
    (await wide.locator(".activity-unattributed").count()) === 1 &&
      /\d+ entries are hidden by the current filters/i.test(
        await wide.locator(".activity-unattributed").innerText()
      ) &&
      /recorded before entries carried a member and round/i.test(
        await wide.locator(".activity-unattributed").innerText()
      ),
    JSON.stringify(
      (await wide.locator(".activity-unattributed").innerText()).replace(/\s+/g, " ").slice(0, 170)
    )
  );
  const filteredCount = await wide.locator(".at-row").count();
  await wide.evaluate(() => PowerFund.setActivityRound("all"));
  await wide.waitForTimeout(250);
  const allRounds = await wide.locator(".at-row").count();
  check(
    "p2/All rounds reveals every row, notice included",
    allRounds > filteredCount &&
      (await wide.locator(".activity-unattributed").count()) === 0,
    `${filteredCount}→${allRounds}`
  );
  await wide.selectOption(".activity-select select >> nth=0", { label: "Sarah" });
  await wide.waitForTimeout(250);
  const sarah = await wide.locator(".at-row").count();
  check(
    "p2/member dropdown narrows to that member",
    sarah > 0 && sarah < allRounds &&
      (await wide.locator(".at-row .at-who").allInnerTexts()).every(
        (t) => t.trim() === "Sarah"
      ),
    `rows=${sarah}`
  );
  await wide.evaluate(() => PowerFund.setActivityMember("all"));
  await wide.waitForTimeout(250);
  check(
    "p2/no horizontal overflow at 1440",
    (await wide.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )) === 0
  );
  // The type filter still works against the table rows, and empties cleanly.
  const before = await wide.locator(".at-row").count();
  await wide.locator(".activity-chip", { hasText: "Payouts" }).click();
  await wide.waitForTimeout(300);
  const after = await wide.locator(".at-row").count();
  check("p2/table respects the type filter", after > 0 && after < before, `${before}→${after}`);
  await wide.close();

  // Mobile keeps the grouped list.
  const narrow = await browser.newPage({ viewport: { width: 390, height: 900 } });
  narrow.on("pageerror", (e) => errors.push(`p2/activity-list: ${e}`));
  await serve(narrow, M.TABLE_DATA);
  await narrow.goto(BASE, { waitUntil: "domcontentloaded" });
  await narrow.waitForTimeout(1500);
  await narrow.locator(".tab-item", { hasText: "Activity" }).click();
  await narrow.waitForTimeout(400);
  check(
    "p2/mobile activity keeps the grouped list",
    (await narrow.locator(".activity-table").count()) === 0 &&
      (await narrow.locator(".activity-list-tab").count()) >= 1
  );
  await narrow.close();
}


/** Phase 6: telling people what happened — required receipt, retryable
 *  uploads, restore's three states, and undoing one confirmed payment. */
async function feedbackStates(browser, errors) {
  // A funded round so the release sheet is reachable.
  const paidR1 = [];
  let id = 8000;
  M.CYCLES.filter((c) => c.cycle_number <= 6).forEach((cy) =>
    M.MEMBERS.forEach((m) =>
      paidR1.push({
        id: uuid(id++), cycle_id: cy.id, member_id: m.id, status: 2,
        amount: 1000, proof_url: null, paid_at: new Date(cy.due_date).toISOString(),
      })
    )
  );
  const funded = {
    ...M.TABLE_DATA,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
    contributions: [...paidR1, ...M.CONTRIBUTIONS.filter((c) => c.status === 1)],
    payouts: M.PAYOUTS.map((p) => (p.round_number === 1 ? { ...p, released: false } : p)),
  };

  // --- release needs its receipt (decision D4) ---------------------------
  const page = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`p6: ${e}`));
  await serve(page, funded);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await unlockTreasurer(page);
  await page.locator(".release-card .payout-btn").click();
  await page.waitForTimeout(400);

  const release = page.locator(".modal-btn-primary").last();
  check("p6/release blocked without a receipt", (await release.isDisabled()) === true);
  // A gate the eye can't see is worse than none — it must also LOOK disabled.
  const dim = await release.evaluate((b) => parseFloat(getComputedStyle(b).opacity));
  check("p6/disabled button looks disabled", dim < 0.8, `opacity=${dim}`);
  check(
    "p6/receipt marked required",
    /required/i.test(await page.locator(".modal").last().innerText())
  );
  check(
    "p6/no-QR offers a reminder to copy",
    (await page.locator(".copy-reminder-btn").count()) === 1
  );

  await page.locator(".modal input[type=file]").last().setInputFiles({
    name: "receipt.png", mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  await page.waitForTimeout(350);
  check(
    "p6/release enabled once attached",
    (await page.locator(".modal-btn-primary").last().isDisabled()) === false
  );
  await page.close();

  // --- a failed upload reports in place, with a retry --------------------
  const up = await browser.newPage({ viewport: { width: 430, height: 950 } });
  up.on("pageerror", (e) => errors.push(`p6/upload: ${e}`));
  await serve(up, M.TABLE_DATA);
  await up.route("**/storage/v1/**", (r) => r.abort()); // the upload fails
  await up.goto(BASE, { waitUntil: "domcontentloaded" });
  await up.waitForTimeout(1500);
  await up.evaluate((id) => PowerFund.openContributeModal(id, 7), M.MEMBERS[4].id);
  await up.waitForTimeout(350);
  await up.locator(".modal input[type=file]").first().setInputFiles({
    name: "proof.png", mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  await up.waitForTimeout(300);
  await up.locator(".modal-btn-primary").first().click();
  await up.waitForTimeout(1200);
  check(
    "p6/failed upload reports in the sheet",
    (await up.locator(".submit-state.failed").count()) === 1 &&
      (await up.locator(".submit-retry").count()) === 1
  );
  check(
    "p6/sheet stays open so nothing is re-entered",
    (await up.locator(".modal-overlay").count()) >= 1
  );
  await up.close();

  // --- restore rejects a file that isn't a backup -----------------------
  const res = await browser.newPage({ viewport: { width: 430, height: 950 } });
  res.on("pageerror", (e) => errors.push(`p6/restore: ${e}`));
  await serve(res, M.TABLE_DATA);
  await res.goto(BASE, { waitUntil: "domcontentloaded" });
  await res.waitForTimeout(1500);
  await res.evaluate(() =>
    PowerFund.restoreBackup(
      new File(['{"hello":"world"}'], "vacation-photos.json", { type: "application/json" })
    )
  );
  await res.waitForTimeout(400);
  const invalidText = (await res.locator(".modal").last().innerText()).replace(/\s+/g, " ");
  check(
    "p6/invalid backup names the file and reassures",
    /isn't a Power Fund backup/i.test(invalidText) &&
      /vacation-photos\.json/.test(invalidText) &&
      /untouched/i.test(invalidText),
    JSON.stringify(invalidText.slice(0, 130))
  );
  check(
    "p6/invalid backup offers another file",
    (await res.locator("button", { hasText: "Choose another file" }).count()) === 1
  );
  await res.close();

  // --- undo one confirmed payment, inline ------------------------------
  const un = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  un.on("pageerror", (e) => errors.push(`p6/undo: ${e}`));
  await serve(un, funded);
  await un.goto(BASE, { waitUntil: "domcontentloaded" });
  await un.waitForTimeout(1500);
  await unlockTreasurer(un);
  await un.locator(".tab-item", { hasText: "Rounds" }).click();
  await un.waitForTimeout(400);
  await un.locator(".round").first().click();
  await un.waitForTimeout(400);
  await un.locator(".member-chip.paid").first().click();
  await un.waitForTimeout(400);
  const panel = un.locator(".undo-paid-panel");
  check("p6/undo opens inline, not as a dialog", (await panel.count()) === 1);
  check(
    "p6/undo names the member and scope",
    /for them only/i.test(await panel.innerText())
  );
  check(
    "p6/undo stays inside the cycle row",
    (await un.locator(".cycle-row .undo-paid-panel").count()) === 1
  );
  await un.locator(".undo-paid-panel button", { hasText: "Cancel" }).click();
  await un.waitForTimeout(300);
  check("p6/undo cancels cleanly", (await un.locator(".undo-paid-panel").count()) === 0);
  await un.close();
}


/** QA-gate fixes: the design's colour rule for confirming someone else's
 *  payment, and the gate on the proof-less cash path. */
async function designGates(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`gates: ${e}`));
  await serve(page, { ...M.TABLE_DATA, app_settings: { ...M.SETTINGS, treasurer_pin: "1234" } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await unlockTreasurer(page);

  // Confirming a payment is a TREASURER action and must not wear the member's
  // amber "pay" colour — the design says so in as many words.
  await page.locator(".attention-more").click();
  await page.waitForTimeout(250);
  await page.locator(".queue-btn-review").first().click();
  await page.waitForTimeout(350);
  const confirm = page.locator(".modal-btn-confirm");
  check("gates/review confirm exists", (await confirm.count()) === 1);
  const [confirmBg, accent] = await page.evaluate(() => {
    const b = document.querySelector(".modal-btn-confirm");
    const cs = getComputedStyle(document.documentElement);
    return [getComputedStyle(b).backgroundColor, cs.getPropertyValue("--accent").trim()];
  });
  check(
    "gates/review confirm is not the member's pay colour",
    !!confirmBg && confirmBg !== accent && !/245,\s*166,\s*35/.test(confirmBg),
    `bg=${confirmBg} accent=${accent}`
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // The cash path writes money with no proof attached, so it confirms first.
  await page.locator(".tab-item", { hasText: "Rounds" }).click();
  await page.waitForTimeout(350);
  // Find a round holding a chip that is neither paid nor pending — those two
  // open undo and review respectively, not the cash path.
  const unpaidSel = ".member-chip.editable:not(.paid):not(.pending):not(.rejected)";
  const roundCount = await page.locator(".round").count();
  for (let i = 0; i < roundCount; i++) {
    await page.locator(".round").nth(i).click();
    await page.waitForTimeout(250);
    if ((await page.locator(unpaidSel).count()) > 0) break;
  }
  const unpaid = page.locator(unpaidSel).first();
  if ((await unpaid.count()) === 0) {
    check("gates/found an unpaid chip to tap", false, "no unpaid chip in any round");
  } else {
    await unpaid.click();
    await page.waitForTimeout(300);
    const panel = page.locator(".mark-paid-panel");
    check("gates/cash path confirms before writing", (await panel.count()) === 1);
    check(
      "gates/cash panel says no screenshot is attached",
      /no screenshot/i.test(await panel.innerText())
    );
    await page.locator(".mark-paid-panel button", { hasText: "Cancel" }).click();
    await page.waitForTimeout(250);
    check("gates/cash panel cancels cleanly", (await page.locator(".mark-paid-panel").count()) === 0);
  }
  await page.close();
}


/** QA round 2: the findings the independent review raised. */
async function qaFixes(browser, errors) {
  // --- a receipt that cannot be stored must NOT release the payout ---------
  const paid = [];
  let id = 8500;
  M.CYCLES.filter((c) => c.cycle_number <= 6).forEach((cy) =>
    M.MEMBERS.forEach((m) =>
      paid.push({
        id: uuid(id++), cycle_id: cy.id, member_id: m.id, status: 2,
        amount: 1000, proof_url: null, paid_at: new Date(cy.due_date).toISOString(),
      })
    )
  );
  const funded = {
    ...M.TABLE_DATA,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
    contributions: paid,
    payouts: M.PAYOUTS.map((p) => (p.round_number === 1 ? { ...p, released: false } : p)),
  };

  const page = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`qa/receipt: ${e}`));
  await serve(page, funded);
  await page.route("**/storage/v1/**", (r) => r.abort()); // the upload fails
  let released = false;
  await page.route("**/rest/v1/payouts**", (r) => {
    const req = r.request();
    if (req.method() === "PATCH" && /released/.test(req.postData() || "")) released = true;
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await unlockTreasurer(page);
  await page.locator(".release-card .payout-btn").click();
  await page.waitForTimeout(400);
  await page.locator(".modal input[type=file]").last().setInputFiles({
    name: "receipt.png", mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  await page.waitForTimeout(300);
  await page.locator(".modal-btn-primary").last().click();
  await page.waitForTimeout(1500);
  check(
    "qa/no receipt stored means no release recorded",
    released === false,
    `released=${released}`
  );
  // The failure is reported INSIDE the sheet now — a page banner would render
  // behind the sheet's own opaque overlay where nobody could read it.
  check(
    "qa/the failure is reported inside the sheet, retryably",
    (await page.locator(".modal .submit-state.failed").count()) === 1 &&
      /NOT released/i.test(await page.locator(".submit-state.failed").innerText()) &&
      (await page.locator(".submit-retry").count()) === 1,
    JSON.stringify(
      (await page.locator(".modal").last().innerText()).replace(/\s+/g, " ").slice(0, 160)
    )
  );
  // And a break-glass exists, so a real transfer is never unrepresentable.
  check(
    "qa/a no-receipt fallback is offered only after the upload fails",
    (await page.locator(".release-noreceipt").count()) === 1 &&
      /without the receipt/i.test(await page.locator(".release-noreceipt").innerText())
  );
  await page.close();

  // --- a failed write is announced and brought into view -------------------
  // The cash path goes through showError(), which is the banner this covers.
  // Contribute uses the in-sheet state machine instead, so it is the wrong
  // path to test here.
  const err = await browser.newPage({ viewport: { width: 430, height: 700 } });
  err.on("pageerror", (e) => errors.push(`qa/error: ${e}`));
  await serve(err, { ...M.TABLE_DATA, app_settings: { ...M.SETTINGS, treasurer_pin: "1234" } });
  await err.goto(BASE, { waitUntil: "domcontentloaded" });
  await err.waitForTimeout(1500);
  await unlockTreasurer(err);
  await err.locator(".tab-item", { hasText: "Rounds" }).click();
  await err.waitForTimeout(300);
  const unpaidSel2 = ".member-chip.editable:not(.paid):not(.pending):not(.rejected)";
  const rc = await err.locator(".round").count();
  for (let i = 0; i < rc; i++) {
    await err.locator(".round").nth(i).click();
    await err.waitForTimeout(250);
    if ((await err.locator(unpaidSel2).count()) > 0) break;
  }
  await err.locator(unpaidSel2).first().click();
  await err.waitForTimeout(300);
  // Block the write, then scroll away so the banner is off-screen when it fires.
  await err.route("**/rest/v1/contributions**", (r) =>
    r.request().method() === "GET"
      ? r.continue()
      : r.fulfill({ status: 500, contentType: "application/json", body: '{"message":"boom"}' })
  );
  await err.locator(".mark-paid-panel button", { hasText: "Record as paid" }).click();
  await err.waitForTimeout(1600);
  const banner = err.locator(".save-error-banner");
  check("qa/a failed write surfaces a banner", (await banner.count()) === 1);
  if ((await banner.count()) === 1) {
    check("qa/error banner is announced", (await banner.getAttribute("role")) === "alert");
    const inView = await banner.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
    check("qa/error banner is scrolled into view", inView);
  }
  await err.close();

  // --- Home chips carry every state, not three of five ---------------------
  const chips = await browser.newPage({ viewport: { width: 430, height: 900 } });
  chips.on("pageerror", (e) => errors.push(`qa/chips: ${e}`));
  const rejectedData = {
    ...M.TABLE_DATA,
    contributions: M.CONTRIBUTIONS.map((c) =>
      c.status === 1 ? { ...c, status: 3, rejection_note: "Blurry" } : c
    ),
  };
  await serve(chips, rejectedData);
  await chips.goto(BASE, { waitUntil: "domcontentloaded" });
  await chips.waitForTimeout(1500);
  // The per-member name badges below the jar are gone; the roster ring is now
  // the single place Home encodes each member's status for the open cycle, by
  // colour alone. A rejected claim must still be visible there.
  check(
    "qa/a rejected member is visible on Home's roster",
    (await chips.locator(".roster-strip .avatar-rejected").count()) >= 1,
    `rejected=${await chips.locator(".roster-strip .avatar-rejected").count()}`
  );
  // The mockup keeps a glyph beside the name (✓ Ana · ◷ You · ⚠ Dan · Elena).
  check(
    "qa/roster keeps a status glyph beside the name",
    (await chips.locator(".roster-name .roster-mark").count()) >= 1
  );
  // The ellipsis must live on the NAME, not on the flex row — on the row it
  // never applies to children, which is what knocked the icon off centre.
  const nameBox = await chips.evaluate(() => {
    const row = document.querySelector(".roster-name");
    const text = row && row.querySelector(".roster-name-text");
    const mark = row && row.querySelector(".roster-mark");
    if (!row || !text) return null;
    const cs = getComputedStyle(row);
    const ts = getComputedStyle(text);
    let dy = 0;
    if (mark) {
      const mr = mark.getBoundingClientRect();
      const tr = text.getBoundingClientRect();
      dy = Math.abs((mr.top + mr.height / 2) - (tr.top + tr.height / 2));
    }
    return { rowFlex: cs.display, rowClip: cs.textOverflow, textClip: ts.textOverflow, dy };
  });
  // A bare .check/.clock modifier collides with the legacy cycle-cell classes
  // of the same name, which carry a 28px box — the tick rendered ~3x size and
  // ellipsised the name. Assert the glyph stays glyph-sized and nothing clips.
  const glyphFit = await chips.evaluate(() =>
    [...document.querySelectorAll(".roster-chip")].map((c) => {
      const t = c.querySelector(".roster-name-text");
      const m = c.querySelector(".roster-mark");
      return {
        mark: m ? Math.round(m.getBoundingClientRect().width) : 0,
        clipped: t.scrollWidth > t.clientWidth + 1,
      };
    })
  );
  check(
    "qa/status glyph keeps its declared size",
    glyphFit.every((g) => g.mark === 0 || g.mark <= 14),
    JSON.stringify(glyphFit)
  );
  check(
    "qa/member names are not clipped by the glyph",
    glyphFit.every((g) => !g.clipped),
    JSON.stringify(glyphFit)
  );
  check(
    "qa/glyph and name share an optical centre",
    !!nameBox && nameBox.rowFlex === "flex" && nameBox.textClip === "ellipsis" && nameBox.dy <= 1.5,
    JSON.stringify(nameBox)
  );
  check(
    "qa/the duplicate badge row is gone",
    (await chips.locator(".cycle-status-chips").count()) === 0
  );
  await chips.close();

  // --- Rounds chips are real controls --------------------------------------
  const kb = await browser.newPage({ viewport: { width: 430, height: 900 } });
  kb.on("pageerror", (e) => errors.push(`qa/kb: ${e}`));
  await serve(kb, M.TABLE_DATA);
  await kb.goto(BASE, { waitUntil: "domcontentloaded" });
  await kb.waitForTimeout(1500);
  await kb.locator(".tab-item", { hasText: "Rounds" }).click();
  await kb.waitForTimeout(300);
  await kb.locator(".round").first().click();
  await kb.waitForTimeout(300);
  check(
    "qa/rounds chips are buttons, not spans",
    (await kb.locator("span.member-chip").count()) === 0 &&
      (await kb.locator("button.member-chip").count()) > 0
  );
  check(
    "qa/rounds chips carry a label for assistive tech",
    !!(await kb.locator("button.member-chip").first().getAttribute("aria-label"))
  );
  await kb.close();

  // --- a rejection must carry a reason ------------------------------------
  const rej = await browser.newPage({ viewport: { width: 430, height: 950 } });
  rej.on("pageerror", (e) => errors.push(`qa/reject: ${e}`));
  await serve(rej, { ...M.TABLE_DATA, app_settings: { ...M.SETTINGS, treasurer_pin: "1234" } });
  await rej.goto(BASE, { waitUntil: "domcontentloaded" });
  await rej.waitForTimeout(1500);
  await unlockTreasurer(rej);
  await rej.locator(".attention-more").click();
  await rej.waitForTimeout(300);
  await rej.locator(".queue-btn-review").first().click();
  await rej.waitForTimeout(400);
  await rej.locator(".modal-btn-secondary.reject").click();
  await rej.waitForTimeout(400);
  const yes = rej.locator(".modal-actions .confirm-yes");
  check("qa/reject is blocked until a reason is given", (await yes.isDisabled()) === true);
  check(
    "qa/and the field says it is required",
    /required/i.test(await rej.locator(".reject-note-label").innerText())
  );
  await rej.locator("#reject-note").fill("Screenshot is unreadable");
  await rej.waitForTimeout(250);
  check("qa/reject enables once a reason exists", (await yes.isDisabled()) === false);
  // Typing must not blow away the textarea mid-word.
  check(
    "qa/the reason survives typing",
    (await rej.locator("#reject-note").inputValue()) === "Screenshot is unreadable"
  );
  await rej.close();

  // --- the master PIN is administrable from the app ------------------------
  const mp = await browser.newPage({ viewport: { width: 430, height: 950 } });
  mp.on("pageerror", (e) => errors.push(`qa/master: ${e}`));
  await serve(mp, { ...M.TABLE_DATA, app_settings: { ...M.SETTINGS, treasurer_pin: "1234" } });
  await mp.goto(BASE, { waitUntil: "domcontentloaded" });
  await mp.waitForTimeout(1500);
  await unlockTreasurer(mp);
  await mp.locator(".tab-item", { hasText: "Menu" }).click();
  await mp.waitForTimeout(400);
  const menuText = await mp.locator(".view-menu, .view").last().innerText();
  check(
    "qa/menu offers the recovery PIN, and says when it is unset",
    /master pin/i.test(menuText) && /no way back from a forgotten pin/i.test(menuText),
    JSON.stringify(menuText.replace(/\s+/g, " ").slice(0, 120))
  );
  await mp.evaluate(() => window.PowerFund.openMasterPin());
  await mp.waitForTimeout(350);
  // It must not simply mirror the treasurer PIN.
  await mp.keyboard.type("1234");
  await mp.locator(".modal-btn-primary").first().click();
  await mp.waitForTimeout(400);
  check(
    "qa/master PIN cannot duplicate the treasurer PIN",
    /different digits/i.test(await mp.locator(".pin-error").innerText())
  );
  await mp.close();

  // --- "Payment due" only inside 7 days of the due date -------------------
  // The cycle being collected can be months out; the card was announcing a
  // December bill in September and offering to take the money.
  const dueWindow = async (daysOut, expectDue) => {
    const page2 = await browser.newPage({ viewport: { width: 430, height: 900 } });
    page2.on("pageerror", (e) => errors.push(`qa/due${daysOut}: ${e}`));
    const target = new Date();
    target.setDate(target.getDate() + daysOut);
    const iso = target.toISOString().slice(0, 10);
    // One open cycle, due `daysOut` from today, nobody paid.
    const cycles = M.CYCLES.map((c, i) =>
      i === 0 ? { ...c, due_date: iso } : { ...c, due_date: iso }
    );
    await serve(page2, {
      ...M.TABLE_DATA,
      cycles,
      contributions: [],
      activity_log: [],
      payouts: M.PAYOUTS.map((p) => ({
        ...p,
        released: false,
        started_at: p.round_number === 1 ? new Date().toISOString() : null,
      })),
    });
    await page2.addInitScript((id) => {
      window.localStorage.setItem("pf_my_member_id", id);
    }, M.MEMBERS[0].id);
    await page2.goto(BASE, { waitUntil: "domcontentloaded" });
    await page2.waitForTimeout(1500);
    const card = (await page2.locator(".my-status-card").innerText()).replace(/\s+/g, " ");
    check(
      `qa/due ${daysOut} days out → ${expectDue ? "payment due" : "caught up"}`,
      expectDue
        ? /payment due/i.test(card)
        : /all caught up/i.test(card) && !/payment due/i.test(card),
      JSON.stringify(card.slice(0, 110))
    );
    await page2.close();
  };
  await dueWindow(3, true);   // inside the window
  await dueWindow(30, false); // months out — nothing is owed yet

  // --- Undo Release names the receipt it removes ---------------------------
  const undo = await browser.newPage({ viewport: { width: 430, height: 900 } });
  undo.on("pageerror", (e) => errors.push(`qa/undo: ${e}`));
  await serve(undo, { ...M.TABLE_DATA, app_settings: { ...M.SETTINGS, treasurer_pin: "1234" } });
  await undo.goto(BASE, { waitUntil: "domcontentloaded" });
  await undo.waitForTimeout(1500);
  await unlockTreasurer(undo);
  await undo.evaluate(() => window.PowerFund.unmarkPayoutReleased(1));
  await undo.waitForTimeout(400);
  const undoText = await undo.locator(".modal").last().innerText();
  check(
    "qa/undo release names the receipt",
    /receipt/i.test(undoText),
    JSON.stringify(undoText.replace(/\s+/g, " ").slice(0, 160))
  );
  await undo.close();
}


/** The three payment sheets and the zoom lightbox, against their mockups. */
async function paymentSheets(browser, errors) {
  const SET = { ...M.SETTINGS, treasurer_pin: "1234", qr_bank: "Maya" };

  // --- Contribute: "Pay Cycle N", QR card, amount row, file chip ----------
  const c = await browser.newPage({ viewport: { width: 390, height: 900 } });
  c.on("pageerror", (e) => errors.push(`sheet/contribute: ${e}`));
  await serve(c, { ...M.TABLE_DATA, app_settings: SET });
  await c.goto(BASE, { waitUntil: "domcontentloaded" });
  await c.waitForTimeout(1500);
  await c.evaluate((id) => window.PowerFund.openContributeModal(id, 7), M.MEMBERS[2].id);
  await c.waitForTimeout(500);
  const cTitle = await c.locator(".sheet-pay h3").innerText();
  check("sheet/contribute is titled by its cycle", /Pay Cycle 7/i.test(cTitle), cTitle);
  check(
    "sheet/contribute has a close affordance in the head",
    (await c.locator(".sheet-head .sheet-x").count()) === 1
  );
  check(
    "sheet/QR is matted with its own actions",
    (await c.locator(".qr-card .qr-card-img").count()) === 1 &&
      (await c.locator(".qr-card .qr-card-save").count()) === 1 &&
      (await c.locator(".qr-card-expand").count()) === 1
  );
  // The wallet is named from settings, never hardcoded over someone's real QR.
  check(
    "sheet/QR names the wallet on file",
    /Maya/.test(await c.locator(".qr-card-title").innerText()),
    await c.locator(".qr-card-title").innerText()
  );
  check(
    "sheet/amount and pay-ahead share one panel",
    (await c.locator(".pay-panel .pay-row").count()) >= 1 &&
      (await c.locator(".pay-panel .stepper").count()) === 1
  );
  // Attaching shows the file as a named chip, not a bare box.
  await c.locator(".modal input[type=file]").first().setInputFiles({
    name: "payment-screenshot.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.alloc(1258291),
  });
  await c.waitForTimeout(400);
  const chipText = (await c.locator(".file-chip").innerText()).replace(/\s+/g, " ");
  check(
    "sheet/attached proof is a named, sized chip",
    /payment-screenshot\.jpg/.test(chipText) && /1\.2 MB · attached/.test(chipText),
    JSON.stringify(chipText)
  );
  check(
    // Two ways to replace it: pick another file, or shoot a fresh photo.
    "sheet/the chip offers a way to replace it",
    (await c.locator(".file-chip-change").count()) === 2 &&
      (await c.locator(".file-chip-change", { hasText: "Camera" }).count()) === 1
  );
  check(
    "sheet/primary action carries the amount",
    /I've sent this ·/.test(await c.locator(".modal-btn-primary").first().innerText())
  );
  // A broken or slow thumbnail must not spill alt text across the row.
  check(
    "sheet/thumbnail clips its contents",
    (await c.locator(".file-chip-thumb").evaluate((el) => getComputedStyle(el).overflow)) ===
      "hidden"
  );
  await c.close();

  // --- Review: claimant row, proof card, green confirm -------------------
  const r = await browser.newPage({ viewport: { width: 390, height: 900 } });
  r.on("pageerror", (e) => errors.push(`sheet/review: ${e}`));
  await serve(r, { ...M.TABLE_DATA, app_settings: SET });
  await r.goto(BASE, { waitUntil: "domcontentloaded" });
  await r.waitForTimeout(1500);
  await unlockTreasurer(r);
  await r.locator(".attention-more").click();
  await r.waitForTimeout(300);
  await r.locator(".queue-btn-review").first().click();
  await r.waitForTimeout(500);
  const claim = (await r.locator(".claim-row").innerText()).replace(/\s+/g, " ");
  check(
    "sheet/review leads with the claimant, cycle and amount",
    /Sarah/.test(claim) && /Cycle 7/.test(claim) && /₱1,000/.test(claim),
    JSON.stringify(claim)
  );
  check(
    "sheet/review says when it was submitted",
    /submitted/i.test(claim),
    JSON.stringify(claim)
  );
  check(
    "sheet/proof is a card that enlarges",
    (await r.locator(".proof-card").count()) === 1 &&
      (await r.locator(".proof-card-expand").count()) === 1
  );
  check(
    "sheet/confirm reads as the mockup and stays green",
    /Confirm Payment/.test(await r.locator(".modal-btn-confirm").innerText())
  );
  check(
    "sheet/reject is the only secondary, close moved to the head",
    (await r.locator(".modal-actions .modal-btn-secondary").count()) === 1 &&
      /Reject claim/.test(await r.locator(".modal-actions .modal-btn-secondary").innerText())
  );
  await r.close();

  // --- Release: ready banner, recipient, send-to card, lightbox ----------
  const paidRows = [];
  let id = 9600;
  M.CYCLES.filter((x) => x.cycle_number <= 6).forEach((cy) =>
    M.MEMBERS.forEach((m) =>
      paidRows.push({
        id: uuid(id++), cycle_id: cy.id, member_id: m.id, status: 2,
        amount: 1000, proof_url: null, paid_at: new Date(cy.due_date).toISOString(),
      })
    )
  );
  const withQr = M.MEMBERS.map((m, i) =>
    i === 0
      ? {
          ...m,
          payout_qr_url: "https://example.invalid/qr.png",
          payout_bank: "GCash",
          payout_account_number: "09XX XXX XXX2",
          payout_account_name: "Regine S.",
        }
      : m
  );
  const rel = await browser.newPage({ viewport: { width: 390, height: 950 } });
  rel.on("pageerror", (e) => errors.push(`sheet/release: ${e}`));
  await serve(rel, {
    ...M.TABLE_DATA, app_settings: SET, members: withQr, contributions: paidRows,
    payouts: M.PAYOUTS.map((p) => (p.round_number === 1 ? { ...p, released: false } : p)),
  });
  await rel.goto(BASE, { waitUntil: "domcontentloaded" });
  await rel.waitForTimeout(1500);
  await unlockTreasurer(rel);
  await rel.locator(".release-card .payout-btn").click();
  await rel.waitForTimeout(600);
  // A ready payout renders as its own card ABOVE the panel, so it must not
  // also count as panel content — that produced a "Needs your attention"
  // heading with nothing under it, and "All caught up" would contradict the
  // release card sitting right above.
  const attention = await rel.locator(".attention-panel");
  if ((await attention.count()) > 0) {
    const body = (await attention.innerText()).replace(/\s+/g, " ").trim();
    check(
      "home/attention panel is never an empty heading",
      body.replace(/needs your attention/i, "").trim().length > 0,
      JSON.stringify(body)
    );
    check(
      "home/no 'all caught up' while a payout is waiting",
      !/all caught up/i.test(body),
      JSON.stringify(body)
    );
  } else {
    check("home/attention panel absent when only a payout waits", true);
  }

  check(
    "sheet/release states why it is releasable first",
    (await rel.locator(".ready-banner").count()) === 1 &&
      /ready to release/i.test(await rel.locator(".ready-banner").innerText())
  );
  check(
    "sheet/release names the recipient in its own card",
    /Regine/.test(await rel.locator(".recipient-card").innerText())
  );
  const sendTo = (await rel.locator(".send-to-card").innerText()).replace(/\s+/g, " ");
  check(
    "sheet/send-to card carries the QR and the account it belongs to",
    (await rel.locator(".send-to-qr").count()) === 1 &&
      /payout QR/i.test(sendTo) &&
      /GCash/.test(sendTo) &&
      /09XX XXX XXX2/.test(sendTo),
    JSON.stringify(sendTo)
  );
  // The payout amount is FIXED at the round goal — no field, nothing to
  // mistype, and the button can only offer that figure.
  check(
    "sheet/payout amount is stated, not editable",
    (await rel.locator(".payout-amount-fixed").count()) === 1 &&
      (await rel.locator("#payout-amount").count()) === 0 &&
      (await rel.locator(".modal input[type=text], .modal input[inputmode=decimal]").count()) === 0
  );
  check(
    "sheet/the fixed amount is the round goal",
    /₱30,000\.00/.test(await rel.locator(".payout-amount-value").innerText()),
    await rel.locator(".payout-amount-value").innerText()
  );
  check(
    "sheet/release button offers only that figure",
    /Release ₱30,000\.00/.test(await rel.locator(".modal-btn-primary").first().innerText()),
    await rel.locator(".modal-btn-primary").first().innerText()
  );

  // Zoom: white mat, and Close BELOW the image as the mockup draws it.
  await rel.locator(".send-to-qr").click();
  await rel.waitForTimeout(400);
  check("sheet/zoom mats the image on white", (await rel.locator(".lightbox-frame").count()) === 1);
  const order = await rel.evaluate(() => {
    const f = document.querySelector(".lightbox-frame");
    const b = document.querySelector(".lightbox-close");
    if (!f || !b) return null;
    return b.getBoundingClientRect().top >= f.getBoundingClientRect().bottom - 1;
  });
  check("sheet/zoom puts Close below the image", order === true, String(order));
  await rel.close();
}

// --- Member accounts (migration 008) --------------------------------------
// AUTH_MODE lives in js/config.js, which the app loads as a plain script, so a
// test picks its mode by serving a patched copy of that one file. The session
// is seeded straight into the storage key supabase-js reads
// (sb-<projectref>-auth-token) with a far-future expiry, so getSession()
// resolves from storage and never tries to refresh over the network.
const FAKE_USER_EMAIL = "regine@example.com";

async function withAuthMode(page, mode, opts) {
  const signedIn = !!(opts && opts.signedIn);
  await page.route("**/js/config.js", async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(
      /AUTH_MODE:\s*"[a-z]*"/,
      `AUTH_MODE: "${mode}"`
    );
    return route.fulfill({ status: 200, contentType: "application/javascript", body });
  });
  // Nothing should reach the auth endpoints; fail loudly rather than hanging.
  await page.route("**/auth/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
  if (signedIn) {
    await page.addInitScript((arg) => {
      const ref = new URL(arg.url).hostname.split(".")[0];
      const email = arg.email;
      const far = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
      try {
        localStorage.setItem(
          `sb-${ref}-auth-token`,
          JSON.stringify({
            access_token: "test-access-token",
            token_type: "bearer",
            expires_in: 31536000,
            expires_at: far,
            refresh_token: "test-refresh-token",
            user: { id: "11111111-1111-1111-1111-111111111111", email, aud: "authenticated" },
          })
        );
      } catch (e) {}
    }, { email: (opts && opts.email) || FAKE_USER_EMAIL, url: supabaseUrl() });
  }
}

/** The project URL, read from js/config.js rather than hardcoded — the storage
 *  key is derived from it, and a stale copy here would seed the wrong key and
 *  fail the signed-in test for a reason nobody would guess. */
let _cfgUrl = null;
function supabaseUrl() {
  if (_cfgUrl) return _cfgUrl;
  const src = require("fs").readFileSync(path.join(__dirname, "..", "js", "config.js"), "utf8");
  const m = src.match(/SUPABASE_URL:\s*"([^"]+)"/);
  if (!m) throw new Error("Couldn't read SUPABASE_URL from js/config.js");
  _cfgUrl = m[1];
  return _cfgUrl;
}

const FAKE_USER_ID = "11111111-1111-1111-1111-111111111111";

/** PAYOUT_BANKS lives in js/app.js; read it rather than hardcoding a number,
 *  so adding a bank does not fail a test for the wrong reason. +2 for the
 *  "Choose one…" placeholder and "Other". */
/** The contribution amount, read from js/calculations.js. */
const C_AMOUNT = Number(
  (require("fs")
    .readFileSync(path.join(__dirname, "..", "js", "calculations.js"), "utf8")
    .match(/const CONTRIBUTION_AMOUNT = (\d+)/) || [, "1000"])[1]
);

/** The name length cap, read from js/app.js so the test cannot drift from it. */
const NAME_MAX = Number(
  (require("fs")
    .readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8")
    .match(/const NAME_MAX = (\d+)/) || [, "10"])[1]
);

const PAYOUT_BANK_COUNT =
  (require("fs")
    .readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8")
    .match(/const PAYOUT_BANKS = \[([^\]]*)\]/) || [, ""])[1]
    .split(",")
    .filter((x) => x.trim()).length + 2;

/** The roster with email addresses, as it looks after the treasurer has run
 *  migration 008's one-off. `overrides` patches the member at index 0. */
function rosterWithEmails(overrides) {
  return M.MEMBERS.map((m, i) => ({
    ...m,
    email: `${m.name.toLowerCase()}@example.com`,
    auth_user_id: null,
    is_treasurer: i === 0,
    ...(i === 0 ? overrides || {} : {}),
  }));
}

/** Claiming is a real write; capture it and answer as the database would. */
async function captureLinkWrites(page, data) {
  const writes = [];
  // Registered AFTER serve()'s catch-all, so this more specific route wins.
  await page.route("**/rest/v1/members**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(data.members),
      });
    }
    let body = {};
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch (e) {}
    writes.push({ url: req.url(), method: req.method(), body });
    // PATCH ... ?id=eq.X&auth_user_id=is.null — echo the row back linked, and
    // mutate the served roster so the next GET reflects it, exactly as a real
    // round-trip would.
    const target = data.members.find((m) => req.url().includes(m.id));
    if (target && body.auth_user_id) {
      target.auth_user_id = body.auth_user_id;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([target]),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  return writes;
}

/** Treasurer -> Account -> Member sign-in: the addresses a Google login is
 *  matched against, and who has actually signed in. Before this panel the
 *  addresses could only be set with hand-written SQL. */
async function signInAdmin(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`signin-admin: ${e}`));

  // A half-rolled-out fund: three of five have an address, one has signed in.
  // rosterWithEmails() flags member 0 as the treasurer, and that member is the
  // one our fake session owns — so this page is the admin.
  const members = rosterWithEmails();
  members[3].email = null;
  members[4].email = null;
  members[0].auth_user_id = FAKE_USER_ID;
  const data = { ...M.TABLE_DATA, members };

  await serve(page, data);
  const writes = [];
  await page.route("**/rest/v1/members**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(data.members),
      });
    }
    let body = {};
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch (e) {}
    writes.push({ url: req.url(), body });
    const target = data.members.find((m) => req.url().includes(m.id));
    Object.assign(target || {}, body);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([target || {}]),
    });
  });
  const logs = [];
  await page.route("**/rest/v1/activity_log**", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      try {
        logs.push(JSON.parse(req.postData() || "{}"));
      } catch (e) {}
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(req.method() === "GET" ? data.activity_log || [] : []),
    });
  });
  await withAuthMode(page, "optional", { signedIn: true, email: "regine@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // STARTS LOCKED, even for the flagged treasurer. Signing in no longer opens
  // treasurer mode on its own — a load is not an intent to act on money.
  check(
    "signin-admin/signing in does NOT open treasurer mode by itself",
    /unlock/i.test(await page.locator(".unlock-btn").innerText()) &&
      (await page.locator(".mode-card.on").count()) === 0
  );

  // ...and opening it costs one tap and NO PIN. The login already proves more
  // than a code shared with all five members can.
  await page.locator(".unlock-btn").click();
  await page.waitForTimeout(500);
  check(
    "signin-admin/and one tap opens it with no PIN prompt",
    (await page.locator(".modal-overlay").count()) === 0 &&
      /treasurer/i.test(await page.locator(".unlock-btn").innerText())
  );

  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(400);
  check(
    "signin-admin/the mode card says why it is open",
    /signed in as the fund's treasurer/i.test(
      await page.locator(".mode-card .mode-card-note").innerText()
    )
  );

  const menuRow = page.locator(".menu-row", { hasText: "Member sign-in" });
  check("signin-admin/the treasurer gets a Member sign-in row", (await menuRow.count()) === 1);
  check(
    "signin-admin/the row says how far the rollout has got",
    /3 of 5 addresses on file/.test(await menuRow.first().innerText())
  );

  await menuRow.first().click();
  await page.waitForTimeout(400);
  check(
    "signin-admin/the panel lists every member",
    (await page.locator(".member-accounts-modal .acct-row").count()) === 5
  );
  check(
    "signin-admin/a linked member reads as signed in",
    (await page.locator(".member-accounts-modal .acct-pill.ok").count()) === 1
  );
  check(
    "signin-admin/an address on file but no login yet says so",
    (await page.locator(".member-accounts-modal .acct-pill.wait").count()) === 2
  );
  check(
    "signin-admin/a member with no address is called out separately",
    (await page.locator(".member-accounts-modal .acct-pill.none").count()) === 2
  );
  check(
    "signin-admin/only a linked member offers Unlink",
    (await page.locator(".member-accounts-modal .acct-unlink").count()) === 1
  );
  check(
    "signin-admin/the readiness line names both outstanding counts",
    /3\/5/.test(await page.locator(".acct-ready").innerText()) &&
      /1\/5/.test(await page.locator(".acct-ready").innerText())
  );

  // Validation, live and without losing the caret (same rule as names).
  const inputs = page.locator(".member-accounts-modal .email-input");
  await inputs.nth(3).fill("not-an-email");
  await page.waitForTimeout(250);
  check(
    "signin-admin/a malformed address is called out as you type",
    /doesn't look like an email/i.test(await page.locator("#memberEmailsError").innerText()) &&
      (await page.locator("#memberEmailsSave").isDisabled())
  );
  await inputs.nth(3).fill(await inputs.nth(0).inputValue());
  await page.waitForTimeout(250);
  check(
    "signin-admin/two members can't share an address",
    /can't share/i.test(await page.locator("#memberEmailsError").innerText())
  );
  // Blank is legitimate — it is the state of every member not yet collected.
  await inputs.nth(3).fill("");
  await page.waitForTimeout(250);
  check(
    "signin-admin/a blank address is allowed",
    (await page.locator("#memberEmailsError").isHidden()) &&
      !(await page.locator("#memberEmailsSave").isDisabled())
  );

  // Saved lowercased, because resolveAccount() compares lowercased — a
  // capitalised paste would otherwise never match its login.
  await inputs.nth(3).fill("  Verdz.Test@Gmail.com  ");
  await page.waitForTimeout(250);
  await page.locator("#memberEmailsSave").click();
  await page.waitForTimeout(900);
  const emailWrite = writes.find((w) => "email" in w.body);
  check(
    "signin-admin/the address is stored trimmed and lowercased",
    !!emailWrite && emailWrite.body.email === "verdz.test@gmail.com"
  );
  check(
    "signin-admin/only the one changed row is written",
    writes.filter((w) => "email" in w.body).length === 1
  );
  // The addresses are five people's personal accounts; the activity log is
  // read by all of them and lands in the CSV export and the backup file, so
  // the entry names the member and never the address.
  const logged = logs.map((b) => JSON.stringify(b)).join(" ");
  check(
    "signin-admin/the activity entry names the member, not the address",
    /Sign-in email/.test(logged) && !/verdz\.test@gmail\.com/.test(logged)
  );

  // Unlinking is confirmed first, and clears auth_user_id — nothing else.
  await page.locator(".menu-row", { hasText: "Member sign-in" }).first().click();
  await page.waitForTimeout(400);
  await page.locator(".member-accounts-modal .acct-unlink").first().click();
  await page.waitForTimeout(400);
  check(
    "signin-admin/Unlink confirms before it acts",
    /unlink/i.test(await page.locator(".modal[role=dialog]").last().innerText())
  );
  await page.locator(".modal-btn-primary", { hasText: /Unlink/i }).first().click();
  await page.waitForTimeout(900);
  const unlink = writes.find((w) => "auth_user_id" in w.body);
  check(
    "signin-admin/Unlink clears the link and touches nothing else",
    !!unlink && unlink.body.auth_user_id === null && Object.keys(unlink.body).length === 1
  );
  await page.close();

  // THE POINT OF THE ADMIN GATE. The treasurer PIN is shared with all five
  // members, so a member who is NOT the flagged treasurer can unlock treasurer
  // mode — and must still not be able to decide who can sign in. Gating this
  // on `unlocked` would let them put their own address on somebody else's row.
  const notAdmin = await browser.newPage({ viewport: { width: 430, height: 950 } });
  notAdmin.on("pageerror", (e) => errors.push(`signin-admin/member: ${e}`));
  const roster2 = rosterWithEmails();
  roster2[1].auth_user_id = FAKE_USER_ID; // Sarah's login; Regine is the treasurer
  await serve(notAdmin, { ...M.TABLE_DATA, members: roster2 });
  await withAuthMode(notAdmin, "optional", { signedIn: true, email: "sarah@example.com" });
  await notAdmin.goto(BASE, { waitUntil: "domcontentloaded" });
  await notAdmin.waitForTimeout(2500);
  // Stronger than "the PIN does not reveal the panel": a linked non-treasurer
  // cannot reach treasurer mode at all now, so the PIN-holder-sees-admin-tools
  // scenario is not reachable through the UI in the first place.
  check(
    "signin-admin/a non-treasurer login is NOT auto-unlocked",
    (await notAdmin.locator(".mode-card.on").count()) === 0 &&
      (await notAdmin.locator(".unlock-btn").count()) === 0
  );
  await notAdmin.locator(".tab-item", { hasText: "Menu" }).click();
  await notAdmin.waitForTimeout(400);
  check(
    "signin-admin/a non-treasurer never sees Member sign-in",
    (await notAdmin.locator(".menu-row", { hasText: "Member sign-in" }).count()) === 0
  );
  // Nor the role transfer, which is the other admin-only surface.
  check(
    "signin-admin/nor Transfer treasurer role",
    (await notAdmin.locator(".menu-row", { hasText: "Transfer treasurer role" }).count()) === 0
  );
  // The handler is exported on PowerFund, so hiding the row is not the gate.
  await notAdmin.evaluate(() => window.PowerFund.openMemberAccountsModal());
  await notAdmin.evaluate(() => window.PowerFund.openTransferRole());
  await notAdmin.waitForTimeout(400);
  check(
    "signin-admin/both handlers refuse a non-treasurer outright",
    (await notAdmin.locator(".member-accounts-modal").count()) === 0 &&
      (await notAdmin.locator(".transfer-role-modal").count()) === 0
  );
  await notAdmin.close();

  // Locking must stick across the 30-second poll and the tab-focus reload,
  // which is how the admin sees the app the way a member does.
  const lock = await browser.newPage({ viewport: { width: 430, height: 950 } });
  lock.on("pageerror", (e) => errors.push(`signin-admin/lock: ${e}`));
  const roster3 = rosterWithEmails();
  roster3[0].auth_user_id = FAKE_USER_ID;
  await serve(lock, { ...M.TABLE_DATA, members: roster3 });
  await withAuthMode(lock, "optional", { signedIn: true, email: "regine@example.com" });
  await lock.goto(BASE, { waitUntil: "domcontentloaded" });
  await lock.waitForTimeout(2500);
  await lock.evaluate(() => window.PowerFund.toggleUnlock()); // open it
  await lock.waitForTimeout(400);
  await lock.evaluate(() => window.PowerFund.toggleUnlock()); // and lock it
  await lock.waitForTimeout(400);
  // A real reload, through the same path the poll and the tab-focus handler
  // use — reload() is not exported, and faking it would prove nothing.
  await lock.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await lock.waitForTimeout(1500);
  check(
    "signin-admin/a lock survives a reload cycle",
    /unlock/i.test(await lock.locator(".unlock-btn").innerText())
  );
  await lock.close();

  // THE BOUNDARY. A PIN-free toggle is for a VERIFIED treasurer only. Anyone
  // the app cannot identify still sees the button (it is the only route to the
  // master PIN) and must still be asked for the PIN — otherwise a member who
  // simply skips sign-in gets one-tap treasurer mode, and before migration 011
  // that is real write access to every table.
  const anon = await browser.newPage({ viewport: { width: 430, height: 950 } });
  anon.on("pageerror", (e) => errors.push(`signin-admin/anon: ${e}`));
  await serve(anon, {
    ...M.TABLE_DATA,
    members: rosterWithEmails(),
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  });
  await withAuthMode(anon, "optional"); // signed OUT
  await anon.goto(BASE, { waitUntil: "domcontentloaded" });
  await anon.waitForTimeout(2200);
  check(
    "signin-admin/an unidentified visitor still gets the button",
    (await anon.locator(".unlock-btn").count()) === 1
  );
  await anon.locator(".unlock-btn").click();
  await anon.waitForTimeout(500);
  check(
    "signin-admin/but is still asked for the PIN — no free pass",
    (await anon.locator(".modal-overlay").count()) === 1 &&
      (await anon.locator(".mode-card.on").count()) === 0
  );
  await anon.close();
}

/** Claim / link on first sign-in (phase 3). */
async function accountLinking(browser, errors) {
  // 1. A matching address that nobody has claimed: link it, silently.
  const link = await browser.newPage({ viewport: { width: 430, height: 950 } });
  link.on("pageerror", (e) => errors.push(`link: ${e}`));
  // Sarah, deliberately — NOT the flagged treasurer at index 0. A flagged
  // treasurer's login now auto-unlocks treasurer mode, and that branch of the
  // Menu has no "You are" card at all (its route to a profile is Account ->
  // Edit my profile, asserted separately in profileEditing).
  const data = { ...M.TABLE_DATA, members: rosterWithEmails() };
  await serve(link, data);
  const writes = await captureLinkWrites(link, data);
  await withAuthMode(link, "required", { signedIn: true, email: "sarah@example.com" });
  await link.goto(BASE, { waitUntil: "domcontentloaded" });
  await link.waitForTimeout(2500);
  check("link/a matching first login gets into the app", (await link.locator(".tab-bar").count()) === 1);
  const claim = writes.find((w) => w.body && w.body.auth_user_id === FAKE_USER_ID);
  check("link/the claim is actually written", !!claim, JSON.stringify(writes.map((w) => w.method)));
  check(
    "link/the claim is guarded by auth_user_id is null",
    !!claim && /auth_user_id=is\.null/.test(claim.url),
    claim ? claim.url.split("?")[1] : "no write"
  );
  // Identity now comes from the link, so it cannot be switched.
  check(
    "link/the identity switcher is gone",
    (await link.locator(".my-status-change").count()) === 0
  );
  await link.locator(".tab-item", { hasText: "Menu" }).click();
  await link.waitForTimeout(400);
  check(
    // Linked, the card offers Edit (migration 009) rather than "Not you?" —
    // the member row belongs to the account, so it is not switchable.
    "link/Menu offers Edit instead of \"Not you?\"",
    (await link.locator(".profile-card-change", { hasText: "Edit" }).count()) === 1 &&
      (await link.locator(".profile-card-change", { hasText: "Not you?" }).count()) === 0
  );
  await link.close();

  // 2. An address nobody on the roster carries: a dead-end with a way out.
  const unknown = await browser.newPage({ viewport: { width: 430, height: 950 } });
  unknown.on("pageerror", (e) => errors.push(`link: ${e}`));
  await serve(unknown, { ...M.TABLE_DATA, members: rosterWithEmails() });
  await withAuthMode(unknown, "required", { signedIn: true, email: "stranger@example.com" });
  await unknown.goto(BASE, { waitUntil: "domcontentloaded" });
  await unknown.waitForTimeout(2500);
  check("link/an unknown address is refused", (await unknown.locator(".signin").count()) === 1);
  check(
    "link/it says which address it refused",
    (await unknown.locator(".signin-sub").innerText()).includes("stranger@example.com")
  );
  check("link/no fund data leaks to a stranger", (await unknown.locator(".tab-bar").count()) === 0);
  check(
    "link/the dead-end offers a way out",
    /sign out/i.test(await unknown.locator(".signin-btn").innerText())
  );
  await unknown.close();

  // 3. The matching row already belongs to a different login.
  const taken = await browser.newPage({ viewport: { width: 430, height: 950 } });
  taken.on("pageerror", (e) => errors.push(`link: ${e}`));
  await serve(taken, {
    ...M.TABLE_DATA,
    members: rosterWithEmails({ auth_user_id: "99999999-9999-9999-9999-999999999999" }),
  });
  await withAuthMode(taken, "required", { signedIn: true, email: "regine@example.com" });
  await taken.goto(BASE, { waitUntil: "domcontentloaded" });
  await taken.waitForTimeout(2500);
  check("link/an already-claimed member is refused", (await taken.locator(".signin").count()) === 1);
  check(
    "link/it explains the row is taken",
    /already linked/i.test(await taken.locator(".signin-sub").innerText()),
    await taken.locator(".signin-title").innerText()
  );
  await taken.close();

  // 4. The treasurer never ran the one-off, so no address exists to match.
  const noEmail = await browser.newPage({ viewport: { width: 430, height: 950 } });
  noEmail.on("pageerror", (e) => errors.push(`link: ${e}`));
  await serve(noEmail, M.TABLE_DATA); // fixtures carry no email column at all
  await withAuthMode(noEmail, "required", { signedIn: true, email: "regine@example.com" });
  await noEmail.goto(BASE, { waitUntil: "domcontentloaded" });
  await noEmail.waitForTimeout(2500);
  check(
    "link/a roster with no addresses says so, not \"not on the roster\"",
    /isn't ready/i.test(await noEmail.locator(".signin-title").innerText()),
    await noEmail.locator(".signin-title").innerText()
  );
  await noEmail.close();

  // 5. Optional mode must NOT wall off an unrecognised account.
  const soft = await browser.newPage({ viewport: { width: 430, height: 950 } });
  soft.on("pageerror", (e) => errors.push(`link: ${e}`));
  await serve(soft, { ...M.TABLE_DATA, members: rosterWithEmails() });
  await withAuthMode(soft, "optional", { signedIn: true, email: "stranger@example.com" });
  await soft.goto(BASE, { waitUntil: "domcontentloaded" });
  await soft.waitForTimeout(2500);
  check("link/optional keeps the app for a stranger", (await soft.locator(".tab-bar").count()) === 1);
  check(
    "link/optional still says the account is unrecognised",
    (await soft.locator(".save-warning-banner").count()) >= 1 &&
      /roster/i.test(await soft.locator(".save-warning-banner").first().innerText())
  );
  await soft.close();
}

/** The floating CTA's geometry. Reported from a real phone: the "Resubmit
 *  payment" button cut a hard band across the round card behind it and sat
 *  2px inside the tab bar.
 *
 *  None of the ~370 checks around this one could see it — they assert markup
 *  and behaviour, and this was three numbers disagreeing. So this one measures
 *  boxes instead. */
async function ctaGeometry(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
  page.on("pageerror", (e) => errors.push(`cta-geom: ${e}`));
  // A rejected member gets the pinned "Resubmit payment" CTA — the exact case
  // that was reported.
  const members = rosterWithEmails();
  const rejected = [
    {
      id: "geom-1",
      member_id: members[0].id,
      cycle_number: 1,
      status: 3,
      rejection_note: "Blurry screenshot",
      rejected_at: new Date().toISOString(),
      proof_url: null,
      amount: C_AMOUNT,
    },
  ];
  await serve(page, { ...M.TABLE_DATA, members, contributions: rejected });
  await page.addInitScript((id) => {
    try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
  }, members[0].id);
  await withAuthMode(page, "off");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);

  check(
    "cta-geom/the rejected member gets a pinned Resubmit action",
    (await page.locator(".floating-cta .rejected-cta").count()) === 1
  );

  const box = async (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
    }, sel);

  // THE BUTTON'S OWN CONTENTS. The container checks below passed while the
  // icon was on a line of its own at the left edge and the label wrapped
  // underneath — measuring the box said nothing about what was inside it.
  //
  // Cause: `.floating-cta .hero-cta { display: block }` outranked
  // `.rejected-cta { display: flex }`, so justify-content and gap were
  // computed but inert and the block-level <svg> took its own line.
  const inner = await page.evaluate(() => {
    const btn = document.querySelector(".floating-cta .rejected-cta");
    if (!btn) return null;
    const svg = btn.querySelector("svg");
    const span = btn.querySelector("span");
    if (!svg || !span) return null;
    const b = btn.getBoundingClientRect();
    const s = svg.getBoundingClientRect();
    const t = span.getBoundingClientRect();
    return {
      display: getComputedStyle(btn).display,
      gap: Math.round(t.left - s.right),
      rowOffset: Math.abs(s.top + s.height / 2 - (t.top + t.height / 2)),
      pairOffCentre: Math.abs((s.left + t.right) / 2 - (b.left + b.width / 2)),
    };
  });
  check(
    "cta-geom/the Resubmit button is a flex row, not a block",
    !!inner && inner.display === "flex",
    inner && inner.display
  );
  check(
    "cta-geom/its icon and label sit on one line, side by side",
    !!inner && inner.rowOffset <= 2 && inner.gap >= 4 && inner.gap <= 12,
    inner && `gap ${inner.gap}px, vertical offset ${Math.round(inner.rowOffset)}px`
  );
  check(
    "cta-geom/and the icon+label pair is centred in the button",
    !!inner && inner.pairOffCentre <= 3,
    inner && `${Math.round(inner.pairOffCentre)}px off centre`
  );

  const cta = await box(".floating-cta");
  const bar = await box(".tab-bar");
  const spacer = await box(".cta-spacer");

  // It used to be pinned at 58px above a bar that measures 60px.
  check(
    "cta-geom/the CTA sits ON the tab bar, not inside it",
    !!cta && !!bar && cta.bottom <= bar.top,
    `cta bottom ${cta && cta.bottom} vs tab-bar top ${bar && bar.top}`
  );
  // The spacer was 84px against a CTA of 95px, so the last card could never
  // fully clear it.
  check(
    "cta-geom/the spacer reserves at least the CTA's height",
    !!cta && !!spacer && spacer.h >= cta.h,
    `spacer ${spacer && spacer.h}px vs CTA ${cta && cta.h}px`
  );

  // Scrolled to the end, nothing real may still be under the button.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  const cta2 = await box(".floating-cta");
  const spacer2 = await box(".cta-spacer");
  check(
    "cta-geom/at the end of the page the CTA covers only the spacer",
    !!cta2 && !!spacer2 && cta2.top >= spacer2.top,
    `cta top ${cta2 && cta2.top} vs spacer top ${spacer2 && spacer2.top}`
  );
  await page.close();

  // Desktop reuses .tab-bar as a full-height sidebar, so the mobile bar's
  // fixed height must not leak into it.
  const wide = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  wide.on("pageerror", (e) => errors.push(`cta-geom/desktop: ${e}`));
  await serve(wide, { ...M.TABLE_DATA, members, contributions: rejected });
  await withAuthMode(wide, "off");
  await wide.goto(BASE, { waitUntil: "domcontentloaded" });
  await wide.waitForTimeout(2200);
  const side = await wide.evaluate(() => {
    const el = document.querySelector(".tab-bar");
    return el ? Math.round(el.getBoundingClientRect().height) : 0;
  });
  check(
    "cta-geom/the desktop sidebar is still full height",
    side > 400,
    `${side}px tall`
  );
  await wide.close();
}

/** Resubmitting a rejected batch. Reported from use: a member paid six cycles
 *  in one transfer, the treasurer rejected all six, and "Resubmit payment"
 *  opened a sheet set to ONE cycle — so five stayed rejected and the card kept
 *  reporting a refusal the member thought they had answered. */
async function resubmitBatch(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`resubmit: ${e}`));
  const members = rosterWithEmails();
  const me = members[2];
  const contributions = [];
  for (let n = 1; n <= 6; n++) {
    // cycle_id, not cycle_number: app.js:468 DERIVES cycle_number from
    // cycle_id, so a fixture that sets only the number has it overwritten with
    // undefined and every cycle label renders as "undefined".
    contributions.push({
      id: "j" + n, member_id: me.id, cycle_id: M.CYCLES[n - 1].id, status: 3,
      amount: C_AMOUNT, proof_url: "batch.jpg",
      rejected_at: "2026-09-10T00:00:00Z", rejection_note: "Blurry",
    });
  }
  await serve(page, { ...M.TABLE_DATA, members, contributions, payouts: [] });
  await page.addInitScript((id) => {
    try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
  }, me.id);
  await withAuthMode(page, "off");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2400);

  check(
    "resubmit/the rejection card names the whole batch",
    /Cycles 1.6/.test(await page.locator(".rejected-card").innerText())
  );
  await page.locator(".rejected-cta").click();
  await page.waitForTimeout(600);
  // THE FIX: the sheet offers to redo all six, not one.
  const sheetText = (await page.locator(".sheet-pay").innerText()).replace(/\s+/g, " ");
  check(
    "resubmit/the sheet defaults to the whole rejected batch",
    /6\s*cycles/i.test(sheetText) || /6,000/.test(sheetText),
    sheetText.slice(0, 120)
  );
  await page.close();

  // A PARTIAL resubmission must still say so: the remaining cycles are genuinely
  // still owed, and the card used to mention only the refusal.
  const part = await browser.newPage({ viewport: { width: 430, height: 950 } });
  part.on("pageerror", (e) => errors.push(`resubmit/partial: ${e}`));
  // Keyed on cycle_id, for the same reason the fixture above is: cycle_number
  // is not on these rows — the app derives it.
  const partial = contributions.map((r) =>
    r.cycle_id === M.CYCLES[0].id ? { ...r, status: 1 } : r
  );
  await serve(part, { ...M.TABLE_DATA, members, contributions: partial, payouts: [] });
  await part.addInitScript((id) => {
    try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
  }, me.id);
  await withAuthMode(part, "off");
  await part.goto(BASE, { waitUntil: "domcontentloaded" });
  await part.waitForTimeout(2400);
  const card = (await part.locator(".rejected-card").innerText()).replace(/\s+/g, " ");
  check(
    "resubmit/a partial resubmission still reports what is STILL rejected",
    /Cycles 2.6/.test(card),
    card.slice(0, 100)
  );
  // A REFUSED ADVANCE IS NOT A DEBT. Jan's cycles 2-6 had no due date yet, so
  // the card must not call them "still due" and the grid must not paint them
  // red. Display only — the rows keep status 3 and their note.
  check(
    "resubmit/a refused advance is not called 'still due'",
    !/These cycles are still due/.test(card) && /paid ahead|aren't due yet/i.test(card),
    card.slice(0, 160)
  );
  await part.locator(".tab-item", { hasText: "Rounds" }).click();
  await part.waitForTimeout(600);
  check(
    "resubmit/...and its chips are not painted red in the grid",
    (await part.locator(".member-chip.rejected").count()) === 0,
    `${await part.locator(".member-chip.rejected").count()} red chips`
  );
  await part.locator(".tab-item", { hasText: "Home" }).click();
  await part.waitForTimeout(500);

  check(
    "resubmit/...and says the resubmitted cycle is with the treasurer",
    (await part.locator(".rejected-inreview").count()) === 1 &&
      /Cycle 1 is/.test(await part.locator(".rejected-inreview").innerText())
  );
  await part.close();
}

/** Whose cycle is this? Tapping another member's chip in Rounds used to open
 *  the pay sheet for THEM, with their name only in a small subtitle — so a
 *  mis-tap filed your screenshot as their contribution. Migration 011 refuses
 *  it outright (contributions_self keys on pf_member_id()), so the UI must not
 *  offer a button that is about to fail. */
async function payAttribution(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`pay-attr: ${e}`));
  const members = rosterWithEmails();
  const me = members[1]; // Sarah
  me.auth_user_id = FAKE_USER_ID;
  // Nothing paid, so every cycle-1 chip is genuinely owed and the guard is
  // actually reached. With the default fixture many are already confirmed and
  // cellClicked returns early — which passes the refusal checks below for the
  // wrong reason.
  await serve(page, { ...M.TABLE_DATA, members, contributions: [] });
  // Identity seeded DIRECTLY, not left to the sign-in round-trip. WHO THE APP
  // THINKS YOU ARE is the entire subject of this test, so it must not depend
  // on the harness happening to link an account — that is exactly how these
  // checks first passed for the wrong reason: nobody was identified, so every
  // chip was clickable and the handler took the who-are-you branch instead of
  // the refusal branch.
  await page.addInitScript((id) => {
    try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
  }, me.id);
  await withAuthMode(page, "optional");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator(".tab-item", { hasText: "Rounds" }).click();
  await page.waitForTimeout(500);
  // Open the current round so the per-cycle chips are on screen.
  await page.locator(".round-head, .round").first().click().catch(() => {});
  await page.waitForTimeout(600);

  const owedChips = page.locator(".member-chip.editable");
  const n = await owedChips.count();
  // The PREMISE, asserted rather than assumed: only the open round's own
  // cycles are tappable, all of them Sarah's. If this is wrong, the two checks
  // after it mean nothing.
  const allChips = await page.locator(".member-chip").count();
  // The PREMISE, asserted rather than assumed: the grid draws every cycle of
  // every round, so "one member's share" — not "one round's worth" — is what
  // tappable should mean. Getting this wrong is how the refusal checks below
  // first passed while every chip on screen was still clickable.
  check(
    "pay-attr/exactly one member's share of chips is tappable",
    n > 0 && allChips > 0 && n === allChips / M.MEMBERS.length,
    `${n} editable of ${allChips} chips, ${M.MEMBERS.length} members`
  );
  // Every chip a member can tap must be their own.
  let foreignClickable = 0;
  for (let i = 0; i < n; i++) {
    const label = await owedChips.nth(i).getAttribute("aria-label");
    if (label && !label.startsWith(me.name + ":")) foreignClickable++;
  }
  check(
    "pay-attr/a member can only tap their OWN chip",
    foreignClickable === 0,
    `${foreignClickable} other members' chips were clickable`
  );

  // The handler is exported, so the disabled button is not the gate.
  const otherId = members[0].id;
  await page.evaluate((id) => window.PowerFund.cellClicked(id, 1), otherId);
  await page.waitForTimeout(500);
  check(
    "pay-attr/the handler refuses another member's cycle",
    (await page.locator(".sheet-pay").count()) === 0
  );
  const errText = await page
    .locator(".save-error-banner")
    .innerText()
    .catch(() => "");
  check(
    "pay-attr/and says whose cycle it was, rather than failing silently",
    /can only send your own payment/i.test(errText),
    errText
      ? errText.replace(/\s+/g, " ").slice(0, 90)
      : "no error banner — identified as: " +
        (await page.evaluate(() => {
          const el = document.querySelector(".profile-card-name");
          return el ? el.textContent : "(nobody)";
        }))
  );
  await page.close();

  // Nobody identified: ask who they are rather than guessing from the chip.
  const anon = await browser.newPage({ viewport: { width: 430, height: 950 } });
  anon.on("pageerror", (e) => errors.push(`pay-attr/anon: ${e}`));
  await serve(anon, { ...M.TABLE_DATA, contributions: [] });
  // Explicitly NOT identified: no linked account and no who-am-I preference.
  await anon.addInitScript(() => {
    try { localStorage.removeItem("pf_my_member_id"); } catch (e) {}
  });
  await withAuthMode(anon, "off");
  await anon.goto(BASE, { waitUntil: "domcontentloaded" });
  await anon.waitForTimeout(2200);
  const firstId = M.MEMBERS[0].id;
  await anon.evaluate((id) => window.PowerFund.cellClicked(id, 1), firstId);
  await anon.waitForTimeout(500);
  check(
    "pay-attr/an unidentified device is asked who it is, not guessed at",
    (await anon.locator(".sheet-pay").count()) === 0 &&
      (await anon.locator(".modal-overlay").count()) === 1
  );
  await anon.close();

  // The treasurer's legitimate path must announce whose payment it is.
  const tre = await browser.newPage({ viewport: { width: 430, height: 950 } });
  tre.on("pageerror", (e) => errors.push(`pay-attr/treasurer: ${e}`));
  const t = rosterWithEmails();
  t[0].auth_user_id = FAKE_USER_ID;
  await serve(tre, { ...M.TABLE_DATA, members: t, contributions: [] });
  await tre.addInitScript((id) => {
    try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
  }, t[0].id);
  await withAuthMode(tre, "optional");
  await tre.goto(BASE, { waitUntil: "domcontentloaded" });
  await tre.waitForTimeout(2500);
  await tre.evaluate((id) => window.PowerFund.openContributeModal(id, 1), t[1].id);
  await tre.waitForTimeout(500);
  check(
    "pay-attr/paying for someone else names them in the TITLE, not a subtitle",
    /for Sarah/i.test(await tre.locator("#dlg-title").innerText())
  );
  check(
    "pay-attr/and warns the proof is filed against their cycle",
    (await tre.locator(".pay-for-warn").count()) === 1
  );
  // Your own payment must not carry the warning.
  await tre.evaluate(() => window.PowerFund.closeModal());
  await tre.waitForTimeout(300);
  await tre.evaluate((id) => window.PowerFund.openContributeModal(id, 1), t[0].id);
  await tre.waitForTimeout(500);
  check(
    "pay-attr/your own payment is unchanged — no name, no warning",
    !/for Regine/i.test(await tre.locator("#dlg-title").innerText()) &&
      (await tre.locator(".pay-for-warn").count()) === 0
  );
  await tre.close();
}

/** My Payout QR Code — member-managed (MyPayoutQRManage.dc.html). This is
 *  where a member's ₱30,000 gets sent, so the interesting assertions are the
 *  refusals: the UI must not offer, and the handlers must not accept, editing
 *  anybody else's. */
async function myPayoutQr(browser, errors) {
  // ---- A linked member editing their OWN -------------------------------
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`payout-qr: ${e}`));
  const members = rosterWithEmails();
  const me = members[1]; // Sarah — deliberately NOT the flagged treasurer
  const other = members[0];
  me.auth_user_id = FAKE_USER_ID;
  other.payout_bank = "BPI";
  other.payout_account_name = "Regine R";
  other.payout_account_number = "091712345678";
  const data = { ...M.TABLE_DATA, members };

  await serve(page, data);
  const writes = [];
  await page.route("**/rest/v1/members**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(data.members),
      });
    }
    let body = {};
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch (e) {}
    const target = data.members.find((m) => req.url().includes(m.id));
    writes.push({ name: target && target.name, body });
    Object.assign(target || {}, body);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([target || {}]),
    });
  });
  await withAuthMode(page, "optional", { signedIn: true, email: "sarah@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // Nothing on file and Sarah is member_order 2, so the Home nudge is due.
  check(
    "payout-qr/Home nudges a member whose round is near and has nothing on file",
    (await page.locator(".payout-nudge").count()) === 1 &&
      /Add your payout QR/i.test(await page.locator(".payout-nudge").innerText())
  );

  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(400);
  const ownRow = page.locator(".menu-row", { hasText: "My Payout QR Code" });
  check("payout-qr/the member gets the design's Menu row", (await ownRow.count()) === 1);
  await ownRow.first().click();
  await page.waitForTimeout(450);
  check("payout-qr/the sheet opens", (await page.locator(".sheet-payout-qr").count()) === 1);
  check(
    "payout-qr/it says what is on file, and nudges by round",
    /Nothing on file/i.test(await page.locator(".pq-status").innerText()) &&
      /before Round 2/i.test(await page.locator(".pq-status").innerText())
  );
  check(
    "payout-qr/the bank is a picker, not a free-text box",
    (await page.locator("#pq-bank option").count()) === PAYOUT_BANK_COUNT
  );
  check(
    "payout-qr/both camera and library are offered",
    (await page.locator('.sheet-payout-qr .photo-row input[capture="environment"]').count()) === 1 &&
      (await page.locator(".sheet-payout-qr .photo-row").count()) === 2
  );

  // "Other" is a dead option in the artboard; it has to reveal a field.
  check(
    "payout-qr/no free-text bank field until Other is chosen",
    (await page.locator("#pq-bank-other").count()) === 0
  );
  await page.locator("#pq-bank").selectOption("__other");
  await page.waitForTimeout(400);
  check(
    "payout-qr/Other reveals a field to type one in",
    (await page.locator("#pq-bank-other").count()) === 1
  );
  // ...and picking a listed bank must not leave the stale Other text behind.
  await page.locator("#pq-bank").selectOption("GCash");
  await page.waitForTimeout(400);
  check(
    "payout-qr/choosing a listed bank hides it again",
    (await page.locator("#pq-bank-other").count()) === 0
  );

  await page.locator("#pq-num").fill("09171234567");
  await page.locator("#pq-name").fill("Sarah T");
  await page.locator(".modal-btn-primary", { hasText: /Save Payout QR/i }).click();
  await page.waitForTimeout(1200);
  const w = writes.find((x) => x.body && "payout_bank" in x.body);
  check(
    "payout-qr/it saves to the signed-in member's OWN row",
    !!w && w.name === "Sarah" && w.body.payout_bank === "GCash",
    JSON.stringify(w || null)
  );
  check(
    "payout-qr/and stamps payout_updated_at, so a swap is datable",
    !!w && !!w.body.payout_updated_at
  );
  await page.close();

  // ---- The refusals ----------------------------------------------------
  const guard = await browser.newPage({ viewport: { width: 430, height: 950 } });
  guard.on("pageerror", (e) => errors.push(`payout-qr/guard: ${e}`));
  const g = rosterWithEmails();
  g[1].auth_user_id = FAKE_USER_ID;
  await serve(guard, { ...M.TABLE_DATA, members: g });
  await withAuthMode(guard, "optional", { signedIn: true, email: "sarah@example.com" });
  await guard.goto(BASE, { waitUntil: "domcontentloaded" });
  await guard.waitForTimeout(2500);

  // THE ONE THAT MATTERS. openPayoutQrModal is exported on PowerFund, so the
  // absence of a button is not the gate: passing someone else's id must be
  // refused outright, not open their sheet.
  const otherId = g[0].id;
  await guard.evaluate((id) => window.PowerFund.openPayoutQrModal(id), otherId);
  await guard.waitForTimeout(450);
  check(
    "payout-qr/the handler refuses another member's id",
    (await guard.locator(".sheet-payout-qr").count()) === 0
  );
  // With no argument it must open THEIR OWN, not the first row it finds.
  await guard.evaluate(() => window.PowerFund.openPayoutQrModal());
  await guard.waitForTimeout(450);
  check(
    "payout-qr/with no argument it opens your own",
    (await guard.locator(".sheet-payout-qr").count()) === 1 &&
      /e.g. Sarah/i.test(await guard.locator("#pq-name").getAttribute("placeholder"))
  );
  await guard.close();

  // ---- Not signed in: offered, but as sign-in --------------------------
  const anon = await browser.newPage({ viewport: { width: 430, height: 950 } });
  anon.on("pageerror", (e) => errors.push(`payout-qr/anon: ${e}`));
  await serve(anon, { ...M.TABLE_DATA, members: rosterWithEmails() });
  await withAuthMode(anon, "optional");
  await anon.goto(BASE, { waitUntil: "domcontentloaded" });
  await anon.waitForTimeout(2200);
  await anon.evaluate((id) => {
    try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
  }, rosterWithEmails()[1].id);
  await anon.reload({ waitUntil: "domcontentloaded" });
  await anon.waitForTimeout(2200);
  await anon.locator(".tab-item", { hasText: "Menu" }).click();
  await anon.waitForTimeout(400);
  check(
    // The who-am-I preference is per-device and unverified, so it must not be
    // enough to change where money goes — the row offers sign-in instead.
    "payout-qr/the who-am-I preference alone does not unlock it",
    /Sign in to set where your payout is sent/i.test(
      await anon.locator(".view-menu").innerText()
    )
  );
  await anon.evaluate(() => window.PowerFund.openPayoutQrModal());
  await anon.waitForTimeout(400);
  check(
    "payout-qr/and the handler refuses without a linked account",
    (await anon.locator(".sheet-payout-qr").count()) === 0
  );
  await anon.close();

  // ---- The treasurer no longer edits anyone else's --------------------
  const tre = await browser.newPage({ viewport: { width: 430, height: 950 } });
  tre.on("pageerror", (e) => errors.push(`payout-qr/treasurer: ${e}`));
  const t = rosterWithEmails();
  t[0].auth_user_id = FAKE_USER_ID; // Regine, the flagged treasurer
  t[1].payout_bank = "GCash";
  t[1].payout_account_number = "091712345678";
  await serve(tre, { ...M.TABLE_DATA, members: t });
  await withAuthMode(tre, "optional", { signedIn: true, email: "regine@example.com" });
  await tre.goto(BASE, { waitUntil: "domcontentloaded" });
  await tre.waitForTimeout(2500);
  await tre.locator(".tab-item", { hasText: "Home" }).click();
  await tre.waitForTimeout(300);
  await tre.locator(".roster-chip, .roster-item, .member-row").first().click().catch(() => {});
  await tre.waitForTimeout(500);
  // Reached however the roster opens, the point is the same: no edit button on
  // somebody else's payout destination, and the number is masked.
  const treText = await tre.locator("body").innerText();
  check(
    "payout-qr/the treasurer gets no edit button on another member's payout",
    !/Edit payout details/i.test(treText)
  );
  check(
    "payout-qr/another member's account number is masked in the roster",
    !treText.includes("091712345678")
  );
  await tre.close();

  // ---- The carve-out: the treasurer covers members who have not signed in --
  // Without it this feature strands exactly the people it is meant to serve:
  // a member with no account cannot set their own details, and if nobody else
  // can either, the destination is unreachable from the app entirely.
  const cover = await browser.newPage({ viewport: { width: 430, height: 950 } });
  cover.on("pageerror", (e) => errors.push(`payout-qr/cover: ${e}`));
  const c = rosterWithEmails();
  c[0].auth_user_id = FAKE_USER_ID; // Regine, the flagged treasurer
  c[2].auth_user_id = null;         // Jan has never signed in
  c[3].auth_user_id = "33333333-3333-3333-3333-333333333333"; // Clara has
  const cdata = { ...M.TABLE_DATA, members: c };
  await serve(cover, cdata);
  const cwrites = [];
  await cover.route("**/rest/v1/members**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify(cdata.members),
      });
    }
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
    const target = cdata.members.find((m) => req.url().includes(m.id));
    cwrites.push({ name: target && target.name, body });
    Object.assign(target || {}, body);
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([target || {}]),
    });
  });
  await withAuthMode(cover, "optional", { signedIn: true, email: "regine@example.com" });
  await cover.goto(BASE, { waitUntil: "domcontentloaded" });
  await cover.waitForTimeout(2500);

  // Jan is unlinked -> the treasurer may stand in.
  await cover.evaluate((id) => window.PowerFund.openPayoutQrModal(id), c[2].id);
  await cover.waitForTimeout(450);
  check(
    "payout-qr/the treasurer may fill in for a member who hasn't signed in",
    (await cover.locator(".sheet-payout-qr").count()) === 1 &&
      /Jan's Payout QR Code/i.test(await cover.locator("#pq-title").innerText())
  );
  check(
    "payout-qr/and the sheet says it is on their behalf, not the treasurer's own",
    /hasn't signed in yet/i.test(await cover.locator(".modal-sub").last().innerText())
  );
  await cover.locator("#pq-bank").selectOption("Maya");
  await cover.locator("#pq-num").fill("09181112222");
  await cover.locator(".modal-btn-primary", { hasText: /Save their details/i }).click();
  await cover.waitForTimeout(1200);
  const cw = cwrites.find((x) => x.body && "payout_bank" in x.body);
  check(
    "payout-qr/it writes to THAT member's row",
    !!cw && cw.name === "Jan" && cw.body.payout_bank === "Maya",
    JSON.stringify(cw || null)
  );

  // Clara IS linked -> the carve-out must not apply. This is the half that
  // keeps the feature meaningful: it shrinks as the fund signs in.
  await cover.evaluate(() => window.PowerFund.closePayoutQrModal());
  await cover.waitForTimeout(300);
  await cover.evaluate((id) => window.PowerFund.openPayoutQrModal(id), c[3].id);
  await cover.waitForTimeout(450);
  check(
    "payout-qr/but NOT for a member who has signed in — it closes on linking",
    (await cover.locator(".sheet-payout-qr").count()) === 0
  );
  await cover.close();

  // A plain member must never get the carve-out, linked target or not.
  const nosy = await browser.newPage({ viewport: { width: 430, height: 950 } });
  nosy.on("pageerror", (e) => errors.push(`payout-qr/nosy: ${e}`));
  const n = rosterWithEmails();
  n[1].auth_user_id = FAKE_USER_ID; // Sarah, an ordinary member
  n[2].auth_user_id = null;         // Jan, unlinked
  await serve(nosy, { ...M.TABLE_DATA, members: n });
  await withAuthMode(nosy, "optional", { signedIn: true, email: "sarah@example.com" });
  await nosy.goto(BASE, { waitUntil: "domcontentloaded" });
  await nosy.waitForTimeout(2500);
  await nosy.evaluate((id) => window.PowerFund.openPayoutQrModal(id), n[2].id);
  await nosy.waitForTimeout(450);
  check(
    "payout-qr/an ordinary member gets no carve-out over an unlinked member",
    (await nosy.locator(".sheet-payout-qr").count()) === 0
  );
  await nosy.close();
}

/** The unlock button is hidden from a member the app can identify as somebody
 *  other than the treasurer — and shown in every case it cannot, because it is
 *  the only route to the PIN modal and so to the MASTER PIN, the fund's
 *  recovery path. */
async function unlockVisibility(browser, errors) {
  // A linked non-treasurer: hidden.
  const member = await browser.newPage({ viewport: { width: 430, height: 950 } });
  member.on("pageerror", (e) => errors.push(`unlock-vis/member: ${e}`));
  const r1 = rosterWithEmails();
  r1[1].auth_user_id = FAKE_USER_ID; // Sarah; Regine is flagged
  await serve(member, { ...M.TABLE_DATA, members: r1 });
  await withAuthMode(member, "optional", { signedIn: true, email: "sarah@example.com" });
  await member.goto(BASE, { waitUntil: "domcontentloaded" });
  await member.waitForTimeout(2500);
  check(
    "unlock-vis/a linked non-treasurer never sees Unlock",
    (await member.locator(".unlock-btn").count()) === 0
  );
  // Hiding a button is not a gate — the handler is on window.
  await member.evaluate(() => window.PowerFund.toggleUnlock());
  await member.waitForTimeout(400);
  check(
    "unlock-vis/and the handler refuses them too",
    (await member.locator(".modal-overlay").count()) === 0
  );
  await member.close();

  // The flagged treasurer: shown, and already unlocked.
  const tre = await browser.newPage({ viewport: { width: 430, height: 950 } });
  tre.on("pageerror", (e) => errors.push(`unlock-vis/treasurer: ${e}`));
  const r2 = rosterWithEmails();
  r2[0].auth_user_id = FAKE_USER_ID;
  await serve(tre, { ...M.TABLE_DATA, members: r2 });
  await withAuthMode(tre, "optional", { signedIn: true, email: "regine@example.com" });
  await tre.goto(BASE, { waitUntil: "domcontentloaded" });
  await tre.waitForTimeout(2500);
  check(
    "unlock-vis/the treasurer still gets the button",
    (await tre.locator(".unlock-btn").count()) === 1
  );
  await tre.close();

  // NOT SIGNED IN: shown. This is the lockout guard — the button is the only
  // route to the PIN modal, and the PIN modal is the only route to the master
  // PIN. Hiding it from someone merely unidentified would take the fund's own
  // way back in with it.
  const anon = await browser.newPage({ viewport: { width: 430, height: 950 } });
  anon.on("pageerror", (e) => errors.push(`unlock-vis/anon: ${e}`));
  await serve(anon, { ...M.TABLE_DATA, members: rosterWithEmails() });
  await withAuthMode(anon, "optional");
  await anon.goto(BASE, { waitUntil: "domcontentloaded" });
  await anon.waitForTimeout(2200);
  check(
    "unlock-vis/an unidentified visitor still gets it (master-PIN route)",
    (await anon.locator(".unlock-btn").count()) === 1
  );
  await anon.close();

  // NOBODY FLAGGED: shown, even to a linked member. The fund has no treasurer
  // account yet, so the PIN is the only authority that exists.
  const boot = await browser.newPage({ viewport: { width: 430, height: 950 } });
  boot.on("pageerror", (e) => errors.push(`unlock-vis/bootstrap: ${e}`));
  const r3 = rosterWithEmails().map((m) => ({ ...m, is_treasurer: false }));
  r3[1].auth_user_id = FAKE_USER_ID;
  await serve(boot, { ...M.TABLE_DATA, members: r3 });
  await withAuthMode(boot, "optional", { signedIn: true, email: "sarah@example.com" });
  await boot.goto(BASE, { waitUntil: "domcontentloaded" });
  await boot.waitForTimeout(2500);
  check(
    "unlock-vis/with nobody flagged, the PIN is still the way in",
    (await boot.locator(".unlock-btn").count()) === 1
  );
  await boot.close();
}

/** More than one treasurer — the state a half-completed transfer leaves, which
 *  the app could create and not fix. 011's preflight refuses to lock a fund
 *  down while it holds, so the only route back was SQL. */
async function extraTreasurer(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`extra-treasurer: ${e}`));
  const members = rosterWithEmails();
  members[0].auth_user_id = FAKE_USER_ID; // Regine, flagged and signed in
  members[4].is_treasurer = true;         // Verdz, also flagged
  members[4].auth_user_id = "44444444-4444-4444-4444-444444444444";
  const data = {
    ...M.TABLE_DATA,
    members,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  };
  await serve(page, data);
  const writes = [];
  await page.route("**/rest/v1/members**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify(data.members),
      });
    }
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
    const target = data.members.find((m) => req.url().includes(m.id));
    writes.push({ name: target && target.name, body });
    Object.assign(target || {}, body);
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([target || {}]),
    });
  });
  await withAuthMode(page, "optional", { signedIn: true, email: "regine@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator(".unlock-btn").click();
  await page.waitForTimeout(500);
  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(400);
  await page.locator(".menu-row", { hasText: "Transfer treasurer role" }).first().click();
  await page.waitForTimeout(450);

  check(
    "extra-treasurer/the second flagged treasurer is surfaced",
    (await page.locator(".transfer-extra").count()) === 1 &&
      /Verdz/.test(await page.locator(".transfer-extra").innerText())
  );
  check(
    "extra-treasurer/and it says 011 will refuse while it holds",
    /011/.test(await page.locator(".transfer-extra-note").innerText())
  );
  // You are not listed as your own extra — stepping down is Transfer, which
  // hands the role on rather than risking zero.
  check(
    "extra-treasurer/you are not offered as removable",
    !/Regine/.test(await page.locator(".transfer-extra").innerText())
  );

  await page.locator(".transfer-extra-remove").first().click();
  await page.waitForTimeout(450);
  check(
    "extra-treasurer/removal confirms, and says what they lose",
    /release payouts/i.test(await page.locator(".modal[role=dialog]").last().innerText())
  );
  await page.locator('.modal input[placeholder="Treasurer PIN"]').fill("1234");
  await page.waitForTimeout(200);
  await page.locator(".confirm-yes").click();
  await page.waitForTimeout(1400);
  const w = writes.find((x) => x.body && "is_treasurer" in x.body);
  check(
    "extra-treasurer/it clears ONLY that member's flag",
    !!w && w.name === "Verdz" && w.body.is_treasurer === false &&
      Object.keys(w.body).length === 1,
    JSON.stringify(w || null)
  );
  await page.close();

  // THE GUARD THAT MATTERS: the last treasurer is not removable. Zero is the
  // unrecoverable direction — nobody could set the flag back, because setting
  // it requires already being the treasurer.
  const solo = await browser.newPage({ viewport: { width: 430, height: 950 } });
  solo.on("pageerror", (e) => errors.push(`extra-treasurer/solo: ${e}`));
  const one = rosterWithEmails();
  one[0].auth_user_id = FAKE_USER_ID;
  await serve(solo, { ...M.TABLE_DATA, members: one });
  await withAuthMode(solo, "optional", { signedIn: true, email: "regine@example.com" });
  await solo.goto(BASE, { waitUntil: "domcontentloaded" });
  await solo.waitForTimeout(2500);
  check(
    "extra-treasurer/a sole treasurer sees no warning at all",
    (await solo.locator(".transfer-extra").count()) === 0
  );
  // Exported handler, so the absent button is not the gate.
  await solo.evaluate((id) => window.PowerFund.removeTreasurer(id), one[0].id);
  await solo.waitForTimeout(500);
  check(
    "extra-treasurer/and the handler refuses to remove the last one",
    /only treasurer/i.test(await solo.locator(".save-error-banner").innerText())
  );
  await solo.close();
}

/** The card TITLE treatment, measured — not eyeballed.
 *
 *  Reported from a real phone: "Needs your attention" still carried a 13px
 *  UPPERCASE amber label from an early pass, while every notice card built
 *  afterwards used sentence case in Space Grotesk with the accent on the
 *  glyph. `design/Main.dc.html` asks for the latter too, so the app had
 *  drifted from its own approved artboard, not merely from itself.
 *
 *  The cause was five near-identical copies of one treatment in the CSS with
 *  nothing tying them together, so this asserts the FAMILY rather than any one
 *  card — six titles that must agree on case, size and family, and a panel
 *  whose geometry matches the notice cards it sits among. Behavioural checks
 *  cannot see any of this, which is why it survived ~550 of them.
 */
async function cardFamily(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  page.on("pageerror", (e) => errors.push(`card-family: ${e}`));
  // One screen carrying as much of the family as possible: a treasurer with a
  // pending claim (attention), a funded round (release) and a dispute filed
  // against their own released payout.
  const members = rosterWithEmails();
  members[0].auth_user_id = FAKE_USER_ID; // Regine, the flagged treasurer
  const payouts = M.PAYOUTS.map((p) =>
    p.round_number === 1
      ? {
          ...p,
          released: true,
          released_on: "2026-09-20",
          amount: 30000,
          recipient_member_id: members[1].id,
          recipient_name: members[1].name,
          disputed_at: "2026-09-22T02:00:00Z",
          disputed_note: "nothing in GCash",
        }
      : p
  );
  await serve(page, {
    ...M.TABLE_DATA,
    members,
    payouts,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  });
  await withAuthMode(page, "off");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await unlockTreasurer(page);
  await page.waitForTimeout(600);

  const styles = await page.evaluate(() => {
    const out = {};
    [
      ".attention-title",
      ".dispute-alert-title",
      ".release-card-title",
    ].forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const cs = getComputedStyle(el);
      out[sel] = {
        transform: cs.textTransform,
        size: cs.fontSize,
        weight: cs.fontWeight,
        family: cs.fontFamily.split(",")[0].replace(/["']/g, ""),
        display: cs.display,
        color: cs.color,
      };
      const ic = el.querySelector(".icon");
      if (ic) out[sel].iconColor = getComputedStyle(ic).color;
    });
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        radius: cs.borderTopLeftRadius,
        leftBorder: cs.borderLeftWidth,
        topBorder: cs.borderTopWidth,
      };
    };
    out.panelBox = box(".attention-panel");
    out.disputeBox = box(".dispute-alert");
    out.releaseBox = box(".release-card");
    return out;
  });

  const t = styles[".attention-title"];
  // THE PREMISE: the panel is on screen at all. Without it every check below
  // passes on an absent element.
  check(
    "card-family/the premise: the attention panel rendered",
    !!t,
    JSON.stringify(Object.keys(styles))
  );
  check(
    "card-family/its title is sentence case, not UPPERCASE",
    !!t && t.transform === "none",
    t ? t.transform : "(no title)"
  );
  // The exact drift that was reported: 13px amber vs the family's 14.5px.
  const fam = styles[".release-card-title"] || styles[".dispute-alert-title"];
  check(
    "card-family/...and agrees with the other cards on size, weight and family",
    !!t && !!fam && t.size === fam.size && t.weight === fam.weight &&
      t.family === fam.family,
    JSON.stringify({ attention: t, family: fam })
  );
  check(
    "card-family/the accent is on the GLYPH, not the words",
    !!t && t.color === fam.color && t.iconColor !== t.color,
    JSON.stringify({ text: t && t.color, icon: t && t.iconColor })
  );
  // Geometry: it is a notice card and must not keep the 18px structural
  // radius or the 3px left rail no other card in the family has.
  check(
    "card-family/the panel's corners match the notice cards beside it",
    !!styles.panelBox &&
      !!styles.disputeBox &&
      styles.panelBox.radius === styles.disputeBox.radius,
    JSON.stringify({ panel: styles.panelBox, dispute: styles.disputeBox })
  );
  check(
    "card-family/...and it has one even border, not a 3px rail",
    !!styles.panelBox && styles.panelBox.leftBorder === styles.panelBox.topBorder,
    JSON.stringify(styles.panelBox)
  );
  await page.close();
}

/** Payout disputes — "it never arrived" (migration 014).
 *
 *  012 gave the recipient one button. A member whose ₱30,000 has NOT arrived
 *  could only press something untrue or stay silent, and silence reads the
 *  same as forgetting to tap. Reported from use, along with the other half:
 *  the treasurer's receipt existed but only on the Rounds screen, so somebody
 *  was being asked to sign for ₱30,000 with the evidence two taps away.
 *
 *  Owner decision: a dispute is FLAGGED LOUDLY and BLOCKS NOTHING.
 */
async function payoutDispute(browser, errors) {
  const roster = (i) => {
    const m = rosterWithEmails();
    m.forEach((x, j) => {
      x.auth_user_id =
        j === i ? FAKE_USER_ID : `8888888${j}-0000-0000-0000-00000000000${j}`;
    });
    return m;
  };
  const released = (members, recipIdx, extra) =>
    M.PAYOUTS.map((p) =>
      p.round_number === 1
        ? {
            ...p,
            released: true,
            released_on: "2026-09-20",
            amount: 30000,
            recipient_member_id: members[recipIdx].id,
            recipient_name: members[recipIdx].name,
            ...(extra || {}),
          }
        : p
    );

  async function withPayoutApi(page, payouts) {
    const writes = [];
    await page.route("**/rest/v1/payouts**", (r) => {
      const req = r.request();
      if (req.method() === "GET") {
        return r.fulfill({
          status: 200, contentType: "application/json", body: JSON.stringify(payouts),
        });
      }
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
      writes.push({ url: req.url(), body });
      return r.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify([{ round_number: 1, ...body }]),
      });
    });
    return writes;
  }

  // ---- the recipient's card: proof, and both answers --------------------
  const page = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  page.on("pageerror", (e) => errors.push(`dispute: ${e}`));
  const members = roster(1); // Sarah is signed in AND the recipient
  const payouts = released(members, 1);
  await serve(page, { ...M.TABLE_DATA, members, payouts });
  const writes = await withPayoutApi(page, payouts);
  await withAuthMode(page, "required", { signedIn: true, email: "sarah@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // THE GAP THAT WAS REPORTED: the treasurer's proof, where the question is.
  check(
    "dispute/the receipt is offered on the card that asks the question",
    (await page.locator(".ack-card .ack-receipt").count()) === 1,
    await page.locator(".ack-card").innerText().catch(() => "(no .ack-card)")
  );
  await page.locator(".ack-card .ack-receipt").click();
  await page.waitForTimeout(500);
  const src = await page.locator(".lightbox img, .lightbox-img").first().getAttribute("src").catch(() => null);
  check(
    "dispute/...and it opens the release's actual receipt",
    src === payouts[0].receipt_url,
    String(src)
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  check(
    "dispute/both answers are offered, not just Yes",
    (await page.locator(".ack-card .ack-cta").count()) === 1 &&
      (await page.locator(".ack-card .ack-no").count()) === 1
  );

  await page.locator(".ack-card .ack-no").click();
  await page.waitForTimeout(400);
  check(
    "dispute/reporting opens its own note field, not the confirm one",
    (await page.locator("#dispute-note").count()) === 1 &&
      (await page.locator("#ack-note").count()) === 0
  );
  await page.locator("#dispute-note").fill("nothing in GCash as of today");
  await page.locator(".ack-panel .dispute-go").click();
  await page.waitForTimeout(1500);
  const filed = writes.find((w) => w.body && "disputed_at" in w.body);
  check(
    "dispute/reporting writes disputed_at for that round only",
    !!filed && /round_number=eq\.1/.test(filed.url),
    filed ? filed.url : `(no PATCH; ${writes.length} write(s))`
  );
  check(
    "dispute/the note is carried and nothing else is touched",
    !!filed &&
      filed.body.disputed_note === "nothing in GCash as of today" &&
      Object.keys(filed.body).sort().join(",") === "disputed_at,disputed_note",
    filed ? JSON.stringify(filed.body) : "(none)"
  );
  await page.close();

  // ---- the two panels are opposite answers and must never both open -----
  const both = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  both.on("pageerror", (e) => errors.push(`dispute-both: ${e}`));
  const m1b = roster(1);
  const p1b = released(m1b, 1);
  await serve(both, { ...M.TABLE_DATA, members: m1b, payouts: p1b });
  await withPayoutApi(both, p1b);
  await withAuthMode(both, "required", { signedIn: true, email: "sarah@example.com" });
  await both.goto(BASE, { waitUntil: "domcontentloaded" });
  await both.waitForTimeout(2500);
  // A half-typed "received in full" must never be filed as a dispute, so
  // opening one panel closes the other.
  await both.evaluate(() => {
    window.PowerFund.openReceiptAck(1);
    window.PowerFund.openDispute(1);
  });
  await both.waitForTimeout(600);
  check(
    "dispute/opening the report panel closes the confirm panel",
    (await both.locator("#dispute-note").count()) === 1 &&
      (await both.locator("#ack-note").count()) === 0
  );
  await both.evaluate(() => window.PowerFund.openReceiptAck(1));
  await both.waitForTimeout(600);
  check(
    "dispute/...and the other way round",
    (await both.locator("#ack-note").count()) === 1 &&
      (await both.locator("#dispute-note").count()) === 0
  );
  await both.close();

  // ---- a filed report, seen by the group -------------------------------
  const open = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  open.on("pageerror", (e) => errors.push(`dispute-open: ${e}`));
  const m2 = roster(3); // Clara is signed in — NOT the recipient
  const p2 = released(m2, 1, {
    disputed_at: "2026-09-22T02:00:00Z",
    disputed_note: "nothing in GCash as of today",
  });
  await serve(open, { ...M.TABLE_DATA, members: m2, payouts: p2 });
  const w2 = await withPayoutApi(open, p2);
  await withAuthMode(open, "required", { signedIn: true, email: "clara@example.com" });
  await open.goto(BASE, { waitUntil: "domcontentloaded" });
  await open.waitForTimeout(2500);
  const alert = await open.locator(".dispute-alert").first().innerText().catch(() => "");
  check(
    "dispute/a report leads the screen for everyone, naming who and how much",
    /Sarah/.test(alert) && /Round 1/.test(alert) && /30,000/.test(alert),
    alert.replace(/\n+/g, " | ").slice(0, 160) || "(no .dispute-alert)"
  );
  check(
    "dispute/...quoting what they said",
    /nothing in GCash/.test(alert),
    alert.slice(0, 120)
  );
  check(
    "dispute/...and saying plainly that it holds nothing up",
    /not a hold/i.test(alert) && /keeps collecting/i.test(alert),
    alert.slice(0, 200)
  );
  // It leads: nothing else comes before it in the DOM.
  const firstCard = await open.evaluate(() => {
    const el = document.querySelector(
      ".dispute-alert, .rejected-card, .dayone-card, .release-card, .attention-panel, .ack-card, .my-status"
    );
    return el ? el.className : "(none)";
  });
  check(
    "dispute/it is the FIRST card on the screen",
    /dispute-alert/.test(firstCard),
    firstCard
  );
  // A non-recipient must not be able to file or clear one.
  await open.evaluate(() => {
    window.PowerFund.openDispute(1);
    window.PowerFund.submitDispute();
    window.PowerFund.withdrawDispute(1);
  });
  await open.waitForTimeout(1200);
  check(
    "dispute/a non-recipient cannot file or withdraw one",
    w2.length === 0,
    JSON.stringify(w2.map((w) => w.body))
  );
  await open.close();

  // ---- the reporter's own view: withdraw, or say it arrived -------------
  const mine = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  mine.on("pageerror", (e) => errors.push(`dispute-mine: ${e}`));
  const m3 = roster(1);
  const p3 = released(m3, 1, {
    disputed_at: "2026-09-22T02:00:00Z",
    disputed_note: "nothing in GCash as of today",
  });
  await serve(mine, { ...M.TABLE_DATA, members: m3, payouts: p3 });
  const w3 = await withPayoutApi(mine, p3);
  await withAuthMode(mine, "required", { signedIn: true, email: "sarah@example.com" });
  await mine.goto(BASE, { waitUntil: "domcontentloaded" });
  await mine.waitForTimeout(2500);
  const card = await mine.locator(".ack-card").first().innerText().catch(() => "");
  // The duplication that a capture caught: the red alert AND the ack card both
  // saying the same thing, with the payout-QR nudge wedged between the copies.
  // The reporter's own card carries the actions, so the alert is for the
  // OTHER four.
  check(
    "dispute/the reporter does NOT also get the group alert about themselves",
    (await mine.locator(".dispute-alert").count()) === 0,
    await mine.locator(".dispute-alert").first().innerText().catch(() => "")
  );
  check(
    "dispute/the reporter's own card says it is reported, and offers both ways out",
    /not arrived/i.test(card) &&
      (await mine.locator(".ack-card .ack-cta").count()) === 1 &&
      (await mine.locator(".ack-card .ack-withdraw").count()) === 1,
    card.replace(/\n+/g, " | ").slice(0, 160) || "(no .ack-card)"
  );
  check(
    "dispute/...and cannot file a second report",
    (await mine.locator(".ack-card .ack-no").count()) === 0
  );
  await mine.locator(".ack-card .ack-withdraw").click();
  await mine.waitForTimeout(1500);
  const cleared = w3.find((w) => w.body && "disputed_at" in w.body);
  check(
    "dispute/withdrawing clears both dispute columns and nothing else",
    !!cleared &&
      cleared.body.disputed_at === null &&
      cleared.body.disputed_note === null &&
      Object.keys(cleared.body).sort().join(",") === "disputed_at,disputed_note",
    cleared ? JSON.stringify(cleared.body) : "(no write)"
  );
  await mine.close();

  // ---- the Rounds record line, and that nothing is blocked -------------
  const rec = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  rec.on("pageerror", (e) => errors.push(`dispute-rec: ${e}`));
  const m4 = M.MEMBERS;
  const p4 = M.PAYOUTS.map((p) =>
    p.round_number === 1
      ? {
          ...p,
          released: true,
          released_on: "2026-09-20",
          amount: 30000,
          recipient_member_id: m4[0].id,
          recipient_name: m4[0].name,
          disputed_at: "2026-09-22T02:00:00Z",
          disputed_note: "nothing yet",
        }
      : p
  );
  await serve(rec, { ...M.TABLE_DATA, payouts: p4 });
  await withAuthMode(rec, "off");
  await rec.goto(BASE, { waitUntil: "domcontentloaded" });
  await rec.waitForTimeout(1800);
  await rec.locator(".tab-item", { hasText: "Rounds" }).click();
  await rec.waitForTimeout(600);
  await rec.locator(".round-head, .round").first().click().catch(() => {});
  await rec.waitForTimeout(500);
  const line = await rec.locator(".payout-disputed").first().innerText().catch(() => "");
  check(
    "dispute/the round's record line says it never arrived",
    /never arrived/i.test(line) && /Regine/.test(line),
    line || "(no .payout-disputed rendered)"
  );
  check(
    "dispute/...and drops the awaiting line",
    (await rec.locator(".payout-awaiting").count()) === 0
  );
  // BLOCKS NOTHING — the owner's decision. The round it belongs to still
  // reads Completed and the fund still shows its collecting round.
  const roundsText = await rec.locator(".view-rounds, .view-body").first().innerText();
  check(
    "dispute/a disputed round still reads Completed — it holds nothing up",
    /Completed/i.test(roundsText),
    roundsText.replace(/\n+/g, " | ").slice(0, 160)
  );
  await rec.close();
}

/** Who received round N: the RECORD, not the current position.
 *
 *  `payouts.recipient_member_id` is stamped at release and the roster can move
 *  afterwards — a turn swap or a treasurer reorder. For a released round the
 *  two then disagree, and reading the position credits somebody who never got
 *  the money while telling the real recipient they are still owed. Reported
 *  from the captures: "Round 1 — Regine" sat over a record reading "Payout
 *  released to Sarah".
 *
 *  The fixture forces the divergence: round 1 is released to SARAH while
 *  REGINE holds position 1.
 */
async function releasedRecipient(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  page.on("pageerror", (e) => errors.push(`recipient: ${e}`));
  const members = M.MEMBERS;
  const paidOut = members[1]; // Sarah — the recorded recipient of round 1
  const atPos1 = members[0];  // Regine — whoever sits at position 1 now
  const payouts = M.PAYOUTS.map((p) =>
    p.round_number === 1
      ? {
          ...p,
          released: true,
          released_on: "2026-09-20",
          amount: 30000,
          recipient_member_id: paidOut.id,
          recipient_name: paidOut.name,
        }
      : p
  );
  // Every cycle of round 1 confirmed, so it is genuinely funded and released
  // rather than carrying a shortfall that would change the copy.
  const contributions = M.CONTRIBUTIONS.filter((c) => c.status === 2).concat(
    [5, 6].flatMap((cycleNumber) =>
      members.slice(4).map((m, i) => ({
        id: `77777777-0000-0000-0000-00000000000${cycleNumber}${i}`,
        cycle_id: M.CYCLES[cycleNumber - 1].id,
        member_id: m.id,
        status: 2,
        amount: 1000,
        proof_url: null,
        paid_at: "2026-09-14T00:00:00Z",
      }))
    )
  );
  await serve(page, { ...M.TABLE_DATA, payouts, contributions });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // THE PREMISE, asserted rather than assumed: the two really do disagree in
  // this fixture. Without this the checks below could pass because the names
  // happen to match.
  check(
    "recipient/the fixture really does diverge (record vs position)",
    paidOut.id !== atPos1.id && atPos1.member_order === 1,
    `${paidOut.name} recorded, ${atPos1.name} at position ${atPos1.member_order}`
  );

  await page.locator(".tab-item", { hasText: "Rounds" }).click();
  await page.waitForTimeout(700);
  const head = await page.locator(".round-head, .round").first().innerText();
  check(
    "recipient/the Rounds header names who RECEIVED it, not who sits there now",
    new RegExp(paidOut.name).test(head) && !new RegExp(atPos1.name).test(head),
    head.replace(/\n+/g, " | ").slice(0, 120)
  );

  // Insights bars cover all five rounds, released ones included.
  await page.locator(".tab-item", { hasText: "Insights" }).click();
  await page.waitForTimeout(700);
  const bar = await page
    .locator(".round-bar-row")
    .first()
    .innerText()
    .catch(() => "");
  check(
    "recipient/the Insights per-round bar agrees with the record",
    new RegExp(paidOut.name).test(bar) && !new RegExp(atPos1.name).test(bar),
    bar.replace(/\n+/g, " | ") || "(no .round-bar-row rendered)"
  );

  // "· received the payout" on each member's own round summary. Members is a
  // DESKTOP nav item (on the phone it is a Home drill-down), so this widens
  // rather than hunting for the See-all link — and on desktop the record
  // lives in the DETAIL PANE beside the list, not folded into the row
  // (memberRow suppresses its panel when isWide, or it would print twice).
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForTimeout(500);
  await page.locator(".tab-item", { hasText: "Members" }).click();
  await page.waitForTimeout(700);
  // The "Paid out" TAG, which is what memberStanding() also keys the ring off.
  // Read from the row itself, not from whichever panel happens to be open —
  // the accordion closes the previous one, so `.first()` was always reading
  // somebody else's and found nothing.
  const tagged = [];
  const credited = [];
  const rowCount = await page.locator(".member-row-wrap").count();
  check(
    "recipient/the premise: the Members roster rendered its rows",
    rowCount === M.MEMBERS.length,
    `${rowCount} of ${M.MEMBERS.length}`
  );
  for (let i = 0; i < rowCount; i++) {
    const row = page.locator(".member-row-wrap").nth(i);
    const name = await row.locator(".member-row-name").innerText();
    if (/Paid out/i.test(await row.locator(".member-row").innerText())) tagged.push(name);
    await row.locator(".member-row").click();
    await page.waitForTimeout(300);
    const panel = await page
      .locator(".members-detail")
      .first()
      .innerText()
      .catch(() => "");
    if (/received the payout/i.test(panel)) credited.push(name);
  }
  check(
    "recipient/only the recorded recipient is tagged Paid out",
    tagged.length === 1 && tagged[0] === paidOut.name,
    JSON.stringify(tagged) + ` (expected only ${paidOut.name})`
  );
  check(
    "recipient/only the recorded recipient is credited with the payout",
    credited.length === 1 && credited[0] === paidOut.name,
    JSON.stringify(credited) + ` (expected only ${paidOut.name})`
  );
  await page.close();
}

/** Turn swaps — *palit ng turno* (migration 013).
 *
 *  Two properties carry this feature, and neither is visual:
 *
 *  1. THE ORDER MOVES BY ONE RPC, never by two updates. `member_order` is
 *     UNIQUE, so the two-write swap the app used to do always collided on the
 *     first write — "Reorder payout order" had never worked. The old test
 *     rendered the screen and never clicked an arrow, which is how that
 *     survived, so the arrow is clicked here.
 *  2. ONLY THE COUNTERPARTY MAY ACCEPT. The treasurer deliberately cannot,
 *     and every handler is exported on PowerFund, so an absent button is not
 *     the gate.
 */
async function swapTurns(browser, errors) {
  // Everyone signed in, with DISTINCT ids — one per person, as real logins
  // are — and FAKE_USER_ID on the member this session owns. rosterWithEmails()
  // links nobody, and swapCandidates() requires a linked counterparty (an
  // unlinked member could never answer), so leaving the others null made the
  // feature correctly disappear and the first version of these checks failed
  // on my fixture rather than on the code.
  const linked = (i) => {
    const m = rosterWithEmails();
    m.forEach((x, j) => {
      x.auth_user_id =
        j === i ? FAKE_USER_ID : `9999999${j}-0000-0000-0000-00000000000${j}`;
    });
    return m;
  };
  // Rounds 1 and 2 released, 3-5 not: Jan (order 3), Clara (4) and Verdz (5)
  // are the members with a turn left to trade.
  const payouts = M.PAYOUTS.map((p) =>
    p.round_number <= 2
      ? { ...p, released: true, released_on: "2026-09-20", amount: 30000 }
      : { ...p, released: false, released_on: null }
  );

  /** Route the table AND the four RPCs, recording every call. */
  async function withSwapApi(page, rows, opts) {
    const o = opts || {};
    const calls = [];
    await page.route("**/rest/v1/rpc/**", (r) => {
      const fn = new URL(r.request().url()).pathname.split("/").pop();
      let body = {};
      try { body = JSON.parse(r.request().postData() || "{}"); } catch (e) {}
      calls.push({ fn, body });
      if (o.answers && o.answers[fn] !== undefined) {
        const a = o.answers[fn];
        if (a && a.error) {
          return r.fulfill({ status: 400, contentType: "application/json",
                             body: JSON.stringify({ message: a.error }) });
        }
        return r.fulfill({ status: 200, contentType: "application/json",
                           body: JSON.stringify(a) });
      }
      // Anything unrouted 404s the way real PostgREST does — answering with
      // 200 [] would hide a missing-migration path.
      return r.fulfill({ status: 404, contentType: "application/json",
        body: JSON.stringify({ code: "42883",
          message: `Could not find the function public.${fn}` }) });
    });
    await page.route("**/rest/v1/swap_requests**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
                  body: JSON.stringify(rows) }));
    return calls;
  }

  // ---- the incoming ask, on the counterparty's Home ----------------------
  const page = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  page.on("pageerror", (e) => errors.push(`swap: ${e}`));
  const members = linked(3); // Clara, order 4, is signed in
  const req = {
    id: "55555555-0000-0000-0000-000000000001",
    from_member_id: members[2].id, // Jan, order 3
    to_member_id: members[3].id,   // Clara, order 4
    from_round: 3,
    to_round: 4,
    status: "pending",
    note: "hospital bill this month",
    created_at: new Date().toISOString(),
    resolved_at: null,
  };
  await serve(page, { ...M.TABLE_DATA, members, payouts, swap_requests: [req] });
  const calls = await withSwapApi(page, [req], {
    answers: { pf_accept_swap: [{ ...req, status: "accepted" }] },
  });
  await withAuthMode(page, "required", { signedIn: true, email: "clara@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const ask = await page.locator(".swap-ask").first().innerText().catch(() => "");
  check(
    "swap/the counterparty is asked, by name and by round",
    /Jan/.test(ask) && /Round 4/.test(ask) && /Round 3/.test(ask),
    ask || "(no .swap-ask rendered)"
  );
  check(
    "swap/the reason they gave is shown",
    /hospital bill/.test(ask),
    ask.slice(0, 120)
  );
  check(
    "swap/it says the treasurer cannot answer for them",
    /treasurer cannot accept it for you/i.test(ask),
    ask.slice(0, 200)
  );
  check(
    "swap/Accept and Decline are both offered",
    (await page.locator(".swap-ask-btns button").count()) === 2
  );

  await page.locator(".swap-ask-btns .modal-btn-primary").click();
  await page.waitForTimeout(1500);
  const accept = calls.find((c) => c.fn === "pf_accept_swap");
  check(
    "swap/accepting calls pf_accept_swap with that request",
    !!accept && accept.body._request === req.id,
    accept ? JSON.stringify(accept.body) : `(no call; ${calls.map((c) => c.fn)})`
  );
  await page.close();

  // ---- a STALE answer is a success that moved nothing --------------------
  // The migration returns the row marked stale rather than raising, because a
  // raise would roll back the very marking it had just written. So the app
  // must read `status` — reporting this as a success would be a lie.
  const stale = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  stale.on("pageerror", (e) => errors.push(`swap-stale: ${e}`));
  const m2 = linked(3);
  const req2 = { ...req, from_member_id: m2[2].id, to_member_id: m2[3].id };
  await serve(stale, { ...M.TABLE_DATA, members: m2, payouts, swap_requests: [req2] });
  const sc = await withSwapApi(stale, [req2], {
    answers: { pf_accept_swap: [{ ...req2, status: "stale" }] },
  });
  await withAuthMode(stale, "required", { signedIn: true, email: "clara@example.com" });
  await stale.goto(BASE, { waitUntil: "domcontentloaded" });
  await stale.waitForTimeout(2500);
  await stale.locator(".swap-ask-btns .modal-btn-primary").click();
  // Waited for an OUTCOME, not for a selector and not for a fixed delay.
  // acceptSwap awaits reload() before raising either toast, and a fixed sleep
  // landed while the handler was still in flight — so the "not a success"
  // assertion below passed because NOTHING had rendered yet, in both
  // directions. Waiting on ".toast-stack" was no better: it resolves on the
  // element, which appears before the branch that fills it is reached. A
  // check that passes because it was early is not a check, so this waits
  // until one of the two possible answers is actually on the page.
  // CAPTURED IN-PAGE, at the moment an outcome appears, rather than polled
  // from the test side. acceptSwap awaits reload() before raising either
  // toast, so a fixed sleep landed mid-flight and both assertions passed on
  // an empty page; and reading the text after a waitForFunction resolved was
  // no better, because the success toast auto-dismisses and the read lost the
  // race to it. This resolves on the first outcome and keeps the string.
  const outcome = await stale.evaluate(
    () =>
      new Promise((done) => {
        const t0 = Date.now();
        const tick = () => {
          const err = document.querySelector(".save-error-banner");
          const ok = document.querySelector(".toast .toast-text");
          if (err) return done({ err: err.innerText, ok: null });
          if (ok) return done({ err: null, ok: ok.innerText });
          if (Date.now() - t0 > 15000) return done({ err: null, ok: null });
          setTimeout(tick, 60);
        };
        tick();
      })
  );
  check(
    "swap/the stale tap did reach pf_accept_swap",
    sc.some((c) => c.fn === "pf_accept_swap"),
    sc.map((c) => c.fn).join(",") || "(none)"
  );
  check(
    "swap/a stale accept is reported as nothing having moved",
    /order changed/i.test(outcome.err || "") && /nothing moved/i.test(outcome.err || ""),
    JSON.stringify(outcome)
  );
  // The other half, and the one that matters: it must not read as a swap that
  // happened. `outcome` holds whichever toast came FIRST, so a success here
  // is a success the app actually showed.
  check(
    "swap/...and is NOT reported as a swap that happened",
    !/swapped/i.test(outcome.ok || ""),
    JSON.stringify(outcome)
  );
  await stale.close();

  // ---- who may NOT answer ------------------------------------------------
  const other = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  other.on("pageerror", (e) => errors.push(`swap-other: ${e}`));
  const m3 = rosterWithEmails();
  m3[0].auth_user_id = FAKE_USER_ID; // Regine: the flagged TREASURER
  const req3 = { ...req, from_member_id: m3[2].id, to_member_id: m3[3].id };
  await serve(other, { ...M.TABLE_DATA, members: m3, payouts, swap_requests: [req3] });
  const oc = await withSwapApi(other, [req3], {
    answers: { pf_accept_swap: [{ ...req3, status: "accepted" }] },
  });
  await withAuthMode(other, "required", { signedIn: true, email: "regine@example.com" });
  await other.goto(BASE, { waitUntil: "domcontentloaded" });
  await other.waitForTimeout(2500);
  check(
    "swap/the TREASURER is not shown somebody else's ask",
    (await other.locator(".swap-ask").count()) === 0
  );
  // Exported on PowerFund, so the absent card is not the gate.
  await other.evaluate((id) => {
    window.PowerFund.acceptSwap(id);
    window.PowerFund.declineSwap(id);
    window.PowerFund.cancelSwap(id);
  }, req3.id);
  await other.waitForTimeout(1200);
  check(
    "swap/and the treasurer's exported handlers all refuse",
    oc.filter((c) => /swap/.test(c.fn)).length === 0,
    oc.map((c) => c.fn).join(",") || "(none)"
  );
  await other.close();

  // ---- the requester's own side -----------------------------------------
  const mine = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  mine.on("pageerror", (e) => errors.push(`swap-mine: ${e}`));
  const m4 = linked(2); // Jan, order 3, is the requester
  const req4 = { ...req, from_member_id: m4[2].id, to_member_id: m4[3].id };
  await serve(mine, { ...M.TABLE_DATA, members: m4, payouts, swap_requests: [req4] });
  const mc = await withSwapApi(mine, [req4], {
    answers: { pf_cancel_swap: [{ ...req4, status: "cancelled" }] },
  });
  await withAuthMode(mine, "required", { signedIn: true, email: "jan@example.com" });
  await mine.goto(BASE, { waitUntil: "domcontentloaded" });
  await mine.waitForTimeout(2500);
  const waiting = await mine.locator(".swap-waiting").first().innerText().catch(() => "");
  check(
    "swap/the requester sees who they are waiting on",
    /Waiting for/.test(waiting) && /Clara/.test(waiting),
    waiting || "(no .swap-waiting rendered)"
  );
  check(
    "swap/the requester is NOT offered their own Accept button",
    (await mine.locator(".swap-ask").count()) === 0
  );
  await mine.locator(".swap-withdraw").click();
  await mine.waitForTimeout(1200);
  check(
    "swap/withdrawing calls pf_cancel_swap",
    mc.some((c) => c.fn === "pf_cancel_swap" && c.body._request === req4.id),
    mc.map((c) => c.fn).join(",") || "(none)"
  );
  await mine.close();

  // ---- asking: the sheet, and who may be asked --------------------------
  const ask2 = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  ask2.on("pageerror", (e) => errors.push(`swap-ask: ${e}`));
  const m5 = linked(2); // Jan, order 3 — rounds 1-2 are paid out
  m5[4].auth_user_id = null; // Verdz has never signed in
  await serve(ask2, { ...M.TABLE_DATA, members: m5, payouts, swap_requests: [] });
  const ac = await withSwapApi(ask2, [], {
    answers: { pf_request_swap: [{ ...req, from_member_id: m5[2].id, to_member_id: m5[3].id }] },
  });
  await withAuthMode(ask2, "required", { signedIn: true, email: "jan@example.com" });
  await ask2.goto(BASE, { waitUntil: "domcontentloaded" });
  await ask2.waitForTimeout(2500);
  await ask2.locator(".tab-item", { hasText: "Menu" }).click();
  await ask2.waitForTimeout(600);
  check(
    "swap/Menu offers Swap my turn to a linked member",
    (await ask2.locator(".menu-row", { hasText: "Swap my turn" }).count()) === 1
  );
  await ask2.locator(".menu-row", { hasText: "Swap my turn" }).click();
  await ask2.waitForTimeout(600);
  const opts = await ask2.locator("#swap-who option").allInnerTexts();
  // Rounds 1 and 2 are PAID OUT, so Regine and Sarah cannot trade — 013
  // refuses it, and offering them would be a button that fails. Verdz has
  // never signed in and so could never answer.
  check(
    "swap/only members who can actually trade are offered",
    !opts.some((o) => /Regine|Sarah|Verdz|Jan/.test(o)) &&
      opts.some((o) => /Clara/.test(o)),
    opts.join(" | ")
  );
  check(
    "swap/Send is disabled until somebody is chosen",
    (await ask2.locator(".modal .modal-btn-primary").isDisabled()) === true
  );
  await ask2.locator("#swap-who").selectOption(m5[3].id);
  await ask2.waitForTimeout(400);
  const prev = await ask2.locator(".swap-preview").first().innerText().catch(() => "");
  check(
    "swap/the sheet spells out both sides of the trade",
    /Round 4/.test(prev) && /Clara/.test(prev) && /Round 3/.test(prev),
    prev || "(no .swap-preview rendered)"
  );
  await ask2.locator("#swap-why").fill("need mine early");
  await ask2.locator(".modal .modal-btn-primary").click();
  await ask2.waitForTimeout(1500);
  const sent = ac.find((c) => c.fn === "pf_request_swap");
  check(
    "swap/sending names the member and carries the reason",
    !!sent && sent.body._to_member === m5[3].id && sent.body._note === "need mine early",
    sent ? JSON.stringify(sent.body) : `(no call; ${ac.map((c) => c.fn)})`
  );
  await ask2.close();

  // ---- a member on a PAID-OUT round has nothing to trade ----------------
  const done = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  done.on("pageerror", (e) => errors.push(`swap-done: ${e}`));
  const m6 = linked(1); // Sarah, order 2 — released
  await serve(done, { ...M.TABLE_DATA, members: m6, payouts, swap_requests: [] });
  const dc = await withSwapApi(done, []);
  await withAuthMode(done, "required", { signedIn: true, email: "sarah@example.com" });
  await done.goto(BASE, { waitUntil: "domcontentloaded" });
  await done.waitForTimeout(2500);
  await done.locator(".tab-item", { hasText: "Menu" }).click();
  await done.waitForTimeout(600);
  check(
    "swap/a member already paid out is not offered the row",
    (await done.locator(".menu-row", { hasText: "Swap my turn" }).count()) === 0
  );
  await done.evaluate(() => window.PowerFund.openSwapModal());
  await done.waitForTimeout(500);
  check(
    "swap/and openSwapModal refuses them",
    (await done.locator("#swap-who").count()) === 0 &&
      !dc.some((c) => c.fn === "pf_request_swap")
  );
  await done.close();

  // ---- THE ORIGINAL BUG: the treasurer's reorder arrow -------------------
  // It must call pf_swap_order, and must NOT write two PATCHes — member_order
  // is UNIQUE, so the first of two would always collide. No browser test had
  // ever clicked this arrow, which is how it shipped broken.
  const tre = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  tre.on("pageerror", (e) => errors.push(`swap-reorder: ${e}`));
  const m7 = rosterWithEmails();
  m7[0].auth_user_id = FAKE_USER_ID;
  await serve(tre, {
    ...M.TABLE_DATA,
    members: m7,
    payouts: M.PAYOUTS.map((p) => ({ ...p, released: false, released_on: null })),
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  });
  const tc = await withSwapApi(tre, [], { answers: { pf_swap_order: m7 } });
  const patches = [];
  await tre.route("**/rest/v1/members**", (r) => {
    const rq = r.request();
    if (rq.method() !== "GET") patches.push({ method: rq.method(), body: rq.postData() });
    return r.fulfill({ status: 200, contentType: "application/json",
                       body: JSON.stringify(m7) });
  });
  await withAuthMode(tre, "required", { signedIn: true, email: "regine@example.com" });
  await tre.goto(BASE, { waitUntil: "domcontentloaded" });
  await tre.waitForTimeout(2500);
  await unlockTreasurer(tre);
  await tre.locator(".tab-item", { hasText: "Menu" }).click();
  await tre.waitForTimeout(600);
  await tre.locator(".menu-row", { hasText: "Reorder payout order" }).click();
  await tre.waitForTimeout(600);
  // The second row's "move up" arrow: a real swap with the row above it.
  await tre.locator(".reorder-row").nth(1).locator("button").first().click();
  await tre.waitForTimeout(1500);
  check(
    "swap/the reorder arrow calls pf_swap_order with both members",
    tc.some(
      (c) => c.fn === "pf_swap_order" && c.body._a === m7[1].id && c.body._b === m7[0].id
    ),
    JSON.stringify(tc.map((c) => [c.fn, c.body]))
  );
  check(
    "swap/and writes NO member_order PATCH (which would always collide)",
    !patches.some((w) => /member_order/.test(w.body || "")),
    JSON.stringify(patches)
  );
  await tre.close();

  // ---- a fund that has not run 013 -------------------------------------
  // The table 404s the way real PostgREST does. The feature must be absent
  // rather than offered and failing.
  const old = await browser.newPage({ viewport: { width: 430, height: 1100 } });
  old.on("pageerror", (e) => errors.push(`swap-pre013: ${e}`));
  const m8 = linked(2);
  await serve(old, { ...M.TABLE_DATA, members: m8, payouts, swap_requests: [] });
  await old.route("**/rest/v1/swap_requests**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json",
      body: JSON.stringify({ code: "42P01",
        message: 'relation "public.swap_requests" does not exist' }) }));
  await withAuthMode(old, "required", { signedIn: true, email: "jan@example.com" });
  await old.goto(BASE, { waitUntil: "domcontentloaded" });
  await old.waitForTimeout(2500);
  check(
    "swap/a fund without migration 013 still loads",
    (await old.locator(".battery-hero, .home-grid, .view-head").count()) > 0 &&
      (await old.locator(".boot-fail, .no-connection").count()) === 0
  );
  await old.locator(".tab-item", { hasText: "Menu" }).click();
  await old.waitForTimeout(600);
  check(
    "swap/...and is not offered a feature its database cannot do",
    (await old.locator(".menu-row", { hasText: "Swap my turn" }).count()) === 0
  );
  await old.close();
}

/** "Received ✓" — the recipient confirming their own payout arrived
 *  (migration 012). NO approved mockup; the behaviour is what is asserted.
 *
 *  The property that matters is the GATE: it is neither `unlocked` nor
 *  `isTreasurerAccount()` but BEING THE RECIPIENT, a different axis from
 *  every other permission in the app — and 012's policy keys on
 *  `recipient_member_id`, so the UI must agree with Postgres or it offers a
 *  button that is refused.
 */
async function receiptAck(browser, errors) {
  // Sarah (index 1) is the recipient AND the signed-in account. Regine
  // (index 0) is the flagged treasurer, so this also proves the card is not
  // a treasurer surface.
  const roster = () => {
    const m = rosterWithEmails();
    m[1].auth_user_id = FAKE_USER_ID;
    return m;
  };
  const payoutsTo = (member, receivedAt) =>
    M.PAYOUTS.map((p) =>
      p.round_number === 1
        ? {
            ...p,
            released: true,
            released_on: "2026-09-20",
            amount: 30000,
            recipient_member_id: member.id,
            recipient_name: member.name,
            received_at: receivedAt || null,
            received_note: receivedAt ? "GCash, received in full" : null,
          }
        : p
    );

  // ---- the recipient's own view -------------------------------------------
  const page = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  page.on("pageerror", (e) => errors.push(`receipt-ack: ${e}`));
  const members = roster();
  const payouts = payoutsTo(members[1]);
  await serve(page, { ...M.TABLE_DATA, members, payouts });
  const writes = [];
  await page.route("**/rest/v1/payouts**", (r) => {
    const req = r.request();
    // Fulfilled, never continued: this route is registered AFTER serve()'s
    // catch-all so it wins, and continue() would go to the real static server.
    if (req.method() === "GET") {
      return r.fulfill({
        status: 200, contentType: "application/json", body: JSON.stringify(payouts),
      });
    }
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
    writes.push({ url: req.url(), body });
    // A real PATCH answers with the updated row; requireRows() treats [] as a
    // refusal, so answering "[]" here would test the error path instead.
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ round_number: 1, ...body }]),
    });
  });
  const logs = [];
  await page.route("**/rest/v1/activity_log**", (r) => {
    const req = r.request();
    if (req.method() !== "GET") {
      try { logs.push(JSON.parse(req.postData() || "{}")); } catch (e) {}
    }
    return r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(req.method() === "GET" ? M.ACTIVITY_LOG : []),
    });
  });
  await withAuthMode(page, "required", { signedIn: true, email: "sarah@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  check(
    "receipt-ack/the recipient is offered the card",
    (await page.locator(".ack-card .ack-cta").count()) === 1,
    await page.locator(".ack-card").count() + " ack-card(s)"
  );
  // It must not open the panel on arrival — the note is optional and the tap
  // is the deliberate act.
  check(
    "receipt-ack/the panel is closed until asked for",
    (await page.locator(".ack-panel").count()) === 0
  );

  await page.locator(".ack-card .ack-cta").click();
  await page.waitForTimeout(400);
  check(
    "receipt-ack/tapping opens the note panel",
    (await page.locator(".ack-panel .ack-input").count()) === 1
  );
  await page.locator(".ack-panel .ack-input").fill("GCash, received in full");
  await page.locator(".ack-panel .modal-btn-primary").click();
  await page.waitForTimeout(1500);

  const patch = writes.find((w) => w.body && "received_at" in w.body);
  check(
    "receipt-ack/confirming writes received_at for that round only",
    !!patch && /round_number=eq\.1/.test(patch.url),
    patch ? patch.url : "(no PATCH captured)"
  );
  check(
    "receipt-ack/the note is carried, and nothing else is touched",
    !!patch &&
      patch.body.received_note === "GCash, received in full" &&
      Object.keys(patch.body).sort().join(",") === "received_at,received_note",
    patch ? JSON.stringify(patch.body) : "(none)"
  );
  // The activity entry carries NO amount: the money moved at release and was
  // logged there. A figure here would make a release-and-confirm read as
  // ₱60,000 leaving the fund — the same bug doUnmarkPayoutReleased avoids.
  const entry = logs.find((l) => l && /confirmed receiving/i.test(l.message || ""));
  check(
    "receipt-ack/the log names the member and carries NO amount",
    !!entry &&
      /Sarah/.test(entry.message) &&
      (entry.amount === null || entry.amount === undefined) &&
      Number(entry.round_number) === 1,
    entry ? JSON.stringify(entry) : `(no entry; ${logs.length} logged)`
  );
  await page.close();

  // ---- somebody who is NOT the recipient ----------------------------------
  const other = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  other.on("pageerror", (e) => errors.push(`receipt-ack-other: ${e}`));
  const m2 = rosterWithEmails();
  m2[1].auth_user_id = FAKE_USER_ID; // Sarah is signed in...
  const payouts2 = payoutsTo(m2[3]); // ...Clara was paid
  await serve(other, { ...M.TABLE_DATA, members: m2, payouts: payouts2 });
  const otherWrites = [];
  await other.route("**/rest/v1/payouts**", (r) => {
    const req = r.request();
    if (req.method() === "GET") {
      return r.fulfill({
        status: 200, contentType: "application/json", body: JSON.stringify(payouts2),
      });
    }
    otherWrites.push(req.url());
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await withAuthMode(other, "required", { signedIn: true, email: "sarah@example.com" });
  await other.goto(BASE, { waitUntil: "domcontentloaded" });
  await other.waitForTimeout(2500);
  check(
    "receipt-ack/a non-recipient is not offered the card",
    (await other.locator(".ack-card").count()) === 0
  );
  // openReceiptAck and confirmReceiptAck are exported on PowerFund, so the
  // absent card is not the gate. Both handlers must refuse.
  await other.evaluate(() => {
    window.PowerFund.openReceiptAck(1);
    window.PowerFund.confirmReceiptAck();
  });
  await other.waitForTimeout(1200);
  check(
    "receipt-ack/the exported handlers refuse a non-recipient",
    (await other.locator(".ack-panel").count()) === 0 && otherWrites.length === 0,
    `${otherWrites.length} write(s) attempted`
  );
  await other.close();

  // ---- the record line, which the whole group reads -----------------------
  const rec = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  rec.on("pageerror", (e) => errors.push(`receipt-ack-record: ${e}`));
  const m3 = rosterWithEmails();
  await serve(rec, { ...M.TABLE_DATA, members: m3, payouts: payoutsTo(m3[1]) });
  await withAuthMode(rec, "off");
  await rec.goto(BASE, { waitUntil: "domcontentloaded" });
  await rec.waitForTimeout(1800);
  await rec.locator(".tab-item", { hasText: "Rounds" }).click();
  await rec.waitForTimeout(600);
  await rec.locator(".round-head, .round").first().click().catch(() => {});
  await rec.waitForTimeout(500);
  const awaiting = await rec.locator(".payout-awaiting").first().innerText().catch(() => "");
  check(
    "receipt-ack/an unconfirmed payout says so, by name",
    /Awaiting/.test(awaiting) && /Sarah/.test(awaiting),
    awaiting || "(no .payout-awaiting rendered)"
  );
  check(
    "receipt-ack/and shows no received line yet",
    (await rec.locator(".payout-received").count()) === 0
  );
  await rec.close();

  const done = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  done.on("pageerror", (e) => errors.push(`receipt-ack-done: ${e}`));
  const m4 = rosterWithEmails();
  m4[1].auth_user_id = FAKE_USER_ID;
  await serve(done, {
    ...M.TABLE_DATA,
    members: m4,
    payouts: payoutsTo(m4[1], "2026-09-21T04:00:00Z"),
  });
  await withAuthMode(done, "required", { signedIn: true, email: "sarah@example.com" });
  await done.goto(BASE, { waitUntil: "domcontentloaded" });
  await done.waitForTimeout(2500);
  check(
    "receipt-ack/an acknowledged payout is not offered again",
    (await done.locator(".ack-card").count()) === 0
  );
  await done.locator(".tab-item", { hasText: "Rounds" }).click();
  await done.waitForTimeout(600);
  await done.locator(".round-head, .round").first().click().catch(() => {});
  await done.waitForTimeout(500);
  const got = await done.locator(".payout-received").first().innerText().catch(() => "");
  check(
    // The date is asserted POSITIVELY, not just as "some text": `received_at`
    // is a timestamptz where `released_on` is a plain date, and the shared
    // formatter appended "T00:00:00" to it — this line read "on Invalid Date"
    // while a laxer version of this check passed.
    "receipt-ack/the record names who confirmed it, when, and their note",
    /Received by/.test(got) &&
      /Sarah/.test(got) &&
      /Sep 21, 2026/.test(got) &&
      !/Invalid/.test(got) &&
      /received in full/.test(got),
    got || "(no .payout-received rendered)"
  );
  check(
    "receipt-ack/and drops the awaiting line",
    (await done.locator(".payout-awaiting").count()) === 0
  );
  await done.close();
}

/** The entry animation marks a SCREEN CHANGE, not a render.
 *
 *  render() reassigns innerHTML, so every element is new every time and every
 *  CSS entry animation restarted — including on the 30-second background poll,
 *  which re-assembled the whole screen under somebody reading it. Reported
 *  from use. */
async function entryAnimation(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`anim: ${e}`));
  await serve(page, M.TABLE_DATA);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);

  const animOn = () => page.evaluate(() => document.body.classList.contains("pf-anim"));
  const entryValue = () =>
    page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--pf-entry").trim()
    );

  check("anim/the first paint animates", (await animOn()) === true);

  // THE REPORTED BUG. visibilitychange runs the same reload() the 30-second
  // poll does, so this exercises the real path without waiting 30 seconds.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(900);
  check("anim/a background refresh does NOT re-animate", (await animOn()) === false);
  check("anim/and the entry animation is switched off, not just restarted",
    (await entryValue()) === "none", await entryValue());

  // The thing the owner explicitly asked to keep.
  await page.locator(".tab-item", { hasText: "Rounds" }).click();
  await page.waitForTimeout(200);
  check("anim/navigating to another tab still animates", (await animOn()) === true);
  check("anim/with the real animation value",
    /pfFadeUp/.test(await entryValue()), await entryValue());

  // A re-render that is not a navigation — the same path a poll takes.
  await page.evaluate(() => window.PowerFund.toggleRound(1));
  await page.waitForTimeout(200);
  check("anim/but re-rendering the same screen does not", (await animOn()) === false);

  // THE TRAP IN THIS FIX. The sparkline is drawn by animating stroke-dashoffset
  // from 400 to 0; switching the animation off without moving the BASE to 0
  // would leave the line fully dashed — i.e. invisible — on every screen that
  // is not a fresh navigation. Worse than the bug being fixed.
  await page.locator(".tab-item", { hasText: "Home" }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(900);
  const spark = await page.evaluate(() => {
    const el = document.querySelector(".spark-line");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { offset: cs.strokeDashoffset, anim: cs.animationName };
  });
  check("anim/premise: the sparkline is on screen", spark !== null);
  if (spark) {
    check("anim/the sparkline is still DRAWN when it does not animate",
      parseFloat(spark.offset) === 0, JSON.stringify(spark));
  }

  // The stagger must survive: the `animation` shorthand resets animation-delay,
  // so a class-prefixed rule would have out-specified the delays below it.
  const delay = await page.evaluate(() => {
    const el = document.querySelector(".battery-hero");
    return el ? getComputedStyle(el).animationDelay : null;
  });
  check("anim/the stagger survives the switch", delay === "0.08s", String(delay));
  await page.close();

  // Reduced motion must still win — those rules are (0,1,0) and win by source
  // order today; raising specificity anywhere here would have broken them.
  const rm = await browser.newPage({
    viewport: { width: 430, height: 950 },
    reducedMotion: "reduce",
  });
  rm.on("pageerror", (e) => errors.push(`anim/rm: ${e}`));
  await serve(rm, M.TABLE_DATA);
  await rm.goto(BASE, { waitUntil: "domcontentloaded" });
  await rm.waitForTimeout(1600);
  const rmAnim = await rm.evaluate(() => {
    const el = document.querySelector(".battery-hero");
    return el ? getComputedStyle(el).animationName : null;
  });
  check("anim/reduced motion still overrides it", rmAnim === "none", String(rmAnim));
  await rm.close();
}

/** The P3 items with behaviour rather than colour: each was invisible to the
 *  suite, and two turned out to be defects rather than polish. */
async function polishPass(browser, errors) {
  // ---- Activity: an empty log offers no controls, and no "loaded" ----------
  const empty = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  empty.on("pageerror", (e) => errors.push(`p3/empty: ${e}`));
  await serve(empty, { ...M.TABLE_DATA, activity_log: [] });
  await empty.goto(BASE, { waitUntil: "domcontentloaded" });
  await empty.waitForTimeout(1600);
  await empty.evaluate(() => window.PowerFund.setView("activity"));
  await empty.waitForTimeout(500);
  check("p3/an empty log offers no filter chips",
    (await empty.locator(".activity-chip").count()) === 0);
  check("p3/nor an export of nothing",
    (await empty.locator(".head-action", { hasText: "Export CSV" }).count()) === 0);
  const emptySub = await empty.locator(".view-sub").innerText();
  check("p3/and does not say 'loaded'", !/loaded/i.test(emptySub), emptySub);
  await empty.close();

  // ---- Activity: the hidden-rows note is quiet at the DEFAULT filters ------
  // desktop-activity-filters-live-notes defaults the round filter to the
  // current round, so this fired on arrival: the first thing a treasurer saw
  // was a warning about a state they had not created.
  const act = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  act.on("pageerror", (e) => errors.push(`p3/activity: ${e}`));
  await serve(act, M.TABLE_DATA);
  await act.goto(BASE, { waitUntil: "domcontentloaded" });
  await act.waitForTimeout(1600);
  await act.evaluate(() => window.PowerFund.setView("activity"));
  await act.waitForTimeout(500);
  const note = act.locator(".activity-unattributed");
  if (await note.count()) {
    check("p3/the hidden-rows note arrives quiet, not as an alert",
      (await note.getAttribute("class")).includes("quiet"),
      await note.getAttribute("class"));
    check("p3/and carries no alert icon at the default",
      (await note.locator(".icon").count()) === 0);
    // Narrow it by hand and it becomes an alert again.
    await act.evaluate(() => window.PowerFund.setActivityFilter("payout"));
    await act.waitForTimeout(400);
    const n2 = act.locator(".activity-unattributed");
    if (await n2.count()) {
      check("p3/but alerts once the viewer narrows it themselves",
        !(await n2.getAttribute("class")).includes("quiet"),
        await n2.getAttribute("class"));
    }
  }
  await act.close();

  // ---- Rounds: ONE badge, and the current round still identifiable --------
  const rounds = await browser.newPage({ viewport: { width: 430, height: 950 } });
  rounds.on("pageerror", (e) => errors.push(`p3/rounds: ${e}`));
  await serve(rounds, M.TABLE_DATA);
  await rounds.goto(BASE, { waitUntil: "domcontentloaded" });
  await rounds.waitForTimeout(1600);
  await rounds.locator(".tab-item", { hasText: "Rounds" }).click();
  await rounds.waitForTimeout(500);
  check("p3/the second 'active' badge is gone",
    (await rounds.locator(".round-active-tag").count()) === 0);
  check("p3/each round header carries exactly one state badge",
    (await rounds.locator(".round-header .round-state").count()) ===
      (await rounds.locator(".round-header").count()),
    `${await rounds.locator(".round-header .round-state").count()} badges / ${await rounds.locator(".round-header").count()} headers`);
  check("p3/and the current round is still marked on the card",
    (await rounds.locator(".round.is-current").count()) === 1);
  await rounds.close();

  // ---- The schedule draft can be put back -------------------------------
  const sch = await browser.newPage({ viewport: { width: 430, height: 950 } });
  sch.on("pageerror", (e) => errors.push(`p3/schedule: ${e}`));
  const members = rosterWithEmails();
  members[0].auth_user_id = FAKE_USER_ID;
  await serve(sch, { ...M.TABLE_DATA, members });
  await withAuthMode(sch, "optional", { signedIn: true, email: "regine@example.com" });
  await sch.goto(BASE, { waitUntil: "domcontentloaded" });
  await sch.waitForTimeout(2400);
  await sch.locator(".unlock-btn").click();
  await sch.waitForTimeout(500);
  await sch.evaluate(() => window.PowerFund.openScheduleModal());
  await sch.waitForTimeout(500);
  const dates = sch.locator(".schedule-date");
  const before = await dates.evaluateAll((els) => els.map((e) => e.value));
  check("p3/Reset changes is hidden while nothing has moved",
    (await sch.locator("#scheduleReset").isVisible()) === false);
  const d = new Date(before[2] + "T00:00:00");
  d.setDate(d.getDate() + 14);
  const pad = (n) => String(n).padStart(2, "0");
  await dates.nth(2).fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  await sch.waitForTimeout(400);
  check("p3/and appears once something has",
    (await sch.locator("#scheduleReset").isVisible()) === true);
  // The count is patched with textContent on every keystroke — a button nested
  // inside it would have been deleted by the first edit.
  check("p3/the count still reads correctly beside it",
    /28 cycles moved/.test(await sch.locator("#scheduleCount").innerText()),
    await sch.locator("#scheduleCount").innerText());
  await sch.locator("#scheduleReset").click();
  await sch.waitForTimeout(400);
  const after = await dates.evaluateAll((els) => els.map((e) => e.value));
  check("p3/Reset changes puts every date back",
    JSON.stringify(after) === JSON.stringify(before),
    `${after[2]} vs ${before[2]}`);
  check("p3/and the button hides itself again",
    (await sch.locator("#scheduleReset").isVisible()) === false);
  await sch.close();
}

/** The terminal screen must read the same way for everyone. S.complete used to
 *  be pulled ahead of the personal card for a treasurer by a rule about the
 *  attention QUEUE outranking it — but when the fund is complete there is no
 *  queue and no release (both gated on !allDone), so all that rule did was
 *  give the treasurer a different reading order on the last screen the group
 *  ever sees. */
async function fundCompleteOrder(browser, errors) {
  // Every cycle confirmed for everyone, every payout released.
  const rows = [];
  let id = 90000;
  M.CYCLES.forEach((cy) =>
    M.MEMBERS.forEach((m) =>
      rows.push({
        id: `00000000-0000-0000-0000-${String(id++).padStart(12, "0")}`,
        cycle_id: cy.id,
        member_id: m.id,
        status: 2,
        amount: C_AMOUNT,
        proof_url: null,
        paid_at: new Date(2026, 8, 14).toISOString(),
      })
    )
  );
  const data = {
    ...M.TABLE_DATA,
    contributions: rows,
    payouts: M.PAYOUTS.map((p, i) => ({
      ...p,
      released: true,
      amount: 30000,
      released_on: "2027-01-10",
      recipient_member_id: M.MEMBERS[i].id,
      recipient_name: M.MEMBERS[i].name,
      started_at: new Date().toISOString(),
    })),
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  };

  /** Which comes first in the DOM: the personal card or the green panel? */
  const order = async (page) =>
    page.evaluate(() => {
      const mine = document.querySelector(".my-status-card");
      const done = document.querySelector(".fund-complete-panel");
      if (!mine || !done) return mine ? "status-only" : done ? "complete-only" : "neither";
      return mine.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING
        ? "status-then-complete"
        : "complete-then-status";
    });

  for (const label of ["member", "treasurer"]) {
    const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
    page.on("pageerror", (e) => errors.push(`complete/${label}: ${e}`));
    await serve(page, data);
    await page.addInitScript((id) => {
      try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
    }, M.MEMBERS[1].id);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    if (label === "treasurer") await unlockTreasurer(page);
    check(`complete/${label}: the personal card leads`,
      (await order(page)) === "status-then-complete", await order(page));
    // And the personal card must not repeat the green panel's own sentence.
    const mineTxt = await page.locator(".my-status-card").innerText();
    const doneTxt = await page.locator(".fund-complete-panel").innerText();
    check(`complete/${label}: no duplicated sentence`,
      !/rounds collected and paid out/i.test(mineTxt), mineTxt.replace(/\s+/g, " "));
    check(`complete/${label}: and the receipt is stated once`,
      /You received/.test(mineTxt) && !/You received/.test(doneTxt),
      doneTxt.replace(/\s+/g, " "));
    await page.close();
  }
}

/** 641-899px: iPad portrait and a phone in landscape. Three breakpoints used
 *  to disagree about what device this is — the shell switches at 900px, but the
 *  sheet treatment and the 44px touch targets both stopped at 640px — so this
 *  band got the thumb-reach tab bar with mouse-sized hit areas and
 *  desktop-positioned centre modals. No check had ever run inside it. */
async function tabletBand(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
  page.on("pageerror", (e) => errors.push(`tablet: ${e}`));
  await serve(page, M.TABLE_DATA);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);

  check("tablet/768px gets the MOBILE shell", (await page.locator(".tab-bar").count()) === 1);
  check("tablet/and no desktop sidebar nav label",
    (await page.locator(".tab-item", { hasText: "Board Members" }).count()) === 0);

  // The sheet must be bottom-anchored, like the shell it belongs to.
  await page.evaluate((id) => window.PowerFund.openContributeModal(id, 7), M.MEMBERS[1].id);
  await page.waitForTimeout(600);
  const sheet = await page.locator(".modal-overlay.sheet .modal").boundingBox();
  const vh = await page.evaluate(() => window.innerHeight);
  check("tablet/the payment sheet is bottom-anchored, not centred",
    Math.abs(sheet.y + sheet.height - vh) <= 2,
    `bottom at ${Math.round(sheet.y + sheet.height)} of ${vh}`);
  check("tablet/and it spans the width",
    sheet.width >= 760, `${Math.round(sheet.width)}px`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Touch targets: this is still a thumb interface.
  await page.locator(".tab-item", { hasText: "Rounds" }).click();
  await page.waitForTimeout(500);
  // The chips live inside a round's accordion; a collapsed one has no box.
  if (!(await page.locator(".round.is-open .member-chip").count())) {
    await page.locator(".round-header").first().click();
    await page.waitForTimeout(500);
  }
  const chipLoc = page.locator(".round.is-open .member-chip").first();
  const chip = (await chipLoc.count()) ? await chipLoc.boundingBox() : null;
  check("tablet/cycle chips keep the 44px touch target",
    !!chip && chip.height >= 44,
    chip ? `${Math.round(chip.height)}px` : "(no visible chip)");
  check("tablet/no sideways scroll",
    (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)) === true);
  await page.close();
}

/** P1-2: treasurer mode says nothing about whether the writes behind it land.
 *  011 keys confirm/reject/revert/record/release off members.is_treasurer, and
 *  the PIN that opens the mode is shared with all five members by design. */
async function moneyGate(browser, errors) {
  // A member the app can POSITIVELY identify as not the treasurer: Jan is
  // signed in and linked, Regine carries the flag.
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`money-gate: ${e}`));
  const members = rosterWithEmails();
  members[2].auth_user_id = FAKE_USER_ID;
  await serve(page, {
    ...M.TABLE_DATA,
    members,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  });
  await withAuthMode(page, "optional", { signedIn: true, email: "jan@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // Premise: they really can unlock. canUnlockTreasurer() hides the button
  // only from someone it can identify as a non-treasurer — so it IS hidden
  // here, and the mode is reached the way the guard must survive: the
  // exported handler. If this premise breaks, the checks below prove nothing.
  await page.evaluate(() => { window.PowerFund.toggleUnlock(); });
  await page.waitForTimeout(400);
  if (await page.locator(".modal-overlay").count()) {
    await page.keyboard.type("1234");
    await page.locator(".modal-btn-primary").first().click();
    await page.waitForTimeout(800);
  }

  const pending = M.CONTRIBUTIONS.find((c) => c.status === 1);
  const cyc = (M.CYCLES.find((c) => c.id === pending.cycle_id) || {}).cycle_number;
  await page.evaluate(
    (a) => window.PowerFund.openReviewModal(a.id, a.cycle),
    { id: pending.member_id, cycle: cyc }
  );
  await page.waitForTimeout(500);
  const openedReview = (await page.locator(".modal-btn-confirm").count()) === 1;
  check("money-gate/premise: a PIN-unlocked member reaches Review Payment", openedReview);

  if (openedReview) {
    check("money-gate/it says the writes are refused, before the press",
      (await page.locator(".money-refused").count()) === 1);
    check("money-gate/Confirm Payment is disabled",
      (await page.locator(".modal-btn-confirm").isDisabled()) === true);
    check("money-gate/Reject claim is disabled",
      (await page.locator(".modal-btn-secondary.reject").isDisabled()) === true);
  }

  // The buttons are not the gate — every handler is exported on PowerFund.
  let wrote = false;
  await page.route("**/rest/v1/contributions**", (r) => {
    if (r.request().method() !== "GET") wrote = true;
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.evaluate(() => window.PowerFund.confirmReview());
  await page.waitForTimeout(500);
  check("money-gate/the exported confirm handler refuses too", wrote === false);
  check("money-gate/and explains why",
    /flagged treasurer/.test(await page.locator(".save-error-banner").innerText()),
    await page.locator(".save-error-banner").innerText());
  await page.close();

  // THE DIRECTION THAT MATTERS MORE. isTreasurerAccount() is false whenever
  // the app cannot identify the viewer at all — and a fund on AUTH_MODE "off"
  // still has flagged members, so keying this off it would disable every money
  // action for a legitimate treasurer with no session. It must not.
  const off = await browser.newPage({ viewport: { width: 430, height: 950 } });
  off.on("pageerror", (e) => errors.push(`money-gate/off: ${e}`));
  await serve(off, {
    ...M.TABLE_DATA,
    members: rosterWithEmails(), // flags set, nobody linked
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  });
  await off.goto(BASE, { waitUntil: "domcontentloaded" });
  await off.waitForTimeout(2000);
  await unlockTreasurer(off);
  await off.evaluate(
    (a) => window.PowerFund.openReviewModal(a.id, a.cycle),
    { id: pending.member_id, cycle: cyc }
  );
  await off.waitForTimeout(500);
  check("money-gate/auth off: a flagged roster does NOT disable the treasurer",
    (await off.locator(".modal-btn-confirm").isDisabled()) === false);
  check("money-gate/auth off: and no refusal notice is shown",
    (await off.locator(".money-refused").count()) === 0);
  await off.close();
}

/** The findings from the independent UI/UX QA pass that were implementation
 *  gaps rather than product decisions. Every one of these passed the suite
 *  before the fix, because nothing asserted the behaviour at all. */
async function qaFindings(browser, errors) {
  // ---- P0: reverting a confirmed payment inside a RELEASED round ----------
  // markPayoutReleased() gates release on isRoundFunded(), so the app asserted
  // funded-implies-released one way and let the other be broken silently: two
  // taps produced a round badged Completed at ₱28,000 / ₱30,000 with a ₱30,000
  // payout on record. The fixtures are already in that state (Verdz is short
  // on cycles 5-6 of round 1, which is released), which is what makes the
  // shortfall marker testable.
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`qa-p0: ${e}`));
  await serve(page, {
    ...M.TABLE_DATA,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await unlockTreasurer(page);

  // Premise: round 1 really is released, and Regine really is confirmed on
  // cycle 1 — without both, a refusal proves nothing.
  const premise = await page.evaluate(() => {
    const p = window.PowerFund;
    return { hasRevert: typeof p.confirmUndoPaid === "function" };
  });
  check("qa-p0/premise: the revert handler is exported", premise.hasRevert === true);
  check(
    "qa-p0/premise: round 1 is released in the fixtures",
    M.PAYOUTS[0].released === true
  );

  await page.locator(".tab-item", { hasText: "Rounds" }).click();
  await page.waitForTimeout(500);
  await page.locator(".round-header").first().click();
  await page.waitForTimeout(500);

  // An already-broken fund must SAY so rather than merely be wrong.
  // Read the count FIRST and only then the text: innerText() on a zero-count
  // locator throws, which aborts the whole run instead of reporting one FAIL —
  // and a check that cannot fail cleanly is no use when verifying the fix.
  const shortfalls = await page.locator(".payout-shortfall").count();
  const shortfallText = shortfalls
    ? await page.locator(".payout-shortfall").first().innerText()
    : "(none rendered)";
  check("qa-p0/a released-but-unfunded round is flagged", shortfalls === 1, shortfallText);
  check("qa-p0/and names the shortfall", /short/.test(shortfallText), shortfallText);
  check(
    "qa-p2/the release reversal says what it reverses",
    /Undo Release/.test(await page.locator(".payout-status-box").first().innerText()),
    await page.locator(".payout-status-box").first().innerText()
  );

  // Tapping a confirmed chip in a released round must not open the undo panel.
  const paidChip = page.locator(".member-chip.paid").first();
  await paidChip.click();
  await page.waitForTimeout(500);
  check("qa-p0/the undo panel does not open on a released round",
    (await page.locator(".undo-paid-panel").count()) === 0);
  const banner = (await page.locator(".save-error-banner").count())
    ? await page.locator(".save-error-banner").first().innerText()
    : "(no error banner)";
  check("qa-p0/and it says to undo the release first",
    /already been paid out/.test(banner), banner);

  // cellClicked is exported, so the chip not being tappable is not the gate.
  // A REAL member id, or this calls a no-op and passes either way.
  const before = await page.locator(".member-chip.paid").count();
  await page.evaluate((id) => window.PowerFund.cellClicked(id, 1), M.MEMBERS[0].id);
  await page.waitForTimeout(400);
  check("qa-p0/the exported handler refuses it too",
    (await page.locator(".undo-paid-panel").count()) === 0);
  const after = await page.locator(".member-chip.paid").count();
  check("qa-p0/no confirmed payment was removed", after === before, `${before} → ${after}`);
  await page.close();

  // ---- P1: the destructive confirm button was never disabled --------------
  // canvas.json's menu-pin-notes names this property explicitly: "type RESET
  // AND enter the PIN before 'Reset everything' enables — genuinely
  // disabled/enabled live based on both fields".
  const d = await browser.newPage({ viewport: { width: 430, height: 950 } });
  d.on("pageerror", (e) => errors.push(`qa-p1: ${e}`));
  await serve(d, {
    ...M.TABLE_DATA,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  });
  await d.goto(BASE, { waitUntil: "domcontentloaded" });
  await d.waitForTimeout(2000);
  await unlockTreasurer(d);
  await d.evaluate(() => window.PowerFund.resetData());
  await d.waitForTimeout(500);

  const yes = d.locator(".modal .confirm-yes");
  check("qa-p1/Reset is disabled on an empty dialog",
    (await yes.isDisabled()) === true);
  await d.locator(".confirm-type-input").fill("RESET");
  await d.waitForTimeout(250);
  check("qa-p1/still disabled with RESET typed but no PIN",
    (await yes.isDisabled()) === true);
  await d.locator('.modal input[placeholder="Treasurer PIN"]').fill("1234");
  await d.waitForTimeout(250);
  check("qa-p1/enabled once both fields are filled",
    (await yes.isDisabled()) === false);
  // Live in both directions — the design says "disabled/enabled live".
  await d.locator(".confirm-type-input").fill("RESE");
  await d.waitForTimeout(250);
  check("qa-p1/and disables again when the word is broken",
    (await yes.isDisabled()) === true);
  await d.close();
}

/** The two PIN dead ends, both created by the PIN-free unlock landing on top
 *  of rules written when treasurer mode could only be entered with a PIN. */
async function pinDeadEnds(browser, errors) {
  // 1. A GOOGLE-VERIFIED TREASURER ON A FUND WITH NO TREASURER PIN.
  //    They unlock with no PIN, so nothing ever mentions that none exists —
  //    until a destructive action asks for one that cannot be typed.
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`pin-deadend: ${e}`));
  const members = rosterWithEmails();
  members[0].auth_user_id = FAKE_USER_ID;
  await serve(page, {
    ...M.TABLE_DATA,
    members,
    app_settings: { ...M.SETTINGS, treasurer_pin: null, master_pin: null },
  });
  await withAuthMode(page, "optional", { signedIn: true, email: "regine@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator(".unlock-btn").click();
  await page.waitForTimeout(500);
  check("pin-deadend/a verified treasurer unlocks with no PIN modal",
    (await page.locator(".modal-overlay").count()) === 0);
  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(400);

  const pinRow = page.locator(".menu-row", { hasText: "treasurer PIN" }).first();
  const pinRowText = (await pinRow.innerText()).replace(/\s+/g, " ");
  check("pin-deadend/the menu says no PIN is set",
    /Set a treasurer PIN/.test(pinRowText), pinRowText);
  check("pin-deadend/and names what needs it",
    /Reset all data/.test(await page.locator(".menu-row", { hasText: "Set a treasurer PIN" }).first().innerText()));

  await page.locator(".reset-btn.danger").click();
  await page.waitForTimeout(450);
  check("pin-deadend/the confirm says there is no PIN, not 'incorrect'",
    (await page.locator(".confirm-no-pin").count()) === 1);
  check("pin-deadend/it offers no PIN field to type into",
    (await page.locator('.modal input[placeholder="Treasurer PIN"]').count()) === 0);
  // Hidden too: typing RESET into a dialog that cannot be submitted is busywork.
  check("pin-deadend/nor the type-to-confirm field",
    (await page.locator(".confirm-type-input").count()) === 0);
  check("pin-deadend/and offers the way out instead of Reset",
    (await page.locator(".confirm-set-pin").count()) === 1 &&
      (await page.locator(".confirm-yes").count()) === 0);

  // submitConfirm is exported, so the hidden field is not the gate — and the
  // missing-PIN check must beat the type-to-confirm one, or the message would
  // be "Type RESET exactly to confirm" for a dialog with no RESET field.
  await page.evaluate(() => window.PowerFund.submitConfirm());
  await page.waitForTimeout(400);
  check("pin-deadend/the handler refuses, and says why",
    /No treasurer PIN is set/.test(await page.locator(".modal .pin-error").innerText()),
    await page.locator(".modal .pin-error").innerText());

  await page.locator(".confirm-set-pin").click();
  await page.waitForTimeout(450);
  check("pin-deadend/the way out opens PIN creation, not 'change'",
    /Choose a treasurer PIN/.test(await page.locator(".modal h3").innerText()),
    await page.locator(".modal h3").innerText());
  check("pin-deadend/a first PIN has two steps, not three",
    (await page.locator(".pin-step").count()) === 2);
  await page.close();

  // 2. THE MASTER-PIN LOCKOUT. Unlocking with the master PIN tells you to set a
  //    new treasurer PIN from Menu → Change PIN — and that screen used to open
  //    by demanding the very PIN you just proved you had forgotten.
  const m = await browser.newPage({ viewport: { width: 430, height: 950 } });
  m.on("pageerror", (e) => errors.push(`pin-master: ${e}`));
  await serve(m, {
    ...M.TABLE_DATA,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234", master_pin: "9999" },
  });
  await m.goto(BASE, { waitUntil: "domcontentloaded" });
  await m.waitForTimeout(2000);
  await m.locator(".unlock-btn").click();
  await m.waitForTimeout(400);
  await m.keyboard.type("9999");
  await m.locator(".modal-btn-primary").first().click();
  await m.waitForTimeout(900);
  check("pin-master/the master PIN unlocks", (await m.locator(".unlock-btn").innerText()).length > 0);
  await m.locator(".tab-item", { hasText: "Menu" }).click();
  await m.waitForTimeout(400);
  await m.locator(".menu-row", { hasText: "Change PIN" }).first().click();
  await m.waitForTimeout(450);
  check(
    "pin-master/Change PIN does NOT demand the forgotten PIN",
    /Choose a new PIN/.test(await m.locator(".modal h3").innerText()),
    await m.locator(".modal h3").innerText()
  );
  check("pin-master/and the progress bar counts two steps",
    (await m.locator(".pin-step").count()) === 2);
  await m.close();

  // The control: an ordinary unlock still has to prove the current PIN, or
  // anyone holding an unlocked phone could lock the group out of its own fund.
  const norm = await browser.newPage({ viewport: { width: 430, height: 950 } });
  norm.on("pageerror", (e) => errors.push(`pin-normal: ${e}`));
  await serve(norm, {
    ...M.TABLE_DATA,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234", master_pin: "9999" },
  });
  await norm.goto(BASE, { waitUntil: "domcontentloaded" });
  await norm.waitForTimeout(2000);
  await norm.locator(".unlock-btn").click();
  await norm.waitForTimeout(400);
  await norm.keyboard.type("1234");
  await norm.locator(".modal-btn-primary").first().click();
  await norm.waitForTimeout(900);
  await norm.locator(".tab-item", { hasText: "Menu" }).click();
  await norm.waitForTimeout(400);
  await norm.locator(".menu-row", { hasText: "Change PIN" }).first().click();
  await norm.waitForTimeout(450);
  check(
    "pin-normal/an ordinary unlock still proves the current PIN",
    /Enter your current PIN/.test(await norm.locator(".modal h3").innerText()),
    await norm.locator(".modal h3").innerText()
  );
  check("pin-normal/three steps",
    (await norm.locator(".pin-step").count()) === 3);
  await norm.close();
}

/** Payment schedule — the 30 due dates, which until now could only be changed
 *  in SQL. Gated on the ACCOUNT (011's cycles_treasurer keys off
 *  members.is_treasurer), not on the shared PIN. */
async function paymentSchedule(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`schedule: ${e}`));
  const members = rosterWithEmails();
  members[0].auth_user_id = FAKE_USER_ID; // Regine, flagged AND signed in
  const data = { ...M.TABLE_DATA, members };
  await serve(page, data);

  const writes = [];
  await page.route("**/rest/v1/cycles**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify(data.cycles),
      });
    }
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
    const target = data.cycles.find((c) => req.url().includes(c.id));
    writes.push({ cycle: target && target.cycle_number, body });
    Object.assign(target || {}, body);
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([target || {}]),
    });
  });
  await withAuthMode(page, "optional", { signedIn: true, email: "regine@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.locator(".unlock-btn").click();
  await page.waitForTimeout(500);
  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(400);

  const rowLoc = page.locator(".menu-row", { hasText: "Payment schedule" });
  check("schedule/the treasurer gets a Payment schedule row", (await rowLoc.count()) === 1);
  await rowLoc.first().click();
  await page.waitForTimeout(450);

  const dates = page.locator(".schedule-modal .schedule-date");
  check("schedule/every cycle is editable", (await dates.count()) === 30, `${await dates.count()} fields`);
  check(
    "schedule/grouped by round",
    (await page.locator(".schedule-modal .schedule-round").count()) === 5
  );
  check("schedule/nothing is moved on open", /No changes yet/.test(
    await page.locator("#scheduleCount").innerText()
  ));

  const vals = () => dates.evaluateAll((els) => els.map((e) => e.value));
  const before = await vals();
  const plusDays = (iso, n) => {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  };

  // THE REASON THE SCREEN EXISTS: a round started late, so cycle 3 and
  // everything after it moves. Doing that one field at a time is 28 edits.
  await dates.nth(2).fill(plusDays(before[2], 14));
  await page.waitForTimeout(350);
  const after = await vals();
  check("schedule/shift leaves earlier cycles alone",
    after[0] === before[0] && after[1] === before[1],
    `${after[0]} / ${after[1]}`);
  check("schedule/the edited cycle moves",
    after[2] === plusDays(before[2], 14), after[2]);
  check(
    "schedule/and every later cycle moves with it",
    after.slice(3).every((v, i) => v === plusDays(before[i + 3], 14)),
    after.slice(3, 6).join(" ")
  );
  check("schedule/it counts what moved", /28 cycles moved/.test(
    await page.locator("#scheduleCount").innerText()
  ));
  // onTimeStats() judges paid_at against due_date, so moving a settled cycle
  // rewrites who is on record as having paid on time. Not blocked — said.
  check(
    "schedule/it warns about already-confirmed cycles",
    (await page.locator("#scheduleSettled").isVisible()) &&
      /paid on time/.test(await page.locator("#scheduleSettled").innerText())
  );

  // Shift off: one date alone.
  await page.locator(".schedule-shift input").uncheck();
  await page.waitForTimeout(150);
  const pre = await vals();
  await dates.nth(19).fill(plusDays(pre[19], 1));
  await page.waitForTimeout(300);
  const post = await vals();
  check("schedule/with the shift off only that cycle moves",
    post[19] === plusDays(pre[19], 1) && post[20] === pre[20],
    `${post[19]} / ${post[20]}`);

  // Out of order is refused: currentCycle() returns the first cycle whose date
  // has not passed while completedCyclesCount() counts every one that has, so
  // an unordered schedule makes those two disagree.
  await dates.nth(1).fill(plusDays(post[2], 5));
  await page.waitForTimeout(300);
  check("schedule/out-of-order dates are refused", /must fall after cycle 2/.test(
    await page.locator("#scheduleError").innerText()
  ), await page.locator("#scheduleError").innerText());
  check("schedule/and Save is disabled while they are",
    (await page.locator("#scheduleSave").isDisabled()) === true);

  await dates.nth(1).fill(pre[1]);
  await page.waitForTimeout(300);
  check("schedule/fixing it re-enables Save",
    (await page.locator("#scheduleSave").isDisabled()) === false);

  await page.locator("#scheduleSave").click();
  await page.waitForTimeout(1600);
  check("schedule/the modal closes on save", (await page.locator(".schedule-modal").count()) === 0);
  check("schedule/only the cycles that moved are written",
    writes.length === 28, `${writes.length} write(s)`);
  check("schedule/cycles 1 and 2 are left alone",
    !writes.some((w) => w.cycle === 1 || w.cycle === 2),
    writes.map((w) => w.cycle).slice(0, 3).join(","));
  check(
    "schedule/each write carries due_date and nothing else",
    writes.every((w) => Object.keys(w.body).length === 1 && "due_date" in w.body),
    JSON.stringify(writes[0] && writes[0].body)
  );
  await page.close();

  // THE GATE. The treasurer PIN is shared with all five members, so unlocking
  // treasurer mode with it must NOT reach a table 011 makes account-only.
  const pin = await browser.newPage({ viewport: { width: 430, height: 950 } });
  pin.on("pageerror", (e) => errors.push(`schedule/pin: ${e}`));
  const roster = rosterWithEmails();
  roster[2].auth_user_id = FAKE_USER_ID; // Jan is signed in; Regine is the treasurer
  await serve(pin, {
    ...M.TABLE_DATA,
    members: roster,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  });
  await withAuthMode(pin, "optional", { signedIn: true, email: "jan@example.com" });
  await pin.goto(BASE, { waitUntil: "domcontentloaded" });
  await pin.waitForTimeout(2500);
  await pin.evaluate(() => window.PowerFund.openScheduleModal());
  await pin.waitForTimeout(400);
  // Exported on PowerFund, so an absent menu row is not the gate.
  check(
    "schedule/a member who is not the flagged treasurer cannot open it",
    (await pin.locator(".schedule-modal").count()) === 0
  );
  await pin.close();
}

/** Transfer treasurer role — moving `members.is_treasurer`, the flag Postgres
 *  checks. The PIN cannot express this, which is the whole point. */
async function transferRole(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`transfer: ${e}`));
  const members = rosterWithEmails();
  members[0].auth_user_id = FAKE_USER_ID; // Regine, the flagged treasurer
  members[1].auth_user_id = "22222222-2222-2222-2222-222222222222"; // Sarah, linked
  members[3].auth_user_id = null; // Clara has never signed in
  // A PIN really is set here: the confirm step asks for it, and M.SETTINGS
  // ships with treasurer_pin null (which is the never-set-up fund).
  const data = {
    ...M.TABLE_DATA,
    members,
    app_settings: { ...M.SETTINGS, treasurer_pin: "1234" },
  };

  await serve(page, data);
  const writes = [];
  await page.route("**/rest/v1/members**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(data.members),
      });
    }
    let body = {};
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch (e) {}
    const target = data.members.find((m) => req.url().includes(m.id));
    writes.push({ name: target && target.name, body });
    Object.assign(target || {}, body);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([target || {}]),
    });
  });
  await withAuthMode(page, "optional", { signedIn: true, email: "regine@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // Treasurer mode no longer opens on sign-in, and Security only exists inside
  // it. One tap, no PIN — that is the point of the verified-treasurer path.
  await page.locator(".unlock-btn").click();
  await page.waitForTimeout(500);
  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(400);

  const rowSel = page.locator(".menu-row", { hasText: "Transfer treasurer role" });
  check("transfer/Security offers it to the admin", (await rowSel.count()) === 1);
  await rowSel.first().click();
  await page.waitForTimeout(400);
  check(
    "transfer/it names the current holder",
    /Regine/.test(await page.locator(".transfer-current").innerText())
  );
  // The role is matched to a LOGIN (pf_is_treasurer reads auth_user_id), so a
  // member who has never signed in cannot hold it and must not be offered.
  check(
    "transfer/only members who have signed in are offered",
    (await page.locator(".transfer-row").count()) === 1 &&
      /Sarah/.test(await page.locator(".transfer-row").innerText())
  );
  check(
    "transfer/and it says why the others are missing",
    /Clara/.test(await page.locator(".transfer-note").innerText())
  );
  check(
    "transfer/Continue is disabled until somebody is picked",
    await page.locator(".modal-btn-primary", { hasText: "Continue" }).isDisabled()
  );

  await page.locator(".transfer-row").first().click();
  await page.waitForTimeout(300);
  await page.locator(".modal-btn-primary", { hasText: "Continue" }).click();
  await page.waitForTimeout(400);
  const confirmText = await page.locator(".modal[role=dialog]").last().innerText();
  check(
    "transfer/the confirm spells out that YOU lose the role",
    /will not/i.test(confirmText) && /Sarah/.test(confirmText)
  );
  check(
    "transfer/and asks for the PIN, like every other irreversible action",
    (await page.locator(".modal[role=dialog] input").count()) > 0
  );

  // Filled by selector, not typed: the confirm dialog does not focus its PIN
  // field, so keyboard input would land nowhere. (Noted for QA — it means the
  // phone keyboard does not come up on its own either.)
  await page.locator('.modal input[placeholder="Treasurer PIN"]').fill("1234");
  await page.waitForTimeout(200);
  await page.locator(".confirm-yes").click();
  await page.waitForTimeout(1800);

  // ORDER IS THE POINT. Grant first, then resign: a failure between the two
  // leaves two treasurers (visible, self-healing) rather than none (which
  // nobody can undo, because setting the flag requires being the treasurer).
  const flagWrites = writes.filter((w) => "is_treasurer" in w.body);
  check(
    "transfer/grants the new treasurer BEFORE resigning",
    flagWrites.length === 2 &&
      flagWrites[0].name === "Sarah" &&
      flagWrites[0].body.is_treasurer === true &&
      flagWrites[1].name === "Regine" &&
      flagWrites[1].body.is_treasurer === false,
    JSON.stringify(flagWrites)
  );
  // Losing the role must drop treasurer mode: before 011 those buttons would
  // still work, which is worse than being refused.
  check(
    "transfer/the outgoing treasurer loses treasurer mode",
    (await page.locator(".mode-card.on").count()) === 0
  );
  check(
    "transfer/and the unlock button with it",
    (await page.locator(".unlock-btn").count()) === 0
  );
  await page.close();
}

/** The optional-mode first-run sign-in prompt. Exists so a shared link
 *  explains itself: the alternative is telling five people, one at a time, to
 *  find Menu -> Account. */
async function signInPrompt(browser, errors) {
  // A genuinely first-run device in "optional" mode: sign-in fronts the app.
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`signin-prompt: ${e}`));
  await serve(page, M.TABLE_DATA);
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("pf_signin_skipped");
    } catch (e) {}
  });
  await withAuthMode(page, "optional");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  check("prompt/optional mode fronts the app with sign-in", (await page.locator(".signin").count()) === 1);
  check("prompt/the shell is not behind it", (await page.locator(".tab-bar").count()) === 0);
  // Unlike the required-mode gate, this one must be escapable — the app really
  // does work without an account in this mode.
  check(
    "prompt/it offers a way past, and says where to find it later",
    (await page.locator(".signin-btn-quiet").count()) === 1 &&
      /Menu/.test(await page.locator(".signin-card").innerText())
  );
  await page.locator(".signin-btn-quiet").click();
  await page.waitForTimeout(600);
  check("prompt/Not now enters the app", (await page.locator(".tab-bar").count()) === 1);
  check(
    "prompt/and the skip is remembered, so it asks once per device",
    (await page.evaluate(() => localStorage.getItem("pf_signin_skipped"))) === "1"
  );
  await page.close();

  // "required" mode has its own gate and must NOT offer a way past it.
  const gate = await browser.newPage({ viewport: { width: 430, height: 950 } });
  gate.on("pageerror", (e) => errors.push(`signin-prompt/gate: ${e}`));
  await serve(gate, M.TABLE_DATA);
  await withAuthMode(gate, "required");
  await gate.goto(BASE, { waitUntil: "domcontentloaded" });
  await gate.waitForTimeout(2000);
  check(
    "prompt/the required-mode gate has no Not now",
    (await gate.locator(".signin").count()) === 1 &&
      (await gate.locator(".signin-btn-quiet").count()) === 0
  );
  await gate.close();

  // "off" has no accounts at all, so nothing should front the app.
  const off = await browser.newPage({ viewport: { width: 430, height: 950 } });
  off.on("pageerror", (e) => errors.push(`signin-prompt/off: ${e}`));
  await serve(off, M.TABLE_DATA);
  await off.addInitScript(() => {
    try {
      localStorage.removeItem("pf_signin_skipped");
    } catch (e) {}
  });
  await withAuthMode(off, "off");
  await off.goto(BASE, { waitUntil: "domcontentloaded" });
  await off.waitForTimeout(2000);
  check(
    "prompt/auth off never asks",
    (await off.locator(".signin").count()) === 0 &&
      (await off.locator(".tab-bar").count()) === 1
  );
  await off.close();
}

/** Onboarding: five approved artboards, previously deferred entirely. */
async function onboarding(browser, errors) {
  // A genuinely first-run device.
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`onboarding: ${e}`));
  await serve(
    page,
    { ...M.TABLE_DATA, app_settings: { ...M.SETTINGS, fund_name: "ViTAMiN Fund 2027", qr_bank: "Maya" } },
    { freshDevice: true }
  );
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);

  check("onb/a first run shows the intro, not the dashboard", (await page.locator(".onboarding").count()) === 1);
  check("onb/the shell is not behind it", (await page.locator(".tab-bar").count()) === 0);
  check(
    "onb/step 1 is Welcome, named for the fund",
    /Welcome to Power Fund/i.test(await page.locator(".ob-title").innerText()) &&
      /ViTAMiN Fund 2027/i.test(await page.locator(".ob-kicker").innerText())
  );
  // Nobody is linked in these fixtures, so the picker step is included: 5 dots.
  check("onb/five dots for five steps", (await page.locator(".ob-dot").count()) === 5);
  check("onb/the first dot is the active one", (await page.locator(".ob-dot.active").first().evaluate(
    (el) => el.previousElementSibling === null
  )) === true);
  check(
    "onb/the first CTA reads Get started",
    /get started/i.test(await page.locator(".ob-next").innerText())
  );

  // Step 2 — the numbers must come from calculations.js, not the mockup.
  await page.locator(".ob-next").click();
  await page.waitForTimeout(350);
  const s2 = (await page.locator(".ob-body").innerText()).replace(/\s+/g, " ");
  check(
    // From calculations.js's constants, and WITHOUT the .00 that C.peso()
    // adds — the artboards write these as prose, not as ledger amounts.
    "onb/step 2 states the real cycle maths, in whole pesos",
    /₱1,000 each cycle/.test(s2) &&
      /6 cycles/.test(s2) &&
      /₱30,000 collected/.test(s2) &&
      /5 rounds/.test(s2) &&
      !/\.00/.test(s2),
    s2.slice(0, 130)
  );
  check("onb/one bar per cycle in a round", (await page.locator(".ob-cycle-bar").count()) === 6);

  // Step 3 — the real wallet name, not the artboard's hardcoded "GCash".
  await page.locator(".ob-next").click();
  await page.waitForTimeout(350);
  const s3 = await page.locator(".ob-text").innerText();
  check("onb/step 3 names the treasurer's ACTUAL wallet", /Maya/.test(s3) && !/GCash/.test(s3), s3.slice(0, 90));
  check("onb/step 3 shows the three-step flow", (await page.locator(".ob-step").count()) === 3);

  // Step 4 — the real roster, not Ana/Ben/Cathy.
  await page.locator(".ob-next").click();
  await page.waitForTimeout(350);
  const rows = await page.locator(".ob-order-row").count();
  const names = (await page.locator(".ob-order-name").allInnerTexts()).join(",");
  check("onb/step 4 lists the real roster", rows === M.MEMBERS.length, `${rows} rows`);
  check(
    "onb/with real names, not the mockup's placeholders",
    names.includes(M.MEMBERS[0].name) && !/Ana|Cathy|Elena/.test(names),
    names
  );
  check(
    "onb/and marks exactly one round as the live one",
    (await page.locator(".ob-order-row.is-now").count()) <= 1
  );

  // Step 5 — the picker, which is the flow's exit.
  await page.locator(".ob-next").click();
  await page.waitForTimeout(350);
  check("onb/step 5 is the member picker", (await page.locator(".ob-picker-row").count()) === M.MEMBERS.length);
  await page.locator(".ob-picker-row").nth(2).click();
  await page.waitForTimeout(600);
  check("onb/picking a member enters the app", (await page.locator(".tab-bar").count()) === 1);
  check(
    "onb/and that member becomes this device's identity",
    (await page.evaluate(() => localStorage.getItem("pf_my_member_id"))) === M.MEMBERS[2].id
  );
  check(
    "onb/the intro does not come back on reload",
    (await page.evaluate(() => localStorage.getItem("pf_onboarded"))) === "1"
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  check("onb/confirmed on an actual reload", (await page.locator(".onboarding").count()) === 0);

  // Menu offers a way back in — the design gives none.
  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(400);
  await page.locator(".menu-row", { hasText: "Replay the intro" }).click();
  await page.waitForTimeout(500);
  check("onb/Menu can replay it", (await page.locator(".onboarding").count()) === 1);
  await page.close();

  // Skip, from the very first step.
  const skip = await browser.newPage({ viewport: { width: 430, height: 950 } });
  skip.on("pageerror", (e) => errors.push(`onboarding: ${e}`));
  await serve(skip, M.TABLE_DATA, { freshDevice: true });
  await skip.goto(BASE, { waitUntil: "domcontentloaded" });
  await skip.waitForTimeout(1800);
  await skip.locator(".ob-skip").click();
  await skip.waitForTimeout(500);
  check("onb/Skip goes straight to the dashboard", (await skip.locator(".tab-bar").count()) === 1);
  check(
    "onb/and Skip still marks it seen",
    (await skip.evaluate(() => localStorage.getItem("pf_onboarded"))) === "1"
  );
  await skip.close();

  // A LINKED member already answers "which one is you?", so that step is
  // dropped — the design predates accounts and cannot know this.
  const linked = await browser.newPage({ viewport: { width: 430, height: 950 } });
  linked.on("pageerror", (e) => errors.push(`onboarding: ${e}`));
  await serve(
    linked,
    { ...M.TABLE_DATA, members: rosterWithEmails({ auth_user_id: FAKE_USER_ID }) },
    { freshDevice: true }
  );
  await withAuthMode(linked, "required", { signedIn: true, email: "regine@example.com" });
  await linked.goto(BASE, { waitUntil: "domcontentloaded" });
  await linked.waitForTimeout(2200);
  check("onb/a linked member still gets the intro", (await linked.locator(".onboarding").count()) === 1);
  check(
    "onb/but four steps, not five — the picker is dropped",
    (await linked.locator(".ob-dot").count()) === 4,
    `${await linked.locator(".ob-dot").count()} dots`
  );
  for (let n = 0; n < 3; n++) {
    await linked.locator(".ob-next").click();
    await linked.waitForTimeout(300);
  }
  check("onb/no picker on the last step", (await linked.locator(".ob-picker-row").count()) === 0);
  await linked.locator(".ob-next").click();
  await linked.waitForTimeout(600);
  check("onb/the last Next enters the app", (await linked.locator(".tab-bar").count()) === 1);
  await linked.close();

  // Desktop frame: centred column, no horizontal scroll.
  const wide = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  wide.on("pageerror", (e) => errors.push(`onboarding: ${e}`));
  await serve(wide, M.TABLE_DATA, { freshDevice: true });
  await wide.goto(BASE, { waitUntil: "domcontentloaded" });
  await wide.waitForTimeout(1800);
  check("onb/desktop shows it too", (await wide.locator(".onboarding").count()) === 1);
  const box = await wide.locator(".ob-body").boundingBox();
  const off = Math.abs(box.x + box.width / 2 - 720);
  check("onb/desktop centres the column", off <= 2, `off-centre by ${Math.round(off)}px`);
  check(
    "onb/desktop never scrolls sideways",
    (await wide.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)) === true
  );
  await wide.close();
}

/** Backup and restore must round-trip everything they claim to.
 *
 *  The backup silently omitted five migrations' worth of columns — most
 *  seriously every member's payout account number, i.e. where the 30,000 is
 *  actually sent — and the activity log was captured but never written back.
 *  So "Reset all data" then "Restore backup" returned the money and dropped
 *  both the history of how it got there and the details of where it goes. */
async function backupRoundTrip(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`backup: ${e}`));

  const members = M.MEMBERS.map((m, i) => ({
    ...m,
    email: `${m.name.toLowerCase()}@example.com`,
    is_treasurer: i === 0,
    avatar_url: i === 0 ? "https://example.invalid/a.jpg" : null,
    payout_bank: "GCash",
    payout_account_name: m.name + " Dela Cruz",
    payout_account_number: `0917${1000000 + i}`,
  }));
  const contributions = M.CONTRIBUTIONS.map((c, i) =>
    i === 0
      ? { ...c, status: 3, rejection_note: "Screenshot was blurry", rejected_at: "2026-09-20T02:00:00Z" }
      : c
  );
  const activityLog = (M.ACTIVITY_LOG || []).map((a, i) => ({
    ...a,
    event_type: "payment",
    amount: 1000,
    round_number: 2,
    member_id: M.MEMBERS[0].id,
  }));
  const settings = {
    id: 1,
    fund_name: "ViTAMiN Fund 2027",
    qr_bank: "Maya",
    qr_account_name: "Fund Treasurer",
    qr_account_number: "09171234567",
  };
  await serve(page, { ...M.TABLE_DATA, members, contributions, activity_log: activityLog, app_settings: settings });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);

  // Capture the file the app would have downloaded.
  await page.evaluate(() => {
    window.__capBlob = null;
    URL.createObjectURL = (blob) => {
      window.__capBlob = blob;
      return "blob:stub";
    };
  });
  await page.evaluate(() => window.PowerFund.downloadBackup());
  await page.waitForTimeout(300);
  const raw = await page.evaluate(() => (window.__capBlob ? window.__capBlob.text() : null));
  const b = JSON.parse(raw);

  check("backup/version is bumped past the incomplete v1", b.version === 2, String(b.version));
  const me = b.members.find((m) => m.member_order === 1);
  check(
    "backup/captures where each member RECEIVES money",
    !!me && me.payout_account_number === "09171000000" && me.payout_bank === "GCash",
    JSON.stringify(me && { bank: me.payout_bank, acct: me.payout_account_number })
  );
  check("backup/captures emails and the treasurer flag", me.email === "regine@example.com" && me.is_treasurer === true);
  check("backup/captures profile photos", me.avatar_url === "https://example.invalid/a.jpg");
  check(
    // A project-specific FK. Restoring it would dangle or re-point ownership.
    "backup/does NOT capture auth_user_id",
    !("auth_user_id" in me)
  );
  const rejected = b.contributions.find((c) => c.status === 3);
  check(
    "backup/captures why a claim was refused",
    !!rejected && rejected.rejection_note === "Screenshot was blurry" && !!rejected.rejected_at
  );
  check(
    "backup/captures the activity log's typed columns",
    b.activityLog.length > 0 &&
      b.activityLog[0].event_type === "payment" &&
      b.activityLog[0].round_number === 2 &&
      b.activityLog[0].member_order === 1,
    JSON.stringify(b.activityLog[0] || {})
  );
  check(
    "backup/captures the fund name and QR account details",
    b.settings && b.settings.fund_name === "ViTAMiN Fund 2027" && b.settings.qr_bank === "Maya"
  );
  check(
    // These live in app_secrets, which the browser cannot read at all.
    "backup/never contains a PIN",
    !/treasurer_pin|master_pin/.test(raw)
  );
  await page.close();

  // ---- Restore: the captured fields must actually go back --------------
  const back = await browser.newPage({ viewport: { width: 430, height: 950 } });
  back.on("pageerror", (e) => errors.push(`backup: ${e}`));
  const writes = [];
  await serve(back, { ...M.TABLE_DATA, members, app_settings: settings });
  await back.route("**/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/").pop();
    if (route.request().method() !== "GET" && !url.pathname.includes("/rpc/")) {
      let body = null;
      try {
        body = JSON.parse(route.request().postData() || "null");
      } catch (e) {}
      writes.push({ table, method: route.request().method(), body });
      // Echo the written rows back, the way PostgREST does with a
      // `select` preference. Returning [] would look like an RLS refusal to
      // requireRows() — which is exactly what it is meant to look like.
      const echo = Array.isArray(body) ? body : [body || {}];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(echo),
      });
    }
    if (url.pathname.includes("/rpc/")) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"code":"42883","message":"no fn"}',
      });
    }
    const rows = { ...M.TABLE_DATA, members, app_settings: settings }[table];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rows === undefined ? [] : rows),
    });
  });
  await back.goto(BASE, { waitUntil: "domcontentloaded" });
  await back.waitForTimeout(1600);
  await back.evaluate(async (json) => {
    await window.DB.restoreFromBackup(JSON.parse(json));
  }, raw);
  await back.waitForTimeout(600);

  const memberWrites = writes.filter((w) => w.table === "members");
  check(
    "restore/writes the payout account details back",
    memberWrites.some(
      (w) => w.body && w.body.payout_account_number === "09171000000"
    ),
    JSON.stringify(memberWrites.map((w) => Object.keys(w.body || {})).slice(0, 2))
  );
  check(
    "restore/writes the fund settings back",
    writes.some((w) => w.table === "app_settings" && w.body && w.body.fund_name === "ViTAMiN Fund 2027")
  );
  check(
    "restore/writes the activity log back",
    writes.some(
      (w) => w.table === "activity_log" && Array.isArray(w.body) && w.body.length > 0
    )
  );
  check(
    "restore/writes the rejection reason back",
    writes.some(
      (w) =>
        w.table === "contributions" &&
        Array.isArray(w.body) &&
        w.body.some((r) => r.rejection_note === "Screenshot was blurry")
    )
  );

  // A v1 file (name only) must NOT null out details currently on the roster.
  writes.length = 0;
  await back.evaluate(async () => {
    await window.DB.restoreFromBackup({
      app: "power-fund",
      version: 1,
      members: [{ member_order: 1, name: "Regine" }],
      contributions: [],
    });
  });
  await back.waitForTimeout(400);
  const v1 = writes.filter((w) => w.table === "members");
  check(
    "restore/a v1 backup touches only the name, nulling nothing",
    v1.length > 0 &&
      v1.every((w) => w.body && Object.keys(w.body).join(",") === "name"),
    JSON.stringify(v1.map((w) => Object.keys(w.body || {})))
  );
  await back.close();
}

/** A write that RLS refuses silently must not be reported as success.
 *
 *  Migration 011 refuses an update by making the row invisible, so the reply
 *  is `[]` with NO error. The treasurer PIN is shared with the whole group, so
 *  a member who is not the flagged treasurer can unlock treasurer mode and tap
 *  Confirm — and without requireRows() the UI would tell them it worked. */
async function silentRefusal(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`refusal: ${e}`));
  await serve(page, { ...M.TABLE_DATA, app_settings: { ...M.SETTINGS, treasurer_pin: "1234" } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await unlockTreasurer(page);
  await page.waitForTimeout(300);

  // From here on, every write comes back 200 [] — exactly what a post-011
  // policy refusal looks like over the wire.
  await page.route("**/rest/v1/contributions**", (r) =>
    r.request().method() === "GET"
      ? r.continue()
      : r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );

  await page.locator(".tab-item", { hasText: "Rounds" }).click();
  await page.waitForTimeout(400);
  const unpaid = ".member-chip.editable:not(.paid):not(.pending):not(.rejected)";
  const rounds = await page.locator(".round").count();
  for (let i = 0; i < rounds; i++) {
    await page.locator(".round").nth(i).click();
    await page.waitForTimeout(250);
    if ((await page.locator(unpaid).count()) > 0) break;
  }
  await page.locator(unpaid).first().click();
  await page.waitForTimeout(300);
  await page.locator(".mark-paid-panel button", { hasText: "Record as paid" }).click();
  await page.waitForTimeout(1200);

  const banner = page.locator(".save-error-banner");
  check("refusal/a refused write surfaces an error", (await banner.count()) === 1);
  check(
    "refusal/and says the treasurer account is what is missing",
    /refused it|treasurer/i.test(await banner.innerText()),
    (await banner.innerText().catch(() => "")).slice(0, 90)
  );
  check(
    "refusal/it is NOT reported as a success",
    (await page.locator(".toast .toast-text").count()) === 0
  );
  await page.close();
}

/** The PIN vault (migration 010).
 *
 *  Every other test in this file runs the PRE-010 world, because the fixtures
 *  serve app_settings with plaintext PIN columns — that is the fallback path,
 *  and its continued passing is what proves the migration is optional until
 *  applied. These tests cover the post-010 world by answering the RPCs. */
async function pinVault(browser, errors) {
  // ---- Post-010: the digits never reach the browser --------------------
  const vault = await browser.newPage({ viewport: { width: 430, height: 950 } });
  vault.on("pageerror", (e) => errors.push(`vault: ${e}`));
  // Routes by hand, so serve() never ran — which means BOTH of serve()'s
  // defaults have to be set here: the storage flags and the AUTH_MODE pin.
  // Missing the flags stranded this test on the intro once; missing the pin
  // stranded it on the sign-in gate the day AUTH_MODE became "required".
  await markOnboarded(vault);
  await withAuthMode(vault, "off");
  const rpcCalls = [];
  const bodies = [];
  // app_settings without the PIN columns, exactly as 010 leaves it.
  const settingsNoPins = { id: 1, qr_code_url: null };
  await vault.route("**/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const last = url.pathname.split("/").pop();
    if (url.pathname.includes("/rpc/")) {
      rpcCalls.push(last);
      let body = {};
      try {
        body = JSON.parse(route.request().postData() || "{}");
      } catch (e) {}
      bodies.push({ fn: last, body });
      if (last === "pf_pin_status") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{ has_treasurer: true, has_master: true }]),
        });
      }
      if (last === "pf_check_pin") {
        const ok =
          (body.kind === "treasurer" && body.pin === "1234") ||
          (body.kind === "master" && body.pin === "999111");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(ok),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
    const data = { ...M.TABLE_DATA, app_settings: settingsNoPins };
    const rows = data[last];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rows === undefined ? [] : rows),
    });
  });
  await vault.route("**/realtime/v1/**", (r) => r.abort());
  await vault.goto(BASE, { waitUntil: "domcontentloaded" });
  await vault.waitForTimeout(1800);

  check("vault/PIN status is read through the RPC", rpcCalls.includes("pf_pin_status"));
  // THE point of the migration: no request ever carries the digits back.
  const served = await vault.evaluate(() => JSON.stringify(window.PowerFund ? {} : {}));
  check(
    "vault/app_settings no longer carries the PINs",
    !("treasurer_pin" in settingsNoPins) && !("master_pin" in settingsNoPins),
    served
  );

  // A PIN exists, so unlocking must ASK rather than offer to create one.
  await vault.locator(".unlock-btn").click();
  await vault.waitForTimeout(400);
  check(
    "vault/an existing PIN is asked for, not re-created",
    /Enter treasurer PIN/i.test(await vault.locator(".modal h3").innerText()),
    await vault.locator(".modal h3").innerText()
  );

  // A wrong PIN is rejected via the RPC, and the app never sees the real one.
  await vault.keyboard.type("0000");
  await vault.locator(".modal-btn-primary").first().click();
  await vault.waitForTimeout(500);
  check(
    "vault/a wrong PIN is refused by the database",
    (await vault.locator(".pin-error").count()) === 1 &&
      bodies.some((b) => b.fn === "pf_check_pin" && b.body.pin === "0000")
  );
  check("vault/still locked", (await vault.locator(".unlock-btn.unlocked").count()) === 0);

  // The right one unlocks.
  await vault.locator(".pin-key", { hasText: "1" }).click();
  await vault.locator(".pin-key", { hasText: "2" }).click();
  await vault.locator(".pin-key", { hasText: "3" }).click();
  await vault.locator(".pin-key", { hasText: "4" }).click();
  await vault.locator(".modal-btn-primary").first().click();
  await vault.waitForTimeout(600);
  check(
    "vault/the correct PIN unlocks treasurer mode",
    (await vault.locator(".unlock-btn.unlocked").count()) === 1
  );
  await vault.close();

  // ---- The dangerous failure: a vault we cannot reach ------------------
  // An unreadable PIN status must NOT read as "no PIN is set", or the app
  // offers to create a treasurer PIN to whoever hit the error.
  const broken = await browser.newPage({ viewport: { width: 430, height: 950 } });
  broken.on("pageerror", (e) => errors.push(`vault: ${e}`));
  await markOnboarded(broken); // routes by hand, so serve() never ran
  await withAuthMode(broken, "off"); // ...so the AUTH_MODE pin is not set either
  await broken.route("**/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const last = url.pathname.split("/").pop();
    if (url.pathname.includes("/rpc/")) {
      // A real error, not a missing function — so no fallback is allowed.
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"message":"boom","code":"XX000"}',
      });
    }
    const rows = { ...M.TABLE_DATA, app_settings: { id: 1 } }[last];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(rows === undefined ? [] : rows),
    });
  });
  await broken.route("**/realtime/v1/**", (r) => r.abort());
  await broken.goto(BASE, { waitUntil: "domcontentloaded" });
  await broken.waitForTimeout(1800);
  // The load fails outright rather than proceeding with a guess.
  check(
    "vault/an unreadable vault fails loudly",
    (await broken.locator(".boot-error").count()) === 1 ||
      (await broken.locator(".save-error-banner").count()) === 1
  );
  check(
    "vault/it never offers to create a new treasurer PIN",
    (await broken.locator(".modal h3", { hasText: "Create a treasurer PIN" }).count()) === 0
  );
  await broken.close();
}

/** Self-service name and photo (migration 009). */
async function profileEditing(browser, errors) {
  // Signed in and linked: Menu offers Edit, and the sheet validates live.
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`profile: ${e}`));
  // Linked as Sarah, not the flagged treasurer: the "You are" card lives in
  // the member branch of the Menu, and a flagged treasurer's login now
  // auto-unlocks past it.
  const members = rosterWithEmails();
  const me = members[1]; // the member this login owns
  const someoneElse = members[0];
  me.auth_user_id = FAKE_USER_ID;
  await serve(page, { ...M.TABLE_DATA, members });
  await withAuthMode(page, "required", { signedIn: true, email: "sarah@example.com" });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(400);
  check(
    "profile/Menu offers Edit on the You-are card",
    (await page.locator(".profile-card-change", { hasText: "Edit" }).count()) === 1
  );
  check(
    "profile/Account also routes there, for a treasurer with no You-are card",
    (await page.locator(".menu-row", { hasText: "Edit my profile" }).count()) === 1
  );

  await page.locator(".profile-card-change", { hasText: "Edit" }).click();
  await page.waitForTimeout(400);
  check("profile/the sheet opens", (await page.locator(".sheet-profile").count()) === 1);
  check(
    "profile/it is prefilled with the current name",
    (await page.locator("#profile-name").inputValue()) === me.name,
    await page.locator("#profile-name").inputValue()
  );
  check(
    "profile/the avatar is the way to the photo sheet",
    (await page.locator(".profile-avatar-btn").count()) === 1
  );

  // Live validation: empty, then a name another member already holds.
  await page.locator("#profile-name").fill("");
  await page.waitForTimeout(200);
  check(
    "profile/an empty name is refused as you type",
    /can't be empty/i.test(await page.locator("#profileNameHint").innerText()) &&
      (await page.locator("#profileSave").isDisabled())
  );
  await page.locator("#profile-name").fill(someoneElse.name);
  await page.waitForTimeout(200);
  check(
    "profile/a name another member holds is refused",
    /already taken/i.test(await page.locator("#profileNameHint").innerText()) &&
      (await page.locator("#profileSave").isDisabled()),
    await page.locator("#profileNameHint").innerText()
  );
  // Its own current name must stay valid — the uniqueness check has to skip
  // the row being edited or Save would never re-enable.
  await page.locator("#profile-name").fill(me.name);
  await page.waitForTimeout(200);
  // The same cap applies on the member's own sheet — one rule, two screens.
  check(
    "profile/the display name carries the same maxlength",
    (await page.locator("#profile-name").getAttribute("maxlength")) === String(NAME_MAX)
  );
  await page.evaluate(() => window.PowerFund.setProfileName("Wednesdayyy"));
  await page.waitForTimeout(250);
  check(
    "profile/an over-long display name is refused",
    /10 characters or fewer/i.test(await page.locator("#profileNameHint").innerText()) &&
      (await page.locator("#profileSave").isDisabled())
  );
  // Put the valid name back — the check below is about the name the member
  // already has, and leaving the over-long one here would fail it for the
  // wrong reason.
  await page.locator("#profile-name").fill(me.name);
  await page.waitForTimeout(250);

  check(
    "profile/your own current name is still valid",
    !(await page.locator("#profileSave").isDisabled()) &&
      /visible to the rest/i.test(await page.locator("#profileNameHint").innerText())
  );

  // The photo sheet, over the top.
  await page.locator(".profile-avatar-btn").click();
  await page.waitForTimeout(400);
  check("profile/the photo sheet opens", (await page.locator(".sheet-photo").count()) === 1);
  check(
    "profile/it offers camera and library",
    (await page.locator(".photo-row", { hasText: "Take Photo" }).count()) === 1 &&
      (await page.locator(".photo-row", { hasText: "Choose from Library" }).count()) === 1
  );
  check(
    "profile/Take Photo asks for the camera",
    (await page
      .locator('.photo-row input[capture="user"]')
      .count()) === 1
  );
  check(
    // Nothing stored and nothing cropped: a Remove button would do nothing.
    "profile/Remove is not offered when there is no photo",
    (await page.locator(".photo-row-danger").count()) === 0
  );
  // Esc must close the sheet on top, not the one underneath.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(
    "profile/Esc closes the photo sheet first",
    (await page.locator(".sheet-photo").count()) === 0 &&
      (await page.locator(".sheet-profile").count()) === 1
  );
  await page.close();

  // A stored photo renders as an image everywhere, not just where it was set.
  const shot = await browser.newPage({ viewport: { width: 430, height: 950 } });
  shot.on("pageerror", (e) => errors.push(`profile: ${e}`));
  const withPhotos = M.MEMBERS.map((m) => ({
    ...m,
    avatar_url: "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=",
  }));
  await serve(shot, { ...M.TABLE_DATA, members: withPhotos });
  await shot.goto(BASE, { waitUntil: "domcontentloaded" });
  await shot.waitForTimeout(1600);
  const roster = await shot.locator(".roster-strip .avatar").count();
  const photos = await shot.locator(".roster-strip .avatar .avatar-img").count();
  check("profile/Home's roster shows photos", roster > 0 && photos === roster, `${photos}/${roster}`);
  // Checked HERE, while Home is still up: .roster-strip is gone once we drill
  // into Members below.
  check(
    "profile/the initial is kept behind the photo",
    (
      await shot
        .locator(".roster-strip .avatar")
        .first()
        .evaluate((el) => (el.textContent || "").trim())
    ).length === 1
  );
  await shot.locator(".roster-strip-all").click();
  await shot.waitForTimeout(400);
  const mRows = await shot.locator(".member-list .avatar").count();
  const mPhotos = await shot.locator(".member-list .avatar .avatar-img").count();
  check("profile/Members shows photos too", mRows > 0 && mPhotos === mRows, `${mPhotos}/${mRows}`);
  await shot.close();

  // Not signed in: the surface is inert rather than half-available.
  const anon = await browser.newPage({ viewport: { width: 430, height: 950 } });
  anon.on("pageerror", (e) => errors.push(`profile: ${e}`));
  await serve(anon, M.TABLE_DATA);
  await anon.addInitScript((id) => {
    try { localStorage.setItem("pf_my_member_id", id); } catch (e) {}
  }, M.MEMBERS[0].id);
  await anon.goto(BASE, { waitUntil: "domcontentloaded" });
  await anon.waitForTimeout(1600);
  await anon.locator(".tab-item", { hasText: "Menu" }).click();
  await anon.waitForTimeout(400);
  check(
    "profile/no Edit without a linked account",
    (await anon.locator(".profile-card-change", { hasText: "Edit" }).count()) === 0 &&
      (await anon.locator(".menu-row", { hasText: "Edit my profile" }).count()) === 0
  );
  // And the exported handler refuses, since hiding a button is not a guard.
  await anon.evaluate(() => window.PowerFund.openProfileModal());
  await anon.waitForTimeout(400);
  check(
    "profile/the handler refuses without a linked account",
    (await anon.locator(".sheet-profile").count()) === 0 &&
      (await anon.locator(".save-error-banner").count()) === 1
  );
  await anon.close();
}

async function memberAccounts(browser, errors) {
  // 1. Required, signed out: the gate, and NOT a single data request.
  const out = await browser.newPage({ viewport: { width: 430, height: 950 } });
  out.on("pageerror", (e) => errors.push(`auth: ${e}`));
  const restCalls = [];
  out.on("request", (r) => {
    if (/\/rest\/v1\//.test(r.url())) restCalls.push(r.url());
  });
  await serve(out, M.TABLE_DATA);
  await withAuthMode(out, "required");
  await out.goto(BASE, { waitUntil: "domcontentloaded" });
  await out.waitForTimeout(2000);
  check("auth/required + signed out shows the sign-in screen", (await out.locator(".signin").count()) === 1);
  check(
    "auth/the gate offers Google",
    /continue with google/i.test(await out.locator(".signin-btn").innerText()),
    await out.locator(".signin-btn").innerText()
  );
  check("auth/no fund UI leaks behind the gate", (await out.locator(".tab-bar").count()) === 0);
  // The whole point of gating the boot: don't ask for money data you have no
  // business reading, and don't paint an error over the sign-in screen.
  check("auth/nothing is fetched while gated", restCalls.length === 0, `${restCalls.length} call(s)`);
  check("auth/no error banner over the gate", (await out.locator(".save-error-banner").count()) === 0);
  await out.close();

  // The gate has no sidebar, so the desktop shell's sidebar gutter must be
  // cancelled or the card sits off-centre. Measured, because the body class
  // that does it is set in render() and an early return once skipped it.
  const wide = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  wide.on("pageerror", (e) => errors.push(`auth: ${e}`));
  await serve(wide, M.TABLE_DATA);
  await withAuthMode(wide, "required");
  await wide.goto(BASE, { waitUntil: "domcontentloaded" });
  await wide.waitForTimeout(2000);
  const box = await wide.locator(".signin-card").boundingBox();
  const offBy = Math.abs(box.x + box.width / 2 - 720);
  check("auth/the gate centres on desktop", offBy <= 2, `off-centre by ${Math.round(offBy)}px`);
  check(
    "auth/the gate never scrolls sideways",
    (await wide.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)) === true
  );
  await wide.close();

  // 2. Required, signed in AND already linked: the app behaves as it always
  //    did. The roster must carry the link — a session against a roster with
  //    no addresses is a dead-end by design (see accountLinking case 4), so
  //    plain fixtures would land on that screen instead of the app.
  const inp = await browser.newPage({ viewport: { width: 430, height: 950 } });
  inp.on("pageerror", (e) => errors.push(`auth: ${e}`));
  await serve(inp, {
    ...M.TABLE_DATA,
    members: rosterWithEmails({ auth_user_id: FAKE_USER_ID }),
  });
  await withAuthMode(inp, "required", { signedIn: true, email: "regine@example.com" });
  await inp.goto(BASE, { waitUntil: "domcontentloaded" });
  await inp.waitForTimeout(2000);
  check("auth/a session gets you the app", (await inp.locator(".signin").count()) === 0);
  check("auth/the fund renders as usual", (await inp.locator(".tab-bar").count()) === 1);
  await inp.locator(".tab-item", { hasText: "Menu" }).click();
  await inp.waitForTimeout(400);
  const acct = inp.locator(".menu-row", { hasText: "Sign out" });
  check("auth/Menu offers sign out", (await acct.count()) === 1);
  check(
    "auth/Menu names the signed-in account",
    (await acct.innerText()).includes("regine@example.com"),
    await acct.innerText()
  );
  await inp.close();

  // 3. Optional, signed out: usable, with a way in. This is the mode the
  //    treasurer deploys first to test Google without gating anyone.
  const opt = await browser.newPage({ viewport: { width: 430, height: 950 } });
  opt.on("pageerror", (e) => errors.push(`auth: ${e}`));
  await serve(opt, M.TABLE_DATA);
  await withAuthMode(opt, "optional");
  await opt.goto(BASE, { waitUntil: "domcontentloaded" });
  await opt.waitForTimeout(2000);
  check("auth/optional never gates the app", (await opt.locator(".signin").count()) === 0);
  check("auth/optional still loads the fund", (await opt.locator(".tab-bar").count()) === 1);
  await opt.locator(".tab-item", { hasText: "Menu" }).click();
  await opt.waitForTimeout(400);
  check(
    "auth/optional offers a way in",
    (await opt.locator(".menu-row", { hasText: "Sign in with Google" }).count()) === 1
  );
  await opt.close();

  // 4. Off (the shipped default): no trace of accounts anywhere.
  const off = await browser.newPage({ viewport: { width: 430, height: 950 } });
  off.on("pageerror", (e) => errors.push(`auth: ${e}`));
  await serve(off, M.TABLE_DATA);
  // Set explicitly rather than leaning on whatever js/config.js currently
  // ships. AUTH_MODE is a deploy-time setting the treasurer changes; a test
  // that reads it is really testing the deployment, not the code.
  await withAuthMode(off, "off");
  await off.goto(BASE, { waitUntil: "domcontentloaded" });
  await off.waitForTimeout(1500);
  await off.locator(".tab-item", { hasText: "Menu" }).click();
  await off.waitForTimeout(400);
  check(
    "auth/off hides accounts entirely",
    (await off.locator(".menu-row", { hasText: "Sign in with Google" }).count()) === 0 &&
      (await off.locator(".menu-row", { hasText: "Sign out" }).count()) === 0
  );
  await off.close();
}

/** Home's "Record a contribution" shortcut must actually reach a confirmation.
 *  A treasurer's cash record and undo confirm INSIDE the Rounds cycle grid, so
 *  picking a member from Home used to close the picker and do nothing at all. */
async function contributePickerFromHome(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  page.on("pageerror", (e) => errors.push(`picker: ${e}`));
  await serve(page, { ...M.TABLE_DATA, app_settings: { ...M.SETTINGS, treasurer_pin: "1234" } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await unlockTreasurer(page);
  await page.waitForTimeout(300);

  const cta = page.locator(".floating-cta button, .home-greet-cta").first();
  check("picker/Home offers the shortcut in treasurer mode", (await cta.count()) === 1);
  await cta.click();
  await page.waitForTimeout(400);
  check("picker/the shortcut opens the member picker", (await page.locator(".picker-list").count()) === 1);

  // An unpaid member: the treasurer's cash path.
  const unpaid = page.locator(".picker-row.unpaid:not([disabled])").first();
  check("picker/an unpaid member is offered", (await unpaid.count()) === 1);
  check(
    "picker/the row says where the tap goes",
    /record as paid/i.test(await unpaid.innerText()),
    await unpaid.innerText()
  );
  await unpaid.click();
  await page.waitForTimeout(600);

  // THE regression: something has to appear, on a screen that can show it.
  check(
    "picker/picking a member reaches the cash confirmation",
    (await page.locator(".mark-paid-panel").count()) === 1
  );
  check(
    "picker/it lands on Rounds, where that panel lives",
    (await page.locator(".rounds-detail, .round").count()) > 0
  );
  const seen = await page.locator(".mark-paid-panel").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  check("picker/the confirmation is scrolled into view", seen === true, String(seen));

  // And it is still a confirmation, not a write: cancelling leaves it unpaid.
  await page.locator(".mark-paid-panel .modal-btn-secondary").click();
  await page.waitForTimeout(300);
  check(
    "picker/cancelling writes nothing",
    (await page.locator(".mark-paid-panel").count()) === 0
  );
  await page.close();
}

/** The desktop shell carries its header actions: Export CSV on Activity,
 *  Reorder payout order on Members, and a titled detail header with
 *  Export round CSV on Rounds. */
async function desktopHeaderActions(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(`head/: ${e}`));
  await serve(page, { ...M.TABLE_DATA, app_settings: { ...M.SETTINGS, treasurer_pin: "1234" } });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Export is TREASURER-ONLY, both directions — the member Menu says exports
  // are only available in treasurer mode and the mobile shell gives a member
  // none, so a desktop member getting one made three surfaces disagree.
  await page.locator(".tab-bar .tab-item", { hasText: "Activity" }).click();
  await page.waitForTimeout(300);
  check(
    "head/Activity hides Export CSV while locked",
    (await page.locator(".view-head .head-action", { hasText: "Export CSV" }).count()) === 0
  );

  await page.locator(".tab-bar .tab-item", { hasText: "Members" }).click();
  await page.waitForTimeout(300);
  check(
    "head/Members hides Reorder while locked",
    (await page.locator(".view-head .head-action").count()) === 0
  );
  await unlockTreasurer(page);
  await page.locator(".tab-bar .tab-item", { hasText: "Activity" }).click();
  await page.waitForTimeout(300);
  check(
    "head/Activity carries Export CSV for the treasurer",
    (await page.locator(".view-head .head-action", { hasText: "Export CSV" }).count()) === 1
  );
  await page.locator(".tab-bar .tab-item", { hasText: "Members" }).click();
  await page.waitForTimeout(300);
  check(
    "head/Members carries Reorder for the treasurer",
    (await page
      .locator(".view-head .head-action", { hasText: "Reorder payout order" })
      .count()) === 1
  );

  await page.locator(".tab-bar .tab-item", { hasText: "Rounds" }).click();
  await page.waitForTimeout(300);
  await page.locator(".rounds-list .round").first().click();
  await page.waitForTimeout(350);
  check(
    "head/Rounds detail names the round",
    /^Round \d+ · /.test(await page.locator(".rounds-detail-title").innerText()),
    await page.locator(".rounds-detail-title").innerText()
  );
  check(
    "head/Rounds detail carries Export round CSV",
    (await page
      .locator(".rounds-detail-head .head-action", { hasText: "Export round CSV" })
      .count()) === 1
  );

  // An export used to give no feedback at all — the file just appeared, or
  // didn't. It now confirms, in the same stack failures use.
  await page.evaluate(() => window.PowerFund.exportCsv());
  await page.waitForTimeout(300);
  check(
    "head/exporting a CSV confirms it saved",
    (await page.locator(".toast-stack .toast .toast-text").count()) === 1 &&
      /saved/i.test(await page.locator(".toast-stack .toast .toast-text").innerText())
  );

  // Names are checked as they are typed, not only on Save — and the check
  // patches the DOM rather than re-rendering, so the field keeps its caret.
  await page.evaluate(() => window.PowerFund.openEditNamesModal());
  await page.waitForTimeout(300);
  const names = page.locator(".edit-names-modal .name-input");
  const first = await names.first().inputValue();
  await names.nth(1).fill(first);
  await page.waitForTimeout(200);
  check(
    "names/a duplicate is called out as you type",
    /unique/i.test(await page.locator("#editNamesError").innerText())
  );
  check(
    "names/Save is disabled while the names are invalid",
    await page.locator("#editNamesSave").isDisabled()
  );
  await names.nth(1).fill("");
  await page.waitForTimeout(200);
  check(
    "names/an empty name is called out too",
    /filled in/i.test(await page.locator("#editNamesError").innerText())
  );
  await names.nth(1).fill(first + " II");
  await page.waitForTimeout(200);
  check(
    "names/valid names clear the error and re-enable Save",
    (await page.locator("#editNamesError").isHidden()) &&
      !(await page.locator("#editNamesSave").isDisabled())
  );

  // A 10-character cap, enforced in the validator and not only by maxlength —
  // the attribute stops a keystroke, it does not stop a paste into a modified
  // field, the exported setter, or a name already on file from before the cap.
  check(
    "names/the field carries the 10-character maxlength",
    (await names.nth(1).getAttribute("maxlength")) === String(NAME_MAX)
  );
  await page.evaluate(
    (args) => window.PowerFund.setEditName(args.id, args.v),
    { id: await names.nth(1).getAttribute("data-member"), v: "Wednesdayyy" }
  );
  await page.waitForTimeout(250);
  check(
    "names/an over-long name is refused and named",
    /too long/i.test(await page.locator("#editNamesError").innerText()) &&
      /Wednesdayyy/.test(await page.locator("#editNamesError").innerText()) &&
      (await page.locator("#editNamesSave").isDisabled())
  );
  await page.evaluate(
    (args) => window.PowerFund.setEditName(args.id, args.v),
    { id: await names.nth(1).getAttribute("data-member"), v: "Wednesday" }
  );
  await page.waitForTimeout(250);
  check(
    "names/exactly 10 characters is allowed",
    (await page.locator("#editNamesError").isHidden()) &&
      !(await page.locator("#editNamesSave").isDisabled())
  );
  await page.close();
}

/** The boot failure screen: no shell, no data, so it must stand on its own
 *  and offer a way back. Console errors are expected here — the app really is
 *  failing to load — so this page's errors are not collected. */
async function bootFailure(browser) {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  // Routes by hand, so serve()'s AUTH_MODE pin never ran. Without this the
  // shipped "required" fronts a sign-in gate and the boot error — the entire
  // subject of this test — never renders.
  await withAuthMode(page, "off");
  await page.route("**/rest/v1/**", (r) => r.abort());
  await page.route("**/realtime/v1/**", (r) => r.abort());
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  check("boot/failure draws the designed screen", (await page.locator(".boot-error").count()) === 1);
  check(
    "boot/failure offers a retry",
    (await page.locator(".boot-error-cta").count()) === 1 &&
      /try again/i.test(await page.locator(".boot-error-cta").innerText())
  );
  // Aborted requests read as a network failure, so the wifi headline is right.
  check(
    "boot/a dead network says so",
    /No connection/i.test(await page.locator(".boot-error-title").innerText()),
    await page.locator(".boot-error-title").innerText()
  );
  await page.close();
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PF_CHROMIUM || undefined,
    args: ["--no-sandbox"],
  });

  // EVERY PAGE GETS ITS OWN CONTEXT, WITH THE SERVICE WORKER BLOCKED.
  //
  // Playwright's page.route() does NOT intercept requests a service worker
  // makes. sw.js installs on the first load and claims the client, so from the
  // second navigation onward every mocked route was silently bypassed and the
  // page fetched the real files instead.
  //
  // That was invisible for as long as the shipped js/config.js happened to
  // match what the tests wanted. The moment AUTH_MODE became "required", a
  // test that reloaded got the real config and met the sign-in gate — which is
  // how this was finally noticed. The service worker is not what these tests
  // are about; the one test that IS about it registers its own.
  //
  // A fresh context per page, not one shared context: pages here rely on their
  // own localStorage (pf_onboarded, pf_my_member_id, the Supabase session), and
  // sharing one would leak identity between checks.
  browser.newPage = async (opts) => {
    const context = await browser.newContext({ ...(opts || {}), serviceWorkers: "block" });
    return context.newPage();
  };

  const errors = [];

  console.log("\nTabs render (mobile shell)");
  await tabsRender(browser, "mobile", { width: 430, height: 900 }, errors, false);
  console.log("\nTabs render (desktop shell)");
  await tabsRender(browser, "desktop", { width: 1440, height: 900 }, errors, true);
  console.log("\nMoney states");
  await moneyStates(browser, errors);
  console.log("\nMotion");
  await reducedMotion(browser);
  console.log("\nRejection & master PIN");
  await rejectionAndMasterPin(browser, errors);
  console.log("\nBreakpoint");
  await breakpointCrossing(browser, errors);
  console.log("\nHome composition");
  await homeComposition(browser, errors);
  console.log("\nMembers & Menu");
  await membersAndMenu(browser, errors);
  console.log("\nActivity & Insights");
  await activityAndInsights(browser, errors);
  console.log("\nFeedback states");
  await feedbackStates(browser, errors);
  console.log("\nDesign gates");
  await designGates(browser, errors);
  console.log("\nQA round 2");
  await qaFixes(browser, errors);
  console.log("\nPayment sheets");
  await paymentSheets(browser, errors);
  console.log("\nMember accounts");
  await memberAccounts(browser, errors);
  console.log("\nAccount linking");
  await signInAdmin(browser, errors);
  await accountLinking(browser, errors);
  console.log("\nOnboarding");
  await ctaGeometry(browser, errors);
  await resubmitBatch(browser, errors);
  await payAttribution(browser, errors);
  await myPayoutQr(browser, errors);
  await unlockVisibility(browser, errors);
  await extraTreasurer(browser, errors);
  await transferRole(browser, errors);
  await paymentSchedule(browser, errors);
  await pinDeadEnds(browser, errors);
  await qaFindings(browser, errors);
  await moneyGate(browser, errors);
  await tabletBand(browser, errors);
  await fundCompleteOrder(browser, errors);
  await polishPass(browser, errors);
  await receiptAck(browser, errors);
  await payoutDispute(browser, errors);
  await cardFamily(browser, errors);
  await swapTurns(browser, errors);
  await releasedRecipient(browser, errors);
  await entryAnimation(browser, errors);
  await signInPrompt(browser, errors);
  await onboarding(browser, errors);
  console.log("\nBackup round-trip");
  await backupRoundTrip(browser, errors);
  console.log("\nSilent refusal");
  await silentRefusal(browser, errors);
  console.log("\nPIN vault");
  await pinVault(browser, errors);
  console.log("\nProfile editing");
  await profileEditing(browser, errors);
  console.log("\nContribute picker");
  await contributePickerFromHome(browser, errors);
  console.log("\nDesktop header actions");
  await desktopHeaderActions(browser, errors);
  console.log("\nBoot failure");
  await bootFailure(browser);

  await browser.close();

  for (const e of errors) check("no console errors", false, e);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE RUN FAILED", e);
  process.exit(1);
});
