/**
 * TASK-T3 (Mission 4): live coaching -- listen / whisper / barge. Thin `Deno.serve` shell only --
 * the actual orchestration lives in `_shared/coaching-core.ts` (deno-tested there, same
 * "index.ts is never imported by a test" split as telnyx-billing/index.ts).
 *
 * `requireTelnyxOrgRole` (not the generic `_shared/auth.ts` requireOrgRole) for the same reason
 * telnyx-billing uses it: this resolves the org AND the connected Telnyx client's role gate in
 * one call, and every action below needs a live TelnyxClient regardless of which branch runs.
 *
 * Two actions only (`start`, `switch_mode`) -- there is no `end`. Ending a coaching attempt is a
 * plain client-side `hangup()` on the manager's own already-connected WebRTC leg (see
 * coaching-core.ts's own header for why); the webhook finalizes the audit row from that real
 * Telnyx `call.hangup`, not from an HTTP call to this function.
 */
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  requireTelnyxOrgRole,
  getSupabaseAdmin,
  getConnectedOrgTelnyxContext,
} from '../_shared/telnyx-org-context.ts';
import { runStartCoachingAction, runSwitchCoachingModeAction } from '../_shared/coaching-core.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const {
    user,
    orgId,
    role,
    error: roleError,
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'manager']);
  if (roleError) return roleError;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const supabase = getSupabaseAdmin();
  const {
    client,
    callControlAppId,
    credentialConnectionId,
    error: telnyxError,
  } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (telnyxError) return telnyxError;
  if (!callControlAppId) {
    return jsonResponse(
      { error: 'This org has no Telnyx Call Control application on record.' },
      400
    );
  }

  let result;
  switch (body.action) {
    case 'start':
      result = await runStartCoachingAction(
        supabase,
        client,
        callControlAppId,
        credentialConnectionId,
        orgId,
        user.id,
        role,
        body
      );
      break;
    case 'switch_mode':
      result = await runSwitchCoachingModeAction(supabase, client, orgId, user.id, body);
      break;
    default:
      return jsonResponse({ error: 'Unknown action' }, 400);
  }
  return jsonResponse(result.body, result.status);
});
