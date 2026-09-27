/**
 * MISSION-5 TASK-A1: the Activity page's own read path, plus a narrow write path for the handful
 * of audit-worthy actions that happen entirely client-side today (CSV export -- `rowsToCsv`/
 * `downloadCsv`, per `apps/web/src/lib/csv.ts`'s own header, never round-trips to a server).
 *
 * GET: owner/admin only (same tier as the Activity page itself). Filters: actor, action (exact
 * match; the client passes one of the ACTION labels this repo writes -- see
 * `.brain/domains/auth.md`'s own table), a [from, to) date range, paged via limit/offset. Actor
 * names are resolved via `profiles` in one extra query (never `auth.admin.getUserById` per row --
 * see `audit/M5/current-state.md`'s TM-X1 finding on `org-members`'s own N+1 there; this endpoint
 * deliberately doesn't repeat it since a name, not an email, is all an activity log needs).
 *
 * POST: also owner/admin only (both of today's client-originated actions -- exporting the Team
 * daily table or the Analytics funnel -- are already gated behind an owner/admin-only route, see
 * MainApp.tsx). `name` must be one of LOGGABLE_CLIENT_EVENTS -- an allowlist, not a free-text
 * action label, so a compromised/buggy client can at most mislabel one of these two specific
 * events, never inject an arbitrary action string into the log.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const LOGGABLE_CLIENT_EVENTS: Record<string, { targetType: string }> = {
  'export.team_csv': { targetType: 'team_daily_stats' },
  'export.analytics_csv': { targetType: 'analytics' },
  // MISSION-5 TASK-M5-A4: Team.tsx's new Attendance tab CSV export -- same client-only shape as
  // the other two (rowsToCsv/downloadCsv never round-trips to a server on their own).
  'export.attendance_csv': { targetType: 'agent_time_in_state' },
};

interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (req.method === 'GET') {
    const { orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
    if (authError) return authError;

    const url = new URL(req.url);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(
        1,
        parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT
      )
    );
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
    const actor = url.searchParams.get('actor')?.trim() || null;
    const action = url.searchParams.get('action')?.trim() || null;
    const from = url.searchParams.get('from')?.trim() || null;
    const to = url.searchParams.get('to')?.trim() || null;

    let query = supabase
      .from('org_audit_log')
      .select('id, actor_user_id, action, target_type, target_id, details, created_at', {
        count: 'exact',
      })
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (actor) query = query.eq('actor_user_id', actor);
    if (action) query = query.eq('action', action);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lt('created_at', to);

    const { data: rows, error, count } = await query;
    if (error) {
      console.error('org-audit-log list error:', error.message);
      return jsonError(500, 'Failed to list activity');
    }

    const actorIds = Array.from(
      new Set(
        (rows ?? []).map((r: AuditLogRow) => r.actor_user_id).filter((id): id is string => !!id)
      )
    );
    const { data: profiles } = actorIds.length
      ? await supabase
          .from('profiles')
          .select('user_id, first_name, last_name')
          .in('user_id', actorIds)
      : { data: [] as { user_id: string; first_name: string | null; last_name: string | null }[] };
    const nameMap = new Map(
      (profiles ?? []).map(
        (p: { user_id: string; first_name: string | null; last_name: string | null }) => [
          p.user_id,
          [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
        ]
      )
    );

    const entries = (rows ?? []).map((r: AuditLogRow) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      actorName: r.actor_user_id ? (nameMap.get(r.actor_user_id) ?? null) : null,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: r.details,
      createdAt: r.created_at,
    }));

    return new Response(JSON.stringify({ entries, total: count ?? entries.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: { name?: string; targetId?: string; details?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }

  const eventDef = body.name ? LOGGABLE_CLIENT_EVENTS[body.name] : undefined;
  if (!body.name || !eventDef) {
    return jsonError(400, `name must be one of: ${Object.keys(LOGGABLE_CLIENT_EVENTS).join(', ')}`);
  }

  await logOrgAction(supabase, {
    orgId,
    actorUserId: user.id,
    action: body.name,
    targetType: eventDef.targetType,
    targetId: body.targetId ?? null,
    details: body.details ?? {},
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
