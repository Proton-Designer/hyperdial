// TASK-S03: POST { requestId, decision: 'approve' | 'deny', note?, allowUnderMinimum? } -> { request }.
// All the rules (role + pod scope, one transaction, notification, GHL events) live in the SQL function
// review_shift_request; this is the thin edge shell. Contract: docs/design/shifts.md section 3.
import {
  handleAdminPost,
  hydrateRequests,
  jsonResponse,
  nudgeShiftGhlSync,
  rpcErrorResponse,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { parseReviewBody } from '../_shared/shifts-admin.ts';
import type { RequestRow } from '../_shared/shifts-core.ts';

Deno.serve((req) =>
  handleAdminPost(req, 'admin-shift-requests-review', async (ctx, body) => {
    const parsed = parseReviewBody(body);
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const { requestId, decision, note, allowUnderMinimum } = parsed.value;
    const { data, error } = await ctx.supabase.rpc('review_shift_request', {
      p_org: ctx.orgId,
      p_reviewer: ctx.userId,
      p_request: requestId,
      p_decision: decision,
      p_note: note,
      p_allow_under_min: allowUnderMinimum,
    });
    if (error) return rpcErrorResponse(error, 'review_shift_request');
    nudgeShiftGhlSync();
    const [request] = await hydrateRequests(ctx, [data as RequestRow]);
    return jsonResponse(200, { request });
  })
);
