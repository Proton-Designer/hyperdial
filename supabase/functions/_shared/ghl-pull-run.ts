/**
 * TASK-T1 (MISSION-4, GHL-4/5): runs ONE configured tag/stage -> campaign mapping end to end --
 * fetch matching GHL contacts, plan (dedupe/DNC/paused/enrichment via `_shared/ghl-import.ts`'s
 * `planGhlImport`), write to `contacts`, enforce DNC/paused org-wide, queue onto the mapped
 * campaign. Shared by the 5-minute cron worker (`ghl-pull-worker`, every enabled org, every one of
 * its mappings) and the on-demand "Sync now" button (`ghl-sync-now`, one org, every one of its
 * mappings, regardless of the auto-pull toggle).
 *
 * Deliberately a SEPARATE orchestration from `ghl-import/index.ts`'s own ad-hoc tag/search pull --
 * that function is already reviewed and deployed and stays untouched here; this one is
 * CONFIG-DRIVEN (an org's own saved `org_ghl_campaign_mappings` rows), not a one-off admin-typed
 * tag/query with an optional campaignId. Both share the same lower-level modules
 * (`planGhlImport`, `campaign-queue.ts`, `campaign-queue-io.ts`) so the dedupe/DNC/queueing rules
 * can never drift between the two entry points even though the glue code around them is written
 * twice.
 */
import type { GhlClient, GhlContact } from './ghl-client.ts';
import {
  fetchAllExistingContactRows,
  fetchAllGhlContacts,
  planGhlImport,
  type ExistingContactRow,
  type GhlImportEnrichment,
} from './ghl-import.ts';
import { planCampaignQueue, type CampaignQueueCandidate } from './campaign-queue.ts';
import {
  fetchActiveElsewhereContactIds,
  fetchDncE164Set,
  insertDncNumbersFromGhlTags,
  setCampaignLeadsStatusForContacts,
  upsertCampaignLeads,
} from './campaign-queue-io.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

export interface GhlCampaignMappingRow {
  id: string;
  match_type: 'tag' | 'stage';
  tag: string | null;
  pipeline_stage_id: string | null;
  campaign_id: string;
}

export interface RunGhlPullMappingArgs {
  orgId: string;
  locationId: string;
  mapping: GhlCampaignMappingRow;
  dncTags?: string[];
  pausedTags?: string[];
  enrichment?: GhlImportEnrichment;
  /** Incremental cursor (GHL-5): a fetched contact whose `dateUpdated` is at or before this is
   *  excluded from the plan entirely -- null/undefined means "no cursor yet" (first run),
   *  process everything fetched. GHL has no server-side "updated since" filter on either the
   *  contacts list or opportunity search (verified against both specs -- see ghl-client.ts's own
   *  header) -- this is a CLIENT-SIDE filter applied after an unavoidably full (bounded) fetch,
   *  not a smaller GHL request; it saves DB writes, not GHL API calls. */
  sinceDate?: Date | null;
}

export interface GhlPullMappingResult {
  mappingId: string;
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  skippedDnc: number;
  skippedPaused: number;
  skippedActiveCampaign: number;
  dncTagged: number;
  pausedTagged: number;
  unpaused: number;
  truncated: boolean;
  /** The max `dateUpdated` seen across every contact FETCHED this run (before the `sinceDate`
   *  filter is applied) -- the caller advances the org's cursor to the max of this across every
   *  mapping run in one pass, so the NEXT run's filter starts from here. Null when nothing fetched
   *  had a `dateUpdated` at all. */
  maxDateUpdatedIso: string | null;
  /** Set only when this mapping's own pull threw (e.g. a stage deleted in GHL since it was
   *  configured, a transient GHL/DB error) -- every other numeric field is left at its zero-ish
   *  default. `runGhlPullForOrg` still runs every OTHER mapping when one fails; it does not
   *  itself throw for a single mapping's failure. */
  error?: string;
}

function parseDateMs(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

const STAGE_PULL_PAGE_LIMIT = 100;
const STAGE_PULL_MAX_PAGES = 20;

/** Stage mode's own bounded page loop over `searchOpportunities`, mirroring `fetchAllGhlContacts`'s
 *  cursor/cap shape -- collects the set of unique contact ids at this stage, then fetches each
 *  contact's full detail (the only endpoint confirmed to carry assignedTo/customFields/
 *  dateUpdated together -- the opportunity's own nested `contact` is missing all three, see
 *  ghl-client.ts's header). */
async function fetchContactsForStage(
  client: GhlClient,
  args: { locationId: string; pipelineStageId: string }
): Promise<{ contacts: GhlContact[]; truncated: boolean }> {
  const contactIds: string[] = [];
  const seen = new Set<string>();
  let startAfterId: string | undefined;
  let startAfter: number | undefined;
  let truncated = false;

  for (let page = 0; page < STAGE_PULL_MAX_PAGES; page++) {
    const res = await client.searchOpportunities({
      locationId: args.locationId,
      pipelineStageId: args.pipelineStageId,
      limit: STAGE_PULL_PAGE_LIMIT,
      startAfterId,
      startAfter,
    });
    if (res.opportunities.length === 0) break;
    for (const opp of res.opportunities) {
      if (opp.contactId && !seen.has(opp.contactId)) {
        seen.add(opp.contactId);
        contactIds.push(opp.contactId);
      }
    }
    if (res.opportunities.length < STAGE_PULL_PAGE_LIMIT) break; // short page -- exhausted

    const last = res.opportunities[res.opportunities.length - 1];
    const lastUpdatedMs = last.updatedAt ? Date.parse(last.updatedAt) : NaN;
    if (!last.id || Number.isNaN(lastUpdatedMs)) break; // can't derive a safe next cursor
    if (page === STAGE_PULL_MAX_PAGES - 1) {
      truncated = true;
      break;
    }
    startAfterId = last.id;
    startAfter = lastUpdatedMs;
  }

  const contacts: GhlContact[] = [];
  for (const contactId of contactIds) {
    try {
      const contact = await client.getContact(contactId);
      // Stamp the stage id onto the contact object so planGhlImport's enrichment step (which
      // reads gc.pipelineStageId via GhlContact's index signature) can resolve its name -- the
      // opportunity search is the only place this pull learned the stage from.
      contacts.push({ ...contact, pipelineStageId: args.pipelineStageId });
    } catch (err) {
      // A single contact's detail fetch failing (deleted mid-run, a transient error) must not
      // fail the whole stage pull -- it's simply left out, same spirit as planGhlImport's own
      // "no usable phone" skip, just one level earlier (no GhlContact to even hand the planner).
      console.warn(`[ghl-pull-run] getContact(${contactId}) failed`, err);
    }
  }
  return { contacts, truncated };
}

/** contacts.user_id is NOT NULL (pre-tenancy-era column, never relaxed -- see
 *  20260924000200's own header on why every other backfill matches to the org's owner instead of
 *  nulling). A cron-triggered pull has no acting admin to attribute the row to, and "Sync now"'s
 *  own caller is deliberately not threaded through either, so every GHL-pull-run-created contact
 *  is attributed to the org's owner, consistently regardless of which entry point ran it. */
async function resolveOrgOwnerUserId(supabase: SupabaseAny, orgId: string): Promise<string> {
  const { data, error } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle();
  if (error || !data?.user_id) {
    throw new Error(`ghl-pull-run: could not resolve an owner for org ${orgId}`);
  }
  return data.user_id as string;
}

export async function runGhlPullMapping(
  supabase: SupabaseAny,
  client: GhlClient,
  args: RunGhlPullMappingArgs
): Promise<GhlPullMappingResult> {
  const { orgId, locationId, mapping } = args;

  const fetched =
    mapping.match_type === 'tag'
      ? await fetchAllGhlContacts(client, { locationId })
      : await fetchContactsForStage(client, {
          locationId,
          pipelineStageId: mapping.pipeline_stage_id!,
        });

  let maxDateUpdatedMs: number | null = null;
  for (const c of fetched.contacts) {
    const ms = parseDateMs(c.dateUpdated);
    if (ms !== null && (maxDateUpdatedMs === null || ms > maxDateUpdatedMs)) maxDateUpdatedMs = ms;
  }

  const sinceMs = args.sinceDate ? args.sinceDate.getTime() : null;
  const contactsToPlan =
    sinceMs === null
      ? fetched.contacts
      : fetched.contacts.filter((c) => {
          const ms = parseDateMs(c.dateUpdated);
          // A contact with no dateUpdated at all is never filtered out by the cursor -- silently
          // dropping it every run would be worse than occasionally re-planning an unchanged one.
          return ms === null || ms > sinceMs;
        });

  const existingRows: ExistingContactRow[] = await fetchAllExistingContactRows(supabase, orgId);

  const plan = planGhlImport({
    mode: mapping.match_type,
    value: mapping.match_type === 'tag' ? mapping.tag! : mapping.pipeline_stage_id!,
    ghlContacts: contactsToPlan,
    existing: existingRows,
    dncTags: args.dncTags,
    pausedTags: args.pausedTags,
    enrichment: args.enrichment,
  });

  if (plan.toInsert.length === 0 && plan.toUpdate.length === 0) {
    return {
      mappingId: mapping.id,
      created: 0,
      updated: 0,
      skipped: plan.skipped,
      invalid: plan.invalid,
      skippedDnc: 0,
      skippedPaused: 0,
      skippedActiveCampaign: 0,
      dncTagged: 0,
      pausedTagged: 0,
      unpaused: plan.unpausedCount,
      truncated: fetched.truncated,
      maxDateUpdatedIso:
        maxDateUpdatedMs !== null ? new Date(maxDateUpdatedMs).toISOString() : null,
    };
  }

  const ownerUserId = await resolveOrgOwnerUserId(supabase, orgId);
  const now = new Date().toISOString();
  const existingById = new Map(existingRows.map((r) => [r.id, r]));

  const dncPhoneNumbers = [
    ...plan.toInsert.map((f) => f.phone_number),
    ...plan.toUpdate
      .map((u) => u.patch.phone_number ?? existingById.get(u.id)?.phone_number)
      .filter((p): p is string => !!p),
  ];
  const dncSet = await fetchDncE164Set(supabase, { orgId, phoneNumbers: dncPhoneNumbers });
  for (const fields of plan.toInsert) {
    if (dncSet.has(fields.phone_number)) fields.dnc = true;
  }
  for (const u of plan.toUpdate) {
    const phone = u.patch.phone_number ?? existingById.get(u.id)?.phone_number;
    if (phone && dncSet.has(phone)) u.patch.dnc = true;
  }

  const queueCandidates: CampaignQueueCandidate[] = [];
  const touched: {
    contactId: string;
    ghlContactId: string;
    phoneNumber: string;
    dnc: boolean;
    paused: boolean;
  }[] = [];

  if (plan.toInsert.length > 0) {
    const { data: inserted, error: insertError } = await supabase
      .from('contacts')
      .insert(
        plan.toInsert.map((fields) => ({
          user_id: ownerUserId,
          org_id: orgId,
          category: 'Cold',
          contact_status: 'No Contact',
          updated_at: now,
          ...fields,
        }))
      )
      .select('id');
    if (insertError) throw new Error(`ghl-pull-run insert failed: ${insertError.message}`);
    (inserted ?? []).forEach((row: { id: string }, i: number) => {
      const fields = plan.toInsert[i];
      const dnc = fields.dnc === true;
      const paused = plan.pausedGhlContactIds.has(fields.ghl_contact_id);
      queueCandidates.push({ contactId: row.id, dnc, paused });
      touched.push({
        contactId: row.id,
        ghlContactId: fields.ghl_contact_id,
        phoneNumber: fields.phone_number,
        dnc,
        paused,
      });
    });
  }

  if (plan.toUpdate.length > 0) {
    // Individual .update() calls, not .upsert() -- same reasoning as ghl-import/index.ts's own
    // comment on this exact pattern: PostgREST's upsert validates NOT NULL columns against the
    // proposed INSERT row even on a guaranteed conflict-then-UPDATE, and a patch here never
    // includes user_id/org_id/category/etc.
    for (const u of plan.toUpdate) {
      const { error: updateError } = await supabase
        .from('contacts')
        .update({ updated_at: now, ...u.patch })
        .eq('id', u.id);
      if (updateError) throw new Error(`ghl-pull-run update failed: ${updateError.message}`);
      const dnc = u.patch.dnc === true || existingById.get(u.id)?.dnc === true;
      const paused = plan.pausedGhlContactIds.has(u.patch.ghl_contact_id);
      queueCandidates.push({ contactId: u.id, dnc, paused });
      touched.push({
        contactId: u.id,
        ghlContactId: u.patch.ghl_contact_id,
        phoneNumber: u.patch.phone_number ?? existingById.get(u.id)?.phone_number ?? '',
        dnc,
        paused,
      });
    }
  }

  const dncNumberRows = touched
    .filter((t) => plan.dncTagNoteByGhlContactId.has(t.ghlContactId) && t.phoneNumber)
    .map((t) => ({
      e164: t.phoneNumber,
      note: plan.dncTagNoteByGhlContactId.get(t.ghlContactId)!,
    }));
  if (dncNumberRows.length > 0) {
    await insertDncNumbersFromGhlTags(supabase, { orgId, rows: dncNumberRows });
  }

  const dncContactIds = touched.filter((t) => t.dnc).map((t) => t.contactId);
  const pausedOnlyContactIds = touched.filter((t) => t.paused && !t.dnc).map((t) => t.contactId);
  if (dncContactIds.length > 0) {
    await setCampaignLeadsStatusForContacts(supabase, {
      orgId,
      contactIds: dncContactIds,
      status: 'dnc',
    });
  }
  if (pausedOnlyContactIds.length > 0) {
    await setCampaignLeadsStatusForContacts(supabase, {
      orgId,
      contactIds: pausedOnlyContactIds,
      status: 'paused',
    });
  }

  let skippedDnc = 0;
  let skippedPaused = 0;
  let skippedActiveCampaign = 0;
  if (queueCandidates.length > 0) {
    const activeElsewhereContactIds = await fetchActiveElsewhereContactIds(supabase, {
      contactIds: queueCandidates.map((c) => c.contactId),
      excludeCampaignId: mapping.campaign_id,
    });
    const queuePlan = planCampaignQueue({ candidates: queueCandidates, activeElsewhereContactIds });
    skippedDnc = queuePlan.skippedDnc;
    skippedPaused = queuePlan.skippedPaused;
    skippedActiveCampaign = queuePlan.skippedActiveElsewhere;
    if (queuePlan.toQueue.length > 0) {
      const { raceDropped } = await upsertCampaignLeads(supabase, {
        campaignId: mapping.campaign_id,
        orgId,
        contactIds: queuePlan.toQueue,
        status: 'queued',
      });
      skippedActiveCampaign += raceDropped.length;
    }
  }

  return {
    mappingId: mapping.id,
    created: plan.created,
    updated: plan.updated,
    skipped: plan.skipped,
    invalid: plan.invalid,
    skippedDnc,
    skippedPaused,
    skippedActiveCampaign,
    dncTagged: touched.filter((t) => t.dnc).length,
    pausedTagged: touched.filter((t) => t.paused).length,
    unpaused: plan.unpausedCount,
    truncated: fetched.truncated,
    maxDateUpdatedIso: maxDateUpdatedMs !== null ? new Date(maxDateUpdatedMs).toISOString() : null,
  };
}

export interface GhlPullOrgResult {
  results: GhlPullMappingResult[];
  totalCreated: number;
  totalUpdated: number;
  maxDateUpdatedIso: string | null;
}

/** Runs every configured mapping for one org, aggregates. A single mapping throwing does not
 *  abort the rest -- one bad mapping (e.g. a stage deleted in GHL since it was configured) must
 *  not block every other mapping's pull, same "isolate one org/mapping's failure" principle
 *  `ghl-pull-worker`'s own per-org loop applies one level up. */
export async function runGhlPullForOrg(
  supabase: SupabaseAny,
  client: GhlClient,
  args: {
    orgId: string;
    locationId: string;
    mappings: GhlCampaignMappingRow[];
    dncTags?: string[];
    pausedTags?: string[];
    enrichment?: GhlImportEnrichment;
    sinceDate?: Date | null;
  }
): Promise<GhlPullOrgResult> {
  const results: GhlPullMappingResult[] = [];
  let maxDateUpdatedMs: number | null = null;

  for (const mapping of args.mappings) {
    try {
      const result = await runGhlPullMapping(supabase, client, {
        orgId: args.orgId,
        locationId: args.locationId,
        mapping,
        dncTags: args.dncTags,
        pausedTags: args.pausedTags,
        enrichment: args.enrichment,
        sinceDate: args.sinceDate,
      });
      results.push(result);
      const ms = parseDateMs(result.maxDateUpdatedIso ?? undefined);
      if (ms !== null && (maxDateUpdatedMs === null || ms > maxDateUpdatedMs))
        maxDateUpdatedMs = ms;
    } catch (err) {
      console.error(`[ghl-pull-run] mapping ${mapping.id} failed`, err);
      results.push({
        mappingId: mapping.id,
        created: 0,
        updated: 0,
        skipped: 0,
        invalid: 0,
        skippedDnc: 0,
        skippedPaused: 0,
        skippedActiveCampaign: 0,
        dncTagged: 0,
        pausedTagged: 0,
        unpaused: 0,
        truncated: false,
        maxDateUpdatedIso: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    results,
    totalCreated: results.reduce((s, r) => s + r.created, 0),
    totalUpdated: results.reduce((s, r) => s + r.updated, 0),
    maxDateUpdatedIso: maxDateUpdatedMs !== null ? new Date(maxDateUpdatedMs).toISOString() : null,
  };
}
