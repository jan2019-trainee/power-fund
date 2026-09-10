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

function uuid(n) {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

// --- Scenarios -------------------------------------------------------------
// Each is a complete Supabase snapshot. Named for the situation a reviewer
// needs to judge, not for the data that produces it.

const SETTINGS = {
  ...M.SETTINGS,
  treasurer_pin: PIN,
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

async function open(browser, data, viewport, member) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/realtime|websocket/i.test(m.text())) {
      errors.push(`console: ${m.text()}`);
    }
  });
  await serve(page, data);
  await page.addInitScript((id) => {
    if (id) window.localStorage.setItem("pf_my_member_id", id);
    else window.localStorage.removeItem("pf_my_member_id");
  }, member || "");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1700);
  return page;
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
  const paidChip = p.locator(".member-chip.paid").first();
  if (await paidChip.count()) {
    await paidChip.click();
    await p.waitForTimeout(500);
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
