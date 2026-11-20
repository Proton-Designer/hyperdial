/**
 * TASK-H37: pure core of the read-only public Calls API (Edge Function `public-api`).
 * GET /v1/calls?since=<ISO>&cursor=<opaque>   header x-api-key. Org comes from the key ONLY (never a parameter).
 * All I/O is injected (`deps`) so the auth / paging / failure rules are unit-testable without a database.
 */
export const PAGE_LIMIT = 200;
export const RATE_LIMIT_PER_MINUTE = 60;
export const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;
const SIGN_TIMEOUT_MS = 8000;
const SIGN_CONCURRENCY = 10;

export interface CallRow {
  id: string;
  ended_at: string;
  duration_seconds: number | null;
  agent_name: string | null;
  agent_email: string | null;
  campaign: string | null;
  disposition: string | null;
  contact_name: string | null;
  contact_business: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  contact_timezone: string | null;
  contact_notes: string | null;
  callback_at: string | null;
  recording_path: string | null;
  recording_status: string | null;
  recording_channels: number | null;
}

export interface KeyCheck {
  org_id: string;
  key_id: string;
  allowed: boolean;
}

export interface PublicApiDeps {
  /** sha256 hex of the presented key -> the key's org/limit result, or null when unknown/revoked. */
  checkKey: (keyHash: string) => Promise<KeyCheck | null>;
  listCalls: (args: {
    orgId: string;
    since: string;
    afterEndedAt: string | null;
    afterId: string | null;
    limit: number;
  }) => Promise<CallRow[]>;
  /** Signed download URL for a storage path, or null on failure. May throw; the caller isolates it. */
  signUrl: (path: string) => Promise<string | null>;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

/** Strict ISO-8601 parse (date or datetime; no timezone = UTC). null when not a real instant. */
export function parseIsoInstant(raw: string): string | null {
  const s = raw.trim();
  if (!ISO_RE.test(s)) return null;
  let norm = s.replace(' ', 'T');
  if (!/[Tt]/.test(norm)) norm += 'T00:00:00Z';
  else if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(norm)) norm += 'Z';
  const t = Date.parse(norm);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function encodeCursor(endedAt: string, id: string): string {
  const raw = JSON.stringify([endedAt, id]);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): { endedAt: string; id: string } | null {
  try {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(cursor)) return null;
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [endedAt, id] = parsed;
    if (typeof endedAt !== 'string' || typeof id !== 'string' || !UUID_RE.test(id)) return null;
    const iso = parseIsoInstant(endedAt);
    return iso ? { endedAt: iso, id } : null;
  } catch {
    return null;
  }
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function signSafely(
  deps: PublicApiDeps,
  path: string
): Promise<{ url: string | null; failed: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = await Promise.race([
      deps.signUrl(path),
      new Promise<null>((_, rej) => {
        timer = setTimeout(() => rej(new Error('sign timeout')), SIGN_TIMEOUT_MS);
      }),
    ]);
    return url ? { url, failed: false } : { url: null, failed: true };
  } catch {
    return { url: null, failed: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function handlePublicApi(req: Request, deps: PublicApiDeps): Promise<Response> {
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  const url = new URL(req.url);
  if (!/\/v1\/calls\/?$/.test(url.pathname)) return json(404, { error: 'Not found' });

  const key = (req.headers.get('x-api-key') ?? '').trim();
  if (!/^hd_live_[0-9A-Za-z]{20,100}$/.test(key))
    return json(401, { error: 'Invalid or missing API key' });
  let check: KeyCheck | null;
  try {
    check = await deps.checkKey(await sha256Hex(key));
  } catch {
    return json(503, { error: 'Temporarily unavailable' }, { 'Retry-After': '5' });
  }
  if (!check) return json(401, { error: 'Invalid or missing API key' });
  if (!check.allowed) {
    return json(
      429,
      { error: `Rate limit: ${RATE_LIMIT_PER_MINUTE} requests per minute` },
      { 'Retry-After': '30' }
    );
  }

  const cursorRaw = url.searchParams.get('cursor');
  const sinceRaw = url.searchParams.get('since');
  let since: string;
  let afterEndedAt: string | null = null;
  let afterId: string | null = null;
  if (cursorRaw) {
    const c = decodeCursor(cursorRaw);
    if (!c) return json(400, { error: 'Invalid cursor' });
    afterEndedAt = c.endedAt;
    afterId = c.id;
    since = '-infinity';
    if (sinceRaw) {
      const s = parseIsoInstant(sinceRaw);
      if (!s)
        return json(400, {
          error: 'since must be an ISO 8601 timestamp, e.g. 2026-11-19T00:00:00Z',
        });
      since = s;
    }
  } else {
    if (!sinceRaw)
      return json(400, { error: 'since (ISO 8601 timestamp) is required unless cursor is given' });
    const s = parseIsoInstant(sinceRaw);
    if (!s)
      return json(400, { error: 'since must be an ISO 8601 timestamp, e.g. 2026-11-19T00:00:00Z' });
    since = s;
  }

  let rows: CallRow[];
  try {
    rows = await deps.listCalls({
      orgId: check.org_id,
      since,
      afterEndedAt,
      afterId,
      limit: PAGE_LIMIT,
    });
  } catch {
    return json(500, { error: 'Failed to load calls' });
  }
  rows = rows.slice(0, PAGE_LIMIT);

  const signed = await mapLimited(rows, SIGN_CONCURRENCY, (r) =>
    r.recording_path
      ? signSafely(deps, r.recording_path)
      : Promise.resolve({ url: null, failed: false })
  );

  const calls = rows.map((r, i) => {
    const s = signed[i];
    const hasRecording = !!r.recording_path;
    return {
      id: r.id,
      ended_at: r.ended_at,
      duration_seconds: r.duration_seconds,
      agent: { name: r.agent_name, email: r.agent_email },
      campaign: r.campaign,
      disposition: r.disposition,
      contact: {
        name: r.contact_name,
        business: r.contact_business,
        phone: r.contact_phone,
        email: r.contact_email,
        timezone: r.contact_timezone,
        notes: r.contact_notes,
      },
      callback_at: r.callback_at,
      recording_url: s.url,
      recording_status: r.recording_status,
      recording_channels: hasRecording ? (r.recording_channels ?? 2) : null,
      recording_channel_map: hasRecording ? { left: 'contact', right: 'agent' } : null,
      ...(s.failed ? { recording_error: 'signing_failed' } : {}),
    };
  });

  const last = rows[rows.length - 1];
  return json(200, {
    calls,
    next_cursor: last
      ? encodeCursor(new Date(last.ended_at).toISOString(), last.id)
      : (cursorRaw ?? null),
    has_more: rows.length === PAGE_LIMIT,
  });
}
