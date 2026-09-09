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

/** Serve one fixed dataset for every table the app asks for. */
async function serve(page, data) {
  await page.route("**/rest/v1/**", (route) => {
    const table = new URL(route.request().url()).pathname.split("/").pop();
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
  if (await page.locator(".modal-overlay").count()) {
    await page.keyboard.type("1234");
    const confirm = page.locator(".modal-btn-primary").first();
    if (await confirm.count()) {
      await confirm.click();
      await page.waitForTimeout(600);
    }
  }
}

/** Every tab renders its own content, with the shared chrome, in both shells. */
async function tabsRender(browser, label, viewport, errors, wide) {
  const page = await browser.newPage({ viewport });
  page.on("console", (m) => {
    // The blocked realtime socket is expected when running offline.
    if (m.type() === "error" && !/WebSocket|ERR_TUNNEL/.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  await serve(page, M.TABLE_DATA);
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
  const rejected = {
    ...M.TABLE_DATA,
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
    "rejection: chip marked in Rounds",
    (await page.locator(".member-chip.rejected").count()) >= 1
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
  check(
    "members/desktop: empty pane explains itself",
    (await wide.locator(".members-detail-empty").count()) === 1
  );
  await wide.locator(".member-row").nth(1).click();
  await wide.waitForTimeout(300);
  check(
    "members/desktop: picking fills the pane",
    (await wide.locator(".members-detail .detail-name").count()) === 1 &&
      (await wide.locator(".members-detail .round-line").count()) > 0
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
    "menu/member: view-only QR + payout destination",
    /the treasurer manages this/i.test(memText) && /payout destination/i.test(memText)
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
    "p7/status chips shown",
    /Pending review/i.test(chips) && /Rejected/i.test(chips),
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
  check(
    "qa/a rejected member is visible on Home",
    (await chips.locator(".mini-chip.rejected").count()) >= 1,
    `rejected=${await chips.locator(".mini-chip.rejected").count()}`
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

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PF_CHROMIUM || undefined,
    args: ["--no-sandbox"],
  });
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

  await browser.close();

  for (const e of errors) check("no console errors", false, e);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE RUN FAILED", e);
  process.exit(1);
});
