// TASK-S02: POST { requestId } -> { request }. Own pending requests only (public.withdraw_shift_request).
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
import { isUuid, type RequestRow } from '../_shared/shifts-core.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST')
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use POST.' });

  const auth = await shiftsAuth(req, ALL_ROLES);
  if (auth.response) return auth.response;
  const ctx = auth.ctx;

  const { body, errorResponse } = await readJsonBody<{ requestId?: unknown }>(req);
  if (errorResponse) return errorResponse;
  if (!isUuid(body?.requestId)) return shiftsError('not_found');

  try {
    const { data, error } = await ctx.supabase.rpc('withdraw_shift_request', {
      p_org: ctx.orgId,
      p_user: ctx.userId,
      p_request_id: body.requestId,
    });
    if (error) return rpcErrorResponse(error, 'shift-requests-withdraw');

    const [request] = await hydrateRequests(ctx, [data as RequestRow]);
    nudgeShiftGhlSync();
    return jsonResponse(200, { request });
  } catch (e) {
    console.error('shift-requests-withdraw failed:', String(e));
    return jsonResponse(500, {
      error: 'server_error',
      message: 'Something went wrong. Try again.',
    });
  }
});
