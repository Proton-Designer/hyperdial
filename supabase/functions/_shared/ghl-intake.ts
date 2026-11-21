/**
 * TASK-H16: instant lead intake for `ghl-webhook`. After an authenticated webhook names GHL contact X, re-read X from GHL
 * and, if X matches one of the org's `org_ghl_campaign_mappings` (tag or pipeline stage), run the SAME import + queue path
 * the 5-minute pull uses (importGhlContactsForMapping in ghl-pull-run.ts: planGhlImport -> contacts write -> DNC / paused
 * enforcement -> planCampaignQueue -> upsertCampaignLeads). The payload is only a trigger: nothing in it except the id is
 * used. An org with no mappings (or auto-pull off) never reaches this module.
 *
 * Every handled intake writes one row to `ghl_intake_log` (service-only table, pruned after 30 days here) for the Settings
 * card. A transient failure is re-thrown so the webhook answers 503 and GHL retries; the 5-minute pull is the backstop for
 * anything dropped (rate limit, a GHL outage that outlasts GHL's own retries).
 */
import type { GhlClient, GhlContact } from './ghl-client.ts';
import { isTransientReadError } from './ghl-reconcile.ts';
import type { ExistingContactRow } from './ghl-import.ts';
import { normalizePhoneStrict } from './phone-normalize.ts';
import {
  contactMatchesMapping,
  importGhlContactsForMapping,
  type GhlCampaignMappingRow,
} from './ghl-pull-run.ts';
import { buildGhlImportEnrichment } from './ghl-enrichment.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

export type IntakeOutcome =
  | 'queued'
  | 'already_queued'
  | 'skipped_dnc'
  | 'skipped_paused'
  | 'skipped_active_elsewhere'
  | 'no_matching_rule'
  | 'error';

/** Mapping row + its creation time (first match wins by created_at). */
export interface IntakeMapping extends GhlCampaignMappingRow {
  created_at?: string | null;
}

export interface IntakeOrg {
  org_id: string;
  location_id: string | null;
  ghl_dnc_tags?: string[] | null;
  ghl_paused_tags?: string[] | null;
  ghl_field_mapping?: Record<string, string> | null;
}

export interface IntakeResult {
  outcome: IntakeOutcome;
  campaignId: string | null;
  contactId: string | null;
  /** A ghl_intake_log row was written. */
  logged: boolean;
}

export const INTAKE_LOG_RETENTION_DAYS = 30;

function byCreatedAt(a: IntakeMapping, b: IntakeMapping): number {
  return (a.created_at ?? '').localeCompare(b.created_at ?? '');
}

/** Tags that look like a HyperDial campaign tag (`hd-<name>`), the convention n8n / the New Campaign dialog use. */
export function hasCampaignStyleTag(gc: GhlContact): boolean {
  return (Array.isArray(gc.tags) ? gc.tags : []).some(
    (t) => typeof t === 'string' && t.trim().toLowerCase().startsWith('hd-')
  );
}

/** The first mapping (by created_at) this contact matches. Tag: same trim + case-insensitive rule as the pull. Stage: the
 *  contact has an opportunity in that pipeline stage (one GHL search, only when a stage mapping exists). */
async function firstMatchingMapping(
  client: GhlClient,
  org: IntakeOrg,
  gc: GhlContact,
  ghlContactId: string,
  mappings: IntakeMapping[]
): Promise<IntakeMapping | null> {
  let stageIds: Set<string> | null = null;
  for (const m of [...mappings].sort(byCreatedAt)) {
    if (m.match_type === 'tag') {
      if (m.tag && contactMatchesMapping(gc, m)) return m;
      continue;
    }
    if (!m.pipeline_stage_id || !org.location_id) continue;
    if (stageIds === null) {
      stageIds = new Set();
      try {
        const opps = await client.searchOpportunities({
          locationId: org.location_id,
          contactId: ghlContactId,
          limit: 100,
        });
        for (const o of opps.opportunities) {
          if (o.contactId === ghlContactId && o.pipelineStageId) stageIds.add(o.pipelineStageId);
        }
      } catch (err) {
        if (isTransientReadError(err)) throw err;
        console.warn('[ghl-intake] stage lookup failed', err);
      }
    }
    if (stageIds.has(m.pipeline_stage_id)) return m;
  }
  return null;
}

/** Only this contact, matched the way planGhlImport does it: by GHL id or by phone digits. */
async function fetchExistingRowsFor(
  supabase: SupabaseAny,
  orgId: string,
  ghlContactId: string,
  gc: GhlContact
): Promise<ExistingContactRow[]> {
  const phone =
    typeof gc.phone === 'string' && gc.phone.trim() ? normalizePhoneStrict(gc.phone.trim()) : null;
  // ids are validated upstream (letters, digits, - _), the e164 is + and digits only: safe inside an .or() filter
  const filters = [`ghl_contact_id.eq.${ghlContactId}`];
  if (phone) filters.push(`phone_number.eq.${phone.e164}`);
  const { data, error } = await supabase
    .from('contacts')
    .select('id, phone_number, ghl_contact_id, dnc, ghl_tags')
    .eq('org_id', orgId)
    .or(filters.join(','))
    .limit(10);
  if (error) throw new Error(`existing contact lookup failed: ${error.message}`);
  return (data ?? []) as ExistingContactRow[];
}

async function writeLog(
  supabase: SupabaseAny,
  orgId: string,
  row: {
    ghlContactId: string;
    contactId: string | null;
    campaignId: string | null;
    outcome: IntakeOutcome;
    detail?: string | null;
  }
): Promise<boolean> {
  try {
    const { error } = await supabase.from('ghl_intake_log').insert({
      org_id: orgId,
      ghl_contact_id: row.ghlContactId,
      contact_id: row.contactId,
      campaign_id: row.campaignId,
      outcome: row.outcome,
      detail: row.detail ? row.detail.slice(0, 300) : null,
    });
    if (error) throw new Error(error.message);
    const cutoff = new Date(Date.now() - INTAKE_LOG_RETENTION_DAYS * 86_400_000).toISOString();
    const { error: pruneError } = await supabase
      .from('ghl_intake_log')
      .delete()
      .eq('org_id', orgId)
      .lt('received_at', cutoff);
    if (pruneError) console.warn('[ghl-intake] prune failed', pruneError.message);
    return true;
  } catch (err) {
    // the log is a convenience for the Settings card, never a reason to fail (or retry) the intake itself
    console.warn('[ghl-intake] log write failed', err);
    return false;
  }
}

export async function intakeWebhookContact(
  supabase: SupabaseAny,
  client: GhlClient,
  org: IntakeOrg,
  mappings: IntakeMapping[],
  ghlContactId: string,
  opts: { logNoMatch: boolean }
): Promise<IntakeResult> {
  let campaignId: string | null = null;
  try {
    const gc = await client.getContact(ghlContactId);
    const mapping = await firstMatchingMapping(client, org, gc, ghlContactId, mappings);
    if (!mapping) {
      // A "Contact Created" workflow pings for EVERY new GHL contact, so a no-match is only worth a log row when the contact
      // carries a campaign-style tag (`hd-...`): that catches a typo'd campaign tag and ignores unrelated contacts.
      const logged =
        opts.logNoMatch && hasCampaignStyleTag(gc)
          ? await writeLog(supabase, org.org_id, {
              ghlContactId,
              contactId: null,
              campaignId: null,
              outcome: 'no_matching_rule',
            })
          : false;
      return { outcome: 'no_matching_rule', campaignId: null, contactId: null, logged };
    }
    campaignId = mapping.campaign_id;

    const existingRows = await fetchExistingRowsFor(supabase, org.org_id, ghlContactId, gc);
    const enrichment = await buildGhlImportEnrichment(
      supabase,
      client,
      org.org_id,
      org.location_id ?? '',
      org.ghl_field_mapping ?? null
    );
    // a stage mapping's contact is stamped with the stage so the enrichment can name it (as the pull's stage fetch does)
    const contact: GhlContact =
      mapping.match_type === 'stage' ? { ...gc, pipelineStageId: mapping.pipeline_stage_id } : gc;
    const { outcomes } = await importGhlContactsForMapping(supabase, {
      orgId: org.org_id,
      mapping,
      contacts: [contact],
      existingRows,
      dncTags: org.ghl_dnc_tags ?? undefined,
      pausedTags: org.ghl_paused_tags ?? undefined,
      enrichment,
      trackOutcomes: true,
    });
    const r = outcomes.find((o) => o.ghlContactId === ghlContactId);
    const outcome: IntakeOutcome = r?.outcome ?? 'error';
    const contactId = r?.contactId ?? null;
    const logged = await writeLog(supabase, org.org_id, {
      ghlContactId,
      contactId,
      campaignId,
      outcome,
      detail: outcome === 'error' ? 'no usable phone number on the GoHighLevel contact' : null,
    });
    return { outcome, campaignId, contactId, logged };
  } catch (err) {
    // transient (GHL 429/5xx, DB hiccup): let the webhook answer 503 so GHL retries this delivery
    if (isTransientReadError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const logged = await writeLog(supabase, org.org_id, {
      ghlContactId,
      contactId: null,
      campaignId,
      outcome: 'error',
      detail: message,
    });
    return { outcome: 'error', campaignId, contactId: null, logged };
  }
}
