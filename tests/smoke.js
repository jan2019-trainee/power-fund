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
    const caught = await page.locator(".attention-panel.caught-up").count();
    const done = await page.locator(".battery-hero.fund-complete").count();
    check(
      `state: ${name}`,
      caught === expect.caught && done === expect.complete,
      `caughtUp=${caught} fundComplete=${done}`
    );
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

  await browser.close();

  for (const e of errors) check("no console errors", false, e);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE RUN FAILED", e);
  process.exit(1);
});
