import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { stopSession } from '../_shared/dialer-engine.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { isManagerScopedToAgent } from '../_shared/pod-scope.ts';

interface StopBody {
  sessionId?: string;
  /** BUG-11: only true once the client's own confirm dialog has been shown (or there was no
   *  live human to confirm) -- see stopSession's own header comment in dialer-engine.ts. */
  force?: boolean;
  /** MISSION-5 TASK-M5-B2: an owner/admin's remote "end session" -- "a live call is allowed to
   *  finish" instead of `force`'s "hang up on them now". Only meaningful for a non-self caller;
   *  an agent ending their own session with this set is harmless (there's no one else's live
   *  call decision being deferred) but this is not the button that sends it. */
  defer?: boolean;
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
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent', 'manager']);
  if (authError) return authError;

  const { body, errorResponse } = await readJsonBody<StopBody>(req);
  if (errorResponse) return errorResponse;

  try {
    const sessionId = body.sessionId?.trim();
    if (!sessionId) return jsonResponse(400, { error: 'sessionId is required' });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // dial_sessions' own RLS policies (20260924000700) draw this exact same boundary for a
    // client-authenticated SELECT (owner/admin see the whole org, an agent only their own) --
    // this replicates it by hand because this function uses the service-role client, which
    // bypasses RLS entirely.
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
    // MISSION-5 TASK-M5-B4: a manager may only remote-end an agent inside their own managed pod
    // scope -- see dialer-session-pause's own identical check + pod-scope.ts's header.
    if (role === 'manager' && session.agent_id !== user.id) {
      const inScope = await isManagerScopedToAgent(supabase, orgId, user.id, session.agent_id);
      if (!inScope) return jsonResponse(403, { error: 'That agent is outside your managed pods' });
    }

    // MISSION-5 TASK-M5-B2: a manager acting on someone ELSE's session -- never true for an
    // agent ending their own (role==='agent' is already restricted to session.agent_id above).
    const isRemoteAction = role !== 'agent' && session.agent_id !== user.id;

    const result = await stopSession(supabase, orgId, sessionId, body.force === true, {
      defer: body.defer === true,
      remoteActorId: isRemoteAction ? user.id : undefined,
    });
    if (!result.ok && result.reason === 'live_call_in_progress') {
      if (result.deferred) {
        // MISSION-5 B2 SHOULD follow-up: no logOrgAction here -- this is only a REQUEST (no state
        // change yet, dial_sessions.remote_stop_requested_at/_by is all that's written). The
        // session doesn't actually end until submit_disposition applies it (dialer-session-
        // disposition/index.ts's own `remoteStopApplied` branch), which is the one place this
        // logically single action gets logged -- logging both here and there produced two
        // `session.remote_end` rows in org_audit_log for one manager click.
        return jsonResponse(202, {
          status: 'deferred',
          message: 'This session will end once the current call finishes.',
        });
      }
      return jsonResponse(409, {
        error: 'A prospect is on the line. Confirm before hanging up on them.',
        code: 'LIVE_CALL_IN_PROGRESS',
      });
    }

    if (isRemoteAction && result.ok) {
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'session.remote_end',
        targetType: 'dial_session',
        targetId: sessionId,
        details: { agentId: session.agent_id, deferred: false },
      });
    }

    return jsonResponse(200, { status: 'stopped' });
  } catch (err) {
    console.error('dialer-session-stop error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});
