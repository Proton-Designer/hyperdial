import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { stopSession } from '../_shared/dialer-engine.ts';
import { readJsonBody } from '../_shared/http-json.ts';

interface StopBody {
  sessionId?: string;
  /** BUG-11: only true once the client's own confirm dialog has been shown (or there was no
   *  live human to confirm) -- see stopSession's own header comment in dialer-engine.ts. */
  force?: boolean;
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

    const result = await stopSession(supabase, orgId, sessionId, body.force === true);
    if (!result.ok && result.reason === 'live_call_in_progress') {
      return jsonResponse(409, {
        error: 'A prospect is on the line. Confirm before hanging up on them.',
        code: 'LIVE_CALL_IN_PROGRESS',
      });
    }

    return jsonResponse(200, { status: 'stopped' });
  } catch (err) {
    console.error('dialer-session-stop error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});
