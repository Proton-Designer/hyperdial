import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { reconnectAgentLeg } from '../_shared/dialer-engine.ts';
import { readJsonBody } from '../_shared/http-json.ts';

/**
 * TASK-L1 spec item 5 (AUD-5): the intern's Reconnect button after an agent-leg-lost
 * (`paused_agent_lost`). Dials a fresh agent leg into the session's existing conference --
 * see dialer-engine.ts's `reconnectAgentLeg`/`processAgentLegEvent` for what happens once it
 * answers (rejoins an ongoing call if a contact leg is still `claimed`, otherwise resumes
 * rolling dialing).
 */

interface ReconnectBody {
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

  const { body, errorResponse } = await readJsonBody<ReconnectBody>(req);
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

    const result = await reconnectAgentLeg(supabase, orgId, sessionId);
    if (!result.ok) {
      if (result.reason === 'not_paused_agent_lost') {
        return jsonResponse(409, {
          error: 'Session is not waiting to reconnect the agent leg.',
          code: 'NOT_PAUSED_AGENT_LOST',
        });
      }
      if (result.reason === 'reconnect_already_in_flight') {
        return jsonResponse(409, {
          error: 'A reconnect is already in progress for this session.',
          code: 'RECONNECT_ALREADY_IN_FLIGHT',
        });
      }
      return jsonResponse(404, { error: 'Session not found' });
    }

    return jsonResponse(200, { status: 'reconnecting' });
  } catch (err) {
    // Review fix (L1 round-3 review-notes-r3.md, nit): AGENT_NOT_REGISTERED hasn't been thrown
    // by anything on this path since B1 (dialer-engine.ts's agentSipUri is self-healing via
    // _shared/agent-webrtc-credential.ts's get-or-create) -- this mapping was dead.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('dialer-session-reconnect error:', err);
    return jsonResponse(500, { error: msg });
  }
});
