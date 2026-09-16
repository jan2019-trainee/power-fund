/* ---------------------------------------------------------------------------
 * Power Fund — notify-payment (Supabase Edge Function)
 *
 * The sending half of migration 015. Postgres coalesces a transfer into one
 * `pg_net` call carrying a txid; this claims that transaction's outbox rows,
 * works out who the treasurer is, and pushes one notification to each device
 * they have registered.
 *
 * ZERO IMPORTS beyond the two local modules. No supabase-js, no web-push:
 * PostgREST is plain fetch, and the crypto is WebCrypto. This is the path
 * carrying a member's payment onto somebody's lock screen, and it is the one
 * place in the project where a dependency would be running with the SERVICE
 * ROLE key in scope.
 *
 * DEPLOY:
 *   supabase functions deploy notify-payment --no-verify-jwt
 *   supabase secrets set PF_PUSH_SECRET=... VAPID_PUBLIC_KEY=... \
 *                        VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
 *
 * --no-verify-jwt IS REQUIRED AND IS NOT A HOLE. The caller is Postgres via
 * pg_net, which has no Supabase session to present; the gate is the
 * x-pf-push-secret header, compared in constant time below. Leaving JWT
 * verification on would simply mean the trigger could never call it.
 * ------------------------------------------------------------------------- */
import { encryptPayload, vapidAuthHeader } from "./webpush.ts";
import { composeNotification, type OutboxRow } from "./message.ts";

/** Read at CALL time, not at module load. Two reasons, and the second is the
 *  one that matters: a secret rotated with `supabase secrets set` is picked up
 *  without the isolate having to be cold, and the handler below can be
 *  imported and exercised by tests/notify-payment.test.mjs under Node, where
 *  there is no Deno at module scope to read from. */
function env(name: string, fallback = ""): string {
  const d = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
  return d?.env.get(name) ?? fallback;
}

/** Length is allowed to leak; the contents are not. */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

interface Subscription {
  id: string;
  member_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  // The endpoint is public (--no-verify-jwt), so this header is the whole
  // gate. An unset secret fails CLOSED: a misconfigured deploy must not
  // become an open relay that can buzz the treasurer's phone.
  const pushSecret = env("PF_PUSH_SECRET");
  if (!pushSecret || !safeEqual(pushSecret, req.headers.get("x-pf-push-secret") ?? "")) {
    return new Response("Forbidden", { status: 403 });
  }
  const vapidPublic = env("VAPID_PUBLIC_KEY");
  const vapidPrivate = env("VAPID_PRIVATE_KEY");
  const vapidSubject = env("VAPID_SUBJECT", "mailto:treasurer@example.com");
  if (!vapidPublic || !vapidPrivate) {
    console.error("VAPID keys are not configured");
    return new Response("Not configured", { status: 500 });
  }

  let txid: string;
  try {
    txid = String(((await req.json()) ?? {}).txid ?? "");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!/^\d+$/.test(txid)) return new Response("Bad txid", { status: 400 });

  // CLAIM FIRST, in one statement. `sent_at is null` makes this atomic: a
  // duplicate delivery of the same txid — pg_net retrying, or somebody
  // replaying the call — claims nothing and sends nothing.
  const claimRes = await rest(`push_outbox?txid=eq.${txid}&sent_at=is.null`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ sent_at: new Date().toISOString() }),
  });
  if (!claimRes.ok) {
    console.error("claim failed", claimRes.status, await claimRes.text());
    return new Response("Claim failed", { status: 500 });
  }
  const rows = (await claimRes.json()) as OutboxRow[];
  if (rows.length === 0) {
    return Response.json({ ok: true, claimed: 0, note: "already handled" });
  }

  // The rows came from the database, written by the trigger — the request body
  // only ever carried a txid, so there is nothing here a caller could forge.
  //
  // GROUPED BY (recipient, event). One transaction can now touch several
  // people — a treasurer confirming one member's batch while rejecting
  // another's — and each of them needs their own sentence, not a muddle.
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.member_id) ids.add(r.member_id);
    if (r.recipient_member_id) ids.add(r.recipient_member_id);
  }
  const membersRes = await rest(
    `members?select=id,name,is_treasurer` +
      (ids.size ? `&or=(is_treasurer.eq.true,id.in.(${[...ids].join(",")}))` : "")
  );
  const members = membersRes.ok
    ? ((await membersRes.json()) as { id: string; name: string; is_treasurer: boolean }[])
    : [];
  const names: Record<string, string> = {};
  for (const m of members) names[m.id] = m.name;

  // A NULL recipient keeps its 015 meaning: the trigger could not resolve a
  // treasurer. Fall back to whoever is flagged now, and if nobody is, say so
  // rather than dropping the event silently.
  const treasurers = members.filter((m) => m.is_treasurer).map((m) => m.id);
  const groups = new Map<string, OutboxRow[]>();
  const unroutable: OutboxRow[] = [];
  for (const r of rows) {
    const to = r.recipient_member_id ?? treasurers[0] ?? null;
    if (!to) {
      unroutable.push(r);
      continue;
    }
    const key = `${to}|${r.event_type}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  if (unroutable.length) await markOutbox(unroutable, "no treasurer is flagged");
  if (groups.size === 0) {
    return Response.json({ ok: true, claimed: rows.length, sent: 0 });
  }

  // One JWT per push SERVICE, not per device: the audience is the origin, so
  // two devices on the same service share a token.
  const jwtByOrigin = new Map<string, string>();
  let sent = 0;
  let devices = 0;
  const errors: string[] = [];
  const quiet: OutboxRow[] = [];

  for (const [key, groupRows] of groups) {
    const to = key.slice(0, key.indexOf("|"));
    const note = composeNotification(groupRows, names);
    if (!note) {
      quiet.push(...groupRows);
      continue;
    }
    const subsRes = await rest(
      `push_subscriptions?select=id,member_id,endpoint,p256dh,auth&member_id=eq.${to}`
    );
    const subs = subsRes.ok ? ((await subsRes.json()) as Subscription[]) : [];
    devices += subs.length;
    if (subs.length === 0) {
      quiet.push(...groupRows);
      continue;
    }
    const payload = JSON.stringify(note);

    for (const sub of subs) {
      try {
        const origin = new URL(sub.endpoint).origin;
        let auth = jwtByOrigin.get(origin);
        if (!auth) {
          auth = await vapidAuthHeader(sub.endpoint, vapidPublic, vapidPrivate, vapidSubject);
          jwtByOrigin.set(origin, auth);
        }
        const body = await encryptPayload(payload, sub.p256dh, sub.auth);
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            // A day. A payment waiting for review is still worth seeing after
            // a phone has been off for a few hours; after a day the app says
            // it better than a stale notification would.
            TTL: "86400",
            Urgency: "normal",
          },
          // Same BufferSource/BodyInit typings artifact as webpush.ts documents.
          body: body as unknown as BodyInit,
        });

        if (res.status === 404 || res.status === 410) {
          // The push service is saying that browser is never coming back.
          // Left in place it would be pushed to forever, and the member would
          // see "on" for a device that no longer exists. This is also how a
          // row from an unsubscribe that failed halfway cleans itself up.
          await rest(`push_subscriptions?id=eq.${sub.id}`, { method: "DELETE" });
          errors.push(`${res.status} gone, pruned`);
          continue;
        }
        if (!res.ok) {
          errors.push(`${res.status} ${(await res.text()).slice(0, 120)}`);
          continue;
        }
        sent++;
        await rest(`push_subscriptions?id=eq.${sub.id}`, {
          method: "PATCH",
          body: JSON.stringify({ last_ok_at: new Date().toISOString() }),
        });
      } catch (e) {
        errors.push(String((e as Error).message ?? e).slice(0, 120));
      }
    }
  }

  if (quiet.length) await markOutbox(quiet, "nobody to notify, or no device registered");

  // The outbox row is the only trail for "the phone stayed quiet", so a run
  // that delivered nothing has to say why.
  if (sent === 0 && errors.length) await markOutbox(rows, errors.join(" | "));

  return Response.json({
    ok: true,
    claimed: rows.length,
    recipients: groups.size,
    devices,
    sent,
    errors,
  });
}

// Guarded so the module can be IMPORTED by a test under Node without starting
// a server. Under Deno on Supabase this is the entry point.
const deno = (globalThis as { Deno?: { serve?: (h: typeof handle) => unknown } }).Deno;
if (deno?.serve) deno.serve(handle);

async function markOutbox(rows: OutboxRow[], error: string): Promise<void> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  await rest(`push_outbox?id=in.(${ids.join(",")})`, {
    method: "PATCH",
    body: JSON.stringify({ last_error: error.slice(0, 400) }),
  });
}
