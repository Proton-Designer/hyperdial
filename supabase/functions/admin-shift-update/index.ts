// TASK-S03: POST { action: 'create'|'move'|'cancel'|'excuse', shiftId?, userId?, date?, start?, end?,
// activity? } -> { shift }. Direct manager edits (source 'admin'); overlaps are impossible (exclusion
// constraint -> 422 overlap). Rules live in admin_update_shift.
import {
  handleAdminPost,
  jsonResponse,
  loadSurveys,
  nudgeShiftGhlSync,
  rpcErrorResponse,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { parseAdminUpdateBody } from '../_shared/shifts-admin.ts';
import { mapShift, type ShiftRow } from '../_shared/shifts-core.ts';

Deno.serve((req) =>
  handleAdminPost(req, 'admin-shift-update', async (ctx, body) => {
    const parsed = parseAdminUpdateBody(body);
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const b = parsed.value;
    const { data, error } = await ctx.supabase.rpc('admin_update_shift', {
      p_org: ctx.orgId,
      p_actor: ctx.userId,
      p_action: b.action,
      p_shift: b.shiftId,
      p_user: b.userId,
      p_date: b.date,
      p_start: b.start,
      p_end: b.end,
      p_activity: b.activity,
    });
    if (error) return rpcErrorResponse(error, 'admin_update_shift');
    nudgeShiftGhlSync();
    const row = data as ShiftRow;
    return jsonResponse(200, { shift: mapShift(row, new Set(), await loadSurveys(ctx, [row.id])) });
  })
);
