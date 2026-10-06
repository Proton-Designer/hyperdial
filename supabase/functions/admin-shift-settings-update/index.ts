// TASK-S03: POST Partial<ShiftSettings> -> { settings }. Owner/admin only for `enabled` (enforced in SQL).
// Works while Shifts is disabled (that is how an owner turns it on).
import {
  handleAdminPost,
  jsonResponse,
  rpcErrorResponse,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { parseSettingsPatch } from '../_shared/shifts-admin.ts';
import { mapSettings, type ShiftSettingsRow } from '../_shared/shifts-core.ts';

Deno.serve((req) =>
  handleAdminPost(req, 'admin-shift-settings-update', async (ctx, body) => {
    const parsed = parseSettingsPatch(body);
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const { data, error } = await ctx.supabase.rpc('admin_update_shift_settings', {
      p_org: ctx.orgId,
      p_actor: ctx.userId,
      p_patch: parsed.value,
    });
    if (error) return rpcErrorResponse(error, 'admin_update_shift_settings');
    return jsonResponse(200, { settings: mapSettings(data as ShiftSettingsRow, true) });
  })
);
