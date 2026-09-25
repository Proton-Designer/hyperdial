/**
 * DB-touching companions to `campaign-queue.ts`'s pure `planCampaignQueue` -- deliberately kept
 * out of that module (its own header says "pure/network-free so it's deno test-able"). Shared by
 * `contacts-import` and `ghl-import` so the chunking/error-handling discipline below (TASK-L3
 * review fix-forward, MAJOR item 4) lives in exactly one place instead of being copy-pasted.
 */
import { ACTIVE_CAMPAIGN_LEAD_STATUSES, chunk } from './campaign-queue.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

/** Every contact id in `contactIds` that already has an ACTIVE campaign_leads row (queued/
 * in_flight/callback) in some campaign OTHER than `excludeCampaignId`. Chunks the `.in()` query
 * (~200/batch) so a large import doesn't hit a URL length limit, and THROWS on any query error
 * instead of the previous behavior of silently treating a failed lookup as "nobody is active
 * elsewhere" -- that silence would have defeated QUE-8's whole purpose on exactly the request
 * that most needed the check (a big enough contact_id list to fail in the first place). */
export async function fetchActiveElsewhereContactIds(
  supabase: SupabaseAny,
  args: { contactIds: string[]; excludeCampaignId: string }
): Promise<Set<string>> {
  const result = new Set<string>();
  for (const batch of chunk(args.contactIds, 200)) {
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('campaign_leads')
      .select('contact_id')
      .neq('campaign_id', args.excludeCampaignId)
      .in('status', ACTIVE_CAMPAIGN_LEAD_STATUSES)
      .in('contact_id', batch);
    if (error) {
      throw new Error(`active-elsewhere lookup failed: ${error.message}`);
    }
    for (const row of (data ?? []) as { contact_id: string }[]) {
      result.add(row.contact_id);
    }
  }
  return result;
}

/** TASK-F-T1 (QUE-7): every E.164 in `phoneNumbers` that is on the org-wide `dnc_numbers` list.
 * Same chunking/error-throwing discipline as `fetchActiveElsewhereContactIds` above -- a failed
 * lookup must fail the import, not silently import DNC numbers as if the list were empty. Callers
 * OR this into a per-candidate `dnc` boolean alongside the existing `contacts.dnc` flag check;
 * `planCampaignQueue` itself only ever takes an externally-computed boolean, so this is purely a
 * caller-side concern. */
export async function fetchDncE164Set(
  supabase: SupabaseAny,
  args: { orgId: string; phoneNumbers: string[] }
): Promise<Set<string>> {
  const result = new Set<string>();
  for (const batch of chunk(args.phoneNumbers, 200)) {
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('dnc_numbers')
      .select('e164')
      .eq('org_id', args.orgId)
      .in('e164', batch);
    if (error) {
      throw new Error(`dnc lookup failed: ${error.message}`);
    }
    for (const row of (data ?? []) as { e164: string }[]) {
      result.add(row.e164);
    }
  }
  return result;
}

/** Upserts `contactIds` onto `campaignId` as `status`, chunked (~200/batch) and error-checked
 * (previously the upsert's result wasn't even captured, so a failure silently queued nothing
 * while the import still reported success). `planCampaignQueue`'s caller has already filtered out
 * every contact known to be DNC/paused/active-elsewhere as of its own point-in-time check, so a
 * 23505 here should be rare -- only a genuine race (a second request queueing the same contact
 * elsewhere between that check and this write). On a 23505, retries that one batch's rows
 * one-at-a-time so the rest of the batch still lands; a row that ALSO 23505s on its own individual
 * retry genuinely lost the race and is returned in `raceDropped` (TASK-L8 review nit: previously
 * silently dropped with no way for the caller to count it in a skip total, so the response could
 * claim more contacts were queued than actually were). Any other error still throws. */
export async function upsertCampaignLeads(
  supabase: SupabaseAny,
  args: { campaignId: string; orgId: string; contactIds: string[]; status: string }
): Promise<{ raceDropped: string[] }> {
  const toRow = (contactId: string) => ({
    campaign_id: args.campaignId,
    contact_id: contactId,
    org_id: args.orgId,
    status: args.status,
  });
  const raceDropped: string[] = [];
  for (const batch of chunk(args.contactIds, 200)) {
    if (batch.length === 0) continue;
    const { error } = await supabase
      .from('campaign_leads')
      .upsert(batch.map(toRow), { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true });
    if (!error) continue;
    if (error.code !== '23505') {
      throw new Error(`campaign_leads upsert failed: ${error.message}`);
    }
    for (const contactId of batch) {
      const { error: rowError } = await supabase.from('campaign_leads').upsert([toRow(contactId)], {
        onConflict: 'campaign_id,contact_id',
        ignoreDuplicates: true,
      });
      if (rowError) {
        if (rowError.code !== '23505') {
          throw new Error(`campaign_leads upsert failed: ${rowError.message}`);
        }
        raceDropped.push(contactId);
      }
    }
  }
  return { raceDropped };
}

/** TASK-G7 (GHL-7): writes the org-wide DNC list entry for a contact whose GHL tags matched one
 * of the org's configured DNC tags this import. `ignoreDuplicates` -- a number can already be on
 * the list (manual entry, a prior disposition, or a prior import) and re-importing must not
 * clobber that earlier row's own note/source/added_by. Chunked like every other batch write in
 * this file. */
export async function insertDncNumbersFromGhlTags(
  supabase: SupabaseAny,
  args: { orgId: string; rows: { e164: string; note: string }[] }
): Promise<void> {
  for (const batch of chunk(args.rows, 200)) {
    if (batch.length === 0) continue;
    const { error } = await supabase.from('dnc_numbers').upsert(
      batch.map((r) => ({ org_id: args.orgId, e164: r.e164, source: 'import', note: r.note })),
      { onConflict: 'org_id,e164', ignoreDuplicates: true }
    );
    if (error) throw new Error(`dnc_numbers insert failed: ${error.message}`);
  }
}

/** TASK-G7 (GHL-7): "if it's already queued, set those campaign_leads to a non-dialable status."
 * Moves every ACTIVE campaign_leads row (see ACTIVE_CAMPAIGN_LEAD_STATUSES) for the given contacts
 * -- across ALL of the org's campaigns, not only the one this import may be queueing into --
 * to `status`. Mirrors `submit_disposition`'s own org-wide `update ... where contact_id = ...`
 * for a disposition-driven DNC (20260924002200/20260925060000): once a contact is known DNC (or,
 * new for this task, paused), it must stop being dialable everywhere, not just in the campaign
 * the current request happens to be about. */
export async function setCampaignLeadsStatusForContacts(
  supabase: SupabaseAny,
  args: { orgId: string; contactIds: string[]; status: string }
): Promise<void> {
  for (const batch of chunk(args.contactIds, 200)) {
    if (batch.length === 0) continue;
    const { error } = await supabase
      .from('campaign_leads')
      .update({ status: args.status, updated_at: new Date().toISOString() })
      .eq('org_id', args.orgId)
      .in('contact_id', batch)
      .in('status', ACTIVE_CAMPAIGN_LEAD_STATUSES);
    if (error) {
      throw new Error(`campaign_leads status update to '${args.status}' failed: ${error.message}`);
    }
  }
}
