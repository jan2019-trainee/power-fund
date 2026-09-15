/* ---------------------------------------------------------------------------
 * Power Fund — Web Push crypto
 *
 * supabase/functions/notify-payment/webpush.ts implements RFC 8291 (aes128gcm)
 * and RFC 8292 (VAPID) on WebCrypto, with no dependencies. This checks that
 * assembly against INDEPENDENT implementations rather than against itself:
 *
 *   * `http_ece` — the library `web-push` itself encrypts with. Given the same
 *     salt and the same ephemeral key pair, the bodies must match BYTE FOR
 *     BYTE, which pins every step of the derivation, not just the result.
 *   * the same library DECRYPTING our output with the subscriber's private
 *     key, which is precisely what the browser does. A round trip against our
 *     own code could not catch a shared misreading of the spec; this can.
 *   * the VAPID JWT verified with WebCrypto's own `verify` against the public
 *     key, plus its claims read back.
 *
 * Both are devDependencies and TEST ORACLES ONLY — the deployed function
 * imports nothing at all.
 *
 * RUN:  node tests/webpush.test.mjs
 * ------------------------------------------------------------------------- */
import crypto from "node:crypto";
import ece from "http_ece";
import { readFileSync } from "node:fs";
import {
  encryptPayload,
  vapidAuthHeader,
  generateServerKeys,
  b64urlToBytes,
  bytesToB64url,
} from "../supabase/functions/notify-payment/webpush.ts";

let failed = 0;
function check(name, pass, detail) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const b64 = (b) => Buffer.from(b).toString("base64url");

/** A subscriber, as a browser would produce one. */
function makeSubscription() {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  return {
    p256dh: b64(ua.getPublicKey()),
    auth: b64(crypto.randomBytes(16)),
    privateKey: ua.getPrivateKey(),
    publicKey: ua.getPublicKey(),
  };
}

/** A FIXED ephemeral pair, in both shapes: a Node ECDH for the oracle and a
 *  WebCrypto key for our code. Encryption is randomised by design, so pinning
 *  this is the only way to ask two implementations for the same bytes. */
async function fixedServerKeys() {
  const node = crypto.createECDH("prime256v1");
  node.generateKeys();
  const pub = node.getPublicKey(); // 0x04 | x | y
  const web = await crypto.webcrypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64(pub.subarray(1, 33)),
      y: b64(pub.subarray(33, 65)),
      d: b64(node.getPrivateKey()),
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  return { node, web: { privateKey: web, publicKey: new Uint8Array(pub) } };
}

console.log("Web Push — message encryption (RFC 8291)");

const PLAINTEXT = JSON.stringify({
  title: "Power Fund",
  body: "Regine sent ₱6,000 — cycles 7–12",
});

{
  const sub = makeSubscription();
  const keys = await fixedServerKeys();
  const salt = crypto.randomBytes(16);

  const ours = await encryptPayload(PLAINTEXT, sub.p256dh, sub.auth, {
    salt: new Uint8Array(salt),
    serverKeys: keys.web,
  });
  const theirs = ece.encrypt(Buffer.from(PLAINTEXT, "utf8"), {
    version: "aes128gcm",
    salt,
    privateKey: keys.node,
    dh: sub.publicKey,
    authSecret: Buffer.from(sub.auth, "base64url"),
    rs: 4096,
  });

  check(
    "our ciphertext is byte-identical to http_ece's",
    Buffer.from(ours).equals(theirs),
    `ours=${ours.length}B theirs=${theirs.length}B`
  );

  // The header layout is what a push service and the browser both parse.
  const view = new DataView(ours.buffer, ours.byteOffset, ours.byteLength);
  check("the header carries the salt", Buffer.from(ours.subarray(0, 16)).equals(salt));
  check("...the record size, big-endian", view.getUint32(16, false) === 4096);
  check("...and the ephemeral public key as the keyid", ours[20] === 65 &&
    Buffer.from(ours.subarray(21, 86)).equals(keys.node.getPublicKey()));
}

{
  // THE ONE THAT MATTERS: an independent implementation decrypting our output
  // with the subscriber's private key. This is what the browser does, and it
  // is the only check here that a shared misreading of the spec cannot pass.
  const sub = makeSubscription();
  const body = await encryptPayload(PLAINTEXT, sub.p256dh, sub.auth);
  const ua = crypto.createECDH("prime256v1");
  ua.setPrivateKey(sub.privateKey);
  let decrypted = null;
  try {
    decrypted = ece.decrypt(Buffer.from(body), {
      version: "aes128gcm",
      privateKey: ua,
      authSecret: Buffer.from(sub.auth, "base64url"),
    });
  } catch (e) {
    decrypted = Buffer.from("<<" + e.message + ">>");
  }
  check(
    "a browser can decrypt what we send (round trip, random salt and key)",
    decrypted.toString("utf8") === PLAINTEXT,
    decrypted.toString("utf8").slice(0, 60)
  );
}

{
  // Every message gets a fresh ephemeral key and salt. Reusing either would
  // let a push service correlate messages, and buys nothing.
  const sub = makeSubscription();
  const a = await encryptPayload("x", sub.p256dh, sub.auth);
  const b = await encryptPayload("x", sub.p256dh, sub.auth);
  check(
    "the same payload encrypts differently every time",
    !Buffer.from(a).equals(Buffer.from(b)) &&
      !Buffer.from(a.subarray(21, 86)).equals(Buffer.from(b.subarray(21, 86)))
  );
}

{
  const sub = makeSubscription();
  // A UTF-8 payload must not be measured in characters. The peso sign and the
  // en dash above are 3 bytes each; a length check written against .length
  // would pass here and truncate on a real phone.
  const body = await encryptPayload(PLAINTEXT, sub.p256dh, sub.auth);
  const expected = Buffer.byteLength(PLAINTEXT, "utf8") + 1 + 16 + 86;
  check("the body length accounts for UTF-8 bytes, the delimiter and the tag",
    body.length === expected, `${body.length} vs ${expected}`);
}

{
  let msg = "";
  try {
    await encryptPayload("x", bytesToB64url(new Uint8Array(32)), bytesToB64url(new Uint8Array(16)));
  } catch (e) {
    msg = e.message;
  }
  check("a malformed subscription key is refused, not sent", /65-byte/.test(msg), msg);
}

console.log("\nWeb Push — the key this fund actually ships");

{
  // THE GUARD THAT WAS MISSING. A VAPID public key is a 65-byte uncompressed
  // P-256 point in base64url: 87 characters, always starting with "B" (the
  // 0x04 prefix). A 64-character hex string is 32 bytes — the size of a
  // PRIVATE key — and every character of hex is also a valid base64url
  // character, so it decodes without complaint to 48 bytes of nonsense and
  // only fails much later, inside pushManager.subscribe() on a real phone.
  //
  // Empty is a legitimate state and passes: it means this fund has not been
  // set up for notifications yet, which the app says in so many words.
  const src = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
  const m = /PUSH_PUBLIC_KEY:\s*"([^"]*)"/.exec(src);
  check("js/config.js declares PUSH_PUBLIC_KEY", !!m);
  const key = m ? m[1] : null;

  if (key === "") {
    check("...it is empty, i.e. notifications are not configured yet", true);
  } else {
    let bytes = null;
    try {
      bytes = b64urlToBytes(key);
    } catch {
      bytes = null;
    }
    check(
      "...and it is a real 65-byte P-256 public key, not a private key or a hex blob",
      key.length === 87 && key[0] === "B" && bytes && bytes.length === 65 && bytes[0] === 0x04,
      `${key.length} chars, ${bytes ? bytes.length : "?"} bytes, starts "${key.slice(0, 1)}"`
    );
    // If it is the private half, it is 32 bytes and must be rotated, not edited.
    check(
      "...and is NOT 32 bytes, which would mean the PRIVATE half was pasted",
      !bytes || bytes.length !== 32
    );
  }
}

console.log("\nWeb Push — VAPID (RFC 8292)");

{
  const vapid = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const raw = vapid.publicKey.export({ type: "spki", format: "der" });
  const publicKey = b64(raw.subarray(raw.length - 65)); // uncompressed point
  const jwk = vapid.privateKey.export({ format: "jwk" });
  const privateKey = jwk.d;

  const endpoint = "https://fcm.googleapis.com/fcm/send/abc123?x=1";
  const now = 1_700_000_000;
  const header = await vapidAuthHeader(endpoint, publicKey, privateKey, "mailto:t@example.com", now);

  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  check("the header is `vapid t=<jwt>, k=<public key>`", !!m, header.slice(0, 40));
  const [jwtHead, jwtBody, jwtSig] = m[1].split(".");
  check("...carrying the SAME public key the subscription was made with",
    m[2] === publicKey);

  const claims = JSON.parse(Buffer.from(jwtBody, "base64url").toString());
  // The audience is the push service's ORIGIN. Sending the full endpoint is a
  // common mistake and the service rejects it.
  check("aud is the endpoint's ORIGIN, not the endpoint",
    claims.aud === "https://fcm.googleapis.com", claims.aud);
  check("exp is 12 hours out, inside the spec's 24-hour cap",
    claims.exp === now + 12 * 3600 && claims.exp - now <= 24 * 3600);
  check("sub carries the contact", claims.sub === "mailto:t@example.com");
  check("alg is ES256", JSON.parse(Buffer.from(jwtHead, "base64url").toString()).alg === "ES256");

  // Verified against the PUBLIC key with an independent primitive — the thing
  // the push service itself does before accepting the request.
  const pubKey = await crypto.webcrypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToB64url(b64urlToBytes(publicKey).slice(1, 33)),
      y: bytesToB64url(b64urlToBytes(publicKey).slice(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pubKey,
    b64urlToBytes(jwtSig),
    new TextEncoder().encode(`${jwtHead}.${jwtBody}`)
  );
  check("the signature verifies against the public key", ok === true);
  check("the signature is raw r||s, not DER", b64urlToBytes(jwtSig).length === 64);

  // A token minted for one endpoint is reused for every endpoint on the same
  // service, which is why aud is the origin — and must NOT be reused across
  // services.
  const other = await vapidAuthHeader(
    "https://updates.push.services.mozilla.com/wpush/v2/xyz",
    publicKey, privateKey, "mailto:t@example.com", now
  );
  const otherAud = JSON.parse(
    Buffer.from(other.split(".")[1], "base64url").toString()
  ).aud;
  check("a different push service gets a different audience",
    otherAud === "https://updates.push.services.mozilla.com", otherAud);

  let badMsg = "";
  try {
    await vapidAuthHeader(endpoint, publicKey, b64(crypto.randomBytes(31)), "mailto:t@e.com", now);
  } catch (e) {
    badMsg = e.message;
  }
  check("a malformed VAPID private key is refused", /32 bytes/.test(badMsg), badMsg);
}

console.log(`\n${failed === 0 ? "all Web Push crypto checks passed" : failed + " CHECK(S) FAILED"}`);
process.exit(failed ? 1 : 0);
