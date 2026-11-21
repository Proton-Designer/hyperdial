/**
 * Purchase a Telnyx number on the org's own BYO Telnyx account (design §3, TASK-P1-06).
 * Owner/admin only (buying a real number costs real money -- design's "buy or release
 * numbers" row). The number is attached to the org's Call Control Application
 * (`org_telephony.call_control_app_id`), the same connection the webhook/engine already
 * routes through, not the WebRTC credential connection. Stored with `org_id` (NOT NULL
 * since TASK-P1-01) and `user_id` (the purchasing member, for attribution only -- any
 * org member can dial out with the number once purchased, per `user_phone_numbers`'
 * org-scoped RLS).
 */
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  requireTelnyxOrgRole,
  getSupabaseAdmin,
  getConnectedOrgTelnyxContext,
} from '../_shared/telnyx-org-context.ts';
import { checkSpendGate } from '../_shared/spend-gate.ts';

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

  let body: { phone_number?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const { phone_number: phoneNumber } = body;
  if (!phoneNumber) return jsonResponse({ error: 'phone_number is required' }, 400);

  const supabase = getSupabaseAdmin();

  // TASK-SP: same gate dialer-session-start uses, applied here too (the task's own explicit
  // ADM-5-adjacent requirement) -- a purchase is a one-time action per request, so the extra
  // GET /balance round trip is cheap here, unlike a per-refill check would be.
  const spendGate = await checkSpendGate(supabase, orgId);
  if (spendGate.blocked) {
    return jsonResponse({ error: spendGate.message, code: spendGate.code }, 400);
  }

  const {
    client,
    callControlAppId,
    error: telnyxError,
  } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (telnyxError) return telnyxError;

  let order;
  try {
    order = await client.orderNumber({
      phoneNumbers: [phoneNumber],
      connectionId: callControlAppId ?? undefined,
    });
  } catch (err) {
    console.error('[telnyx-purchase-number] order failed', err);
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: `Telnyx order failed: ${message}` }, 502);
  }

  const orderedNumbers = order.phone_numbers as unknown[] | undefined;
  const orderedNumber = orderedNumbers?.[0];
  const telnyxId =
    typeof orderedNumber === 'object' && orderedNumber !== null && 'id' in orderedNumber
      ? (orderedNumber as { id: string }).id
      : null;
  const num =
    typeof orderedNumber === 'object' && orderedNumber !== null && 'phone_number' in orderedNumber
      ? (orderedNumber as { phone_number: string }).phone_number
      : phoneNumber;

  if (!order.id && !telnyxId) {
    return jsonResponse({ error: 'Failed to create number order' }, 500);
  }

  // TASK-N1: a freshly purchased number lands in the team pool (assigned_user_id stays null --
  // the column default) at the org's CURRENT default_daily_cap, not the daily_cap column's own
  // hardcoded fallback -- an owner who has raised/lowered the org default should see every new
  // purchase honor it, not silently get the schema default.
  const { data: poolSettings } = await supabase
    .from('org_number_pool_settings')
    .select('default_daily_cap')
    .eq('org_id', orgId)
    .maybeSingle();
  const dailyCap = (poolSettings?.default_daily_cap as number | undefined) ?? 100;

  const { error: insertError } = await supabase.from('user_phone_numbers').insert({
    user_id: user.id,
    org_id: orgId,
    telnyx_phone_number_id: telnyxId || (order.id as string),
    phone_number: num,
    daily_cap: dailyCap,
  });
  if (insertError) {
    console.error('[telnyx-purchase-number] insert failed', insertError.message);
    return jsonResponse({ error: insertError.message }, 500);
  }

  return jsonResponse({ success: true, phone_number: num });
});
