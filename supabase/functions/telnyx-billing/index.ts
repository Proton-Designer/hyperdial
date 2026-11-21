/**
 * TASK-BF1: add funds + auto-recharge, directly from inside HyperDial (owner AND admin -- user
 * order: "this capabilty should be avaiable for admins as well not just owner"). Thin
 * `Deno.serve` shell only -- the actual orchestration (validation, rate limits, idempotency, the
 * pending->succeeded/failed audit rows, the Telnyx calls) lives in `_shared/billing-core.ts`,
 * which is what gets deno-tested (this file, like every other Edge Function `index.ts` in this
 * repo, does not -- `Deno.serve` runs as an import-time side effect).
 *
 * Actions (one function, not three, since all three share the same role gate + connected-Telnyx-
 * client lookup):
 *  - `get`: live balance + auto-recharge prefs.
 *  - `update_auto_recharge`: validates, PATCHes Telnyx, records an audit row.
 *  - `add_funds`: validates, enforces idempotency + rate limits, records pending->succeeded/
 *    failed audit rows around the actual Telnyx charge.
 *
 * Recent billing ACTIVITY (org_billing_events) is read directly by the client under its own RLS
 * instead of through this function -- same "member read... no edge function needed" shape as
 * getSpendSettings, since that read needs no live Telnyx call.
 */
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  requireTelnyxOrgRole,
  getSupabaseAdmin,
  getConnectedOrgTelnyxContext,
} from '../_shared/telnyx-org-context.ts';
import {
  runAddFundsAction,
  runGetAction,
  runUpdateAutoRechargeAction,
} from '../_shared/billing-core.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, orgId, error: roleError } = await requireTelnyxOrgRole(req, ['owner', 'admin']);
  if (roleError) return roleError;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const supabase = getSupabaseAdmin();
  const { client, error: telnyxError } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (telnyxError) return telnyxError;

  let result;
  switch (body.action) {
    case 'get':
      result = await runGetAction(client);
      break;
    case 'update_auto_recharge':
      result = await runUpdateAutoRechargeAction(supabase, client, orgId, user.id, body);
      break;
    case 'add_funds':
      result = await runAddFundsAction(supabase, client, orgId, user.id, body);
      break;
    default:
      return jsonResponse({ error: 'Unknown action' }, 400);
  }
  return jsonResponse(result.body, result.status);
});
