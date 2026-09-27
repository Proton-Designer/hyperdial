/**
 * TASK-T4 (Mission 4): warm/cold transfer + hold (AUD-6 + NEW). Thin `Deno.serve` shell only --
 * the actual orchestration lives in `_shared/transfer-core.ts` (deno-tested there), same split as
 * dialer-coaching/index.ts.
 *
 * Unlike dialer-coaching (owner/admin only -- a manager coaching someone ELSE), hold/transfer is
 * the INTERN's OWN action on their OWN current call -- `['owner', 'admin', 'agent']`, with
 * transfer-core.ts's own `callerCanActOnSession` enforcing "an agent may only act on their own
 * session" underneath (an owner/admin may act on any session in the org, same as every other
 * dialer-session-* endpoint's existing role shape).
 */
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  requireTelnyxOrgRole,
  getSupabaseAdmin,
  getConnectedOrgTelnyxContext,
} from '../_shared/telnyx-org-context.ts';
import {
  runHoldAction,
  runResumeAction,
  runStartTransferAction,
  runCompleteTransferAction,
  runCancelTransferAction,
} from '../_shared/transfer-core.ts';

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
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
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

  let result;
  switch (body.action) {
    case 'hold':
      result = await runHoldAction(supabase, client, orgId, role as string, user.id, body);
      break;
    case 'resume':
      result = await runResumeAction(supabase, client, orgId, role as string, user.id, body);
      break;
    case 'start':
      if (!callControlAppId) {
        return jsonResponse(
          { error: 'This org has no Telnyx Call Control application on record.' },
          400
        );
      }
      result = await runStartTransferAction(
        supabase,
        client,
        callControlAppId,
        credentialConnectionId,
        orgId,
        role as string,
        user.id,
        body
      );
      break;
    case 'complete':
      result = await runCompleteTransferAction(
        supabase,
        client,
        orgId,
        role as string,
        user.id,
        body
      );
      break;
    case 'cancel':
      result = await runCancelTransferAction(
        supabase,
        client,
        orgId,
        role as string,
        user.id,
        body
      );
      break;
    default:
      return jsonResponse({ error: 'Unknown action' }, 400);
  }
  return jsonResponse(result.body, result.status);
});
