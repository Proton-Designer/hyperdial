// TASK-S03: POST { id?, label, isoWeekdays, startTime, endTime, active } -> { powerWindow }.
// Also recomputes power_minutes for scheduled shifts in weeks that have not started (SQL).
import {
  handleAdminPost,
  jsonResponse,
  rpcErrorResponse,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { parsePowerWindowBody } from '../_shared/shifts-admin.ts';
import { mapPowerWindow, type PowerWindowRow } from '../_shared/shifts-core.ts';

Deno.serve((req) =>
  handleAdminPost(req, 'admin-power-windows-upsert', async (ctx, body) => {
    const parsed = parsePowerWindowBody(body);
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const b = parsed.value;
    const { data, error } = await ctx.supabase.rpc('admin_upsert_power_window', {
      p_org: ctx.orgId,
      p_actor: ctx.userId,
      p_id: b.id,
      p_label: b.label,
      p_days: b.isoWeekdays,
      p_start: b.startTime,
      p_end: b.endTime,
      p_active: b.active,
    });
    if (error) return rpcErrorResponse(error, 'admin_upsert_power_window');
    return jsonResponse(200, { powerWindow: mapPowerWindow(data as PowerWindowRow) });
  })
);
