// TASK-S05: the orchestration of one shift's KPI pass, with its I/O injected so it is deno-testable.
// `shift-kpi-compute` wires the deps to Supabase RPCs; shift-kpi-core.ts does the maths.

import {
  computeShiftKpi,
  isFinalizable,
  type KpiEvent,
  type KpiLeg,
  type KpiResult,
  type KpiSettings,
  type KpiWindow,
} from './shift-kpi-core.ts';

export interface KpiRunShift {
  id: string;
  org_id: string;
  user_id: string;
  activity: string;
  starts_at: string;
  ends_at: string;
}

export interface KpiInputsRow {
  events: KpiEvent[];
  legs: KpiLeg[];
  last_leg_end: Record<string, string>;
}

export interface KpiDeps {
  nowMs: number;
  settings(orgId: string): Promise<KpiSettings>;
  windows(orgId: string): Promise<KpiWindow[]>;
  inputs(shiftId: string): Promise<KpiInputsRow | null>;
  /** shift_kpi_save: 'saved' | 'completed' | 'missed' | 'skipped'. */
  save(shiftId: string, kpi: KpiResult | null, final: boolean): Promise<string>;
}

export type KpiRunOutcome =
  | { action: 'none' }
  | { action: 'saved' | 'skipped'; kpi: KpiResult | null }
  | { action: 'finalized'; status: string; kpi: KpiResult | null };

/** One pass over one shift. `live` (a client asking for numbers) never finalizes. */
export async function processShift(
  deps: KpiDeps,
  shift: KpiRunShift,
  opts: { live?: boolean } = {}
): Promise<KpiRunOutcome> {
  const { nowMs } = deps;
  const ended = nowMs >= Date.parse(shift.ends_at);

  if (shift.activity !== 'dialing') {
    // Non-dialing shifts: no KPIs; completed once they end.
    if (!ended || opts.live) return { action: 'none' };
    const status = await deps.save(shift.id, null, true);
    return status === 'skipped'
      ? { action: 'skipped', kpi: null }
      : { action: 'finalized', status, kpi: null };
  }
  if (nowMs < Date.parse(shift.starts_at)) return { action: 'none' };

  const [settings, windows, inputs] = await Promise.all([
    deps.settings(shift.org_id),
    deps.windows(shift.org_id),
    deps.inputs(shift.id),
  ]);
  if (!inputs) return { action: 'none' };
  const kpi = computeShiftKpi({
    shift,
    settings,
    windows,
    events: inputs.events,
    legs: inputs.legs,
    lastLegEnd: inputs.last_leg_end,
    nowMs,
  });
  const final = !opts.live && isFinalizable(shift.ends_at, nowMs);
  const status = await deps.save(shift.id, kpi, final);
  if (status === 'skipped') return { action: 'skipped', kpi };
  return final ? { action: 'finalized', status, kpi } : { action: 'saved', kpi };
}
