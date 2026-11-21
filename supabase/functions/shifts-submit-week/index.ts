// TASK-S02: POST { weekStart, blocks: {date,start,end,activity}[] } -> { shifts, commitment }.
// All rules live in public.submit_week (one transaction); this only authenticates, validates the
// request shape, maps the result to the contract and nudges shift-ghl-sync.
import { corsPreflightResponse } from '../_shared/cors.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import {
  ALL_ROLES,
  jsonResponse,
  nudgeShiftGhlSync,
  rpcErrorResponse,
  shiftsAuth,
  shiftsError,
} from '../_shared/shifts-io.ts';
import {
  mapCommitment,
  mapShift,
  parseSubmitBody,
  type CommitmentRow,
  type ShiftRow,
} from '../_shared/shifts-core.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST')
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use POST.' });

  const auth = await shiftsAuth(req, ALL_ROLES);
  if (auth.response) return auth.response;
  const ctx = auth.ctx;

  const { body, errorResponse } = await readJsonBody<unknown>(req);
  if (errorResponse) return errorResponse;
  const parsed = parseSubmitBody(body);
  if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);

  try {
    const { data, error } = await ctx.supabase.rpc('submit_week', {
      p_org: ctx.orgId,
      p_user: ctx.userId,
      p_week_start: parsed.value.weekStart,
      p_blocks: parsed.value.blocks,
    });
    if (error) return rpcErrorResponse(error, 'shifts-submit-week');

    const result = data as { shifts: ShiftRow[]; commitment: CommitmentRow };
    const { data: pending } = await ctx.supabase
      .from('shift_change_requests')
      .select('from_shift_id')
      .eq('org_id', ctx.orgId)
      .eq('user_id', ctx.userId)
      .eq('status', 'pending');
    const pendingIds = new Set(
      ((pending ?? []) as { from_shift_id: string | null }[])
        .map((p) => p.from_shift_id)
        .filter((x): x is string => !!x)
    );

    nudgeShiftGhlSync();
    return jsonResponse(200, {
      shifts: result.shifts.map((s) => mapShift(s, pendingIds)),
      commitment: mapCommitment(result.commitment),
    });
  } catch (e) {
    console.error('shifts-submit-week failed:', String(e));
    return jsonResponse(500, {
      error: 'server_error',
      message: 'Something went wrong. Try again.',
    });
  }
});
