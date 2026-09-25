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
import { planCampaignQueue, type CampaignQueueCandidate } from '../_shared/campaign-queue.ts';
import {
  fetchActiveElsewhereContactIds,
  fetchDncE164Set,
  upsertCampaignLeads,
} from '../_shared/campaign-queue-io.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** Same PostgREST max_rows=1000 pagination gap as contacts-import's existing-contacts lookup
 * (TASK-L3 review fix-forward, MAJOR item 5) -- an org with more than 1000 contacts would
 * otherwise see this dedupe check silently miss everything past the first page. */
async function fetchAllExistingContactRows(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  orgId: string
): Promise<ExistingContactRow[]> {
  const PAGE_SIZE = 1000;
  const all: ExistingContactRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone_number, ghl_contact_id, dnc')
      .eq('org_id', orgId)
      // TASK-L8 review nit: same as contacts-import's own fetchAllContactRows -- .range() paging
      // with no explicit order isn't guaranteed stable across separate requests.
      .order('id')
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`existing contacts lookup failed: ${error.message}`);
    const page = (data ?? []) as ExistingContactRow[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
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

  // GHL_API_BASE (TASK-P3-P2, same shape as TELNYX_API_BASE): server-side-only override so a
  // local curl verification can redirect this org's client at a mock GHL HTTP server. Reading
  // Deno.env here, not inside ghl-client.ts, keeps that file test-flag-free -- see its header.
  const client = createGhlClient(token as string, {
    apiBase: Deno.env.get('GHL_API_BASE') || undefined,
  });

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

  let existingRows: ExistingContactRow[];
  try {
    existingRows = await fetchAllExistingContactRows(supabase, orgId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ghl-import] existing contacts lookup failed', message);
    return jsonResponse({ error: 'Failed to look up existing contacts' }, 500);
  }

  const plan = planGhlImport({
    mode,
    value,
    ghlContacts: fetched.contacts,
    existing: existingRows,
  });

  const now = new Date().toISOString();
  const existingById = new Map(existingRows.map((r) => [r.id, r]));
  const queueCandidates: CampaignQueueCandidate[] = [];

  // TASK-F-T1 (QUE-7): the org-wide DNC list, checked in addition to (never synced with) GHL's
  // own dnd/dialer:dnc-tag signal already folded into `fields.dnc`/`patch.dnc` above by
  // planGhlImport. One lookup covering every phone number this run touches (a new contact's own
  // field, or an updated contact's patched-or-existing number), then OR'd directly into
  // `fields.dnc`/`u.patch.dnc` BEFORE the insert/update calls below, so contacts.dnc itself
  // reflects the org DNC list for a freshly imported/updated contact, not only the campaign-queue
  // skip decision.
  const dncPhoneNumbers = [
    ...plan.toInsert.map((f) => f.phone_number),
    ...plan.toUpdate
      .map((u) => u.patch.phone_number ?? existingById.get(u.id)?.phone_number)
      .filter((p): p is string => !!p),
  ];
  let dncSet: Set<string>;
  try {
    dncSet = await fetchDncE164Set(supabase, { orgId, phoneNumbers: dncPhoneNumbers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ghl-import] dnc lookup failed', message);
    return jsonResponse({ error: 'Failed to check the do-not-call list' }, 500);
  }
  for (const fields of plan.toInsert) {
    if (dncSet.has(fields.phone_number)) fields.dnc = true;
  }
  for (const u of plan.toUpdate) {
    const phone = u.patch.phone_number ?? existingById.get(u.id)?.phone_number;
    if (phone && dncSet.has(phone)) u.patch.dnc = true;
  }

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
    // .insert() of an array preserves input order in its response, so zipping by index recovers
    // each new row's ghl_contact_id/dnc without a second round trip.
    (inserted ?? []).forEach((row: { id: string }, i) => {
      const fields = plan.toInsert[i];
      queueCandidates.push({
        contactId: row.id,
        dnc: fields.dnc === true,
        paused: plan.pausedGhlContactIds.has(fields.ghl_contact_id),
      });
    });
  }

  if (plan.toUpdate.length > 0) {
    // Individual .update() calls, not .upsert(): PostgREST's upsert always builds a genuine
    // INSERT ... ON CONFLICT DO UPDATE, so Postgres validates NOT NULL columns (user_id,
    // org_id, ...) against the INSERT's proposed row even when a conflict -- and therefore an
    // UPDATE, not a real insert -- is guaranteed. A patch that omits those columns (every
    // patch here does; only the changed fields are included) fails outright. Found live via
    // this task's own post-apply curl verification, not caught by the deno tests (which never
    // touch the real DB) or the migration dry-run.
    for (const u of plan.toUpdate) {
      const { error: updateError } = await supabase
        .from('contacts')
        .update({ updated_at: now, ...u.patch })
        .eq('id', u.id);
      if (updateError) {
        console.error('[ghl-import] update failed', updateError.message);
        return jsonResponse({ error: updateError.message }, 500);
      }
      queueCandidates.push({
        contactId: u.id,
        // patch.dnc is only ever `true` or absent (never an explicit false) -- an update that
        // didn't set it keeps whatever the contact already had.
        dnc: u.patch.dnc === true || existingById.get(u.id)?.dnc === true,
        paused: plan.pausedGhlContactIds.has(u.patch.ghl_contact_id),
      });
    }
  }

  let skippedDnc = 0;
  let skippedPaused = 0;
  let skippedActiveCampaign = 0;

  if (campaignId && queueCandidates.length > 0) {
    let activeElsewhereContactIds: Set<string>;
    try {
      activeElsewhereContactIds = await fetchActiveElsewhereContactIds(supabase, {
        contactIds: queueCandidates.map((c) => c.contactId),
        excludeCampaignId: campaignId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ghl-import] active-elsewhere lookup failed', message);
      return jsonResponse({ error: 'Failed to check existing campaign assignments' }, 500);
    }

    const queuePlan = planCampaignQueue({ candidates: queueCandidates, activeElsewhereContactIds });
    skippedDnc = queuePlan.skippedDnc;
    skippedPaused = queuePlan.skippedPaused;
    skippedActiveCampaign = queuePlan.skippedActiveElsewhere;

    if (queuePlan.toQueue.length > 0) {
      try {
        const { raceDropped } = await upsertCampaignLeads(supabase, {
          campaignId,
          orgId,
          contactIds: queuePlan.toQueue,
          status: 'queued',
        });
        // TASK-L8 review nit: same as contacts-import -- count a contact that lost the race for
        // "active elsewhere" between the check above and this write, don't silently under-report.
        skippedActiveCampaign += raceDropped.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[ghl-import] campaign_leads upsert failed', message);
        return jsonResponse({ error: 'Failed to queue contacts onto the campaign' }, 500);
      }
    }
  }

  return jsonResponse({
    created: plan.created,
    updated: plan.updated,
    skipped: plan.skipped,
    invalid: plan.invalid,
    skippedDnc,
    skippedPaused,
    skippedActiveCampaign,
    truncated: fetched.truncated,
  });
});
