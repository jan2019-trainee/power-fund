/* ---------------------------------------------------------------------------
 * Power Fund — the deploy-time config check
 *
 * DELIBERATELY DEPENDENCY-FREE. It imports one local module and node:fs, and
 * nothing from node_modules — so it runs on a machine that has just cloned the
 * repo, which is exactly where somebody stands when they are about to paste a
 * key and deploy.
 *
 * RUN:  node tests/config.test.mjs
 * ------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { b64urlToBytes } from "../supabase/functions/notify-payment/webpush.ts";

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
  }
}

console.log(
  `\n${failed === 0 ? "config looks deployable" : failed + " CHECK(S) FAILED — do not deploy"}`
);
process.exit(failed ? 1 : 0);
