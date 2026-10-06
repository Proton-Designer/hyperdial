// Shifts subsystem (TASK-S02): the I/O half shared by the shifts-* / shift-* edge functions --
// auth + org resolution, the {error, message} response shape, settings/enabled gate, request DTO
// hydration and the fire-and-forget nudge of shift-ghl-sync. Pure logic lives in shifts-core.ts.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from './cors.ts';
import { requireOrgRole, type OrgRole } from './auth.ts';
import {
  mapRequest,
  mapSettings,
  parseShiftRpcError,
  shiftErrorBody,
  shiftErrorStatus,
  type RequestRow,
  type ShiftRow,
  type ShiftSettingsRow,
} from './shifts-core.ts';

export interface ShiftsCtx {
  supabase: SupabaseClient;
  userId: string;
  orgId: string;
  role: OrgRole;
  /** owner / admin / manager: full names in rosters, admin screens. */
  managerLevel: boolean;
}

export const ALL_ROLES: OrgRole[] = ['owner', 'admin', 'manager', 'agent'];
export const MANAGER_ROLES: OrgRole[] = ['owner', 'admin', 'manager'];

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function shiftsError(code: string, detail: Record<string, unknown> = {}): Response {
  return jsonResponse(shiftErrorStatus(code), shiftErrorBody(code, detail));
}

/** Maps a failed PostgREST/RPC call to the shifts error shape, or a generic 500. */
export function rpcErrorResponse(
  err: { code?: string; message?: string; details?: string | null },
  where: string
): Response {
  const parsed = parseShiftRpcError(err);
  if (parsed) return shiftsError(parsed.code, parsed.detail);
  console.error(`${where}:`, err.code, err.message);
  return jsonResponse(500, { error: 'server_error', message: 'Something went wrong. Try again.' });
}

/** Authenticates + resolves the caller's org/role (requireOrgRole), re-shaping its auth failures
 *  into the shifts `{error: <code>, message}` form. */
export async function shiftsAuth(
  req: Request,
  roles: OrgRole[] = ALL_ROLES
): Promise<{ ctx: ShiftsCtx; response?: undefined } | { ctx?: undefined; response: Response }> {
  const auth = await requireOrgRole(req, roles);
  if (auth.error) {
    let message = 'Something went wrong. Try again.';
    try {
      const body = (await auth.error.clone().json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep the generic message
    }
    const code =
      auth.error.status === 401
        ? 'unauthorized'
        : auth.error.status === 403
          ? 'forbidden'
          : 'bad_request';
    return {
      response: jsonResponse(auth.error.status, { error: code, message }),
    };
  }
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  return {
    ctx: {
      supabase,
      userId: auth.user.id,
      orgId: auth.orgId,
      role: auth.role,
      managerLevel: MANAGER_ROLES.includes(auth.role),
    },
  };
}

/** Seeds the org config on first use and returns the settings row (throws on a DB error). */
export async function loadSettings(ctx: ShiftsCtx): Promise<ShiftSettingsRow> {
  const { error: seedErr } = await ctx.supabase.rpc('shift_ensure_config', { p_org: ctx.orgId });
  if (seedErr) throw new Error(`shift_ensure_config: ${seedErr.message}`);
  const { data, error } = await ctx.supabase
    .from('shift_settings')
    .select('*')
    .eq('org_id', ctx.orgId)
    .single();
  if (error || !data) throw new Error(`shift_settings: ${error?.message ?? 'missing'}`);
  return data as ShiftSettingsRow;
}

export { mapSettings };

/** Display names for user ids (`full` = true for manager-level readers). */
export async function loadNames(
  ctx: ShiftsCtx,
  ids: string[],
  full: boolean
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data, error } = await ctx.supabase.rpc('shift_member_names', {
    p_ids: unique,
    p_full: full,
  });
  if (error) throw new Error(`shift_member_names: ${error.message}`);
  return new Map((data as { user_id: string; name: string }[]).map((r) => [r.user_id, r.name]));
}

const COUNTED = ['scheduled', 'completed', 'missed'];

/** Full ShiftRequest DTOs for a set of rows: fromShift, user/reviewer names, hoursBefore/After. */
export async function hydrateRequests(ctx: ShiftsCtx, rows: RequestRow[]) {
  if (rows.length === 0) return [];
  const fromIds = [...new Set(rows.map((r) => r.from_shift_id).filter((x): x is string => !!x))];
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const weeks = [...new Set(rows.map((r) => r.week_start))];

  const [fromRes, hoursRes, names, pendingRes] = await Promise.all([
    fromIds.length
      ? ctx.supabase.from('shifts').select('*').eq('org_id', ctx.orgId).in('id', fromIds)
      : Promise.resolve({ data: [] as ShiftRow[], error: null }),
    ctx.supabase
      .from('shifts')
      .select('user_id, week_start, hours')
      .eq('org_id', ctx.orgId)
      .in('user_id', userIds)
      .in('week_start', weeks)
      .in('status', COUNTED),
    loadNames(
      ctx,
      [...userIds, ...rows.map((r) => r.reviewer_id).filter((x): x is string => !!x)],
      true
    ),
    ctx.supabase
      .from('shift_change_requests')
      .select('from_shift_id')
      .eq('org_id', ctx.orgId)
      .eq('status', 'pending')
      .in('user_id', userIds),
  ]);
  for (const r of [fromRes, hoursRes, pendingRes]) {
    if (r.error) throw new Error(`hydrateRequests: ${r.error.message}`);
  }
  const fromById = new Map((fromRes.data as ShiftRow[]).map((s) => [s.id, s]));
  const hoursBy = new Map<string, number>();
  for (const h of hoursRes.data as {
    user_id: string;
    week_start: string;
    hours: number | string;
  }[]) {
    const k = `${h.user_id}|${h.week_start}`;
    hoursBy.set(k, (hoursBy.get(k) ?? 0) + Number(h.hours));
  }
  const pending = new Set(
    (pendingRes.data as { from_shift_id: string | null }[])
      .map((p) => p.from_shift_id)
      .filter((x): x is string => !!x)
  );
  return rows.map((r) =>
    mapRequest(r, {
      userName: names.get(r.user_id) ?? 'Member',
      reviewerName: r.reviewer_id ? (names.get(r.reviewer_id) ?? null) : null,
      fromShift: r.from_shift_id ? (fromById.get(r.from_shift_id) ?? null) : null,
      hoursBefore: hoursBy.get(`${r.user_id}|${r.week_start}`) ?? 0,
      pendingShiftIds: pending,
    })
  );
}

/** Ask shift-ghl-sync (S04) to drain the outbox now. Fire and forget: the cron drains it anyway,
 *  and the function may not be deployed yet -- neither may ever fail the user's request. */
export function nudgeShiftGhlSync(): void {
  const base = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) return;
  const p = fetch(`${base}/functions/v1/shift-ghl-sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: '{}',
  })
    .then((r) => r.body?.cancel())
    .catch((e) => console.warn('shift-ghl-sync nudge failed:', String(e)));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
}

/** Shared shell of the admin-* POST functions: CORS, method, manager-level auth (403 otherwise), JSON
 *  body, and a uniform 500. `roles` narrows further (e.g. owner/admin only) when a function needs it. */
export async function handleAdminPost(
  req: Request,
  name: string,
  run: (ctx: ShiftsCtx, body: unknown) => Promise<Response>,
  roles: OrgRole[] = MANAGER_ROLES
): Promise<Response> {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST')
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use POST.' });
  const auth = await shiftsAuth(req, roles);
  if (auth.response) return auth.response;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  try {
    return await run(auth.ctx, body);
  } catch (e) {
    console.error(`${name} failed:`, String(e));
    return jsonResponse(500, {
      error: 'server_error',
      message: 'Something went wrong. Try again.',
    });
  }
}
