import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { pauseSession } from '../_shared/dialer-engine.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { isManagerScopedToAgent } from '../_shared/pod-scope.ts';

interface PauseBody {
  sessionId?: string;
  reason?: string;
}

const MAX_REASON_LENGTH = 80;

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
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent', 'manager']);
  if (authError) return authError;

  const { body, errorResponse } = await readJsonBody<PauseBody>(req);
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
    if (!session || session.org_id !== orgId)
      return jsonResponse(404, { error: 'Session not found' });
    if (role === 'agent' && session.agent_id !== user.id) {
      return jsonResponse(403, { error: 'Not your session' });
    }
    // MISSION-5 TASK-M5-B4: a manager may only remote-pause an agent inside their own managed
    // pod scope (A5's own `is_agent_in_callers_pod_scope` shape, reimplemented in TS since this
    // isn't an RPC call -- see pod-scope.ts's own header). Owner/admin are unrestricted, as before.
    if (role === 'manager' && session.agent_id !== user.id) {
      const inScope = await isManagerScopedToAgent(supabase, orgId, user.id, session.agent_id);
      if (!inScope) return jsonResponse(403, { error: 'That agent is outside your managed pods' });
    }

    // MISSION-5 TASK-M5-B1: pause reason picker. Free text, not validated against the org's own
    // org_pause_reason_settings list (that table is a UI data source, not a server-side enum --
    // see its migration's own comment) -- defaults to 'Other' so an old client that never sends
    // this field keeps working exactly as before, just newly tagged.
    const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const reason = (rawReason || 'Other').slice(0, MAX_REASON_LENGTH);

    // Only meaningful while actively refilling (`dialing`) -- pauseSession no-ops (returns
    // false) from any other state, e.g. already `wrap_up`/`paused`/`stopped`.
    const paused = await pauseSession(supabase, orgId, sessionId, reason);
    if (!paused) {
      return jsonResponse(409, {
        error: 'Session is not currently dialing, so it cannot be paused.',
      });
    }

    // MISSION-5 TASK-M5-B2: audit-log only a manager acting on someone ELSE's session -- an
    // agent's own routine Pause click is not a team-management action worth logging (same
    // scoping every other routine dialer action in this file already gets, e.g. resume/hangup).
    if (role !== 'agent' && session.agent_id !== user.id) {
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'session.remote_pause',
        targetType: 'dial_session',
        targetId: sessionId,
        details: { agentId: session.agent_id, reason },
      });
    }

    return jsonResponse(200, { status: 'paused' });
  } catch (err) {
    console.error('dialer-session-pause error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});
