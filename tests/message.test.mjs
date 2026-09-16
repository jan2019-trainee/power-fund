/* What the treasurer's lock screen says. The rule under test is the one the
 * database went to trouble for: ONE NOTIFICATION PER TRANSFER. */
/* These import the Edge Function's .ts modules directly, which needs Node's
 * native type stripping (22.6+). Without this guard Node fails with a bare
 * ERR_UNKNOWN_FILE_EXTENSION that names no version and no remedy. */
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(
    `This suite imports TypeScript directly and needs Node 22+ — you are on ` +
      `${process.versions.node}.\n\n` +
      `  node tests/config.test.mjs   is the pre-deploy check and runs on any Node.\n`
  );
  process.exit(2);
}

// Dynamic, after the guard: a static import is hoisted past it.
const { composeNotification, cycleLabel, peso } =
  await import("../supabase/functions/notify-payment/message.ts");

let failed = 0;
function check(name, pass, detail) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const SARAH = "11111111-0000-0000-0000-000000000002";
const REGINE = "11111111-0000-0000-0000-000000000001";
const NAMES = { [SARAH]: "Sarah", [REGINE]: "Regine" };
const row = (cycle, member = SARAH, amount = 1000) => ({
  id: "r" + cycle, txid: 1, event_type: "payment_pending",
  member_id: member, cycle_number: cycle, amount,
});

console.log("Notification text");

check("one cycle reads as one cycle",
  composeNotification([row(7)], NAMES).body === "Sarah sent ₱1,000 — cycle 7",
  composeNotification([row(7)], NAMES).body);

// The whole point of the outbox: six rows, one sentence.
const six = [7, 8, 9, 10, 11, 12].map((c) => row(c));
check("a six-cycle transfer is ONE sentence, with the total",
  composeNotification(six, NAMES).body === "Sarah sent ₱6,000 — cycles 7–12",
  composeNotification(six, NAMES).body);

check("non-contiguous cycles are counted, not mis-stated as a range",
  composeNotification([row(7), row(9), row(11)], NAMES).body ===
    "Sarah sent ₱3,000 — 3 cycles",
  composeNotification([row(7), row(9), row(11)], NAMES).body);

check("the tag is per member, so two people do not collapse into one notice",
  composeNotification(six, NAMES).tag === `pf-payment-${SARAH}` &&
    composeNotification([row(3, REGINE)], NAMES).tag === `pf-payment-${REGINE}`);

// The app has no routing, so a deep link would reload at Home and look broken.
check("the url stays '/' because the app has no routing",
  composeNotification(six, NAMES).url === "/");

// THE TITLE IS THE EVENT, NOT THE APP. iOS prints its own "from <app name>"
// line under the title, so a title of "Power Fund" read as "Power Fund / from
// Power Fund" on a real lock screen — the boldest line spent on a fact the
// reader already had. Reported from a phone, not caught by any check.
check("the title says what to DO, and never repeats the app name",
  composeNotification(six, NAMES).title === "Payment to review" &&
    !/Power Fund/i.test(composeNotification(six, NAMES).title),
  composeNotification(six, NAMES).title);
check("...and the multi-member title too",
  !/Power Fund/i.test(composeNotification([row(7), row(7, REGINE)], NAMES).title),
  composeNotification([row(7), row(7, REGINE)], NAMES).title);

check("an unknown member reads as 'A member', never as an id",
  composeNotification([row(7, "unknown-id")], NAMES).body.startsWith("A member sent"),
  composeNotification([row(7, "unknown-id")], NAMES).body);

// userVisibleOnly means every push MUST show something — so the caller has to
// know when there is nothing to say, rather than be handed a made-up notice.
check("nothing to say returns null rather than inventing a notice",
  composeNotification([], NAMES) === null &&
    composeNotification([{ ...row(7), event_type: "something_else" }], NAMES) === null);

check("several members in one transaction do not claim to be one person",
  /2 members sent/.test(composeNotification([row(7), row(7, REGINE)], NAMES).body),
  composeNotification([row(7), row(7, REGINE)], NAMES).body);

console.log("\nFormatting");
check("pesos are whole and separated, as the artboards write them",
  peso(30000) === "₱30,000" && peso(1000) === "₱1,000", peso(30000));
check("cycle labels", cycleLabel([5]) === "cycle 5" &&
  cycleLabel([1, 2, 3]) === "cycles 1–3" && cycleLabel([]) === "");
// Rows can arrive in any order — the trigger fires per row and the claim does
// not order them.
check("an out-of-order batch still reads as a range",
  cycleLabel([12, 8, 10, 7, 11, 9]) === "cycles 7–12", cycleLabel([12, 8, 10, 7, 11, 9]));

console.log(`\n${failed === 0 ? "all notification text checks passed" : failed + " CHECK(S) FAILED"}`);
process.exit(failed ? 1 : 0);
