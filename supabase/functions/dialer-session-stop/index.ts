import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { stopSession } from '../_shared/dialer-engine.ts';

interface StopBody {
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
    const body = (await req.json()) as StopBody;
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

    await stopSession(supabase, orgId, sessionId);

    return jsonResponse(200, { status: 'stopped' });
  } catch (err) {
    console.error('dialer-session-stop error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});
