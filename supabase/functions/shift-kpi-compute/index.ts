// TASK-S05: per-shift KPIs. Two callers (contract: docs/design/shifts.md section 3):
//   * cron / internal (X-Cron-Secret or the service-role bearer), body {}: every due shift of every enabled
//     org. Dialing shifts that started get live numbers every pass; once one ended more than 2 hours ago it
//     is finalized (status completed, or missed on the no_show flag, + the Shift completed / missed GHL
//     events). Non-dialing shifts are completed when they end, without KPIs.
//   * a signed-in user, body { shiftId }: live numbers for their own shift, or for a shift of an intern in
//     their pods (owner/admin: anyone). Never finalizes. Returns { kpis: ShiftKpi[] }.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsPreflightResponse } from '../_shared/cors.ts';
import {
  ALL_ROLES,
  isCronAuthorized,
  jsonResponse,
  nudgeShiftGhlSync,
  rpcErrorResponse,
  shiftsAuth,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { isUuid, mapKpi, type KpiRow } from '../_shared/shifts-core.ts';
import { processShift, type KpiDeps, type KpiRunShift } from '../_shared/shift-kpi-run.ts';
import type { KpiResult, KpiSettings, KpiWindow } from '../_shared/shift-kpi-core.ts';

const DUE_LIMIT = 300;

function makeDeps(sb: SupabaseClient, nowMs: number): KpiDeps {
  const settingsCache = new Map<string, Promise<KpiSettings>>();
  const windowsCache = new Map<string, Promise<KpiWindow[]>>();
  return {
    nowMs,
    settings(orgId) {
      let p = settingsCache.get(orgId);
      if (!p) {
        p = (async () => {
          const { data, error } = await sb
            .from('shift_settings')
            .select(
              'timezone, grace_minutes, idle_flag_minutes, adherence_flag_pct, conversation_min_seconds, open_session_tail_minutes'
            )
            .eq('org_id', orgId)
            .single();
          if (error || !data) throw new Error(`shift_settings: ${error?.message ?? 'missing'}`);
          return data as KpiSettings;
        })();
        settingsCache.set(orgId, p);
      }
      return p;
    },
    windows(orgId) {
      let p = windowsCache.get(orgId);
      if (!p) {
        p = (async () => {
          const { data, error } = await sb
            .from('power_windows')
            .select('iso_weekdays, start_time, end_time, active')
            .eq('org_id', orgId);
          if (error) throw new Error(`power_windows: ${error.message}`);
          return (data ?? []) as KpiWindow[];
        })();
        windowsCache.set(orgId, p);
      }
      return p;
    },
    async inputs(shiftId) {
      const { data, error } = await sb.rpc('shift_kpi_inputs', { p_shift: shiftId });
      if (error) throw new Error(`shift_kpi_inputs: ${error.message}`);
      return data ?? null;
    },
    async save(shiftId, kpi: KpiResult | null, final) {
      const { data, error } = await sb.rpc('shift_kpi_save', {
        p_shift: shiftId,
        p_kpi: kpi,
        p_final: final,
      });
      if (error) throw new Error(`shift_kpi_save: ${error.message}`);
      return String(data);
    },
  };
}

async function runCron(): Promise<Response> {
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const { data, error } = await sb.rpc('shift_kpi_due', { p_limit: DUE_LIMIT });
  if (error) {
    console.error('shift-kpi-compute: shift_kpi_due failed:', error.message);
    return jsonResponse(500, {
      error: 'server_error',
      message: 'Something went wrong. Try again.',
    });
  }
  const deps = makeDeps(sb, Date.now());
  const counts = { due: 0, saved: 0, finalized: 0, skipped: 0, failed: 0 };
  for (const shift of (data ?? []) as KpiRunShift[]) {
    counts.due++;
    try {
      const r = await processShift(deps, shift);
      if (r.action === 'saved') counts.saved++;
      else if (r.action === 'finalized') counts.finalized++;
      else if (r.action === 'skipped') counts.skipped++;
    } catch (e) {
      counts.failed++;
      console.error(`shift-kpi-compute: shift ${shift.id} failed:`, String(e));
    }
  }
  if (counts.finalized > 0) nudgeShiftGhlSync();
  return jsonResponse(200, { ok: counts.failed === 0, ...counts });
}

async function runClient(req: Request, body: unknown): Promise<Response> {
  const auth = await shiftsAuth(req, ALL_ROLES);
  if (auth.response) return auth.response;
  const ctx = auth.ctx;
  const shiftId = (body as { shiftId?: unknown } | null)?.shiftId;
  if (!isUuid(shiftId)) return shiftsError('bad_request', { reason: 'bad_shift_id' });

  const { data: shift, error } = await ctx.supabase
    .from('shifts')
    .select('id, org_id, user_id, activity, starts_at, ends_at')
    .eq('id', shiftId)
    .eq('org_id', ctx.orgId)
    .maybeSingle();
  if (error) throw new Error(`shifts: ${error.message}`);
  if (!shift) return shiftsError('not_found');

  if (shift.user_id !== ctx.userId) {
    if (!ctx.managerLevel) return shiftsError('forbidden');
    const m = await ctx.supabase.rpc('shift_admin_members', {
      p_org: ctx.orgId,
      p_actor: ctx.userId,
    });
    if (m.error) return rpcErrorResponse(m.error, 'shift_admin_members');
    if (!(m.data as { user_id: string }[]).some((x) => x.user_id === shift.user_id)) {
      return shiftsError('forbidden');
    }
  }

  const { data: st } = await ctx.supabase
    .from('shift_settings')
    .select('enabled')
    .eq('org_id', ctx.orgId)
    .maybeSingle();
  if (!st?.enabled) return shiftsError('shifts_disabled');

  await processShift(makeDeps(ctx.supabase, Date.now()), shift as KpiRunShift, { live: true });
  const { data: row, error: kErr } = await ctx.supabase
    .from('shift_kpis')
    .select('*')
    .eq('shift_id', shiftId)
    .maybeSingle();
  if (kErr) throw new Error(`shift_kpis: ${kErr.message}`);
  return jsonResponse(200, { kpis: row ? [mapKpi(row as KpiRow)] : [] });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST')
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use POST.' });
  try {
    if (isCronAuthorized(req)) return await runCron();
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    return await runClient(req, body);
  } catch (e) {
    console.error('shift-kpi-compute failed:', String(e));
    return jsonResponse(500, {
      error: 'server_error',
      message: 'Something went wrong. Try again.',
    });
  }
});
