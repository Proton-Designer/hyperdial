import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { resumeToDialing } from '../_shared/dialer-engine.ts';
import { readJsonBody } from '../_shared/http-json.ts';

/**
 * TASK-L2b: the Resume button for a manually `paused` session. `resumeToDialing`
 * (`_shared/dialer-engine.ts`) already existed and already accepted `paused` as a valid
 * starting state (it was built for TASK-P3-E1's dispositions-submission path, which only ever
 * calls it from `wrap_up`) -- there was simply no HTTP endpoint for the `paused` case before
 * this task, so a manually paused session had no way back to `dialing` from the UI at all.
 * Same shape as `dialer-session-pause`/`-reconnect`.
 */

interface ResumeBody {
  sessionId?: string;
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const {
    user,
    orgId,
    role,
    error: authError,
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  const { body, errorResponse } = await readJsonBody<ResumeBody>(req);
  if (errorResponse) return errorResponse;

  try {
    const sessionId = body.sessionId?.trim();
    if (!sessionId) return jsonResponse(400, { error: 'sessionId is required' });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: session, error: sessionError } = await supabase
      .from('dial_sessions')
      .select('id, org_id, agent_id')
      .eq('id', sessionId)
      .maybeSingle();
    if (sessionError) return jsonResponse(500, { error: sessionError.message });
    if (!session || session.org_id !== orgId) {
      return jsonResponse(404, { error: 'Session not found' });
    }
    if (role === 'agent' && session.agent_id !== user.id) {
      return jsonResponse(403, { error: 'Not your session' });
    }

    // Only meaningful from `paused` (wrap_up resumes itself, via dialer-session-disposition) --
    // resumeToDialing no-ops (returns false) from any other state.
    const resumed = await resumeToDialing(supabase, orgId, sessionId);
    if (!resumed) {
      return jsonResponse(409, { error: 'Session is not currently paused, so it cannot resume.' });
    }

    return jsonResponse(200, { status: 'dialing' });
  } catch (err) {
    console.error('dialer-session-resume error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});
