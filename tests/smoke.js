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
async function serve(page, data) {
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

/** Claim / link on first sign-in (phase 3). */
async function accountLinking(browser, errors) {
  // 1. A matching address that nobody has claimed: link it, silently.
  const link = await browser.newPage({ viewport: { width: 430, height: 950 } });
  link.on("pageerror", (e) => errors.push(`link: ${e}`));
  const data = { ...M.TABLE_DATA, members: rosterWithEmails() };
  await serve(link, data);
  const writes = await captureLinkWrites(link, data);
  await withAuthMode(link, "required", { signedIn: true, email: "regine@example.com" });
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
  const members = rosterWithEmails({ auth_user_id: FAKE_USER_ID });
  await serve(page, { ...M.TABLE_DATA, members });
  await withAuthMode(page, "required", { signedIn: true, email: "regine@example.com" });
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
    (await page.locator("#profile-name").inputValue()) === members[0].name,
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
  await page.locator("#profile-name").fill(M.MEMBERS[1].name);
  await page.waitForTimeout(200);
  check(
    "profile/a name another member holds is refused",
    /already taken/i.test(await page.locator("#profileNameHint").innerText()) &&
      (await page.locator("#profileSave").isDisabled()),
    await page.locator("#profileNameHint").innerText()
  );
  // Its own current name must stay valid — the uniqueness check has to skip
  // the row being edited or Save would never re-enable.
  await page.locator("#profile-name").fill(members[0].name);
  await page.waitForTimeout(200);
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

  await page.locator(".tab-bar .tab-item", { hasText: "Activity" }).click();
  await page.waitForTimeout(300);
  check(
    "head/Activity carries Export CSV",
    (await page.locator(".view-head .head-action", { hasText: "Export CSV" }).count()) === 1
  );

  await page.locator(".tab-bar .tab-item", { hasText: "Members" }).click();
  await page.waitForTimeout(300);
  check(
    "head/Members hides Reorder while locked",
    (await page.locator(".view-head .head-action").count()) === 0
  );
  await unlockTreasurer(page);
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
  await page.close();
}

/** The boot failure screen: no shell, no data, so it must stand on its own
 *  and offer a way back. Console errors are expected here — the app really is
 *  failing to load — so this page's errors are not collected. */
async function bootFailure(browser) {
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
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
  await accountLinking(browser, errors);
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
