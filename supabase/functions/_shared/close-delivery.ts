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
  // TASK-H28: nothing on the form is required, so these can all be null (and the lists empty)
  owner_name: string | null;
  business_name: string | null;
  mobile: string | null;
  email: string | null;
  services: string[];
  cities: string[];
  frequencies: string[];
  insured: boolean | null;
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

// ---- outbound address guard (TASK-H05) --------------------------------------------------------------------------

/** Parses dotted IPv4 into 4 octets, or null. */
function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** True for any IPv4 address a public webhook must never resolve to. */
export function isBlockedIpv4(o: number[]): boolean {
  const [a, b, c] = o;
  return (
    a === 0 || //                          0.0.0.0/8 "this network"
    a === 10 || //                         RFC1918
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a === 127 || //                        loopback
    (a === 169 && b === 254) || //         link-local (cloud metadata lives here)
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || //         RFC1918
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 //                            multicast, reserved, broadcast
  );
}

/** Expands an IPv6 literal into 8 16-bit groups, or null when it is not one. */
function parseIpv6(raw: string): number[] | null {
  let s = raw.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  // dotted IPv4 tail ("::ffff:1.2.3.4") -> two hex groups
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = parseIpv4(tail[1]);
    if (!v4) return null;
    s =
      s.slice(0, -tail[1].length) +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ':' +
      ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...rest];
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((n) => !Number.isNaN(n)) ? out : null;
}

export function isBlockedIpv6(g: number[]): boolean {
  const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zeros5 = g.slice(0, 5).every((n) => n === 0);
  if (g.every((n) => n === 0)) return true; //                              :: unspecified
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; //    ::1 loopback
  if (zeros5 && g[5] === 0xffff) return isBlockedIpv4(embeddedV4(g[6], g[7])); // ::ffff:a.b.c.d mapped
  if (zeros5 && g[5] === 0) return true; //                                 ::a.b.c.d deprecated IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0))
    return isBlockedIpv4(embeddedV4(g[6], g[7])); //                        64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return isBlockedIpv4(embeddedV4(g[1], g[2])); //      6to4 embeds an IPv4
  if (g[0] === 0x2001 && g[1] === 0) return true; //                        Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; //                    documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  if ((g[0] & 0xfe00) === 0xfc00) return true; //                           fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; //                           fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; //                           fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true; //                           ff00::/8 multicast
  return false;
}

/** True when `addr` (an A or AAAA answer) is not safe to connect to. Unparseable answers are blocked. */
export function isBlockedAddress(addr: string): boolean {
  const v4 = parseIpv4(addr);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(addr);
  return v6 ? isBlockedIpv6(v6) : true;
}

export type HostResolver = (host: string) => Promise<string[]>;

/** Default resolver: A + AAAA through Deno.resolveDns. A family that fails to resolve just contributes nothing. */
export const resolveHostAddresses: HostResolver = async (host) => {
  if (typeof Deno === 'undefined' || typeof Deno.resolveDns !== 'function') {
    throw new Error('dns resolution is not available in this runtime');
  }
  const [a, aaaa] = await Promise.allSettled([
    Deno.resolveDns(host, 'A'),
    Deno.resolveDns(host, 'AAAA'),
  ]);
  const out: string[] = [];
  if (a.status === 'fulfilled') out.push(...a.value);
  if (aaaa.status === 'fulfilled') out.push(...(aaaa.value as string[]));
  return out;
};

/**
 * Runs before EVERY outbound request (delivery, test, and the Apps Script echo GET): resolves the host and refuses it
 * when ANY answer is a loopback/private/link-local/CGNAT/unique-local/multicast/unspecified address (or an IPv4-mapped /
 * NAT64 / 6to4 form of one). Nothing resolving is a transient failure (retry), a bad answer is permanent.
 *
 * Residual risk (known, accepted): `fetch` resolves the name again itself, so a DNS-rebinding server that answers
 * differently between this check and the connect can still slip through. Deno has no way to pin the checked address
 * while keeping TLS/SNI for the hostname; closing that gap needs an egress proxy that applies this same denylist.
 */
export async function checkHostResolvesPublic(
  host: string,
  resolver: HostResolver
): Promise<{ ok: true } | { ok: false; kind: 'retry' | 'permanent'; error: string }> {
  let addrs: string[];
  try {
    addrs = await resolver(host);
  } catch (err) {
    console.error(
      '[close-delivery] dns lookup failed',
      host,
      err instanceof Error ? err.message : err
    );
    return { ok: false, kind: 'retry', error: 'could not resolve the host' };
  }
  if (addrs.length === 0) return { ok: false, kind: 'retry', error: 'could not resolve the host' };
  if (addrs.some(isBlockedAddress)) {
    return {
      ok: false,
      kind: 'permanent',
      error: 'the host points at a private or internal address',
    };
  }
  return { ok: true };
}

/**
 * TASK-H08: the same address check at SAVE time, so an admin learns about a private host right away instead of at the
 * first delivery/test. A private/internal answer is refused; a host that does not resolve yet is saved with a warning
 * (the name may be created later; delivery re-checks and retries). Run only for a non-empty URL.
 */
export async function checkWebhookUrlForSave(
  raw: string,
  resolver: HostResolver = resolveHostAddresses
): Promise<{ ok: true; warning: string | null } | { ok: false; error: string }> {
  const guard = validateWebhookUrl(raw);
  if (!guard.ok) return { ok: false, error: guard.error };
  const resolved = await checkHostResolvesPublic(guard.url.hostname, resolver);
  if (resolved.ok) return { ok: true, warning: null };
  if (resolved.kind === 'permanent') {
    return {
      ok: false,
      error: 'That host points at a private or internal address, so it cannot be used.',
    };
  }
  return { ok: true, warning: 'Could not look up the host yet; delivery will retry.' };
}

export interface DeliverArgs {
  url: string;
  secret: string | null;
  payload: unknown;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test seam; defaults to Deno.resolveDns (A + AAAA). */
  resolveHost?: HostResolver;
}

const BODY_LIMIT = 4096;

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(all.slice(0, BODY_LIMIT));
}

function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Network-level failure -> a plain category. The raw error is logged server side, never stored or returned. */
function networkError(err: unknown): string {
  console.error(
    '[close-delivery] request failed',
    err instanceof Error ? `${err.name}: ${err.message}` : err
  );
  const name = err instanceof Error ? err.name : '';
  return name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'could not connect';
}

/**
 * Apps Script answers a POST with a 302/303 once the script has RUN, and the script's own output (our snippet returns
 * `{ok:true}` or `{ok:false,error}`) sits behind that redirect. Fetch it exactly once, no further redirects.
 */
async function readAppsScriptEcho(
  target: URL,
  fetchImpl: typeof fetch,
  resolver: HostResolver
): Promise<DeliveryOutcome> {
  const guard = await checkHostResolvesPublic(target.hostname, resolver);
  if (!guard.ok) return { kind: guard.kind, error: guard.error };
  let res: Response;
  try {
    res = await fetchImpl(target.toString(), {
      method: 'GET',
      headers: { 'User-Agent': 'Softdial-Closes/1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'retry', error: networkError(err) };
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => {});
    return { kind: 'retry', error: `script answer was HTTP ${res.status}` };
  }
  const text = await readCapped(res);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'retry', error: `script did not answer with JSON: ${oneLine(text, 160)}` };
  }
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  if (obj?.ok === true) return { kind: 'sent' };
  const detail = typeof obj?.error === 'string' ? obj.error : 'ok was not true';
  return { kind: 'retry', error: `script reported: ${oneLine(detail, 200)}` };
}

/**
 * POSTs the payload once. Redirects are never followed blindly: a 302/303 to script.googleusercontent.com (https only,
 * that host only) is the Apps Script "script ran" answer and its Location is read once (see readAppsScriptEcho); any
 * other redirect fails. Any 2xx from another receiver (e.g. a GHL inbound webhook) is delivered.
 */
export async function deliverClose(args: DeliverArgs): Promise<DeliveryOutcome> {
  const guard = validateWebhookUrl(args.url);
  if (!guard.ok) return { kind: 'permanent', error: guard.error };
  const fetchImpl = args.fetchImpl ?? fetch;
  const resolver = args.resolveHost ?? resolveHostAddresses;
  const resolved = await checkHostResolvesPublic(guard.url.hostname, resolver);
  if (!resolved.ok) return { kind: resolved.kind, error: resolved.error };

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
    return { kind: 'retry', error: networkError(err) };
  }
  const status = res.status;
  await res.body?.cancel().catch(() => {});

  if (status >= 200 && status < 300) return { kind: 'sent' };
  if (status === 302 || status === 303) {
    const loc = res.headers.get('location');
    let target: URL | null = null;
    try {
      target = loc ? new URL(loc, guard.url) : null;
    } catch {
      target = null;
    }
    if (
      target &&
      target.protocol === 'https:' &&
      target.hostname === APPS_SCRIPT_ECHO_HOST &&
      !target.port &&
      !target.username &&
      !target.password
    ) {
      return await readAppsScriptEcho(target, fetchImpl, resolver);
    }
    return { kind: 'permanent', error: `redirect (${status}) to another host was not followed` };
  }
  if (status >= 300 && status < 400) {
    return { kind: 'permanent', error: `redirect (${status}) was not followed` };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: 'retry', error: `rejected: HTTP ${status}` };
  }
  return { kind: 'permanent', error: `rejected: HTTP ${status}` };
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
