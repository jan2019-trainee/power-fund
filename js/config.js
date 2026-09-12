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
  // ===================================================================
  // DEMO BRANCH — this is `demo/group-walkthrough`, NOT main.
  // ===================================================================
  //
  // "optional", which IS what was asked for — but it could not have worked
  // against the live project, and that is worth knowing:
  //
  //   * MIGRATION 011 IS APPLIED there, and it revokes `anon` entirely. Every
  //     policy is `to authenticated`. So "optional" while SIGNED OUT reads
  //     nothing at all — the demo would be a load error, not an app.
  //   * "optional" while SIGNED IN sets accountMemberId, which sets
  //     `identityLocked`. The who-am-I picker is hidden AND
  //     openWhoAmIPicker() refuses. So you still could not switch member.
  //
  // DEMO_MODE closes both: the data never leaves the browser, so there is no
  // RLS to satisfy; and js/demo-db.js FAKES a session for whichever member the
  // DEMO bar names, so switching is one dropdown and no Google account.
  //
  // Why "optional" and not "off": half the app is gated on a LINKED ACCOUNT —
  // Received ✓, reporting a payout as not arrived, My payout details, turn
  // swaps. With auth off those render inert, and the newest half of the app
  // could be shown but never driven.
  AUTH_MODE: "optional",

  // ===================================================================
  // DEMO_MODE — the whole point of this branch.
  //
  // true  -> js/demo-db.js REPLACES window.DB with an in-browser store
  //          (localStorage). No Supabase, no network, no auth. Every member
  //          is switchable, every action writes, nothing touches the real
  //          fund's records.
  // false -> the app is exactly main. The real database, the real rules.
  //
  // NEVER merge this branch to main with this true. The banner across the top
  // of the app exists so nobody in the room mistakes it for the live fund.
  // ===================================================================
  DEMO_MODE: true,
};
