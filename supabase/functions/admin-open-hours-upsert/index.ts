// TASK-S03: POST { rows: OpenHours[] } (full replace; a missing weekday becomes closed) ->
// { openHours, affectedShiftCount } (S03F: scheduled future shifts now outside the new hours; the shifts
// themselves are not touched).
import {
  handleAdminPost,
  jsonResponse,
  rpcErrorResponse,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { parseOpenHoursBody } from '../_shared/shifts-admin.ts';
import { mapOpenHours, type OpenHoursRow } from '../_shared/shifts-core.ts';

Deno.serve((req) =>
  handleAdminPost(req, 'admin-open-hours-upsert', async (ctx, body) => {
    const parsed = parseOpenHoursBody(body);
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const { data, error } = await ctx.supabase.rpc('admin_replace_open_hours', {
      p_org: ctx.orgId,
      p_actor: ctx.userId,
      p_rows: parsed.value,
    });
    if (error) return rpcErrorResponse(error, 'admin_replace_open_hours');
    // `rows` + `affected` since S03F; an older database answers a bare array.
    const result = (
      Array.isArray(data) ? { rows: data, affected: 0 } : (data ?? { rows: [], affected: 0 })
    ) as {
      rows: OpenHoursRow[];
      affected: number;
    };
    return jsonResponse(200, {
      openHours: result.rows.map(mapOpenHours),
      affectedShiftCount: Number(result.affected ?? 0),
    });
  })
);
