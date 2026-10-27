import { parse } from 'npm:csv-parse/sync';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { normalizePhoneStrict } from '../_shared/phone-normalize.ts';
import { timezoneForAreaCode } from '../_shared/area-code-tz.ts';
import { normalizeListName } from '../_shared/list-name.ts';
import {
  CUSTOM_FIELD_MARKER,
  normalizeCustomValue,
  planCustomFields,
} from '../_shared/custom-fields.ts';
import { planCampaignQueue, type CampaignQueueCandidate } from '../_shared/campaign-queue.ts';
import {
  fetchActiveElsewhereContactIds,
  fetchDncE164Set,
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
      // TASK-L8 review nit: .range() paging with no explicit order isn't guaranteed stable
      // across separate requests -- a row could be skipped or repeated across pages. .order('id')
      // (a unique column) makes the page boundaries deterministic.
      .order('id')
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
  // TASK-H01: canonical, not a custom field (H02 filters by it, H03 autofills from it).
  City: 'city',
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
      /** TASK-G18: optional name of the list being imported (the UI defaults to the file name). */
      list_name?: string;
    };
    const csvText = body?.csv_text;
    const columnMappings = body?.column_mappings;
    const category =
      body?.category && ['Cold', 'Warm', 'Follow Up', 'Voicemail', 'Booked'].includes(body.category)
        ? body.category
        : 'Cold';
    const campaignId = body?.campaign_id?.trim() || null;
    const listName = normalizeListName(body?.list_name);
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

    // TASK-H01: headers left on "Create custom field" become per-org custom fields (idempotent: the
    // same header in a later import reuses the same def). Past the org cap the extra headers are
    // skipped and counted, never an error.
    const customHeaders = [
      ...new Set(
        columnMappings
          .filter((m) => m.mapped_field?.trim() === CUSTOM_FIELD_MARKER && m.original_header)
          .map((m) => m.original_header)
      ),
    ];
    let customKeyByHeader = new Map<string, string>();
    let customFieldsCreated = 0;
    let customFieldsSkipped = 0;
    if (customHeaders.length > 0) {
      const { data: defRows, error: defErr } = await supabase
        .from('contact_field_defs')
        .select('key')
        .eq('org_id', orgId);
      if (defErr) throw new Error(`custom field lookup failed: ${defErr.message}`);
      const plan = planCustomFields({
        headers: customHeaders,
        existingKeys: ((defRows ?? []) as { key: string }[]).map((d) => d.key),
      });
      if (plan.newDefs.length > 0) {
        const { error: insDefErr } = await supabase.from('contact_field_defs').upsert(
          plan.newDefs.map((d) => ({
            org_id: orgId,
            key: d.key,
            label: d.label,
            created_by: user.id,
          })),
          { onConflict: 'org_id,key', ignoreDuplicates: true }
        );
        if (insDefErr) throw new Error(`custom field create failed: ${insDefErr.message}`);
        customFieldsCreated = plan.newDefs.length;
      }
      customKeyByHeader = plan.keyByHeader;
      customFieldsSkipped = plan.overCapHeaders.length;
    }

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
    // TASK-F-T1 (QUE-7): carries an internal-only `phone` field alongside the two real
    // CampaignQueueCandidate fields, used below to build the org-wide DNC lookup -- never passed
    // through to planCampaignQueue as a literal, so TS's excess-property check never sees it.
    // TASK-H01: custom values for re-imported duplicates, merged server-side without overwriting.
    const duplicateCustomValues = new Map<string, Record<string, string>>();
    const duplicateContactCandidates = new Map<
      string,
      CampaignQueueCandidate & { phone: string }
    >();

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
      const customValues: Record<string, string> = {};
      for (const [header, key] of customKeyByHeader) {
        const v = normalizeCustomValue(row[header]);
        if (v !== null) customValues[key] = v;
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
            phone: contact.phone_number as string,
          });
          if (Object.keys(customValues).length > 0) {
            // first occurrence of a key wins when the same phone repeats in one CSV
            duplicateCustomValues.set(existingMatch.id, {
              ...customValues,
              ...(duplicateCustomValues.get(existingMatch.id) ?? {}),
            });
          }
        }
        continue;
      }
      existingSet.add(phoneDigits);
      contact.phone_raw = phoneRaw;
      if (customKeyByHeader.size > 0) contact.custom_values = customValues;
      const timezone = timezoneForAreaCode(areaCode);
      if (timezone) contact.timezone = timezone;
      // TASK-G18: only set when a list name was given, so a request without one never touches the new column.
      if (listName) contact.import_list = listName;
      toInsert.push(contact);
    }

    // TASK-F-T1 (QUE-7): the org-wide DNC list, checked in addition to (never synced with) the
    // per-contact `dnc` flag above. One lookup for every phone number this run touched (fresh
    // inserts + duplicate matches), then OR'd into each candidate's dnc -- and, for fresh inserts,
    // persisted directly onto the new contacts.dnc column, not just used to skip the queue below.
    const dncSet = await fetchDncE164Set(supabase, {
      orgId,
      phoneNumbers: [
        ...toInsert.map((c) => c.phone_number as string),
        ...[...duplicateContactCandidates.values()].map((c) => c.phone),
      ],
    });
    for (const contact of toInsert) {
      if (dncSet.has(contact.phone_number as string)) contact.dnc = true;
    }
    for (const candidate of duplicateContactCandidates.values()) {
      if (dncSet.has(candidate.phone)) candidate.dnc = true;
    }

    // { contactId, dnc } per freshly-inserted row -- dnc now reflects the org-wide DNC check
    // above, not always false, so this is read straight off the insert's own returned rows
    // (matched by phone_number) rather than assumed to line up positionally with `toInsert`.
    let insertedCandidates: { contactId: string; dnc: boolean }[] = [];
    if (toInsert.length > 0) {
      const { data: inserted, error } = await supabase
        .from('contacts')
        .insert(toInsert)
        .select('id, phone_number, dnc');
      if (error) {
        console.error('contacts-import insert error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      imported = toInsert.length;
      insertedCandidates = (inserted ?? []).map((r: { id: string; dnc: boolean }) => ({
        contactId: r.id,
        dnc: r.dnc,
      }));
    }

    if (duplicateCustomValues.size > 0) {
      const items = [...duplicateCustomValues].map(([contact_id, values]) => ({
        contact_id,
        values,
      }));
      for (let i = 0; i < items.length; i += 500) {
        const { error: mergeErr } = await supabase.rpc('import_merge_custom_values', {
          p_org_id: orgId,
          p_items: items.slice(i, i + 500),
        });
        if (mergeErr) console.error('contacts-import custom value merge error:', mergeErr);
      }
    }

    let skippedDnc = 0;
    let skippedActiveCampaign = 0;
    const queueCandidates: CampaignQueueCandidate[] = [
      ...insertedCandidates,
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
          const { raceDropped } = await upsertCampaignLeads(supabase, {
            campaignId,
            orgId,
            contactIds: plan.toQueue,
            status: 'queued',
            listName,
          });
          // TASK-L8 review nit: a contact that lost the race for "active elsewhere" between the
          // check above and this write was not queued -- count it, don't silently under-report.
          skippedActiveCampaign += raceDropped.length;
        }
      }
    }

    // skipped counts every row with no usable phone_number (missing or invalid); invalid
    // is the subset of those where a value was actually provided but libphonenumber-js
    // rejected it -- design §7's "invalid ones are rejected... with a count". skippedDnc/
    // skippedActiveCampaign (TASK-L3) only apply when campaignId is set -- they count contacts
    // that exist (new or matched-duplicate) but were not queued onto it.
    return new Response(
      JSON.stringify({
        imported,
        skipped,
        invalid,
        duplicates,
        skippedDnc,
        skippedActiveCampaign,
        customFieldsCreated,
        customFieldsSkipped,
      }),
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
