/* ---------------------------------------------------------------------------
 * Power Fund — database layer
 *
 * Every Supabase call lives here. app.js never talks to Supabase directly.
 * All functions are async, use try/catch, log the real error to the console,
 * and throw a short, user-friendly Error that app.js shows in a banner.
 *
 * Tables:  members, cycles, contributions, payouts, activity_log, app_settings
 * Storage: bucket "payment-proofs" (public)
 * ------------------------------------------------------------------------- */

window.DB = (function () {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const PROOF_BUCKET = "payment-proofs";
  const ASSET_BUCKET = "payment-assets"; // treasurer-managed assets (the payment QR)
  const AVATAR_BUCKET = "member-avatars"; // members' own profile photos (009)

  if (
    !cfg.SUPABASE_URL ||
    !cfg.SUPABASE_ANON_KEY ||
    cfg.SUPABASE_URL.includes("YOUR-PROJECT")
  ) {
    console.error(
      "Supabase is not configured. Edit js/config.js with your project URL and anon key."
    );
  }

  // supabase-js v2 UMD build exposes a global `supabase` with createClient.
  const client = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_ANON_KEY,
    { realtime: { params: { eventsPerSecond: 5 } } }
  );

  /** Unwrap a Supabase response, turning errors into friendly exceptions. */
  function unwrap(res, whatFailed) {
    if (res.error) {
      console.error(whatFailed + ":", res.error);
      const msg = res.error.message || "";
      if (/Failed to fetch|NetworkError|network/i.test(msg)) {
        throw new Error("Can't reach the database — check your internet connection.");
      }
      if (/duplicate key|unique/i.test(msg)) {
        throw new Error("That contribution is already recorded for this cycle.");
      }
      if (/pending_requires_proof|check constraint/i.test(msg)) {
        throw new Error(
          "Please attach your proof of payment before submitting."
        );
      }
      if (/qr_code_url|qr_updated/i.test(msg)) {
        throw new Error(
          "The database is missing an update. Run supabase/migrations/003_payment_qr.sql " +
            "in the Supabase SQL editor, then reload."
        );
      }
      if (/recipient_member_id|recipient_name|receipt_url|released_by/i.test(msg)) {
        throw new Error(
          "The database is missing an update. Run supabase/migrations/004_payout_accountability.sql " +
            "in the Supabase SQL editor, then reload."
        );
      }
      if (/started_at|schema cache|could not find the .* column/i.test(msg)) {
        throw new Error(
          "The database is missing an update. Run supabase/migrations/002_round_lifecycle.sql " +
            "in the Supabase SQL editor, then reload."
        );
      }
      throw new Error(whatFailed + ". " + (msg || "Please try again."));
    }
    return res.data;
  }

  // ===================================================================
  // Members
  // ===================================================================
  async function getMembers() {
    return unwrap(
      await client.from("members").select("*").order("member_order"),
      "Couldn't load members"
    );
  }

  async function addMember(name, memberOrder) {
    return unwrap(
      await client
        .from("members")
        .insert({ name: String(name).trim(), member_order: memberOrder })
        .select()
        .single(),
      "Couldn't add member"
    );
  }

  async function updateMember(id, fields) {
    return unwrap(
      await client.from("members").update(fields).eq("id", id).select().single(),
      "Couldn't update member"
    );
  }

  async function deleteMember(id) {
    unwrap(await client.from("members").delete().eq("id", id), "Couldn't delete member");
  }

  /** updates: [{ id, member_order }, ...] — used by the reorder arrows. */
  async function updateMemberOrder(updates) {
    for (const u of updates) {
      unwrap(
        await client
          .from("members")
          .update({ member_order: u.member_order })
          .eq("id", u.id),
        "Couldn't change payout order"
      );
    }
  }

  // ===================================================================
  // Cycles
  // ===================================================================
  async function getCycles() {
    return unwrap(
      await client.from("cycles").select("*").order("cycle_number"),
      "Couldn't load cycles"
    );
  }

  // ===================================================================
  // Contributions
  // ===================================================================
  async function getContributions() {
    return unwrap(
      await client.from("contributions").select("*"),
      "Couldn't load contributions"
    );
  }

  async function getContributionsForCycle(cycleId) {
    return unwrap(
      await client.from("contributions").select("*").eq("cycle_id", cycleId),
      "Couldn't load contributions"
    );
  }

  /**
   * Insert or update one contribution. The DB has UNIQUE(cycle_id, member_id),
   * so upsert keeps "one row per member per cycle" true even if two people
   * click at the same moment.
   */
  async function upsertContribution({
    cycleId,
    memberId,
    amount,
    status,
    proofUrl,
    notes,
  }) {
    const row = {
      cycle_id: cycleId,
      member_id: memberId,
      amount: amount != null ? amount : 1000,
      status: status,
      proof_url: proofUrl != null ? proofUrl : null,
      notes: notes != null ? notes : null,
      paid_at: status === 2 ? new Date().toISOString() : null,
    };
    return unwrap(
      await client
        .from("contributions")
        .upsert(row, { onConflict: "cycle_id,member_id" })
        .select()
        .single(),
      "Couldn't save the contribution"
    );
  }

  /** Batch version of upsertContribution for "pay several cycles at once". */
  async function upsertContributions(rows) {
    const payload = rows.map((r) => ({
      cycle_id: r.cycleId,
      member_id: r.memberId,
      amount: r.amount != null ? r.amount : 1000,
      status: r.status,
      proof_url: r.proofUrl != null ? r.proofUrl : null,
      notes: r.notes != null ? r.notes : null,
      paid_at: r.status === 2 ? new Date().toISOString() : null,
    }));
    return unwrap(
      await client
        .from("contributions")
        .upsert(payload, { onConflict: "cycle_id,member_id" })
        .select(),
      "Couldn't save the contributions"
    );
  }

  async function updateContribution(id, fields) {
    return unwrap(
      await client.from("contributions").update(fields).eq("id", id).select().single(),
      "Couldn't update the contribution"
    );
  }

  async function deleteContribution(memberId, cycleId) {
    unwrap(
      await client
        .from("contributions")
        .delete()
        .eq("member_id", memberId)
        .eq("cycle_id", cycleId),
      "Couldn't remove the contribution"
    );
  }

  /**
   * Reject a reviewed claim, keeping the record.
   *
   * Rejection used to DELETE the rows, which threw away the only evidence that
   * a member ever submitted anything and left them with no way to learn why.
   * Migration 006 turns it into a state change instead — status 3, the
   * treasurer's reason, and a timestamp — so the member sees the refusal and
   * can resubmit.
   *
   * The screenshot is deliberately NOT archived here: the surviving row still
   * points at it, and moving the file would leave proof_url dangling.
   *
   * Returns true when the rejection was recorded. Returns false when this
   * database has not had migration 006 applied yet, so the caller can fall
   * back to the old destructive path rather than failing the treasurer's
   * action outright.
   */
  async function rejectContributions(ids, note) {
    if (!ids || !ids.length) return true;
    const res = await client
      .from("contributions")
      .update({
        status: 3,
        rejection_note: note && note.trim() ? note.trim() : null,
        rejected_at: new Date().toISOString(),
      })
      .in("id", ids);

    if (!res.error) return true;

    // Un-migrated database: either the columns are absent, or the older
    // status check — which only allows 0/1/2 — refuses the value 3.
    const msg = res.error.message || "";
    if (/rejection_note|rejected_at|status_check/i.test(msg)) {
      console.warn(
        "Migration 006 not applied — falling back to delete-on-reject:",
        msg
      );
      return false;
    }
    unwrap(res, "Couldn't reject the claim");
  }

  // ===================================================================
  // Payment proof screenshots (Supabase Storage)
  // ===================================================================
  async function uploadProof(file, memberId, cycleNumber) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${memberId}/cycle-${cycleNumber}-${Date.now()}.${ext}`;
    const res = await client.storage
      .from(PROOF_BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
    if (res.error) {
      console.error("Proof upload failed:", res.error);
      throw new Error("Couldn't upload the screenshot — the claim was not saved.");
    }
    const { data } = client.storage.from(PROOF_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  /** Best-effort delete of a proof image given its public URL. */
  async function deleteProof(publicUrl) {
    if (!publicUrl) return;
    const marker = `/${PROOF_BUCKET}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx === -1) return;
    const path = decodeURIComponent(publicUrl.slice(idx + marker.length));
    const res = await client.storage.from(PROOF_BUCKET).remove([path]);
    if (res.error) console.warn("Could not delete old proof image:", res.error);
  }

  /**
   * Move a proof screenshot into the bucket's `archive/` folder and return its
   * new public URL. Used instead of deleteProof when a treasurer rejects or
   * reverts a contribution, so the payment evidence is preserved.
   *
   * Throws on failure — the caller surfaces it, because "the contribution was
   * changed but the screenshot was NOT archived" is a state the treasurer must
   * know about. Returns null when the URL is not one of ours or is already
   * archived (nothing to do).
   */
  async function archiveProof(publicUrl) {
    if (!publicUrl) return null;
    const marker = `/${PROOF_BUCKET}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx === -1) return null; // not a file we manage
    const fromPath = decodeURIComponent(publicUrl.slice(idx + marker.length));
    if (fromPath.startsWith("archive/")) return publicUrl; // already archived
    const toPath = "archive/" + fromPath;

    const res = await client.storage.from(PROOF_BUCKET).move(fromPath, toPath);
    if (res.error) {
      console.error("Proof archive failed:", res.error);
      throw new Error(
        "Couldn't archive the payment screenshot — it is still stored at its original location."
      );
    }
    const { data } = client.storage.from(PROOF_BUCKET).getPublicUrl(toPath);
    return data.publicUrl;
  }

  // ===================================================================
  // Payment QR code (Supabase Storage + app_settings)
  // ===================================================================
  /** Best-effort delete of a payment-asset file given its public URL. */
  async function deletePaymentAsset(publicUrl) {
    if (!publicUrl) return;
    const marker = `/${ASSET_BUCKET}/`;
    const idx = publicUrl.indexOf(marker);
    if (idx === -1) return; // not one of ours (e.g. the bundled assets/gcash-qr.jpg)
    const path = decodeURIComponent(publicUrl.slice(idx + marker.length));
    const res = await client.storage.from(ASSET_BUCKET).remove([path]);
    if (res.error) console.warn("Could not delete old QR image:", res.error);
  }

  /**
   * Upload a new payment QR image and point app_settings at it.
   *
   * Order is chosen so the app never ends up on a broken QR:
   *   1. upload the new file under a unique name (the current one is untouched)
   *   2. update app_settings.qr_code_url to the new public URL
   *      - if this fails, the just-uploaded orphan is removed and we throw,
   *        leaving the previous QR still active
   *   3. only then, best-effort delete the previous QR file
   */
  async function uploadPaymentQr(file, updatedBy) {
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const path = `qr-code/qr-${Date.now()}.${ext}`;

    const up = await client.storage
      .from(ASSET_BUCKET)
      .upload(path, file, {
        upsert: false,
        contentType: file.type || "image/png",
        cacheControl: "60",
      });
    if (up.error) {
      console.error("QR upload failed:", up.error);
      const m = up.error.message || "";
      if (/bucket.*not.*found|not.*found|does not exist/i.test(m)) {
        throw new Error(
          "The 'payment-assets' storage bucket is missing. Run " +
            "supabase/migrations/003_payment_qr.sql in the Supabase SQL editor."
        );
      }
      if (/policy|permission|unauthor/i.test(m)) {
        throw new Error(
          "Storage rejected the upload — the 'payment-assets' bucket policies " +
            "are not set. Run supabase/migrations/003_payment_qr.sql."
        );
      }
      throw new Error("Couldn't upload the QR image. Please try again.");
    }

    const { data: pub } = client.storage.from(ASSET_BUCKET).getPublicUrl(path);
    const newUrl = pub.publicUrl;

    let prevUrl = null;
    try {
      const current = await getSettings();
      prevUrl = current && current.qr_code_url;
      unwrap(
        await client
          .from("app_settings")
          .upsert(
            {
              id: 1,
              qr_code_url: newUrl,
              qr_updated_at: new Date().toISOString(),
              qr_updated_by: updatedBy || "treasurer",
            },
            { onConflict: "id" }
          )
          .select()
          .single(),
        "Couldn't save the new QR code"
      );
    } catch (e) {
      // Roll back the orphaned upload so nothing points at a half-done change.
      await client.storage
        .from(ASSET_BUCKET)
        .remove([path])
        .catch(() => {});
      throw e;
    }

    await deletePaymentAsset(prevUrl);
    return newUrl;
  }

  /**
   * Upload an optional payout receipt image (what the recipient bought with the
   * ₱30,000). Stored in the same `payment-assets` bucket as the QR, under
   * receipts/. Returns the public URL. Only called when the treasurer attaches
   * one while releasing a payout.
   */
  /**
   * A member's receiving QR — where their payout gets sent. Same bucket and
   * failure handling as the fund's own payment QR; kept under payout-qr/ so
   * the two are distinguishable in storage.
   *
   * Returns the public URL. Saving it onto the member row is the caller's job,
   * so a failed upload can never blank an existing QR.
   */
  async function uploadMemberPayoutQr(file, memberId) {
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const path = `payout-qr/${memberId}-${Date.now()}.${ext}`;
    const res = await client.storage
      .from(ASSET_BUCKET)
      .upload(path, file, { upsert: false, contentType: file.type || "image/png" });
    if (res.error) {
      console.error("Payout QR upload failed:", res.error);
      const m = res.error.message || "";
      if (/bucket.*not.*found|not.*found|does not exist/i.test(m)) {
        throw new Error(
          "The 'payment-assets' storage bucket is missing. Run " +
            "supabase/migrations/005_member_payout_details.sql in the Supabase SQL editor."
        );
      }
      if (/policy|permission|unauthor/i.test(m)) {
        throw new Error(
          "Storage rejected the upload — the 'payment-assets' bucket policies " +
            "are not set. Run supabase/migrations/003_payment_qr.sql."
        );
      }
      throw new Error("Couldn't upload the payout QR. Please try again.");
    }
    const { data } = client.storage.from(ASSET_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  /**
   * Save a member's payout details. Surfaces the specific "run the migration"
   * message when the columns aren't there yet, rather than a generic failure
   * that leaves the treasurer guessing.
   */
  async function saveMemberPayoutDetails(memberId, fields) {
    const res = await client
      .from("members")
      .update({ ...fields, payout_updated_at: new Date().toISOString() })
      .eq("id", memberId)
      .select()
      .single();
    if (res.error) {
      const m = res.error.message || "";
      if (/column .* does not exist|payout_/i.test(m)) {
        throw new Error(
          "Payout details need a database update. Run " +
            "supabase/migrations/005_member_payout_details.sql in the Supabase SQL editor."
        );
      }
      throw new Error("Couldn't save the payout details. Please try again.");
    }
    return res.data;
  }

  /** A member's own profile photo (migration 009). The caller hands over an
   *  already-squared, downscaled Blob — see squareAvatarBlob() in app.js — so
   *  this only stores it. Always .jpg, because that is what the canvas encodes. */
  async function uploadMemberAvatar(blob, memberId) {
    const path = `${memberId}/${Date.now()}.jpg`;
    const res = await client.storage
      .from(AVATAR_BUCKET)
      .upload(path, blob, { upsert: false, contentType: "image/jpeg" });
    if (res.error) {
      console.error("Avatar upload failed:", res.error);
      const m = res.error.message || "";
      if (/bucket.*not.*found|not.*found|does not exist/i.test(m)) {
        throw new Error(
          "The 'member-avatars' storage bucket is missing. Run " +
            "supabase/migrations/009_member_avatars.sql in the Supabase SQL editor."
        );
      }
      if (/policy|permission|unauthor/i.test(m)) {
        throw new Error(
          "Storage rejected the upload — the 'member-avatars' bucket policies " +
            "are not set. Run supabase/migrations/009_member_avatars.sql."
        );
      }
      throw new Error("Couldn't upload your photo. Please try again.");
    }
    const { data } = client.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  /** Clear the column FIRST, then best-effort delete the file. If the delete
   *  fails the app is still correct — the photo is gone from every screen and
   *  an orphaned object costs nothing. Doing it the other way round can leave
   *  avatar_url pointing at a file that no longer exists, which renders as a
   *  broken image on every member surface. */
  async function removeMemberAvatar(memberId, currentUrl) {
    unwrap(
      await client.from("members").update({ avatar_url: null }).eq("id", memberId),
      "Couldn't remove your photo"
    );
    const path = avatarPathFromUrl(currentUrl);
    if (!path) return;
    try {
      const res = await client.storage.from(AVATAR_BUCKET).remove([path]);
      if (res.error) console.warn("Avatar file left behind:", res.error.message);
    } catch (e) {
      console.warn("Avatar file left behind:", e);
    }
  }

  /** ".../member-avatars/<memberId>/<ts>.jpg" -> "<memberId>/<ts>.jpg" */
  function avatarPathFromUrl(url) {
    if (!url) return null;
    const marker = `/${AVATAR_BUCKET}/`;
    const i = String(url).indexOf(marker);
    if (i === -1) return null;
    return decodeURIComponent(String(url).slice(i + marker.length).split("?")[0]) || null;
  }

  async function uploadPayoutReceipt(file, roundNumber) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `receipts/round-${roundNumber}-${Date.now()}.${ext}`;
    const res = await client.storage
      .from(ASSET_BUCKET)
      .upload(path, file, { upsert: false, contentType: file.type || "image/jpeg" });
    if (res.error) {
      console.error("Receipt upload failed:", res.error);
      const m = res.error.message || "";
      if (/bucket.*not.*found|not.*found|does not exist/i.test(m)) {
        throw new Error(
          "The 'payment-assets' storage bucket is missing. Run " +
            "supabase/migrations/003_payment_qr.sql in the Supabase SQL editor."
        );
      }
      throw new Error("Couldn't upload the receipt image. Please try again.");
    }
    const { data } = client.storage.from(ASSET_BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  // ===================================================================
  // Payouts
  // ===================================================================
  async function getPayouts() {
    return unwrap(
      await client.from("payouts").select("*").order("round_number"),
      "Couldn't load payouts"
    );
  }

  async function updatePayout(roundNumber, fields) {
    return unwrap(
      await client
        .from("payouts")
        .upsert(
          { round_number: roundNumber, ...fields },
          { onConflict: "round_number" }
        )
        .select()
        .single(),
      "Couldn't update the payout"
    );
  }

  /**
   * Mark a round as "started" (its payouts row gets a started_at timestamp).
   * The `.is("started_at", null)` guard makes this safe to call twice — a
   * second call updates zero rows, so a round can never be started twice.
   * Returns the updated rows (empty array => it was already started).
   *
   * Requires the `started_at` column (migration 002). If it is missing, the
   * error is turned into a clear "run migration 002" message by unwrap().
   */
  async function startRound(roundNumber) {
    return unwrap(
      await client
        .from("payouts")
        .update({ started_at: new Date().toISOString() })
        .eq("round_number", roundNumber)
        .is("started_at", null)
        .select(),
      "Couldn't start the next round"
    );
  }

  // ===================================================================
  // Activity log
  // ===================================================================
  async function getActivityLog(limit) {
    return unwrap(
      await client
        .from("activity_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit || 30),
      "Couldn't load the activity log"
    );
  }

  /**
   * Append one activity-log line. Never throws — a logging failure must not roll
   * back the real action — but it DOES report the outcome so the caller can warn
   * the treasurer that the action happened without an audit line.
   * Returns true on success, false on failure.
   */
  /**
   * Write one activity-log entry.
   *
   * `meta` carries the typed columns migration 006 added — event_type, a signed
   * amount, and the contribution status the action produced. They exist so the
   * Activity screen can show an amount column and a status chip; neither is
   * recoverable from the message prose, which the app previously regex-matched
   * to guess a category.
   *
   * The amount is a DISPLAY value only. Nothing reads it back for funding —
   * every total comes from the contributions table.
   *
   * A database without 006 rejects the extra columns, so the write is retried
   * with the message alone rather than losing the audit line entirely.
   */
  async function addActivityLog(message, meta) {
    const row = { message: String(message) };
    if (meta) {
      if (meta.type != null) row.event_type = String(meta.type);
      if (meta.amount != null) row.amount = meta.amount;
      if (meta.refStatus != null) row.ref_status = meta.refStatus;
      // Migration 007: who it was about and which round it belongs to, so the
      // desktop Activity table can filter on them without guessing at names
      // inside `message`.
      if (meta.memberId != null) row.member_id = meta.memberId;
      if (meta.round != null) row.round_number = meta.round;
    }

    let res = await client.from("activity_log").insert(row);

    // 007 missing but 006 present: drop just the attribution columns.
    if (res.error && /member_id|round_number/i.test(res.error.message || "")) {
      console.warn(
        "Migration 007 not applied — logging without attribution:",
        res.error.message
      );
      const { member_id, round_number, ...rest } = row;
      res = await client.from("activity_log").insert(rest);
    }

    if (res.error && /event_type|ref_status|amount/i.test(res.error.message || "")) {
      console.warn(
        "Migration 006 not applied — logging without typed columns:",
        res.error.message
      );
      res = await client.from("activity_log").insert({ message: String(message) });
    }
    if (res.error) {
      console.warn("Couldn't write to the activity log:", res.error);
      return false;
    }
    return true;
  }

  // ===================================================================
  // Settings (treasurer PIN)
  // ===================================================================
  /** The bank / account-name / account-number trio shown beside the payment
   *  QR, so a member can check they are paying the right account before they
   *  send (migration 006's qr_bank / qr_account_* columns). */
  async function saveQrAccount(fields) {
    const res = await client
      .from("app_settings")
      .upsert({ id: 1, ...fields }, { onConflict: "id" })
      .select()
      .single();
    if (res.error && /qr_bank|qr_account/i.test(res.error.message || "")) {
      throw new Error(
        "This database doesn't have the QR account columns yet — run " +
          "supabase/migrations/006_redesign_foundation.sql first."
      );
    }
    return unwrap(res, "Couldn't save the account details");
  }

  async function getSettings() {
    const data = unwrap(
      await client.from("app_settings").select("*").eq("id", 1).maybeSingle(),
      "Couldn't load settings"
    );
    return data || { id: 1 };
  }

  // ===================================================================
  // PINs (migration 010)
  //
  // Before 010 the digits lived in app_settings and every browser was handed
  // them by select("*"). After 010 they live in `app_secrets`, which has RLS
  // on and no policy, and the only way in is three security-definer functions.
  //
  // Both paths are implemented because the app has to keep working either
  // side of the migration. The rule throughout: an ERROR is never reported as
  // "no PIN is set" — that would offer to create a fresh treasurer PIN to
  // whoever happened to hit a network blip.
  // ===================================================================

  /** Whether each PIN exists — never the digits, once 010 is applied.
   *  `source` tells the caller which world it is in; `treasurerPin`/
   *  `masterPin` are present ONLY on the pre-010 path, where they are already
   *  public anyway, and are what the legacy comparison falls back to. */
  // Which world this database is in, remembered for the session. Without this
  // the app probes a missing pf_pin_status() on every load AND every 30-second
  // poll, so a pre-010 database logs a browser 404 forever. Only the negative
  // is cached, and it is cleared the moment the legacy read stops working —
  // which is exactly what happens when 010 is applied mid-session, so the app
  // re-probes and finds the vault instead of quietly staying on a dead path.
  let pinPath = null; // null (unknown) | "vault" | "legacy"

  async function pinStatus() {
    const rpc = pinPath === "legacy" ? { error: { code: "42883" } } : await client.rpc("pf_pin_status");
    const row = rpc.error
      ? null
      : Array.isArray(rpc.data)
      ? rpc.data[0]
      : rpc.data;
    if (!rpc.error && row) {
      pinPath = "vault";
      return {
        source: "vault",
        hasTreasurer: !!row.has_treasurer,
        hasMaster: !!row.has_master,
      };
    }
    // pf_pin_status() always returns exactly one row — app_secrets is a
    // single-row table the migration seeds. So a SUCCESSFUL but empty answer
    // is not "no PINs are set"; it means we are not really talking to the
    // vault. Reading it as false would offer to create a fresh treasurer PIN,
    // which is how a proxy quirk becomes a takeover. Fall through instead.
    //
    // 42883 = undefined_function: migration 010 has not been run here.
    const missing =
      !rpc.error ||
      rpc.error.code === "42883" ||
      /pf_pin_status|does not exist/i.test(rpc.error.message || "");
    if (!missing) {
      console.error("Couldn't read PIN status:", rpc.error);
      throw new Error("Couldn't check this fund's PIN settings. Please try again.");
    }
    const legacy = await client
      .from("app_settings")
      .select("treasurer_pin, master_pin")
      .eq("id", 1)
      .maybeSingle();
    if (legacy.error) {
      // Post-010 the columns are gone, so this is also what a stale "legacy"
      // decision looks like: forget it so the next load probes the vault
      // again. Either way this throws rather than reporting "no PIN is set".
      pinPath = null;
      console.error("Couldn't read PIN status (legacy):", legacy.error);
      throw new Error("Couldn't check this fund's PIN settings. Please try again.");
    }
    pinPath = "legacy";
    const d = legacy.data || {};
    return {
      source: "legacy",
      hasTreasurer: !!d.treasurer_pin,
      hasMaster: !!d.master_pin,
      treasurerPin: d.treasurer_pin || null,
      masterPin: d.master_pin || null,
    };
  }

  /** kind: "treasurer" | "master". Throws rather than returning false when it
   *  cannot tell — a wrong answer here unlocks or locks out the treasurer. */
  async function verifyPin(kind, pin, status) {
    if (!pin) return false;
    const rpc =
      pinPath === "legacy"
        ? { error: { code: "42883" } }
        : await client.rpc("pf_check_pin", { kind, pin });
    if (!rpc.error && typeof rpc.data === "boolean") return rpc.data;
    // Anything other than a real boolean means we did not reach the vault —
    // not that the PIN was wrong. Same reasoning as pinStatus().
    const missing =
      !rpc.error ||
      rpc.error.code === "42883" ||
      /pf_check_pin|does not exist/i.test(rpc.error.message || "");
    if (missing && status && status.source === "legacy") {
      const stored = kind === "master" ? status.masterPin : status.treasurerPin;
      return !!stored && stored === pin;
    }
    console.error("Couldn't verify the PIN:", rpc.error);
    throw new Error("Couldn't check that PIN. Check your connection and try again.");
  }

  /** kind: "treasurer" | "master". The server enforces the length minimum, the
   *  treasurer-only rule and the two-PINs-must-differ rule, so its message is
   *  passed through rather than second-guessed. */
  async function setPin(kind, pin, status) {
    const rpc =
      pinPath === "legacy"
        ? { error: { code: "42883" } }
        : await client.rpc("pf_set_pin", { kind, pin });
    if (!rpc.error) return;
    const missing =
      rpc.error.code === "42883" || /pf_set_pin|does not exist/i.test(rpc.error.message || "");
    if (!missing) {
      console.error("Couldn't save the PIN:", rpc.error);
      throw new Error(rpc.error.message || "Couldn't save the PIN. Please try again.");
    }
    if (!status || status.source !== "legacy") {
      throw new Error("Couldn't save the PIN. Please try again.");
    }
    // Pre-010 fallback: write the plaintext column, as the app always did.
    const field = kind === "master" ? "master_pin" : "treasurer_pin";
    const row = { id: 1 };
    row[field] = pin;
    const res = await client.from("app_settings").upsert(row, { onConflict: "id" });
    if (res.error) {
      console.error("Couldn't save the PIN (legacy):", res.error);
      if (/master_pin/i.test(res.error.message || "")) {
        throw new Error(
          "This fund's database is missing the master-PIN column. Run migration 006."
        );
      }
      throw new Error("Couldn't save the PIN. Please try again.");
    }
  }



  // ===================================================================
  // Bulk: load everything, reset, backup/restore
  // ===================================================================
  async function loadEverything(activityLimit) {
    const [members, cycles, contributions, payouts, activityLog, settings] =
      await Promise.all([
        getMembers(),
        getCycles(),
        getContributions(),
        getPayouts(),
        getActivityLog(activityLimit || 30),
        getSettings(),
      ]);
    // Which PINs exist, without the digits (migration 010). Loaded here so the
    // PIN screens can choose between "Create a PIN" and "Enter your PIN"
    // without a second round trip on every render.
    const pins = await pinStatus();
    return { members, cycles, contributions, payouts, activityLog, settings, pins };
  }

  /**
   * Wipe contributions + activity log, un-release every payout, reset the round
   * lifecycle. The treasurer PIN is deliberately KEPT so treasurer mode still
   * needs it after a reset.
   */
  async function resetAll() {
    unwrap(
      await client.from("contributions").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      "Couldn't clear contributions"
    );
    unwrap(
      await client.from("activity_log").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      "Couldn't clear the activity log"
    );
    for (let r = 1; r <= 5; r++) {
      await updatePayout(r, { released: false, note: null, released_on: null });
    }
    // Clear the payout accountability fields too (migration 004). Without
    // this a reset left every round claiming it had paid a named recipient a
    // real amount, with a receipt, while released was false — stale financial
    // records surviving the action whose whole job is to remove them. Skipped
    // silently on databases that predate migration 004, like started_at below.
    for (let r = 1; r <= 5; r++) {
      const res = await client
        .from("payouts")
        .update({
          amount: null,
          recipient_member_id: null,
          recipient_name: null,
          receipt_url: null,
          released_by: null,
        })
        .eq("round_number", r);
      if (res.error) {
        console.warn(
          "Skipped clearing payout accountability fields (run migration 004):",
          res.error.message
        );
        break;
      }
    }
    // Reset the round lifecycle too, but only if migration 002 has been run —
    // skip silently otherwise so reset still works on the older schema.
    for (let r = 1; r <= 5; r++) {
      const res = await client
        .from("payouts")
        .update({ started_at: r === 1 ? new Date().toISOString() : null })
        .eq("round_number", r);
      if (res.error) {
        console.warn("Skipped resetting started_at (run migration 002):", res.error.message);
        break;
      }
    }

    // Best-effort: empty the proof bucket.
    try {
      const list = await client.storage.from(PROOF_BUCKET).list("", { limit: 1000 });
      if (!list.error && list.data && list.data.length) {
        const folders = list.data.map((f) => f.name);
        for (const folder of folders) {
          const inner = await client.storage.from(PROOF_BUCKET).list(folder, { limit: 1000 });
          if (!inner.error && inner.data && inner.data.length) {
            await client.storage
              .from(PROOF_BUCKET)
              .remove(inner.data.map((f) => `${folder}/${f.name}`));
          }
        }
      }
    } catch (e) {
      console.warn("Could not fully empty the proof bucket:", e);
    }
  }

  /**
   * Replace all contributions (and payout/name state) with a JSON backup made
   * by the "Download backup" button. Destructive — app.js confirms first.
   */
  async function restoreFromBackup(backup) {
    if (!backup || !Array.isArray(backup.contributions)) {
      throw new Error("That file doesn't look like a Power Fund backup.");
    }
    // Names (match by member_order so it works across projects).
    if (Array.isArray(backup.members)) {
      for (const m of backup.members) {
        if (m.member_order && m.name) {
          unwrap(
            await client
              .from("members")
              .update({ name: m.name })
              .eq("member_order", m.member_order),
            "Couldn't restore member names"
          );
        }
      }
    }

    const members = await getMembers();
    const cycles = await getCycles();
    const memberByOrder = {};
    members.forEach((m) => (memberByOrder[m.member_order] = m.id));
    const cycleByNumber = {};
    cycles.forEach((c) => (cycleByNumber[c.cycle_number] = c.id));

    unwrap(
      await client.from("contributions").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      "Couldn't clear contributions"
    );

    const rows = backup.contributions
      .map((c) => ({
        cycle_id: cycleByNumber[c.cycle_number],
        member_id: memberByOrder[c.member_order],
        amount: c.amount != null ? c.amount : 1000,
        status: c.status,
        proof_url: c.proof_url || null,
        notes: c.notes || null,
        paid_at: c.paid_at || (c.status === 2 ? new Date().toISOString() : null),
      }))
      .filter((r) => r.cycle_id && r.member_id && r.status !== 0);

    if (rows.length) {
      unwrap(
        await client.from("contributions").insert(rows),
        "Couldn't restore contributions"
      );
    }

    if (Array.isArray(backup.payouts)) {
      for (const p of backup.payouts) {
        await updatePayout(p.round_number, {
          released: !!p.released,
          note: p.note || null,
          released_on: p.released_on || null,
        });
      }
      // Restore the round lifecycle separately (needs migration 002).
      for (const p of backup.payouts) {
        if (p.started_at === undefined) continue;
        const res = await client
          .from("payouts")
          .update({ started_at: p.started_at || null })
          .eq("round_number", p.round_number);
        if (res.error) {
          console.warn("Skipped restoring started_at (run migration 002):", res.error.message);
          break;
        }
      }
      // Restore payout accountability fields separately (needs migration 004).
      // Older backups won't have these keys — those rows are simply skipped.
      for (const p of backup.payouts) {
        const extra = {};
        if (p.amount !== undefined) extra.amount = p.amount;
        if (p.recipient_member_id !== undefined)
          extra.recipient_member_id = p.recipient_member_id || null;
        if (p.recipient_name !== undefined) extra.recipient_name = p.recipient_name || null;
        if (p.receipt_url !== undefined) extra.receipt_url = p.receipt_url || null;
        if (p.released_by !== undefined) extra.released_by = p.released_by || null;
        if (!Object.keys(extra).length) continue;
        const res = await client
          .from("payouts")
          .update(extra)
          .eq("round_number", p.round_number);
        if (res.error) {
          console.warn(
            "Skipped restoring payout accountability fields (run migration 004):",
            res.error.message
          );
          break;
        }
      }
    }
  }

  // ===================================================================
  // Realtime
  // ===================================================================
  /**
   * Call `onChange` whenever another device changes the fund. Returns an
   * unsubscribe function. Falls back silently if realtime can't connect —
   * app.js also polls slowly and refreshes on tab focus.
   */
  function subscribeToChanges(onChange) {
    const channel = client
      .channel("power-fund-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "contributions" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "payouts" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "members" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "activity_log" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, onChange)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") console.log("Realtime connected.");
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
          console.warn("Realtime unavailable — falling back to polling.", status);
      });
    return () => client.removeChannel(channel);
  }

  // ===================================================================
  // Auth (migration 008)
  //
  // Google is the only provider, chosen because it is the only option that
  // needs no SMTP: a forgotten password is Google's problem, not something
  // this app has to build a recovery flow for. supabase-js persists the
  // session in localStorage and refreshes the token itself; detectSessionInUrl
  // (on by default) consumes the #access_token fragment on the way back from
  // the redirect, so nothing here has to parse the URL.
  // ===================================================================

  /** Attach a login to a roster row. The `is null` guard is the important
   *  part: it makes the claim atomic in the database rather than in JS, so two
   *  devices racing the same first login cannot both think they won — the
   *  second update matches no row and comes back empty.
   *
   *  Returns the linked member row, or null when the row was already claimed. */
  async function linkMemberAccount(memberId, authUserId) {
    // Post-010 this goes through pf_claim_member(), which does the email match
    // in SQL instead of trusting the browser to have done it, and returns the
    // linked row's id. The migration's guard trigger also refuses a direct
    // update from an unlinked caller, so the RPC is the only route once 010 is
    // applied — the fallback below is strictly for a pre-010 database.
    // pf_claim_member and pf_pin_status both arrive with migration 010, so a
    // database already known to predate it cannot have this either.
    const rpc =
      pinPath === "legacy"
        ? { error: { code: "42883" } }
        : await client.rpc("pf_claim_member");
    if (!rpc.error) {
      const id = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
      if (!id) return null; // no matching address, or already claimed
      const row = await client.from("members").select("*").eq("id", id).maybeSingle();
      return row.error ? { id } : row.data || { id };
    }
    const missing =
      rpc.error.code === "42883" ||
      /pf_claim_member|does not exist/i.test(rpc.error.message || "");
    if (!missing) {
      console.error("Couldn't link this account:", rpc.error);
      throw new Error("Couldn't link your account to your member profile.");
    }

    const res = await client
      .from("members")
      .update({ auth_user_id: authUserId })
      .eq("id", memberId)
      .is("auth_user_id", null)
      .select();
    if (res.error) {
      console.error("Couldn't link this account:", res.error);
      // 42703 = undefined_column: migration 008 has not been run.
      if (res.error.code === "42703" || /auth_user_id/.test(res.error.message || "")) {
        throw new Error(
          "This fund's database is missing the accounts columns. Run migration 008."
        );
      }
      throw new Error("Couldn't link your account to your member profile.");
    }
    return (res.data && res.data[0]) || null;
  }

  /** The current session, or null. Never throws — a boot must not die here. */
  async function getSession() {
    try {
      const res = await client.auth.getSession();
      if (res.error) {
        console.warn("Couldn't read the session:", res.error);
        return null;
      }
      return (res.data && res.data.session) || null;
    } catch (e) {
      console.warn("Couldn't read the session:", e);
      return null;
    }
  }

  /** Fires on sign-in, sign-out and every silent token refresh. */
  function onAuthChange(cb) {
    try {
      const res = client.auth.onAuthStateChange((event, session) => {
        cb(event, session || null);
      });
      return (res && res.data && res.data.subscription) || null;
    } catch (e) {
      console.warn("Couldn't watch auth state:", e);
      return null;
    }
  }

  /** Leaves the page and comes back signed in. `redirectTo` must also be
   *  listed in Supabase -> Authentication -> URL Configuration, or the
   *  redirect lands on the project's Site URL instead of here. */
  async function signInWithGoogle() {
    const redirectTo = window.location.origin + window.location.pathname;
    const res = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (res.error) {
      console.error("Google sign-in failed:", res.error);
      throw new Error(
        /provider is not enabled/i.test(res.error.message || "")
          ? "Google sign-in isn't switched on for this fund yet. The treasurer needs to enable it in Supabase."
          : "Couldn't start Google sign-in. Check your connection and try again."
      );
    }
    return res.data;
  }

  async function signOut() {
    const res = await client.auth.signOut();
    if (res.error) {
      console.error("Sign out failed:", res.error);
      throw new Error("Couldn't sign out. Try again.");
    }
  }

  return {
    client,
    getMembers,
    addMember,
    updateMember,
    deleteMember,
    updateMemberOrder,
    getCycles,
    getContributions,
    getContributionsForCycle,
    upsertContribution,
    upsertContributions,
    updateContribution,
    deleteContribution,
    rejectContributions,
    uploadProof,
    deleteProof,
    archiveProof,
    uploadPaymentQr,
    uploadMemberPayoutQr,
    saveMemberPayoutDetails,
    uploadPayoutReceipt,
    deletePaymentAsset,
    getPayouts,
    updatePayout,
    startRound,
    getActivityLog,
    addActivityLog,
    getSettings,
    pinStatus,
    verifyPin,
    setPin,
    saveQrAccount,
    loadEverything,
    resetAll,
    restoreFromBackup,
    subscribeToChanges,
    linkMemberAccount,
    uploadMemberAvatar,
    removeMemberAvatar,
    getSession,
    onAuthChange,
    signInWithGoogle,
    signOut,
  };
})();
