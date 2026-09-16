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
  /** Who to TELL. Null means the trigger could not resolve one — see index.ts. */
  recipient_member_id?: string | null;
  /** Who the event is ABOUT. For a member's own event these are the same. */
  member_id: string | null;
  cycle_number: number | null;
  round_number?: number | null;
  amount: number | string | null;
  note?: string | null;
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
 * Turn ONE recipient's rows from one transaction into one notification.
 *
 * index.ts groups the claimed rows by (recipient, event_type) before calling
 * this, so every row here shares an event. That grouping is what lets a single
 * transaction — a treasurer confirming one member and rejecting another —
 * produce the right sentence for each person instead of one muddled one.
 *
 * `names` maps member id to display name. An unknown id reads "A member"
 * rather than an id: the id is meaningless on a lock screen, and this is read
 * by somebody holding a phone, not debugging.
 *
 * Returns null when there is nothing worth showing — the caller must not
 * invent a notification to satisfy userVisibleOnly.
 */
export function composeNotification(
  rows: OutboxRow[],
  names: Record<string, string>
): Notification | null {
  if (!rows.length) return null;
  const event = rows[0].event_type;
  const mine = rows.filter((r) => r.event_type === event);
  if (!mine.length) return null;

  const total = mine.reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const cycles = mine
    .map((r) => Number(r.cycle_number))
    .filter((c) => Number.isFinite(c));
  const where = cycleLabel(cycles);
  const subjects = [...new Set(mine.map((r) => String(r.member_id)))];
  const id = subjects[0];
  const who = names[id] || "A member";
  const round = mine[0].round_number;
  const note = (mine[0].note || "").trim();

  // EVERY TITLE NAMES THE EVENT, never the app. iOS prints its own
  // "from <app name>" line beneath the title and Android shows the app in its
  // own header, so "Power Fund" there says the same thing twice and spends the
  // boldest line on a fact the reader already has. Reported from a phone.
  switch (event) {
    case "payment_pending": {
      // To the TREASURER, about somebody else.
      if (subjects.length > 1) {
        return {
          title: "Payments to review",
          body: `${subjects.length} members sent ${peso(total)} in total`,
          tag: "pf-payment",
          url: "/",
        };
      }
      return {
        title: "Payment to review",
        body: `${who} sent ${peso(total)}${where ? " \u2014 " + where : ""}`,
        // PER MEMBER. A repeat from the same person replaces their earlier
        // notice (sw.js sets renotify, so it still buzzes); two different
        // people stack, because collapsing them would hide one of the two.
        tag: `pf-payment-${id}`,
        url: "/",
      };
    }

    // The member sent proof and has been waiting. This is the loop closing.
    case "payment_confirmed":
      return {
        title: "Payment confirmed",
        body: `Your ${peso(total)}${where ? " for " + where : ""} is confirmed`,
        tag: `pf-confirmed-${id}`,
        url: "/",
      };

    // A DIFFERENT FACT from the above: cash that changed hands in person, now
    // on the record. Calling it "confirmed" would imply they had sent proof.
    case "payment_recorded":
      return {
        title: "Payment recorded",
        body: `The treasurer recorded ${peso(total)}${where ? " for " + where : ""}`,
        tag: `pf-recorded-${id}`,
        url: "/",
      };

    // The one that matters most: a rejection is invisible in the app until
    // opened, and unlike a confirmation it NEEDS ACTION. The reason travels
    // with it, because "send it again" with nothing to act on is worse than
    // useless.
    case "payment_rejected":
      return {
        title: "Payment needs resending",
        body:
          `Your payment${where ? " for " + where : ""} was rejected \u2014 ` +
          (note || "send it again"),
        tag: `pf-rejected-${id}`,
        url: "/",
      };

    // The largest single transfer in the fund. The nudge is deliberate: the
    // record that it arrived is the one thing only the recipient can give.
    case "payout_released":
      return {
        title: "Your payout has been sent",
        body:
          `${peso(total)}${round ? " for Round " + round : ""} \u2014 ` +
          "tap to confirm it arrived",
        tag: `pf-payout-${id}`,
        url: "/",
      };

    default:
      // An event type this build does not know about. Saying nothing is right:
      // userVisibleOnly means a push MUST show something, so the caller needs
      // to know there is nothing to say rather than be handed a guess.
      return null;
  }
}
