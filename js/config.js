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
};
