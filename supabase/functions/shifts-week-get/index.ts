// TASK-S02: GET ?week=YYYY-MM-DD (a Monday; omitted = the current week). Contract: docs/design/shifts.md
// section 3 -- every key below must match ShiftsWeekResponse in apps/web/src/lib/api.ts.
import { corsPreflightResponse } from '../_shared/cors.ts';
import {
  ALL_ROLES,
  hydrateRequests,
  jsonResponse,
  loadNames,
  loadSurveys,
  loadSettings,
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
  mapRosterEntry,
  mapSettings,
  mapShift,
  parseWeekParam,
  pickLiveShift,
  powerWeekSentence,
  type CommitmentRow,
  type KpiRow,
  type OpenHoursRow,
  type PowerWindowRow,
  type RequestRow,
  type RosterRow,
  type ShiftRow,
} from '../_shared/shifts-core.ts';

const REQUEST_WINDOW_DAYS = 60;
const POWER_WEEK_HISTORY = 12;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'GET')
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use GET.' });

  const auth = await shiftsAuth(req, ALL_ROLES);
  if (auth.response) return auth.response;
  const ctx = auth.ctx;

  try {
    const settings = await loadSettings(ctx);
    if (!settings.enabled) return shiftsError('shifts_disabled');

    const parsed = parseWeekParam(new URL(req.url).searchParams.get('week'));
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const nowMs = Date.now();
    const weekStart = parsed.value ?? currentWeekStart(nowMs, settings.timezone);

    const sb = ctx.supabase;
    const fifteenMinAhead = new Date(nowMs + 15 * 60000).toISOString();
    const [
      commitmentRes,
      openHoursRes,
      windowsRes,
      rosterRes,
      myShiftsRes,
      requestsRes,
      pendingRes,
      historyRes,
      liveRes,
    ] = await Promise.all([
      sb
        .from('week_commitments')
        .select('*')
        .eq('org_id', ctx.orgId)
        .eq('user_id', ctx.userId)
        .eq('week_start', weekStart)
        .maybeSingle(),
      sb.from('open_hours').select('*').eq('org_id', ctx.orgId).order('iso_weekday'),
      sb.from('power_windows').select('*').eq('org_id', ctx.orgId).order('start_time'),
      sb.rpc('shift_week_roster', {
        p_org: ctx.orgId,
        p_week_start: weekStart,
        p_full: ctx.managerLevel,
        p_viewer: ctx.userId,
      }),
      sb
        .from('shifts')
        .select('*')
        .eq('org_id', ctx.orgId)
        .eq('user_id', ctx.userId)
        .eq('week_start', weekStart)
        .order('starts_at'),
      sb
        .from('shift_change_requests')
        .select('*')
        .eq('org_id', ctx.orgId)
        .eq('user_id', ctx.userId)
        .gte('created_at', new Date(nowMs - REQUEST_WINDOW_DAYS * 86400000).toISOString())
        .order('created_at', { ascending: false })
        .limit(200),
      sb
        .from('shift_change_requests')
        .select('from_shift_id')
        .eq('org_id', ctx.orgId)
        .eq('user_id', ctx.userId)
        .eq('status', 'pending'),
      sb
        .from('week_commitments')
        .select('*')
        .eq('org_id', ctx.orgId)
        .eq('user_id', ctx.userId)
        .eq('power_week', true)
        .order('week_start', { ascending: false })
        .limit(POWER_WEEK_HISTORY),
      sb
        .from('shifts')
        .select('*')
        .eq('org_id', ctx.orgId)
        .eq('user_id', ctx.userId)
        .eq('status', 'scheduled')
        .lte('starts_at', fifteenMinAhead)
        .gt('ends_at', new Date(nowMs).toISOString()),
    ]);
    for (const r of [
      commitmentRes,
      openHoursRes,
      windowsRes,
      rosterRes,
      myShiftsRes,
      requestsRes,
      pendingRes,
      historyRes,
      liveRes,
    ]) {
      if (r.error) throw new Error(`shifts-week-get query: ${r.error.message}`);
    }

    const myShifts = (myShiftsRes.data ?? []) as ShiftRow[];
    const pendingShiftIds = new Set(
      ((pendingRes.data ?? []) as { from_shift_id: string | null }[])
        .map((p) => p.from_shift_id)
        .filter((x): x is string => !!x)
    );
    const commitment = (commitmentRes.data as CommitmentRow | null) ?? null;

    // KPIs for the caller's shifts this week (S05 fills the table; empty until then).
    let kpis: KpiRow[] = [];
    if (myShifts.length > 0) {
      const { data, error } = await sb
        .from('shift_kpis')
        .select('*')
        .in(
          'shift_id',
          myShifts.map((s) => s.id)
        );
      if (error) throw new Error(`shift_kpis: ${error.message}`);
      kpis = (data ?? []) as KpiRow[];
    }

    // Power-week history sentences (positive recognition only).
    const historyRows = (historyRes.data ?? []) as CommitmentRow[];
    let powerWeekHistory: { weekStart: string; sentence: string }[] = [];
    if (historyRows.length > 0) {
      const weeks = historyRows.map((h) => h.week_start);
      const [shiftsRes, nameMap] = await Promise.all([
        sb
          .from('shifts')
          .select('id, week_start')
          .eq('org_id', ctx.orgId)
          .eq('user_id', ctx.userId)
          .in('week_start', weeks),
        loadNames(ctx, [ctx.userId], false),
      ]);
      if (shiftsRes.error) throw new Error(`power history shifts: ${shiftsRes.error.message}`);
      const weekOf = new Map(
        (shiftsRes.data as { id: string; week_start: string }[]).map((s) => [s.id, s.week_start])
      );
      const kpiRes = weekOf.size
        ? await sb
            .from('shift_kpis')
            .select('shift_id, active_dial_minutes')
            .in('shift_id', [...weekOf.keys()])
        : { data: [], error: null };
      if (kpiRes.error) throw new Error(`power history kpis: ${kpiRes.error.message}`);
      const minutesByWeek = new Map<string, number>();
      for (const k of kpiRes.data as { shift_id: string; active_dial_minutes: number }[]) {
        const w = weekOf.get(k.shift_id);
        if (w) minutesByWeek.set(w, (minutesByWeek.get(w) ?? 0) + k.active_dial_minutes);
      }
      const name = nameMap.get(ctx.userId) ?? 'You';
      powerWeekHistory = historyRows.map((h) => ({
        weekStart: h.week_start,
        sentence: powerWeekSentence(
          name,
          minutesByWeek.get(h.week_start) ?? 0,
          Number(h.power_dial_pct ?? 100)
        ),
      }));
    }

    const live = pickLiveShift((liveRes.data ?? []) as ShiftRow[], nowMs);
    const surveys = await loadSurveys(ctx, [
      ...myShifts.map((s) => s.id),
      ...(live ? [live.id] : []),
    ]);

    return jsonResponse(200, {
      role: ctx.role,
      week: buildWeekInfo(weekStart, settings, commitment, nowMs),
      settings: mapSettings(settings, ctx.managerLevel),
      openHours: ((openHoursRes.data ?? []) as OpenHoursRow[]).map(mapOpenHours),
      powerWindows: ((windowsRes.data ?? []) as PowerWindowRow[]).map(mapPowerWindow),
      roster: ((rosterRes.data ?? []) as RosterRow[]).map((r) => mapRosterEntry(r, ctx.userId)),
      myShifts: myShifts.map((s) => mapShift(s, pendingShiftIds, surveys)),
      commitment: commitment ? mapCommitment(commitment) : null,
      kpis: kpis.map(mapKpi),
      myRequests: await hydrateRequests(ctx, (requestsRes.data ?? []) as RequestRow[]),
      powerWeekHistory,
      liveShift: live ? mapShift(live, pendingShiftIds, surveys) : null,
    });
  } catch (e) {
    console.error('shifts-week-get failed:', String(e));
    return jsonResponse(500, {
      error: 'server_error',
      message: 'Something went wrong. Try again.',
    });
  }
});
