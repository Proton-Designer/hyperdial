import { parse } from 'npm:csv-parse/sync';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { normalizePhoneStrict } from '../_shared/phone-normalize.ts';
import { timezoneForAreaCode } from '../_shared/area-code-tz.ts';
import { planCampaignQueue, type CampaignQueueCandidate } from '../_shared/campaign-queue.ts';
import {
  fetchActiveElsewhereContactIds,
  upsertCampaignLeads,
} from '../_shared/campaign-queue-io.ts';

/** PostgREST's default `max_rows` caps a single `.select()` at 1000 rows -- an org with more
 * contacts than that would silently see only a partial existing-contacts set, which (as of the
 * TASK-L3 unique index) makes a re-import of an untracked contact's phone number 500 the whole
 * batch insert instead of being recognized as a duplicate. Pages through with `.range()` until a
 * page comes back short. */
async function fetchAllContactRows(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  orgId: string
): Promise<{ id: string; phone_number: string | null; dnc: boolean }[]> {
  const PAGE_SIZE = 1000;
  const all: { id: string; phone_number: string | null; dnc: boolean }[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone_number, dnc')
      .eq('org_id', orgId)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`existing-contacts lookup failed: ${error.message}`);
    const page = (data ?? []) as { id: string; phone_number: string | null; dnc: boolean }[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

const CANONICAL_TO_DB: Record<string, string> = {
  'Business Name': 'business_name',
  'Business Link': 'business_link',
  'Business Type': 'business_type',
  Rating: 'rating',
  'Review Count': 'review_count',
  'Open Hours': 'open_hours',
  'Phone Number': 'phone_number',
  Website: 'website',
  Notes: 'notes',
  'First Name': 'first_name',
  'Last Name': 'last_name',
  'Owner Contact': 'owner_contact',
  Address: 'address',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  // Design §2 permission matrix: importing contacts is owner/admin only.
  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  try {
    const body = (await req.json()) as {
      csv_text?: string;
      column_mappings?: { original_header: string; mapped_field: string | null }[];
      category?: string;
      campaign_id?: string;
    };
    const csvText = body?.csv_text;
    const columnMappings = body?.column_mappings;
    const category =
      body?.category && ['Cold', 'Warm', 'Follow Up', 'Voicemail', 'Booked'].includes(body.category)
        ? body.category
        : 'Cold';
    const campaignId = body?.campaign_id?.trim() || null;
    if (!csvText || !Array.isArray(columnMappings)) {
      return new Response(JSON.stringify({ error: 'Missing csv_text or column_mappings' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];

    const headerToDb = new Map<string, string>();
    for (const m of columnMappings) {
      const mapped = m.mapped_field?.trim();
      if (mapped && mapped !== 'Skip this column' && CANONICAL_TO_DB[mapped]) {
        headerToDb.set(m.original_header, CANONICAL_TO_DB[mapped]);
      }
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const existingPhones = await fetchAllContactRows(supabase, orgId);
    const existingByPhoneDigits = new Map<string, { id: string; dnc: boolean }>();
    for (const r of existingPhones) {
      if (r.phone_number) existingByPhoneDigits.set(r.phone_number.replace(/\D/g, ''), r);
    }
    const existingSet = new Set(existingByPhoneDigits.keys());

    let imported = 0;
    let skipped = 0;
    let invalid = 0;
    let duplicates = 0;
    const toInsert: Record<string, unknown>[] = [];
    // Every existing contact this run matched by phone (a "duplicate" row in the CSV) is still a
    // campaign-queue candidate below if campaignId is set -- re-importing the same list into a
    // different campaign should attach it, not silently do nothing, as long as it isn't DNC or
    // already active elsewhere. Keyed by contactId (not a plain array) so the SAME phone number
    // repeated more than twice in one CSV -- which resolves to the same existing contact every
    // time -- contributes exactly one candidate; an array here would double/triple-count that one
    // contact into skippedDnc/skippedActiveCampaign for every extra repeat, even though only one
    // real contact was ever actually affected.
    const duplicateContactCandidates = new Map<string, CampaignQueueCandidate>();

    for (const row of rows) {
      const contact: Record<string, unknown> = {
        user_id: user.id,
        org_id: orgId,
        category,
        contact_status: 'No Contact',
        updated_at: new Date().toISOString(),
      };
      let phoneValue: string | null = null;
      let phoneRaw: string | null = null;
      let phoneWasProvided = false;
      let areaCode: string | null = null;
      for (const [origHeader, dbCol] of headerToDb) {
        const val = row[origHeader] != null ? String(row[origHeader]).trim() : '';
        if (dbCol === 'phone_number') {
          phoneWasProvided = val !== '';
          phoneRaw = val || null;
          const normalized = normalizePhoneStrict(val);
          phoneValue = normalized?.e164 ?? null;
          areaCode = normalized?.areaCode ?? null;
          contact[dbCol] = phoneValue;
        } else if (dbCol === 'rating') {
          const num = parseFloat(val);
          contact[dbCol] = isNaN(num) ? null : num;
        } else if (dbCol === 'review_count') {
          const num = parseInt(val, 10);
          contact[dbCol] = isNaN(num) ? null : num;
        } else {
          contact[dbCol] = val || null;
        }
      }
      if (!contact.phone_number) {
        if (phoneWasProvided) invalid++;
        skipped++;
        continue;
      }
      const phoneDigits = (contact.phone_number as string).replace(/\D/g, '');
      if (existingSet.has(phoneDigits)) {
        duplicates++;
        // A match against a real DB contact (not just another row earlier in this same CSV
        // batch, which has no contact id yet -- its first occurrence already goes through the
        // insert+queue path below) is still a campaign-queue candidate.
        const existingMatch = existingByPhoneDigits.get(phoneDigits);
        if (existingMatch) {
          duplicateContactCandidates.set(existingMatch.id, {
            contactId: existingMatch.id,
            dnc: existingMatch.dnc,
          });
        }
        continue;
      }
      existingSet.add(phoneDigits);
      contact.phone_raw = phoneRaw;
      const timezone = timezoneForAreaCode(areaCode);
      if (timezone) contact.timezone = timezone;
      toInsert.push(contact);
    }

    let insertedContactIds: string[] = [];
    if (toInsert.length > 0) {
      const { data: inserted, error } = await supabase
        .from('contacts')
        .insert(toInsert)
        .select('id');
      if (error) {
        console.error('contacts-import insert error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      imported = toInsert.length;
      insertedContactIds = (inserted ?? []).map((r: { id: string }) => r.id);
    }

    let skippedDnc = 0;
    let skippedActiveCampaign = 0;
    // Every freshly-inserted contact is dnc=false by construction (CSV import never sets it) --
    // only the duplicate-matched existing contacts can already be DNC.
    const queueCandidates: CampaignQueueCandidate[] = [
      ...insertedContactIds.map((contactId) => ({ contactId, dnc: false })),
      ...duplicateContactCandidates.values(),
    ];

    if (campaignId && queueCandidates.length > 0) {
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('id')
        .eq('id', campaignId)
        .eq('org_id', orgId)
        .maybeSingle();
      if (campaign) {
        const activeElsewhereContactIds = await fetchActiveElsewhereContactIds(supabase, {
          contactIds: queueCandidates.map((c) => c.contactId),
          excludeCampaignId: campaignId,
        });

        const plan = planCampaignQueue({ candidates: queueCandidates, activeElsewhereContactIds });
        skippedDnc = plan.skippedDnc;
        skippedActiveCampaign = plan.skippedActiveElsewhere;

        if (plan.toQueue.length > 0) {
          await upsertCampaignLeads(supabase, {
            campaignId,
            orgId,
            contactIds: plan.toQueue,
            status: 'queued',
          });
        }
      }
    }

    // skipped counts every row with no usable phone_number (missing or invalid); invalid
    // is the subset of those where a value was actually provided but libphonenumber-js
    // rejected it -- design §7's "invalid ones are rejected... with a count". skippedDnc/
    // skippedActiveCampaign (TASK-L3) only apply when campaignId is set -- they count contacts
    // that exist (new or matched-duplicate) but were not queued onto it.
    return new Response(
      JSON.stringify({ imported, skipped, invalid, duplicates, skippedDnc, skippedActiveCampaign }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('contacts-import error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
