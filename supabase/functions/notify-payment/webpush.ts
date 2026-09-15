/* ---------------------------------------------------------------------------
 * Web Push, on WebCrypto alone
 *
 * RFC 8291 (aes128gcm message encryption) + RFC 8292 (VAPID), with NO
 * dependencies at all — not `npm:web-push`, not a Deno third-party module.
 *
 * WHY NOT npm:web-push. It is the obvious choice and it was rejected for two
 * reasons, in this order:
 *
 *   1. It is built on Node's `crypto` (createECDH, createHmac). On Supabase
 *      Edge Functions that runs through Deno's Node-compatibility layer, and
 *      nothing in this repo's toolchain can verify that it works — there is no
 *      Deno here. WebCrypto is native to Deno AND to Node, so what the tests
 *      run is the same code that deploys.
 *   2. This is the path that carries a member's payment into somebody's
 *      lock screen. Zero imports is zero supply chain.
 *
 * It is NOT hand-rolled crypto: every primitive is WebCrypto's (ECDH, HKDF,
 * AES-GCM, ECDSA). What this file owns is the assembly, and
 * `tests/webpush.test.mjs` checks that assembly against the `web-push` and
 * `http_ece` libraries byte for byte — including decrypting its output with
 * an independent implementation, which is exactly what a browser does.
 * ------------------------------------------------------------------------- */

const enc = new TextEncoder();

/** Web Push speaks base64url without padding, everywhere. */
export function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** WebCrypto takes a `BufferSource`. TypeScript 5.7 narrowed that to views
 *  over a plain ArrayBuffer, while a `Uint8Array` PARAMETER is typed over
 *  ArrayBufferLike (which also admits SharedArrayBuffer) — so an ordinary
 *  Uint8Array is rejected at the call site. Nothing about the runtime changes;
 *  this states what is already true, in one place rather than as a cast at
 *  each of six. Remove it when the DOM typings settle. */
export function asBufferSource(b: Uint8Array): BufferSource {
  return b as unknown as BufferSource;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** HKDF-SHA256, extract and expand in one — which is what WebCrypto gives.
 *  Calling it twice with the same salt/ikm and different info re-runs the
 *  extract each time and yields the same PRK, so the two derivations below
 *  match an implementation that extracts once. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", asBufferSource(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: asBufferSource(salt), info: asBufferSource(info) },
    key,
    bytes * 8
  );
  return new Uint8Array(bits);
}

export interface ServerKeys {
  privateKey: CryptoKey;
  publicKey: Uint8Array; // raw uncompressed P-256 point, 65 bytes
}

/** A FRESH KEY PAIR PER MESSAGE. This is the ephemeral half of the ECDH and
 *  is not the VAPID identity — reusing it across messages would let a push
 *  service correlate them, and it buys nothing. */
export async function generateServerKeys(): Promise<ServerKeys> {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  )) as CryptoKeyPair;
  return {
    privateKey: kp.privateKey,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)),
  };
}

export interface EncryptOptions {
  /** Test seam ONLY. Encryption is randomised by design; pinning the salt and
   *  the ephemeral key pair is what lets another implementation be asked for
   *  the same bytes. Never passed in production. */
  salt?: Uint8Array;
  serverKeys?: ServerKeys;
  recordSize?: number;
}

/**
 * Encrypt one push message body (Content-Encoding: aes128gcm).
 *
 * `p256dh` and `auth` are the subscription's own keys, exactly as the browser
 * handed them to us and as push_subscriptions stores them.
 *
 * Single record: a notification payload is far below the 4096-byte record
 * size, and a second record would only ever be dead code here.
 */
export async function encryptPayload(
  plaintext: string,
  p256dh: string,
  auth: string,
  opts: EncryptOptions = {}
): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  if (uaPublic.length !== 65) {
    throw new Error(`p256dh must be a 65-byte P-256 point, got ${uaPublic.length}`);
  }
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const server = opts.serverKeys ?? (await generateServerKeys());
  const recordSize = opts.recordSize ?? 4096;

  const uaKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, server.privateKey, 256)
  );

  // RFC 8291 §3.4. The two public keys go in RECEIVER-then-SENDER order; swap
  // them and every browser silently fails to decrypt, with nothing to see at
  // this end but a 201 from the push service.
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(enc.encode("WebPush: info\0"), uaPublic, server.publicKey),
    32
  );
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // 0x02 is the padding delimiter for the LAST record (0x01 for a middle one).
  const record = concat(enc.encode(plaintext), Uint8Array.of(2));
  const aesKey = await crypto.subtle.importKey("raw", asBufferSource(cek), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asBufferSource(nonce), tagLength: 128 },
      aesKey,
      asBufferSource(record)
    )
  );

  // RFC 8188 header: salt(16) | record size(4, big-endian) | keyid len(1) | keyid
  const header = new Uint8Array(16 + 4 + 1 + server.publicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = server.publicKey.length;
  header.set(server.publicKey, 21);

  return concat(header, ciphertext);
}

/**
 * The `Authorization: vapid ...` header for one endpoint (RFC 8292).
 *
 * `aud` is the push service's ORIGIN, not the endpoint — a JWT minted for one
 * endpoint is reused for every endpoint on that service, and using the full
 * URL is rejected.
 */
export async function vapidAuthHeader(
  endpoint: string,
  publicKey: string,
  privateKey: string,
  subject: string,
  nowSeconds?: number
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  // 12 hours. The spec caps it at 24; shorter limits what a leaked token buys
  // without needing the clocks to agree closely.
  const claims = { aud, exp: now + 12 * 60 * 60, sub: subject };
  const signingInput =
    bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))) +
    "." +
    bytesToB64url(enc.encode(JSON.stringify(claims)));

  const key = await importVapidPrivateKey(publicKey, privateKey);
  // WebCrypto's ECDSA signature is already the raw r||s a JWS wants — no DER
  // unwrapping, which is the step Node-based implementations have to do.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      asBufferSource(enc.encode(signingInput))
    )
  );
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${publicKey}`;
}

/** WebCrypto cannot import a bare private scalar, and deriving the public
 *  point from it would mean doing EC arithmetic by hand. It does not have to:
 *  the VAPID PUBLIC key is configured alongside, and x and y are simply its
 *  second and third 32 bytes. */
async function importVapidPrivateKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(publicKey);
  const d = b64urlToBytes(privateKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
  }
  if (d.length !== 32) {
    throw new Error(`VAPID private key must be 32 bytes, got ${d.length}`);
  }
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      d: bytesToB64url(d),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}
