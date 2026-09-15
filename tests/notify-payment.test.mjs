/* ---------------------------------------------------------------------------
 * Power Fund — the notify-payment Edge Function
 *
 * Exercises the real handler under Node with Deno's two globals shimmed and
 * `fetch` pointed at an in-memory PostgREST and push service. The happy path
 * goes all the way: outbox rows in, and an INDEPENDENT DECRYPT of what was
 * actually POSTed to the push service out — so the assertion is the sentence
 * the treasurer would read on their lock screen, not an intermediate.
 *
 * WHAT THIS CANNOT CHECK, said plainly: the fake answers PostgREST's URL
 * syntax rather than being PostgREST. It proves the handler's logic and makes
 * every query string it builds visible (they are asserted below), but a
 * malformed filter that this fake happens to understand and the real thing
 * rejects would pass here. The first deploy is still the first real test of
 * those strings.
 *
 * RUN:  node tests/notify-payment.test.mjs
 * ------------------------------------------------------------------------- */
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

import crypto from "node:crypto";
import ece from "http_ece";

let failed = 0;
function check(name, pass, detail) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const b64 = (b) => Buffer.from(b).toString("base64url");
const SUPA = "https://proj.supabase.co";
const SECRET = "a-long-shared-secret";

// A real VAPID pair and a real subscription — the crypto is not stubbed.
const vapidKp = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const vapidDer = vapidKp.publicKey.export({ type: "spki", format: "der" });
const VAPID_PUBLIC = b64(vapidDer.subarray(vapidDer.length - 65));
const VAPID_PRIVATE = vapidKp.privateKey.export({ format: "jwk" }).d;

function makeDevice(endpoint) {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  return {
    endpoint,
    p256dh: b64(ua.getPublicKey()),
    auth: b64(crypto.randomBytes(16)),
    privateKey: ua.getPrivateKey(),
  };
}

const ENV = {
  SUPABASE_URL: SUPA,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  PF_PUSH_SECRET: SECRET,
  VAPID_PUBLIC_KEY: VAPID_PUBLIC,
  VAPID_PRIVATE_KEY: VAPID_PRIVATE,
  VAPID_SUBJECT: "mailto:treasurer@example.com",
};
// No `serve`, so importing the module does not start a server.
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const TRE = "11111111-0000-0000-0000-000000000001"; // Regine, flagged treasurer
const MEM = "11111111-0000-0000-0000-000000000002"; // Sarah, the payer

/** State for one scenario, plus the recording fetch that serves it. */
function scenario({ outbox, members, subs, pushStatus = 201 }) {
  const state = {
    outbox: outbox.map((r) => ({ ...r })),
    members: members.map((m) => ({ ...m })),
    subs: subs.map((s) => ({ ...s })),
    restUrls: [],
    pushes: [],
    deleted: [],
    patched: [],
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (!u.startsWith(SUPA)) {
      state.pushes.push({ url: u, headers: init.headers, body: init.body });
      const s = typeof pushStatus === "function" ? pushStatus(u) : pushStatus;
      return new Response(s >= 400 ? "gone" : "", { status: s });
    }
    const q = u.slice(`${SUPA}/rest/v1/`.length);
    state.restUrls.push(`${method} ${q}`);
    const [table, query = ""] = q.split("?");
    const body = init.body ? JSON.parse(init.body) : null;

    if (table === "push_outbox" && method === "PATCH" && query.includes("sent_at=is.null")) {
      const txid = /txid=eq\.(\d+)/.exec(query)[1];
      const hit = state.outbox.filter((r) => String(r.txid) === txid && r.sent_at == null);
      hit.forEach((r) => Object.assign(r, body));
      return Response.json(hit);
    }
    if (table === "push_outbox" && method === "PATCH") {
      state.patched.push(body);
      return Response.json([]);
    }
    if (table === "members") {
      const ids = (/id\.in\.\(([^)]*)\)/.exec(query) || [, ""])[1].split(",").filter(Boolean);
      return Response.json(
        state.members
          .filter((m) => m.is_treasurer || ids.includes(m.id))
          .map(({ id, name, is_treasurer }) => ({ id, name, is_treasurer }))
      );
    }
    if (table === "push_subscriptions" && method === "GET") {
      const ids = (/member_id=in\.\(([^)]*)\)/.exec(query) || [, ""])[1].split(",").filter(Boolean);
      return Response.json(
        state.subs.filter((s) => ids.includes(s.member_id))
          .map(({ id, member_id, endpoint, p256dh, auth }) => ({ id, member_id, endpoint, p256dh, auth }))
      );
    }
    if (table === "push_subscriptions" && method === "DELETE") {
      state.deleted.push(/id=eq\.([^&]+)/.exec(query)[1]);
      return new Response(null, { status: 204 });
    }
    if (table === "push_subscriptions" && method === "PATCH") {
      return Response.json([]);
    }
    return new Response("unhandled", { status: 500 });
  };
  return state;
}

const { handle } = await import("../supabase/functions/notify-payment/index.ts");

const post = (txid, secret = SECRET) =>
  new Request("https://fn/notify-payment", {
    method: "POST",
    headers: { "x-pf-push-secret": secret, "Content-Type": "application/json" },
    body: JSON.stringify({ txid: String(txid) }),
  });

const outboxRows = (cycles, member = MEM, txid = 42) =>
  cycles.map((c, i) => ({
    id: `out-${i}`, txid, event_type: "payment_pending",
    member_id: member, cycle_number: c,
    // PostgREST hands numeric back as a STRING; the real thing does too.
    amount: "1000.00", sent_at: null, last_error: null,
  }));

const ROSTER = [
  { id: TRE, name: "Regine", is_treasurer: true },
  { id: MEM, name: "Sarah", is_treasurer: false },
];

console.log("notify-payment — the gate");
{
  scenario({ outbox: [], members: ROSTER, subs: [] });
  check("GET is refused", (await handle(new Request("https://fn/x"))).status === 405);
  check("a wrong secret is refused", (await handle(post(42, "nope"))).status === 403);
  const noHeader = new Request("https://fn/x", { method: "POST", body: "{}" });
  check("a missing secret is refused", (await handle(noHeader)).status === 403);
  check("a non-numeric txid is refused",
    (await handle(post("1; drop table"))).status === 400);
}
{
  // A misconfigured deploy must not become an open relay onto the treasurer's
  // phone, so an unset secret fails CLOSED rather than waving everything past.
  ENV.PF_PUSH_SECRET = "";
  scenario({ outbox: [], members: ROSTER, subs: [] });
  check("an UNSET secret refuses everything, rather than allowing it",
    (await handle(post(42, ""))).status === 403);
  ENV.PF_PUSH_SECRET = SECRET;
}

console.log("\nnotify-payment — the happy path");
{
  const device = makeDevice("https://push.example/ep-treasurer");
  const st = scenario({
    outbox: outboxRows([7, 8, 9, 10, 11, 12]),
    members: ROSTER,
    subs: [{ id: "sub-1", member_id: TRE, ...device }],
  });
  const res = await handle(post(42));
  const out = await res.json();
  check("it claims the whole transaction and sends once",
    out.claimed === 6 && out.sent === 1 && st.pushes.length === 1,
    JSON.stringify(out));

  const push = st.pushes[0];
  check("...to the TREASURER's device, not the payer's",
    push.url === "https://push.example/ep-treasurer");
  check("...with the aes128gcm content encoding",
    push.headers["Content-Encoding"] === "aes128gcm");
  check("...and a VAPID Authorization carrying our public key",
    /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(push.headers.Authorization) &&
      push.headers.Authorization.endsWith(VAPID_PUBLIC));
  check("...and a TTL, so a phone that was off still gets it",
    push.headers.TTL === "86400");

  // THE ONE THAT MATTERS: decrypt what was actually sent, the way the browser
  // will, and read the sentence off it.
  const ua = crypto.createECDH("prime256v1");
  ua.setPrivateKey(device.privateKey);
  const plain = ece.decrypt(Buffer.from(push.body), {
    version: "aes128gcm", privateKey: ua,
    authSecret: Buffer.from(device.auth, "base64url"),
  });
  const note = JSON.parse(plain.toString("utf8"));
  check("the treasurer's lock screen reads the whole transfer, once",
    note.body === "Sarah sent ₱6,000 — cycles 7–12", note.body);
  check("...titled Power Fund, opening the app",
    note.title === "Power Fund" && note.url === "/");

  // Visible for review even though this fake is not PostgREST.
  check("it claims with sent_at is null, which is what makes it atomic",
    st.restUrls[0] === "PATCH push_outbox?txid=eq.42&sent_at=is.null", st.restUrls[0]);
}
{
  // A duplicate delivery — pg_net retrying, or a replayed call — must not
  // buzz the phone twice.
  const device = makeDevice("https://push.example/ep");
  const rows = outboxRows([7]);
  rows[0].sent_at = "2026-01-01T00:00:00Z"; // already claimed
  const st = scenario({ outbox: rows, members: ROSTER, subs: [{ id: "s", member_id: TRE, ...device }] });
  const out = await (await handle(post(42))).json();
  check("a second delivery of the same txid sends nothing",
    out.claimed === 0 && st.pushes.length === 0, JSON.stringify(out));
}

console.log("\nnotify-payment — when there is nobody to tell");
{
  const st = scenario({ outbox: outboxRows([7]), members: [{ ...ROSTER[1] }], subs: [] });
  const out = await (await handle(post(42))).json();
  check("no treasurer flagged: nothing sent, and the outbox says why",
    out.sent === 0 && /no treasurer/i.test(st.patched[0]?.last_error || ""),
    JSON.stringify(st.patched));
}
{
  const st = scenario({ outbox: outboxRows([7]), members: ROSTER, subs: [] });
  const out = await (await handle(post(42))).json();
  check("no device registered: nothing sent, and the outbox says why",
    out.sent === 0 && /no device/i.test(st.patched[0]?.last_error || ""),
    JSON.stringify(st.patched));
}

console.log("\nnotify-payment — dead subscriptions");
{
  const device = makeDevice("https://push.example/gone");
  const st = scenario({
    outbox: outboxRows([7]), members: ROSTER,
    subs: [{ id: "sub-dead", member_id: TRE, ...device }],
    pushStatus: 410,
  });
  const out = await (await handle(post(42))).json();
  // 410 Gone is the push service saying the browser is never coming back.
  // Left in place it would be pushed to forever, and the member would see
  // "on" for a device that no longer exists.
  check("a 410 prunes the subscription", st.deleted.includes("sub-dead"), JSON.stringify(st.deleted));
  check("...and the run reports it rather than claiming success",
    out.sent === 0 && /410/.test(out.errors.join(" ")), JSON.stringify(out.errors));
}
{
  const good = makeDevice("https://push.example/good");
  const dead = makeDevice("https://push.example/dead-404");
  const st = scenario({
    outbox: outboxRows([7]), members: ROSTER,
    subs: [
      { id: "sub-dead", member_id: TRE, ...dead },
      { id: "sub-good", member_id: TRE, ...good },
    ],
    pushStatus: (u) => (u.includes("dead-404") ? 404 : 201),
  });
  const out = await (await handle(post(42))).json();
  check("one dead device does not stop the others",
    out.sent === 1 && st.deleted.includes("sub-dead") && st.pushes.length === 2,
    JSON.stringify(out));
}

console.log(`\n${failed === 0 ? "all notify-payment checks passed" : failed + " CHECK(S) FAILED"}`);
process.exit(failed ? 1 : 0);
