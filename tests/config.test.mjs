/* ---------------------------------------------------------------------------
 * Power Fund — the deploy-time config check
 *
 * DELIBERATELY DEPENDENCY-FREE, AND VERSION-FREE. It imports node:fs and
 * nothing else — no node_modules, and no .ts module, because Node only strips
 * types from 22.6 onward and the person about to paste a key and deploy runs
 * whatever Node they happen to have. (Reported from a real machine on v18.)
 *
 * RUN:  node tests/config.test.mjs
 * ------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

/* Node's own base64url decoder, NOT the Edge Function's — importing that would
 * pull in a .ts file, and Node only strips types from 22.6 onward. This check
 * has to run on whatever Node the person deploying happens to have. */
const b64urlToBytes = (s) => new Uint8Array(Buffer.from(s, "base64url"));

let failed = 0;
function check(name, pass, detail) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

console.log("js/config.js — the VAPID key this fund ships");
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
    // THE REAL CHECK. Length and prefix would accept 65 random bytes starting
    // 0x04 — a paste that dropped or gained a character can still look right.
    // Importing it is the only way to know it is a point ON the curve, and it
    // is what the browser does before it will subscribe.
    let onCurve = false;
    try {
      await webcrypto.subtle.importKey(
        "raw", bytes, { name: "ECDH", namedCurve: "P-256" }, false, []
      );
      onCurve = true;
    } catch (e) {
      onCurve = e.message;
    }
    check(
      "...and is a real point on the P-256 curve, not 65 plausible bytes",
      onCurve === true,
      onCurve === true ? "" : String(onCurve)
    );
  }
}

console.log(
  `\n${failed === 0 ? "config looks deployable" : failed + " CHECK(S) FAILED — do not deploy"}`
);
process.exit(failed ? 1 : 0);
