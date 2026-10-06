// TASK-S03: GET ?week=YYYY-MM-DD (a Monday; omitted = current week). Everything the Team Shifts screens
// need in one response (contract: docs/design/shifts.md section 3, AdminShiftsOverview in api.ts).
// Manager-level callers only; a manager sees only the interns of their pods (owner/admin: everyone).
// 409 shifts_disabled while Shifts is off (the screen shows its "Enable Shifts" card then).
import { corsPreflightResponse } from '../_shared/cors.ts';
import {
  MANAGER_ROLES,
  hydrateRequests,
  jsonResponse,
  loadNames,
  loadSettings,
  rpcErrorResponse,
  shiftsAuth,
  shiftsError,
} from '../_shared/shifts-io.ts';
import {
  buildWeekInfo,
  currentWeekStart,
  mapCommitment,
  mapKpi,
  mapOpenHours,
  mapPowerWindow,
  mapSettings,
  mapShift,
  parseWeekParam,
  type CommitmentRow,
  type KpiRow,
  type OpenHoursRow,
  type PowerWindowRow,
  type RequestRow,
  type ShiftRow,
} from '../_shared/shifts-core.ts';
import {
  buildCallouts,
  buildRollup,
  mapAdminMember,
  syncHealth,
  type MemberRow,
  type OutboxHealthRow,
} from '../_shared/shifts-admin.ts';

const NO_ONE = '00000000-0000-0000-0000-000000000000';
const PENDING_LIMIT = 200;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'GET')
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use GET.' });

  const auth = await shiftsAuth(req, MANAGER_ROLES);
  if (auth.response) return auth.response;
  const ctx = auth.ctx;

  try {
    const settings = await loadSettings(ctx);
    if (!settings.enabled) return shiftsError('shifts_disabled');

    const parsed = parseWeekParam(new URL(req.url).searchParams.get('week'));
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const nowMs = Date.now();
    const thisWeek = currentWeekStart(nowMs, settings.timezone);
    const weekStart = parsed.value ?? thisWeek;
    const sb = ctx.supabase;

    const membersRes = await sb.rpc('shift_admin_members', {
      p_org: ctx.orgId,
      p_actor: ctx.userId,
    });
    if (membersRes.error) return rpcErrorResponse(membersRes.error, 'shift_admin_members');
    const memberRows = (membersRes.data ?? []) as MemberRow[];
    const scope = memberRows.length ? memberRows.map((m) => m.user_id) : [NO_ONE];

    const [openRes, windowsRes, shiftsRes, commitRes, pendingRes, decidedRes, outboxRes] =
      await Promise.all([
        sb.from('open_hours').select('*').eq('org_id', ctx.orgId).order('iso_weekday'),
        sb.from('power_windows').select('*').eq('org_id', ctx.orgId).order('start_time'),
        sb
          .from('shifts')
          .select('*')
          .eq('org_id', ctx.orgId)
          .eq('week_start', weekStart)
          .in('user_id', scope)
          .order('starts_at'),
        sb
          .from('week_commitments')
          .select('*')
          .eq('org_id', ctx.orgId)
          .eq('week_start', weekStart)
          .in('user_id', scope),
        sb
          .from('shift_change_requests')
          .select('*')
          .eq('org_id', ctx.orgId)
          .eq('status', 'pending')
          .in('user_id', scope)
          .order('created_at', { ascending: true })
          .limit(PENDING_LIMIT),
        sb
          .from('shift_change_requests')
          .select('*')
          .eq('org_id', ctx.orgId)
          .eq('week_start', weekStart)
          .neq('status', 'pending')
          .in('user_id', scope)
          .order('created_at', { ascending: true })
          .limit(PENDING_LIMIT),
        sb
          .from('shift_ghl_outbox')
          .select('id, kind, event, user_id, status, last_error, attempts, created_at')
          .eq('org_id', ctx.orgId)
          .or('status.eq.error,and(status.eq.pending,last_error.not.is.null)')
          .order('id', { ascending: false })
          .limit(200),
      ]);
    for (const r of [
      openRes,
      windowsRes,
      shiftsRes,
      commitRes,
      pendingRes,
      decidedRes,
      outboxRes,
    ]) {
      if (r.error) throw new Error(`admin-shifts-overview query: ${r.error.message}`);
    }
    const shifts = (shiftsRes.data ?? []) as ShiftRow[];
    const commitments = (commitRes.data ?? []) as (CommitmentRow & { user_id: string })[];

    const kpiRes = shifts.length
      ? await sb
          .from('shift_kpis')
          .select('*')
          .in(
            'shift_id',
            shifts.map((s) => s.id)
          )
      : { data: [], error: null };
    if (kpiRes.error) throw new Error(`shift_kpis: ${kpiRes.error.message}`);
    const kpis = (kpiRes.data ?? []) as KpiRow[];

    const requestRows = [
      ...((pendingRes.data ?? []) as RequestRow[]),
      ...((decidedRes.data ?? []) as RequestRow[]),
    ];
    const requests = await hydrateRequests(ctx, requestRows);
    const pendingShiftIds = new Set(
      ((pendingRes.data ?? []) as RequestRow[])
        .map((r) => r.from_shift_id)
        .filter((x): x is string => !!x)
    );

    const members = memberRows.map(mapAdminMember);
    const nameOf = new Map(memberRows.map((m) => [m.user_id, m.name]));
    const inScope = new Set(memberRows.map((m) => m.user_id));
    const outbox = ((outboxRes.data ?? []) as OutboxHealthRow[]).filter(
      (r) => r.user_id === null || inScope.has(r.user_id)
    );

    const weekClosed = weekStart < thisWeek;
    const shortNames = weekClosed
      ? await loadNames(
          ctx,
          commitments.filter((c) => c.power_week).map((c) => c.user_id),
          false
        )
      : new Map<string, string>();

    return jsonResponse(200, {
      week: buildWeekInfo(weekStart, settings, null, nowMs),
      settings: mapSettings(settings, true),
      openHours: ((openRes.data ?? []) as OpenHoursRow[]).map(mapOpenHours),
      powerWindows: ((windowsRes.data ?? []) as PowerWindowRow[]).map(mapPowerWindow),
      members,
      shifts: shifts.map((s) => ({
        ...mapShift(s, pendingShiftIds),
        userName: nameOf.get(s.user_id) ?? 'Member',
      })),
      commitments: commitments.map((c) => ({ ...mapCommitment(c), userId: c.user_id })),
      requests,
      kpis: kpis.map(mapKpi),
      rollup: buildRollup({
        members: memberRows.map((m) => ({
          userId: m.user_id,
          name: m.name,
          participates: m.participates,
        })),
        shifts,
        commitments,
        kpis,
      }),
      powerWeekCallouts: weekClosed ? buildCallouts(commitments, kpis, shortNames) : [],
      syncHealth: syncHealth(outbox, nameOf),
    });
  } catch (e) {
    console.error('admin-shifts-overview failed:', String(e));
    return jsonResponse(500, {
      error: 'server_error',
      message: 'Something went wrong. Try again.',
    });
  }
});
