/* ---------------------------------------------------------------------------
 * What the lock screen actually says.
 *
 * Kept out of index.ts so it can be tested without a Deno runtime: index.ts
 * calls Deno.serve() at module scope, so importing it under Node would start
 * a server rather than return a function.
 *
 * The rule this file exists to hold: ONE NOTIFICATION PER TRANSFER. The
 * database already coalesced a six-cycle batch into one dispatch; this has to
 * render it as one sentence rather than six.
 * ------------------------------------------------------------------------- */

export interface OutboxRow {
  id: string;
  txid: number | string;
  event_type: string;
  member_id: string | null;
  cycle_number: number | null;
  amount: number | string | null;
}

export interface Notification {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/** Whole pesos with separators. The ledger's two decimals are right in a
 *  table and wrong in a sentence — the artboards write "₱1,000". */
export function peso(n: number): string {
  return "₱" + Math.round(n).toLocaleString("en-US");
}

/** "cycle 7" · "cycles 7–12" · "6 cycles" when they are not contiguous.
 *  An en dash, matching the rest of the app's copy. */
export function cycleLabel(cycles: number[]): string {
  const list = cycles.filter((c) => Number.isFinite(c)).sort((a, b) => a - b);
  if (list.length === 0) return "";
  if (list.length === 1) return `cycle ${list[0]}`;
  const contiguous = list[list.length - 1] - list[0] === list.length - 1;
  return contiguous
    ? `cycles ${list[0]}–${list[list.length - 1]}`
    : `${list.length} cycles`;
}

/**
 * Turn one transaction's worth of outbox rows into one notification.
 *
 * `names` maps member id to display name. An unknown id reads "A member"
 * rather than an id: the id is meaningless on a lock screen, and this
 * notification is read by somebody holding a phone, not debugging.
 *
 * Returns null when there is nothing worth showing — the caller must not
 * invent a notification to satisfy userVisibleOnly.
 */
export function composeNotification(
  rows: OutboxRow[],
  names: Record<string, string>
): Notification | null {
  const payments = rows.filter((r) => r.event_type === "payment_pending");
  if (payments.length === 0) return null;

  // Normally one member per transaction — a member submits their own batch.
  // More than one can only happen if some future writer batches across
  // members, and a wrong-but-confident sentence is worse than a general one.
  const memberIds = [...new Set(payments.map((r) => String(r.member_id)))];
  const total = payments.reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const cycles = payments
    .map((r) => Number(r.cycle_number))
    .filter((c) => Number.isFinite(c));

  if (memberIds.length > 1) {
    return {
      title: "Power Fund",
      body: `${memberIds.length} payments sent — ${peso(total)} waiting for review`,
      tag: "pf-payment",
      url: "/",
    };
  }

  const id = memberIds[0];
  const who = names[id] || "A member";
  const where = cycleLabel(cycles);
  return {
    title: "Power Fund",
    body: `${who} sent ${peso(total)}${where ? " — " + where : ""}`,
    // PER MEMBER. A repeat from the same person replaces their earlier notice
    // (sw.js sets renotify, so it still buzzes); two different people stack,
    // because collapsing them would hide one of the two payments.
    tag: `pf-payment-${id}`,
    // "/" and not a deep link: the app has NO routing — one currentView, no
    // hash, no history — so anything else reloads at Home and looks broken.
    url: "/",
  };
}
