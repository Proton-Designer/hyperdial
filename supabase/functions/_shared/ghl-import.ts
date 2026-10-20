/**
 * GHL pull-import (TASK-P3-P2, design §7): paging through LeadConnector contacts and
 * turning them into a dedupe/normalize plan for `contacts`. Split into two pure,
 * network-free-except-`fetchAllGhlContacts` pieces so the paging/dedupe logic is
 * `deno test`-able without a Supabase client or a live GHL location -- the
 * `ghl-import` Edge Function itself is the thin `Deno.serve` wrapper that calls these
 * and does the actual DB reads/writes (same split as `_shared/ghl-client.ts`'s pure
 * builders vs. its `createGhlClient` network client).
 */
import type { GhlClient, GhlContact } from './ghl-client.ts';
import { normalizePhoneStrict } from './phone-normalize.ts';
import { timezoneForAreaCode } from './area-code-tz.ts';

export const GHL_IMPORT_PAGE_LIMIT = 100;
/** Bounds a single import run to at most 2,000 GHL contacts fetched, so a "tag" pull
 *  against a huge, mostly-non-matching location (client-side tag filter, no
 *  server-side one exists -- see ghl-client.ts's header) can't run unbounded. */
export const GHL_IMPORT_MAX_PAGES = 20;

export interface FetchAllGhlContactsArgs {
  locationId: string;
  /** Free-text search term (search mode). Omitted entirely for tag mode -- GHL has
   *  no server-side tag filter, so tag mode pages every contact and filters after. */
  query?: string;
  pageLimit?: number;
  maxPages?: number;
}

export interface FetchAllGhlContactsResult {
  contacts: GhlContact[];
  /** true when maxPages was hit while a page was still full -- there may be more
   *  contacts this run did not fetch. */
  truncated: boolean;
}

/**
 * Pages `GET /contacts/` to exhaustion (a short page means "last page") or
 * `maxPages`, whichever comes first. Cursor is (last contact's id, last contact's
 * dateAdded as epoch ms) per GHL's own spec for `startAfterId`/`startAfter`.
 */
export async function fetchAllGhlContacts(
  client: GhlClient,
  args: FetchAllGhlContactsArgs
): Promise<FetchAllGhlContactsResult> {
  const pageLimit = args.pageLimit ?? GHL_IMPORT_PAGE_LIMIT;
  const maxPages = args.maxPages ?? GHL_IMPORT_MAX_PAGES;
  const all: GhlContact[] = [];
  let startAfterId: string | undefined;
  let startAfter: number | undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const res = await client.searchContacts({
      locationId: args.locationId,
      query: args.query,
      limit: pageLimit,
      startAfterId,
      startAfter,
    });
    if (res.contacts.length === 0) break;
    all.push(...res.contacts);

    if (res.contacts.length < pageLimit) break; // short page -- exhausted

    const last = res.contacts[res.contacts.length - 1];
    const lastDateAdded = typeof last.dateAdded === 'string' ? Date.parse(last.dateAdded) : NaN;
    if (!last.id || Number.isNaN(lastDateAdded)) break; // can't derive a safe next cursor

    if (page === maxPages - 1) {
      truncated = true;
      break;
    }
    startAfterId = last.id;
    startAfter = lastDateAdded;
  }

  return { contacts: all, truncated };
}

export interface ExistingContactRow {
  id: string;
  phone_number: string | null;
  ghl_contact_id: string | null;
  /** TASK-L3: needed so the caller knows an updated contact's CURRENT dnc status when this pull
   *  didn't itself indicate dnc=true -- a patch here is only ever `{dnc: true}` or absent, never
   *  an explicit false (see GhlImportContactFields.dnc's own doc), so "does this contact stay
   *  DNC" for an update is `patch.dnc === true || existing.dnc`, not the patch alone. */
  dnc: boolean;
  /** TASK-G7 (GHL-7): the contact's GHL tags as of its last import, or null if never imported
   *  from GHL / imported before this column existed. Used only to detect "was this contact
   *  paused before and is it not paused any more" -- see GhlImportPlan.unpausedCount's header. */
  ghl_tags: string[] | null;
}

/** TASK-T1 (MISSION-4, GHL-3/6/8): the run-wide lookup maps only the CALLER can build, since
 *  resolving them needs a network round trip or an `org_members` lookup that this pure/
 *  network-free planner deliberately never does itself. Applied uniformly to every contact in
 *  one `planGhlImport` call -- built ONCE per run, not once per contact. */
export interface GhlImportEnrichment {
  /** GHL custom-field-definition id -> the org's own target key (e.g. "business_name"). Built
   *  from `org_integrations.ghl_field_mapping` (Settings -> Integrations -> GHL field mapping). */
  fieldMappingByGhlFieldId?: Record<string, string>;
  /** GHL user id -> org member's `auth.users.id` (GHL-8). Built from `org_members.ghl_user_id`. */
  orgMemberIdByGhlUserId?: Record<string, string>;
  /** GHL pipeline-stage id -> its human name, resolved once per run via `getPipelines`. Only
   *  meaningful for a stage-mode pull -- a tag/search-mode contact has no opportunity to look a
   *  stage id up from in the first place, so this map is simply never consulted for those modes. */
  stageNameByPipelineStageId?: Record<string, string>;
}

export interface GhlImportContactFields {
  first_name: string | null;
  last_name: string | null;
  phone_number: string;
  phone_raw: string;
  ghl_contact_id: string;
  timezone?: string;
  /** Only ever `true` -- GHL not-DND never forces an existing contact's dnc back to
   *  false; a human may have set it true for a reason GHL doesn't know about. */
  dnc?: true;
  /** TASK-T1 (GHL-3): the contact's pipeline stage NAME (not the raw id) -- only ever set for a
   *  stage-mode pull whose stage id resolved to a real, currently-existing stage this run; absent
   *  (not overwritten to null) otherwise, so a tag-mode re-import of a contact that already has a
   *  stored stage from an earlier stage-mode pull never blanks it out. */
  ghl_pipeline_stage?: string;
  /** TASK-T1 (GHL-6): mapped custom-field values for target keys with NO dedicated `contacts`
   *  column (license_number, service_zips, tier, list_source, ...) -- e.g.
   *  `{license_number: "RF-1234"}`. A target key that DOES have a dedicated column
   *  (business_name/website/rating/review_count -- see
   *  `ghl-field-mapping.ts`'s `GHL_FIELD_MAPPING_KNOWN_COLUMNS`) is written onto that column
   *  directly below instead, never duplicated in here. Absent (not `{}`) when the org has no
   *  field mapping configured, or every mapped value this run landed on a known column. */
  ghl_custom_fields?: Record<string, unknown>;
  /** TASK-T1 (GHL-6): the four target keys with a dedicated `contacts` column (pre-existing, from
   *  the CSV-import schema) -- only ever set when the org's field mapping resolved a value for
   *  that key this run; absent otherwise (never overwritten to null), same "don't blank out a
   *  value this run didn't touch" rule `ghl_pipeline_stage` follows. `rating`/`review_count` are
   *  parsed from GHL's own (string) custom-field value; an unparseable value is dropped, not
   *  written as NaN/garbage. */
  business_name?: string;
  website?: string;
  rating?: number;
  review_count?: number;
  /** TASK-T1 (GHL-8): the org member this contact's GHL `assignedTo` resolved to, via that
   *  member's own `org_members.ghl_user_id`. Absent when the contact has no GHL assignee, or the
   *  assignee's GHL user id isn't mapped to any org member yet -- never guessed. The dialer's own
   *  queueing/assignment logic never reads this column; it's informational only (GHL-8's own
   *  explicit "the dialer never assigns owners itself"). */
  assigned_user_id?: string;
  /** TASK-G7: the contact's raw GHL tags this run, stored verbatim (not normalized) so a future
   *  import can diff against them -- see ExistingContactRow.ghl_tags. Always set (possibly []),
   *  never omitted, so a contact that had all its tags removed in GHL is recorded as such. */
  ghl_tags: string[];
}

export interface PlannedUpdate {
  id: string;
  patch: GhlImportContactFields;
}

export interface GhlImportPlan {
  toInsert: GhlImportContactFields[];
  toUpdate: PlannedUpdate[];
  created: number;
  updated: number;
  /** Every GHL contact that did not become an insert or an update: no phone at all,
   *  an invalid phone, or a duplicate of another contact already handled earlier in
   *  this same run. Mirrors contacts-import's `skipped` semantics (always incremented
   *  when there's no usable phone) so the two import paths report consistently. */
  skipped: number;
  /** Subset of `skipped` where a phone value was present but failed strict E.164
   *  validation -- same split as contacts-import's `invalid` vs `skipped`. */
  invalid: number;
  /** `ghl_contact_id`s tagged with one of the org's configured paused tags (TASK-G7, GHL-7): the
   *  contact is still inserted/updated normally (paused is a queueing decision, not a stored
   *  field -- there's no `contacts.paused` column), but the caller must exclude these ids from
   *  whatever campaign_leads it queues after this plan runs, AND move any of the contact's
   *  already-active campaign_leads rows to a non-dialable status. */
  pausedGhlContactIds: Set<string>;
  /** ghl_contact_id -> the dnc_numbers.note text the caller should use when writing that
   *  contact's number into `dnc_numbers` (source 'import'). Present for every contact
   *  marked DNC this run: `GHL tag: <tag>` for a tag match, else `GHL do-not-disturb` for GHL's own
   *  `dnd` flag (TASK-G25 / G23 F5: before, a dnd-only contact had no dnc_numbers row, so the
   *  contacts.dnc flag alone kept it blocked and an agent clearing it re-enabled dialing). */
  dncTagNoteByGhlContactId: Map<string, string>;
  /** Contacts that were paused as of their last import (per their stored `ghl_tags`, see
   *  ExistingContactRow) but no longer carry a paused tag this run -- i.e. the paused tag was
   *  removed in GHL since. Reported as a count only: GHL-7's spec is explicit that re-queueing a
   *  formerly-paused contact is a manager's deliberate choice, never automatic, so this planner
   *  does not touch campaign_leads for these -- the caller just surfaces the count. A brand-new
   *  contact (no existing row) can never count here, since it has no prior `ghl_tags` to have
   *  been paused by. */
  unpausedCount: number;
}

/** GHL-7: default blocked-tag lists, used when an org has never customized
 * `org_integrations.ghl_dnc_tags`/`ghl_paused_tags` (both columns default to these same lists at
 * the DB layer -- duplicated here only so this pure module doesn't need a DB round trip just to
 * plan a dry-run/test call with no explicit lists). */
export const DEFAULT_GHL_DNC_TAGS = ['do not call', 'dnc', 'do-not-call'];
export const DEFAULT_GHL_PAUSED_TAGS = ['paused', 'pause'];

/** Case-insensitive, whitespace-trimmed exact match, per the task spec. Not a substring match --
 * a tag list entry of "dnc" must not accidentally match an unrelated tag like "dncx" or a tag
 * that merely contains the word. */
function normalizeTag(t: string): string {
  return t.trim().toLowerCase();
}

function contactTags(gc: GhlContact): string[] {
  return Array.isArray(gc.tags) ? gc.tags.filter((t): t is string => typeof t === 'string') : [];
}

/** Returns the first raw (non-normalized) tag on `tags` that normalizes to a member of
 * `wantedSet`, or undefined if none match -- used both for the paused test (boolean) and the DNC
 * test (also wants the matched tag's original casing for the dnc_numbers note). */
function firstMatchingTag(tags: string[], wantedSet: ReadonlySet<string>): string | undefined {
  return tags.find((t) => wantedSet.has(normalizeTag(t)));
}

export interface PlanGhlImportArgs {
  /** TASK-T1 (GHL-4) adds 'stage': the caller already resolved the matching contacts via
   *  `searchOpportunities`+`getContact` before calling this planner (GHL has a server-side
   *  pipeline-stage filter, unlike tags), so 'stage' needs no client-side filtering here --
   *  same as 'search'. */
  mode: 'tag' | 'search' | 'stage';
  /** The tag to match (tag mode) or the query/stage id that was already sent to GHL (search/stage
   *  mode, kept only for symmetry -- neither mode does client-side filtering, GHL already
   *  filtered server-side). */
  value: string;
  ghlContacts: GhlContact[];
  existing: ExistingContactRow[];
  /** Org-configured blocked-tag lists (Settings -> Integrations -> GHL). Defaults to
   *  DEFAULT_GHL_DNC_TAGS/DEFAULT_GHL_PAUSED_TAGS when omitted. */
  dncTags?: string[];
  pausedTags?: string[];
  /** TASK-T1 (GHL-3/6/8): run-wide lookup maps the caller resolved outside this pure planner
   *  (stage names, custom-field mapping, GHL-user-id -> org-member mapping). Omitted entirely =
   *  no enrichment applied (every existing caller/test still works unchanged). */
  enrichment?: GhlImportEnrichment;
}

/**
 * Pure dedupe/normalize planner -- no network, no DB write. `mode==='tag'` filters
 * client-side on `GhlContact.tags` (exact, case-insensitive match): GHL's own
 * `GET /contacts/` has no server-side tag-filter query param (verified against its
 * published OpenAPI spec -- only `add`/`remove`/`bulk-update` tag endpoints exist,
 * nothing to filter a list *by* tag), so tag mode must page everything and filter
 * here. Dedupe key order matches the task spec: `ghl_contact_id` first, normalized
 * phone second -- a contact already linked by a prior import is matched by id even if
 * its phone changed in GHL since; an unlinked contact (e.g. originally CSV-imported)
 * is matched by phone and gets `ghl_contact_id` stamped onto it going forward.
 */
export function planGhlImport(args: PlanGhlImportArgs): GhlImportPlan {
  const { mode, value, ghlContacts, existing } = args;
  const dncTagSet = new Set((args.dncTags ?? DEFAULT_GHL_DNC_TAGS).map(normalizeTag));
  const pausedTagSet = new Set((args.pausedTags ?? DEFAULT_GHL_PAUSED_TAGS).map(normalizeTag));

  const existingByGhlId = new Map<string, ExistingContactRow>();
  const existingByPhone = new Map<string, ExistingContactRow>();
  for (const row of existing) {
    if (row.ghl_contact_id) existingByGhlId.set(row.ghl_contact_id, row);
    if (row.phone_number) existingByPhone.set(row.phone_number.replace(/\D/g, ''), row);
  }

  const wantedTag = mode === 'tag' ? value.trim().toLowerCase() : null;
  const seenGhlIds = new Set<string>();
  const seenPhones = new Set<string>();

  const toInsert: GhlImportContactFields[] = [];
  const toUpdate: PlannedUpdate[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let invalid = 0;
  const pausedGhlContactIds = new Set<string>();
  const dncTagNoteByGhlContactId = new Map<string, string>();
  let unpausedCount = 0;

  for (const gc of ghlContacts) {
    if (wantedTag !== null) {
      const tags = Array.isArray(gc.tags) ? gc.tags : [];
      const matches = tags.some((t) => typeof t === 'string' && t.toLowerCase() === wantedTag);
      if (!matches) continue; // not selected by this import at all, not a "skip"
    }

    if (!gc.id) {
      skipped++;
      continue;
    }

    const rawPhone = typeof gc.phone === 'string' ? gc.phone.trim() : '';
    const phoneWasProvided = rawPhone !== '';
    const normalized = phoneWasProvided ? normalizePhoneStrict(rawPhone) : null;
    if (!normalized) {
      skipped++;
      if (phoneWasProvided) invalid++;
      continue;
    }

    const digits = normalized.e164.replace(/\D/g, '');
    if (seenGhlIds.has(gc.id) || seenPhones.has(digits)) {
      skipped++; // duplicate within this same fetched batch
      continue;
    }
    seenGhlIds.add(gc.id);
    seenPhones.add(digits);

    const gcTags = contactTags(gc);
    const matchedDncTag = firstMatchingTag(gcTags, dncTagSet);
    const isPausedNow = firstMatchingTag(gcTags, pausedTagSet) !== undefined;

    const timezone = timezoneForAreaCode(normalized.areaCode) ?? undefined;
    const fields: GhlImportContactFields = {
      first_name: typeof gc.firstName === 'string' ? gc.firstName : null,
      last_name: typeof gc.lastName === 'string' ? gc.lastName : null,
      phone_number: normalized.e164,
      phone_raw: rawPhone,
      ghl_contact_id: gc.id,
      ghl_tags: gcTags,
      ...(timezone && { timezone }),
      // dnd is GHL's own do-not-disturb flag; an org-configured DNC tag is the other way in --
      // either one is enough to mark the contact DNC (TASK-G7, GHL-7).
      ...((gc.dnd === true || matchedDncTag !== undefined) && { dnc: true }),
    };

    // TASK-T1 (GHL-3/6/8): apply the run-wide lookup maps, if the caller provided any. Every
    // lookup is a plain miss-is-fine `Record` access -- an unmapped stage/field/assignee simply
    // leaves the corresponding output field unset, never a guess or a thrown error.
    if (args.enrichment) {
      const stageId = typeof gc.pipelineStageId === 'string' ? gc.pipelineStageId : undefined;
      const stageName = stageId ? args.enrichment.stageNameByPipelineStageId?.[stageId] : undefined;
      if (stageName) fields.ghl_pipeline_stage = stageName;

      const fieldMapping = args.enrichment.fieldMappingByGhlFieldId;
      if (fieldMapping && Array.isArray(gc.customFields) && gc.customFields.length > 0) {
        const mappedCustomFields: Record<string, unknown> = {};
        for (const cf of gc.customFields) {
          const targetKey = cf && typeof cf.id === 'string' ? fieldMapping[cf.id] : undefined;
          if (!targetKey) continue;
          const rawValue = cf.value;
          // The four keys with a dedicated `contacts` column go straight onto that column;
          // everything else accumulates into ghl_custom_fields. See GHL_FIELD_MAPPING_KNOWN_
          // COLUMNS's own header for why these four specifically.
          if (targetKey === 'business_name' && typeof rawValue === 'string' && rawValue.trim()) {
            fields.business_name = rawValue.trim();
          } else if (targetKey === 'website' && typeof rawValue === 'string' && rawValue.trim()) {
            fields.website = rawValue.trim();
          } else if (targetKey === 'rating') {
            const n = Number(rawValue);
            if (Number.isFinite(n)) fields.rating = n;
          } else if (targetKey === 'review_count') {
            const n = Number(rawValue);
            if (Number.isFinite(n)) fields.review_count = Math.trunc(n);
          } else {
            mappedCustomFields[targetKey] = rawValue;
          }
        }
        if (Object.keys(mappedCustomFields).length > 0)
          fields.ghl_custom_fields = mappedCustomFields;
      }

      const ownerMap = args.enrichment.orgMemberIdByGhlUserId;
      if (ownerMap && typeof gc.assignedTo === 'string') {
        const memberId = ownerMap[gc.assignedTo];
        if (memberId) fields.assigned_user_id = memberId;
      }
    }

    if (matchedDncTag !== undefined) {
      dncTagNoteByGhlContactId.set(gc.id, `GHL tag: ${matchedDncTag}`);
    } else if (gc.dnd === true) {
      // TASK-G25 (G23 F5): a DND-only contact needs its dnc_numbers row too, otherwise clearing the
      // contacts.dnc flag alone would make it dialable again while GHL still has DND on.
      dncTagNoteByGhlContactId.set(gc.id, 'GHL do-not-disturb');
    }
    if (isPausedNow) {
      pausedGhlContactIds.add(gc.id);
    }

    const match = existingByGhlId.get(gc.id) ?? existingByPhone.get(digits);
    if (match) {
      const wasPausedBefore = firstMatchingTag(match.ghl_tags ?? [], pausedTagSet) !== undefined;
      if (wasPausedBefore && !isPausedNow) unpausedCount++;
      toUpdate.push({ id: match.id, patch: fields });
      updated++;
    } else {
      toInsert.push(fields);
      created++;
    }
  }

  return {
    toInsert,
    toUpdate,
    created,
    updated,
    skipped,
    invalid,
    pausedGhlContactIds,
    dncTagNoteByGhlContactId,
    unpausedCount,
  };
}

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

/** Same PostgREST max_rows=1000 pagination gap as contacts-import's existing-contacts lookup
 *  (TASK-L3 review fix-forward, MAJOR item 5) -- an org with more than 1000 contacts would
 *  otherwise see any dedupe check silently miss everything past the first page. Moved here
 *  (TASK-T1, MISSION-4) from being ghl-import/index.ts's own private helper so
 *  `_shared/ghl-pull-run.ts`'s scheduled/on-demand mapping-driven pulls share the exact same
 *  paging logic instead of a second hand-copied version. */
export async function fetchAllExistingContactRows(
  supabase: SupabaseAny,
  orgId: string
): Promise<ExistingContactRow[]> {
  const PAGE_SIZE = 1000;
  const all: ExistingContactRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, phone_number, ghl_contact_id, dnc, ghl_tags')
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
