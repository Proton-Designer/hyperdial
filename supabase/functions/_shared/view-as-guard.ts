/**
 * TASK-H21: "View as intern". A view-as session is a real GoTrue session minted for the intern (view-as-start); the row in
 * `view_as_sessions` is what marks it. This guard runs inside `getUserFromRequest` (_shared/auth.ts), the one function every
 * user-JWT Edge Function authenticates through, so it covers every requireOrgRole / requireTelnyxOrgRole / shiftsAuth call.
 *
 * A view-as token may only call a function listed in VIEW_AS_ALLOWLIST with a listed method. Anything else, including a
 * function added tomorrow, is refused with 403 'View-only' (default DENY). The DB side is db_pre_request (read-only
 * transactions); this layer exists because Edge Functions write with the service role, which that layer cannot see.
 * A lookup failure fails CLOSED (503) for that request.
 */
import { corsHeaders } from './cors.ts';

/** function name -> methods a view-as token may use. Every entry was checked to perform no write (audit/H21/design.md §4). */
export const VIEW_AS_ALLOWLIST: Record<string, readonly string[]> = {
  'dialer-session-get': ['GET'],
  'dialer-session-active': ['GET'],
  'shifts-week-get': ['GET'],
  'admin-shifts-overview': ['GET'],
  'dashboard-stats': ['GET'],
  'team-performance': ['GET'],
  'analytics-summary': ['GET'],
  'org-audit-log': ['GET'],
  'org-members': ['GET'],
  'telnyx-spend-status': ['GET'],
  'telnyx-list-numbers': ['GET'],
  'voicemail-upload': ['GET'],
  // POST that only returns a signed URL (no write)
  'recording-url': ['POST'],
  // Exit: the view-as token ends its own session
  'view-as-stop': ['POST'],
};

/** OPTIONS is the CORS preflight and never reaches auth; listed so a future caller cannot trip over it. */
const ALWAYS_OK_METHODS = new Set(['OPTIONS']);

export function isViewAsAllowed(fnName: string | null, method: string): boolean {
  if (ALWAYS_OK_METHODS.has(method.toUpperCase())) return true;
  if (!fnName) return false;
  const methods = Object.prototype.hasOwnProperty.call(VIEW_AS_ALLOWLIST, fnName)
    ? VIEW_AS_ALLOWLIST[fnName]
    : undefined;
  return !!methods && methods.includes(method.toUpperCase());
}

/**
 * The function the gateway routes this request to: the FIRST segment after `/functions/v1/` (inside the runtime the prefix may
 * already be stripped, so the first segment is then the name). Any extra path segment returns null (= deny): the gateway
 * routes `/functions/v1/dialer-session-start/dashboard-stats` to dialer-session-start, so taking the LAST segment would let
 * a view token pass an allowlisted name in front of a write function.
 */
export function functionNameFromUrl(url: string): string | null {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const i = segs.findIndex((x, k) => x === 'functions' && segs[k + 1] === 'v1');
    const rest = i >= 0 ? segs.slice(i + 2) : segs;
    if (rest.length !== 1) return null;
    return decodeURIComponent(rest[0]);
  } catch {
    return null;
  }
}

/**
 * The `session_id` claim of a JWT. NOT a verification: callers have already validated the token with GoTrue
 * (`auth.getUser(token)`), which also rejects a signed-out session, so reading the claim here is safe.
 */
export function jwtSessionId(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const claims = JSON.parse(json) as { session_id?: unknown };
    return typeof claims.session_id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.session_id)
      ? claims.session_id
      : null;
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

export interface ViewAsRow {
  session_id: string;
  org_id: string;
  viewer_id: string;
  target_id: string;
  ended_at: string | null;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
// Per-isolate. Safe to cache both answers: the view_as_sessions row is written BEFORE its token is handed out (so a "not a
// view session" answer can never predate the row), and an ended session is already refused by GoTrue's getUser.
const cache = new Map<string, { at: number; row: ViewAsRow | null }>();

export function clearViewAsCache() {
  cache.clear();
}

export async function lookupViewAsSession(
  supabase: SupabaseAny,
  sessionId: string
): Promise<ViewAsRow | null> {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.row;
  const { data, error } = await supabase
    .from('view_as_sessions')
    .select('session_id, org_id, viewer_id, target_id, ended_at')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data as ViewAsRow | null) ?? null;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(sessionId, { at: Date.now(), row });
  return row;
}

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Returns a Response to send instead of running the function, or null when the request may proceed. */
export async function checkViewAs(
  supabase: SupabaseAny,
  token: string,
  req: Request
): Promise<Response | null> {
  const sessionId = jwtSessionId(token);
  if (!sessionId) return null; // no session claim: not a GoTrue user session, nothing to restrict
  let row: ViewAsRow | null;
  try {
    row = await lookupViewAsSession(supabase, sessionId);
  } catch (err) {
    console.error('[view-as-guard] lookup failed, failing closed', err);
    return deny(503, 'Could not verify the session. Try again.');
  }
  if (!row) return null;
  if (row.ended_at) return deny(401, 'This view-only session has ended.');
  if (isViewAsAllowed(functionNameFromUrl(req.url), req.method)) return null;
  return deny(403, 'View-only');
}
