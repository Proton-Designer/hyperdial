/**
 * TASK-SP: current balance + MTD spend (estimated) for Settings -> Telephony's display, and the
 * Dashboard/Settings low-balance banners. Owner/admin only -- same role as everything else
 * touching billing in this lane (buying numbers, connecting Telnyx). Read-only; the org's spend
 * SETTINGS themselves (cap/thresholds) are a plain RLS table (org_spend_settings) the client
 * reads/writes directly, no edge function needed for those -- this function exists only because
 * the balance/MTD numbers require a live Telnyx call + the org's decrypted key, neither of which
 * the client can do itself.
 */
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole, getSupabaseAdmin } from '../_shared/telnyx-org-context.ts';
import { getOrgSpendSnapshot } from '../_shared/spend-gate.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { orgId, error: roleError } = await requireTelnyxOrgRole(req, ['owner', 'admin']);
  if (roleError) return roleError;

  const supabase = getSupabaseAdmin();
  const snapshot = await getOrgSpendSnapshot(supabase, orgId);

  if (!snapshot.ok) {
    // Not a 5xx -- "can't read the balance right now" is an expected, displayable state (Telnyx
    // not connected yet, key missing, or a transient API error), not a server bug.
    return jsonResponse({ available: false, reason: snapshot.reason });
  }

  return jsonResponse({
    available: true,
    balanceUsd: snapshot.balanceUsd,
    availableCreditUsd: snapshot.availableCreditUsd,
    mtdSpendEstimateUsd: snapshot.mtdSpendEstimateUsd,
    isEstimate: true,
    monthlySpendCapUsd: snapshot.settings.monthly_spend_cap_usd,
    lowBalanceAlertUsd: snapshot.settings.low_balance_alert_usd,
    minBalanceToDialUsd: snapshot.settings.min_balance_to_dial_usd,
  });
});
