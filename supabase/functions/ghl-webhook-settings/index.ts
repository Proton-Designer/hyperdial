/**
 * TASK-G30: owner/admin settings for the GHL webhook (Settings -> GoHighLevel).
 * POST { action: 'get' }    -> status: whether a workflow-webhook secret exists, when it was rotated, the last event.
 * POST { action: 'rotate' } -> generates a new random secret, stores ONLY its SHA-256 hash, returns the secret once
 *                              (the previous secret stops working immediately).
 * POST { action: 'revoke' } -> deletes the stored hash (workflow webhooks stop being accepted).
 *
 * All actions are owner/admin only (requireOrgRole); the org always comes from the caller's membership. The table
 * (ghl_webhook_state) has RLS on with no client policy, so this function (service role) is the only reader.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { generateWebhookSecret, sha256Hex } from '../_shared/ghl-webhook.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

async function readStatus(supabase: AdminClient, orgId: string) {
  const { data: integ, error: integError } = await supabase
    .from('org_integrations')
    .select('location_id, ghl_reconcile_enabled')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .eq('status', 'connected')
    .maybeSingle();
  if (integError) throw new Error(integError.message);
  if (!integ) return null;
  const { data: st, error } = await supabase
    .from('ghl_webhook_state')
    .select('secret_hash, secret_rotated_at, last_event_at, last_event_type, handled_count')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  // TASK-H16: the latest intakes for the Settings card (contract: apps/web/src/lib/api.ts GhlIntakeSummary)
  const { data: intakeRows, error: intakeError } = await supabase
    .from('ghl_intake_log')
    .select(
      'received_at, outcome, contacts(first_name, last_name, business_name, phone_number), campaigns(name)'
    )
    .eq('org_id', orgId)
    .order('received_at', { ascending: false })
    .limit(20);
  if (intakeError) throw new Error(intakeError.message);
  const one = <T>(v: T | T[] | null | undefined): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  const recent = ((intakeRows ?? []) as Record<string, unknown>[]).map((r) => {
    const c = one(
      r.contacts as {
        first_name: string | null;
        last_name: string | null;
        business_name: string | null;
        phone_number: string | null;
      } | null
    );
    const person = [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim();
    return {
      receivedAt: r.received_at as string,
      contactName: c?.business_name?.trim() || person || null,
      phone: c?.phone_number ?? null,
      outcome: r.outcome as string,
      campaignName: one(r.campaigns as { name: string | null } | null)?.name ?? null,
    };
  });
  return {
    intake: { lastIntakeAt: recent[0]?.receivedAt ?? null, recent },
    webhookUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/ghl-webhook`,
    locationId: (integ.location_id as string | null) ?? null,
    reconcileEnabled: integ.ghl_reconcile_enabled === true,
    hasSecret: Boolean(st?.secret_hash),
    secretRotatedAt: (st?.secret_rotated_at as string | null) ?? null,
    lastEventAt: (st?.last_event_at as string | null) ?? null,
    lastEventType: (st?.last_event_type as string | null) ?? null,
    handledCount: Number(st?.handled_count ?? 0),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const action = body.action;
  if (action !== 'get' && action !== 'rotate' && action !== 'revoke') {
    return jsonResponse({ error: "action must be 'get', 'rotate' or 'revoke'" }, 400);
  }

  const supabase = getSupabaseAdmin();
  try {
    let secret: string | undefined;
    if (action === 'rotate' || action === 'revoke') {
      const status = await readStatus(supabase, orgId);
      if (!status) return jsonResponse({ error: 'GoHighLevel is not connected' }, 400);
      secret = action === 'rotate' ? generateWebhookSecret() : undefined;
      const { error } = await supabase.from('ghl_webhook_state').upsert(
        {
          org_id: orgId,
          secret_hash: secret ? await sha256Hex(secret) : null,
          secret_rotated_at: new Date().toISOString(),
          secret_rotated_by: user.id,
        },
        { onConflict: 'org_id' }
      );
      if (error) throw new Error(error.message);
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: action === 'rotate' ? 'ghl.rotate_webhook_secret' : 'ghl.revoke_webhook_secret',
        targetType: 'org_integrations',
        targetId: orgId,
        details: {},
      });
    }
    const status = await readStatus(supabase, orgId);
    if (!status) return jsonResponse({ error: 'GoHighLevel is not connected' }, 400);
    return jsonResponse(secret ? { ...status, secret } : status);
  } catch (err) {
    console.error('[ghl-webhook-settings] failed', err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
