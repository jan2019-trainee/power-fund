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
const TABS = ["Home", "Rounds", "Members", "Activity", "Insights", "Menu"];

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
async function tabsRender(browser, label, viewport, errors) {
  const page = await browser.newPage({ viewport });
  page.on("console", (m) => {
    // The blocked realtime socket is expected when running offline.
    if (m.type() === "error" && !/WebSocket|ERR_TUNNEL/.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  await serve(page, M.TABLE_DATA);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  for (const tab of TABS) {
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
  await page.locator(".tab-item", { hasText: "Menu" }).click();
  await page.waitForTimeout(250);
  const rows = await page.locator(".menu-row").count();
  const danger = await page.locator(".danger-zone").count();
  check(`${label}/treasurer settings`, rows === 6 && danger === 1, `rows=${rows} danger=${danger}`);

  await page.locator(".tab-item", { hasText: "Home" }).click();
  await page.waitForTimeout(250);
  const attention = await page.locator(".attention-panel").count();
  check(`${label}/attention panel`, attention === 1, `panels=${attention}`);

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

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PF_CHROMIUM || undefined,
    args: ["--no-sandbox"],
  });
  const errors = [];

  console.log("\nTabs render (mobile shell)");
  await tabsRender(browser, "mobile", { width: 430, height: 900 }, errors);
  console.log("\nTabs render (desktop shell)");
  await tabsRender(browser, "desktop", { width: 1440, height: 900 }, errors);
  console.log("\nMoney states");
  await moneyStates(browser, errors);
  console.log("\nMotion");
  await reducedMotion(browser);

  await browser.close();

  for (const e of errors) check("no console errors", false, e);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE RUN FAILED", e);
  process.exit(1);
});
