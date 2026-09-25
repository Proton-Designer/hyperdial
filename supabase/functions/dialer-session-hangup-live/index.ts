import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { endLiveCall } from '../_shared/dialer-engine.ts';
import { readJsonBody } from '../_shared/http-json.ts';

interface HangupLiveBody {
  sessionId?: string;
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Ends the current live (claimed/on_call) contact leg for a session. The resulting
 *  call.hangup webhook drives the normal ended -> apply_leg_outcome -> wrap_up flow --
 *  this function only issues the Telnyx hangup command, same "commands only, state changes
 *  through the webhook" discipline as everywhere else in this lane. */
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

  const { body, errorResponse } = await readJsonBody<HangupLiveBody>(req);
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
      .select('id, org_id, agent_id, active_leg_id')
      .eq('id', sessionId)
      .maybeSingle();
    if (sessionError) return jsonResponse(500, { error: sessionError.message });
    if (!session || session.org_id !== orgId)
      return jsonResponse(404, { error: 'Session not found' });
    if (role === 'agent' && session.agent_id !== user.id) {
      return jsonResponse(403, { error: 'Not your session' });
    }
    if (!session.active_leg_id) {
      return jsonResponse(400, { error: 'No live call to end' });
    }

    const ok = await endLiveCall(supabase, orgId, sessionId);
    if (!ok) return jsonResponse(400, { error: 'No live call to end' });

    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error('dialer-session-hangup-live error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});
