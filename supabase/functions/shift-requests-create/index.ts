// TASK-S02: POST { type, fromShiftId?, date?, start?, end?, toActivity?, requestedMinHours?, reason }
// -> { request }. Validation + insert + manager notifications + GHL events: public.create_shift_request.
// Contract addition (optional): for light_week, `date` (any day of the target week), default next week.
import { corsPreflightResponse } from '../_shared/cors.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import {
  ALL_ROLES,
  hydrateRequests,
  jsonResponse,
  nudgeShiftGhlSync,
  rpcErrorResponse,
  shiftsAuth,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { parseCreateRequestBody, type RequestRow } from '../_shared/shifts-core.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST')
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use POST.' });

  const auth = await shiftsAuth(req, ALL_ROLES);
  if (auth.response) return auth.response;
  const ctx = auth.ctx;

  const { body, errorResponse } = await readJsonBody<unknown>(req);
  if (errorResponse) return errorResponse;
  const parsed = parseCreateRequestBody(body);
  if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
  const b = parsed.value;

  try {
    const { data, error } = await ctx.supabase.rpc('create_shift_request', {
      p_org: ctx.orgId,
      p_user: ctx.userId,
      p_type: b.type,
      p_from_shift_id: b.fromShiftId,
      p_date: b.date,
      p_start: b.start,
      p_end: b.end,
      p_to_activity: b.toActivity,
      p_requested_min_hours: b.requestedMinHours,
      p_reason: b.reason,
    });
    if (error) return rpcErrorResponse(error, 'shift-requests-create');

    const [request] = await hydrateRequests(ctx, [data as RequestRow]);
    nudgeShiftGhlSync();
    return jsonResponse(200, { request });
  } catch (e) {
    console.error('shift-requests-create failed:', String(e));
    return jsonResponse(500, {
      error: 'server_error',
      message: 'Something went wrong. Try again.',
    });
  }
});
