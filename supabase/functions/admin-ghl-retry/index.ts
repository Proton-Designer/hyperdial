// TASK-S03: POST { outboxId? } (omitted = every row that needs attention in the caller's scope) -> { reset }.
import {
  handleAdminPost,
  jsonResponse,
  nudgeShiftGhlSync,
  rpcErrorResponse,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { parseRetryBody } from '../_shared/shifts-admin.ts';

Deno.serve((req) =>
  handleAdminPost(req, 'admin-ghl-retry', async (ctx, body) => {
    const parsed = parseRetryBody(body);
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const { data, error } = await ctx.supabase.rpc('admin_retry_shift_outbox', {
      p_org: ctx.orgId,
      p_actor: ctx.userId,
      p_id: parsed.value,
    });
    if (error) return rpcErrorResponse(error, 'admin_retry_shift_outbox');
    const reset = Number(data ?? 0);
    if (reset > 0) nudgeShiftGhlSync();
    return jsonResponse(200, { reset });
  })
);
