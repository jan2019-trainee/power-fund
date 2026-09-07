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
  async function addActivityLog(message) {
    const res = await client
      .from("activity_log")
      .insert({ message: String(message) });
    if (res.error) {
      console.warn("Couldn't write to the activity log:", res.error);
      return false;
    }
    return true;
  }

  // ===================================================================
  // Settings (treasurer PIN)
  // ===================================================================
  async function getSettings() {
    const data = unwrap(
      await client.from("app_settings").select("*").eq("id", 1).maybeSingle(),
      "Couldn't load settings"
    );
    return data || { id: 1, treasurer_pin: null };
  }

  async function updateTreasurerPin(pin) {
    return unwrap(
      await client
        .from("app_settings")
        .upsert({ id: 1, treasurer_pin: pin }, { onConflict: "id" })
        .select()
        .single(),
      "Couldn't save the treasurer PIN"
    );
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
    return { members, cycles, contributions, payouts, activityLog, settings };
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
    uploadProof,
    deleteProof,
    archiveProof,
    uploadPaymentQr,
    uploadPayoutReceipt,
    deletePaymentAsset,
    getPayouts,
    updatePayout,
    startRound,
    getActivityLog,
    addActivityLog,
    getSettings,
    updateTreasurerPin,
    loadEverything,
    resetAll,
    restoreFromBackup,
    subscribeToChanges,
  };
})();
