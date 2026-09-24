import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { pauseSession } from '../_shared/dialer-engine.ts';

interface PauseBody {
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

  try {
    const body = (await req.json()) as PauseBody;
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

    // Only meaningful while actively refilling (`dialing`) -- pauseSession no-ops (returns
    // false) from any other state, e.g. already `wrap_up`/`paused`/`stopped`.
    const paused = await pauseSession(supabase, orgId, sessionId);
    if (!paused) {
      return jsonResponse(409, {
        error: 'Session is not currently dialing, so it cannot be paused.',
      });
    }

    return jsonResponse(200, { status: 'paused' });
  } catch (err) {
    console.error('dialer-session-pause error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});
