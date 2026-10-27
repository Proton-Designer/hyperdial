/**
 * TASK-H03: delivery of a "Log Close" form to the org's closes webhook (a Google Apps Script web
 * app that appends a Sheet row, or a GHL inbound-webhook trigger). Pure helpers live here so they
 * are unit-testable; close-delivery-worker/index.ts and log-contact-close/index.ts hold the I/O.
 */

export const CLOSE_MAX_ATTEMPTS = 6;
const RETRY_DELAYS_MIN = [5, 15, 60, 180, 360];
const REQUEST_TIMEOUT_MS = 10_000;
/** Apps Script answers a POST with a 302 to this host once the script has already run. */
export const APPS_SCRIPT_ECHO_HOST = 'script.googleusercontent.com';

export interface CloseRow {
  id: string;
  org_id: string;
  contact_id: string;
  closed_by: string;
  owner_name: string;
  business_name: string;
  mobile: string;
  email: string | null;
  services: string[];
  cities: string[];
  frequencies: string[];
  insured: boolean;
  best_contact: string | null;
  starting_price: number | string | null;
  capacity: number | null;
  years_in_business: number | null;
  created_at: string;
  delivery_attempts: number;
}

export interface CloseAgent {
  id: string;
  name: string | null;
}

export function buildClosePayload(close: CloseRow, agent: CloseAgent) {
  return {
    event: 'contact.closed',
    version: 1,
    close_id: close.id,
    closed_at: close.created_at,
    contact_id: close.contact_id,
    agent: { id: agent.id, name: agent.name },
    form: {
      owner_name: close.owner_name,
      business_name: close.business_name,
      mobile: close.mobile,
      email: close.email,
      services: close.services,
      cities: close.cities,
      frequencies: close.frequencies,
      insured: close.insured,
      best_contact: close.best_contact,
      starting_price:
        close.starting_price === null || close.starting_price === undefined
          ? null
          : Number(close.starting_price),
      capacity: close.capacity,
      years_in_business: close.years_in_business,
    },
  };
}

/** HMAC-SHA256 over `${timestamp}.${body}`, hex. The receiver recomputes it with the shared secret. */
export async function signBody(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`)
  );
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Server-side URL guard (the org owner types this URL; the platform's server calls it).
 * https only, no credentials, no IP literals, no localhost/internal-looking names, standard port.
 * DNS rebinding is not defended here (Deno has no resolve-then-pin) -- the URL is owner/admin-set.
 */
export function validateWebhookUrl(
  raw: string
): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'Not a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'URL must start with https://' };
  if (url.username || url.password) return { ok: false, error: 'URL must not contain credentials' };
  if (url.port && url.port !== '443')
    return { ok: false, error: 'Only the default https port is allowed' };
  const host = url.hostname.toLowerCase();
  // A trailing dot ("localhost.", "db.internal.") is the same host for DNS but slips past the suffix checks below.
  if (host.endsWith('.') || host.includes('..')) {
    return { ok: false, error: 'Hostnames ending in a dot are not allowed' };
  }
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return { ok: false, error: 'IP addresses are not allowed; use a hostname' };
  }
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)
  ) {
    return { ok: false, error: 'Internal hostnames are not allowed' };
  }
  if (raw.length > 2000) return { ok: false, error: 'URL is too long' };
  return { ok: true, url };
}

export type DeliveryOutcome =
  { kind: 'sent' } | { kind: 'retry'; error: string } | { kind: 'permanent'; error: string };

export interface DeliverArgs {
  url: string;
  secret: string | null;
  payload: unknown;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * POSTs the payload once. Redirects are never followed: a 302/303 to script.googleusercontent.com
 * is the normal Apps Script "script ran" answer and counts as delivered; any other redirect fails.
 */
export async function deliverClose(args: DeliverArgs): Promise<DeliveryOutcome> {
  const guard = validateWebhookUrl(args.url);
  if (!guard.ok) return { kind: 'permanent', error: guard.error };
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = JSON.stringify(args.payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Softdial-Closes/1',
  };
  if (args.secret) {
    const ts = String(Math.floor((args.now ?? Date.now)() / 1000));
    headers['X-Softdial-Timestamp'] = ts;
    headers['X-Softdial-Signature'] = `sha256=${await signBody(args.secret, ts, body)}`;
  }

  let res: Response;
  try {
    res = await fetchImpl(guard.url.toString(), {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      kind: 'retry',
      error: `request failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    };
  }
  const status = res.status;
  await res.body?.cancel().catch(() => {});

  if (status >= 200 && status < 300) return { kind: 'sent' };
  if (status === 302 || status === 303) {
    const loc = res.headers.get('location');
    try {
      const target = loc ? new URL(loc, guard.url) : null;
      if (target && target.protocol === 'https:' && target.hostname === APPS_SCRIPT_ECHO_HOST) {
        return { kind: 'sent' };
      }
    } catch {
      /* fall through */
    }
    return { kind: 'permanent', error: `redirect (${status}) to another host was not followed` };
  }
  if (status >= 300 && status < 400) {
    return { kind: 'permanent', error: `redirect (${status}) was not followed` };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: 'retry', error: `receiver answered HTTP ${status}` };
  }
  return { kind: 'permanent', error: `receiver rejected the request (HTTP ${status})` };
}

export type NextState =
  | { status: 'sent'; nextAttemptAt: null }
  | { status: 'pending'; nextAttemptAt: string }
  | { status: 'failed'; nextAttemptAt: null };

/** `attempts` already includes the attempt that just ran (claim increments it). */
export function nextDeliveryState(
  outcome: DeliveryOutcome,
  attempts: number,
  now: number = Date.now()
): NextState {
  if (outcome.kind === 'sent') return { status: 'sent', nextAttemptAt: null };
  if (outcome.kind === 'permanent' || attempts >= CLOSE_MAX_ATTEMPTS) {
    return { status: 'failed', nextAttemptAt: null };
  }
  const delayMin = RETRY_DELAYS_MIN[Math.min(attempts - 1, RETRY_DELAYS_MIN.length - 1)];
  return { status: 'pending', nextAttemptAt: new Date(now + delayMin * 60_000).toISOString() };
}
