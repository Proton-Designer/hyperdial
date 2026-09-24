/**
 * "Import from GHL" (design §7, TASK-P3-P2), admin+. Pages the org's connected GHL
 * sub-account by tag or free-text query, normalizes/dedupes through
 * `_shared/ghl-import.ts`'s pure planner, upserts into `contacts`, and optionally
 * queues the created/updated contacts onto a chosen campaign. "Re-sync" (the UI's
 * second entry point) is the same call with the same `{ mode, value }` the caller
 * remembers from the first run -- no separate endpoint or server-side saved-search
 * state; dedupe on `ghl_contact_id`/phone makes a rerun naturally idempotent.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { createGhlClient } from '../_shared/ghl-client.ts';
import {
  fetchAllGhlContacts,
  planGhlImport,
  type ExistingContactRow,
} from '../_shared/ghl-import.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  // Design §2 permission matrix: importing contacts is owner/admin only, same as CSV import.
  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: { mode?: string; value?: string; campaignId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const mode = body.mode;
  const value = body.value?.trim();
  const campaignId = body.campaignId?.trim() || null;
  if (mode !== 'tag' && mode !== 'search') {
    return jsonResponse({ error: 'mode must be "tag" or "search"' }, 400);
  }
  if (!value) {
    return jsonResponse({ error: 'value is required' }, 400);
  }

  const supabase = getSupabaseAdmin();

  const { data: integration, error: integrationError } = await supabase
    .from('org_integrations')
    .select('status, location_id')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (integrationError) {
    console.error('[ghl-import] org_integrations lookup failed', integrationError.message);
    return jsonResponse({ error: 'Failed to look up the GHL connection' }, 500);
  }
  if (!integration || integration.status !== 'connected' || !integration.location_id) {
    return jsonResponse({ error: 'GHL is not connected for this org' }, 400);
  }

  const { data: token, error: tokenError } = await supabase.rpc('get_org_ghl_token', {
    p_org: orgId,
  });
  if (tokenError || !token) {
    console.error('[ghl-import] get_org_ghl_token failed', tokenError?.message);
    return jsonResponse({ error: 'Failed to retrieve the GHL token' }, 502);
  }

  const client = createGhlClient(token as string);

  let fetched;
  try {
    fetched = await fetchAllGhlContacts(client, {
      locationId: integration.location_id,
      query: mode === 'search' ? value : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ghl-import] fetchAllGhlContacts failed', message);
    return jsonResponse({ error: `GHL request failed: ${message}` }, 502);
  }

  if (campaignId) {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id')
      .eq('id', campaignId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (!campaign) {
      return jsonResponse({ error: 'campaignId does not belong to this org' }, 400);
    }
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('contacts')
    .select('id, phone_number, ghl_contact_id')
    .eq('org_id', orgId);
  if (existingError) {
    console.error('[ghl-import] existing contacts lookup failed', existingError.message);
    return jsonResponse({ error: 'Failed to look up existing contacts' }, 500);
  }

  const plan = planGhlImport({
    mode,
    value,
    ghlContacts: fetched.contacts,
    existing: (existingRows ?? []) as ExistingContactRow[],
  });

  const now = new Date().toISOString();
  const touchedContactIds: string[] = [];

  if (plan.toInsert.length > 0) {
    const { data: inserted, error: insertError } = await supabase
      .from('contacts')
      .insert(
        plan.toInsert.map((fields) => ({
          user_id: user.id,
          org_id: orgId,
          category: 'Cold',
          contact_status: 'No Contact',
          updated_at: now,
          ...fields,
        }))
      )
      .select('id');
    if (insertError) {
      console.error('[ghl-import] insert failed', insertError.message);
      return jsonResponse({ error: insertError.message }, 500);
    }
    touchedContactIds.push(...(inserted ?? []).map((r: { id: string }) => r.id));
  }

  if (plan.toUpdate.length > 0) {
    const { error: updateError } = await supabase.from('contacts').upsert(
      plan.toUpdate.map((u) => ({ id: u.id, updated_at: now, ...u.patch })),
      { onConflict: 'id' }
    );
    if (updateError) {
      console.error('[ghl-import] update failed', updateError.message);
      return jsonResponse({ error: updateError.message }, 500);
    }
    touchedContactIds.push(...plan.toUpdate.map((u) => u.id));
  }

  if (campaignId && touchedContactIds.length > 0) {
    const leadRows = touchedContactIds.map((contact_id) => ({
      campaign_id: campaignId,
      contact_id,
      org_id: orgId,
      status: 'queued',
    }));
    await supabase
      .from('campaign_leads')
      .upsert(leadRows, { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true });
  }

  return jsonResponse({
    created: plan.created,
    updated: plan.updated,
    skipped: plan.skipped,
    invalid: plan.invalid,
    truncated: fetched.truncated,
  });
});
