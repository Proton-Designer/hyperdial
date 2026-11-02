import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  requireTelnyxOrgRole,
  getConnectedOrgTelnyxContext,
} from '../_shared/telnyx-org-context.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import { parseDtmfDigits, resolveDtmfTarget } from '../_shared/dtmf.ts';

interface SendDtmfBody {
  sessionId?: string;
  digits?: string;
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** TASK-H11: plays keypad tones (0-9 * #) into the session's current contact leg, for an answering-machine
 *  menu ("press 1 to be connected"). A Telnyx command only: no call_legs / dial_sessions state changes here,
 *  and nothing in the dial engine is touched. Only the session's own agent may send. */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const {
    user,
    orgId,
    error: authError,
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent', 'manager']);
  if (authError) return authError;

  const { body, errorResponse } = await readJsonBody<SendDtmfBody>(req);
  if (errorResponse) return errorResponse;

  try {
    const sessionId = body.sessionId?.trim();
    if (!sessionId) return jsonResponse(400, { error: 'sessionId is required' });
    const parsed = parseDtmfDigits(body.digits);
    if ('error' in parsed) return jsonResponse(400, { error: parsed.error });

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

    let leg = null;
    if (session?.active_leg_id) {
      const { data, error: legError } = await supabase
        .from('call_legs')
        .select('id, org_id, session_id, kind, state, call_control_id')
        .eq('id', session.active_leg_id)
        .maybeSingle();
      if (legError) return jsonResponse(500, { error: legError.message });
      leg = data;
    }

    const target = resolveDtmfTarget({
      sessionOrgId: session?.org_id ?? null,
      callerOrgId: orgId,
      sessionAgentId: session?.agent_id ?? null,
      callerUserId: user.id,
      activeLegId: session?.active_leg_id ?? null,
      leg,
      sessionId,
    });
    if ('error' in target) return jsonResponse(target.status, { error: target.error });

    const { client, error: telnyxError } = await getConnectedOrgTelnyxContext(supabase, orgId);
    if (!client) return telnyxError!;
    await client.sendDtmf(target.callControlId, parsed.digits);
    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error('dialer-send-dtmf error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});
