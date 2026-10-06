// TASK-C1: POST { shiftId, action: 'start' } | { shiftId, action: 'end', survey? } -> { shift } (docs/design/shifts.md 4b).
// Own shift only (clock_shift re-checks org + owner); the server clock is the only clock. A dialing shift needs the
// survey to end. Rules and errors live in SQL (public.clock_shift); this function only parses and maps.
import { corsPreflightResponse } from '../_shared/cors.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import {
  ALL_ROLES,
  jsonResponse,
  rpcErrorResponse,
  shiftsAuth,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { mapShift, parseClockBody, type ShiftRow, type SurveyRow } from '../_shared/shifts-core.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST')
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Use POST.' });

  const auth = await shiftsAuth(req, ALL_ROLES);
  if (auth.response) return auth.response;
  const ctx = auth.ctx;

  const { body, errorResponse } = await readJsonBody<unknown>(req);
  if (errorResponse) return errorResponse;
  const parsed = parseClockBody(body);
  if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
  const b = parsed.value;

  try {
    const { data, error } = await ctx.supabase.rpc('clock_shift', {
      p_org: ctx.orgId,
      p_user: ctx.userId,
      p_shift: b.shiftId,
      p_action: b.action,
      p_survey: b.survey,
    });
    if (error) return rpcErrorResponse(error, 'shift-clock');
    const out = data as { shift: ShiftRow; survey: SurveyRow | null };
    const surveys = new Map<string, SurveyRow>(out.survey ? [[out.shift.id, out.survey]] : []);
    return jsonResponse(200, { shift: mapShift(out.shift, new Set(), surveys) });
  } catch (e) {
    console.error('shift-clock failed:', String(e));
    return jsonResponse(500, {
      error: 'server_error',
      message: 'Something went wrong. Try again.',
    });
  }
});
