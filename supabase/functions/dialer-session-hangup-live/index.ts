import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  requireTelnyxOrgRole,
  getConnectedOrgTelnyxContext,
} from '../_shared/telnyx-org-context.ts';
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
      // TASK-I1: no live CONTACT leg -- but a caller can be bridged into this same session's
      // conference with no call_legs row at all (inbound-engine.ts's `bridging_session` step,
      // dial_sessions.pause_reason: 'inbound_call'). Same "current, not-yet-ended" scoping as
      // dialer-session-get's own inboundCall query. Ending IT is a real Telnyx hangup on the
      // caller's own leg, not an engine state transition -- the resulting call.hangup webhook
      // (handleOriginalLegEvent) is what finalizes the inbound_calls row; the agent resumes
      // dialing afterward via the existing Resume button, same as any other pause (decision 7,
      // RESUME_PLAN-eng2.md).
      const { data: inboundCall, error: inboundError } = await supabase
        .from('inbound_calls')
        .select('call_control_id')
        .eq('dial_session_id', sessionId)
        .eq('state', 'bridging_session')
        .is('ended_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (inboundError) return jsonResponse(500, { error: inboundError.message });
      if (!inboundCall) return jsonResponse(400, { error: 'No live call to end' });

      const { client, error: telnyxError } = await getConnectedOrgTelnyxContext(supabase, orgId);
      if (!client) return telnyxError!;
      await client.hangup(inboundCall.call_control_id);
      return jsonResponse(200, { ok: true });
    }

    const ok = await endLiveCall(supabase, orgId, sessionId);
    if (!ok) return jsonResponse(400, { error: 'No live call to end' });

    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error('dialer-session-hangup-live error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});
