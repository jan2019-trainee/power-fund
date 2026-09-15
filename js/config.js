/* ---------------------------------------------------------------------------
 * Power Fund — configuration
 *
 * Paste your Supabase project values below. These two values are meant to be
 * used in the browser:
 *
 *   SUPABASE_URL       - your project URL, e.g. https://abcdxyz.supabase.co
 *   SUPABASE_ANON_KEY  - the "anon" / "public" API key (Project Settings -> API)
 *
 * The anon key is SAFE to commit and to expose in the deployed site — that is
 * what it is designed for. Security for this app comes from keeping the site
 * URL private (see README "Security limitations").
 *
 * NEVER put the "service_role" key here. It bypasses all database rules.
 * ------------------------------------------------------------------------- */

window.APP_CONFIG = {
  SUPABASE_URL: "https://shuejisxlajdxmrwhyem.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_ufoOqFVxvLV1IDFWXhyk3g__HsKdkzs",

  // FALLBACK payment QR — used only until the treasurer uploads one from the
  // app (Treasurer mode -> "Payment QR"), which stores it in Supabase so all
  // members see the same image. Replace assets/gcash-qr.jpg to change this default.
  QR_IMAGE_URL: "assets/gcash-qr.jpg",

  // Subtitle shown under the "⚡ Power Fund" title on every page load, e.g.
  // your group's name for this fund. Leave blank ("") to fall back to the
  // auto-generated "N-member sinking fund · ₱X on the 15th & end of every
  // month" summary instead.
  SUBTITLE: "ViTAMiN Fund 2027",

  // Member accounts (migration 008). Three states, so switching auth on is a
  // decision you make AFTER checking it works — not a side effect of a deploy:
  //
  //   "off"       no auth anywhere. Exactly how the app behaved before 008.
  //   "optional"  a "Sign in" row appears in Menu and signing in works, but
  //               the app is fully usable without it. Use this to test Google
  //               on a real phone without locking the other four members out.
  //   "required"  no session, no app: the sign-in screen replaces everything.
  //
  // Leave this on "off" until Google is enabled in Supabase (Authentication ->
  // Providers) AND this site's URL is listed under Authentication -> URL
  // Configuration -> Redirect URLs. Turning it to "required" before both are
  // true locks every member out, including the treasurer.
  //
  // NOW "required": all five members have an address on file and have each
  // signed in once, which is the real precondition — a member with no address
  // hits the `unknown` dead-end and cannot reach the app at all.
  //
  // This does NOT require migration 011. The coupling runs one way only: 011
  // without "required" shows every member a load error, but "required" without
  // 011 is simply a gate in front of rules Postgres is not enforcing yet. So
  // this is the reversible half — flip it back to "optional" and redeploy if
  // anything goes wrong.
  AUTH_MODE: "required",

  // Push notifications (migration 015).
  //
  // THIS FIELD HOLDS THE VAPID *PUBLIC* KEY. There is no separate "VAPID"
  // entry in this file — this is it, under a different name, which has caught
  // somebody out already. Specifically: the 87-character string labelled
  // "Public Key:" by `npx web-push generate-vapid-keys`, which always starts
  // with "B". The 43-character "Private Key:" NEVER goes in this file, and
  // neither does PF_PUSH_SECRET — a secret was pasted here once and had to be
  // rotated out of the git history.
  //
  // The same public key also goes to Supabase as the VAPID_PUBLIC_KEY
  // function secret. Two places, one value, and they must match exactly.
  //
  // It is meant to be in the page: it is what the browser subscribes against,
  // and it identifies this app to the push service.
  //
  // THE PRIVATE HALF NEVER COMES NEAR THIS FILE. It is an Edge Function
  // secret, the same rule as the service_role key above. Generate a pair with:
  //
  //   npx web-push generate-vapid-keys
  //
  // Leave this "" until the Edge Function is deployed. Empty means the app
  // says notifications are not set up yet rather than offering a switch that
  // registers a device nothing will ever send to.
  PUSH_PUBLIC_KEY: "BONYMNptDbobkZyOEEPuBu39DhKRDBs0iNLxf3EgEaEfRcdXMmiMVRx7XGJ62QZo839n64tiKscoOiOdBcEiwMY",
};
