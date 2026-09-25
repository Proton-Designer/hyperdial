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

/** Upserts `contactIds` onto `campaignId` as `status`, chunked (~200/batch) and error-checked
 * (previously the upsert's result wasn't even captured, so a failure silently queued nothing
 * while the import still reported success). `planCampaignQueue`'s caller has already filtered out
 * every contact known to be DNC/paused/active-elsewhere as of its own point-in-time check, so a
 * 23505 here should be rare -- only a genuine race (a second request queueing the same contact
 * elsewhere between that check and this write). On a 23505, retries that one batch's rows
 * one-at-a-time so the rest of the batch still lands, silently dropping just the row(s) that lost
 * the race rather than failing every contact in the batch for one collision. Any other error
 * still throws. */
export async function upsertCampaignLeads(
  supabase: SupabaseAny,
  args: { campaignId: string; orgId: string; contactIds: string[]; status: string }
): Promise<void> {
  const toRow = (contactId: string) => ({
    campaign_id: args.campaignId,
    contact_id: contactId,
    org_id: args.orgId,
    status: args.status,
  });
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
      if (rowError && rowError.code !== '23505') {
        throw new Error(`campaign_leads upsert failed: ${rowError.message}`);
      }
    }
  }
}
