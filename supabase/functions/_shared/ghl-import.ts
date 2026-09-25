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
   *  contact's number into `dnc_numbers` (source 'import'). Only present for contacts marked DNC
   *  by a tag match this run -- a contact marked DNC only via GHL's own `dnd` flag (no matching
   *  tag) is NOT in this map, since there's no "GHL tag: <tag>" to cite and `dnc_numbers` is only
   *  written for the tag-driven case per the task spec (dnd already flows into contacts.dnc and
   *  the org-wide dnc_numbers-vs-dnc-flag reconciliation is out of scope for this planner). */
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
  mode: 'tag' | 'search';
  /** The tag to match (tag mode) or the query that was already sent to GHL (search
   *  mode, kept only for symmetry -- search mode does no client-side filtering, GHL
   *  already filtered server-side). */
  value: string;
  ghlContacts: GhlContact[];
  existing: ExistingContactRow[];
  /** Org-configured blocked-tag lists (Settings -> Integrations -> GHL). Defaults to
   *  DEFAULT_GHL_DNC_TAGS/DEFAULT_GHL_PAUSED_TAGS when omitted. */
  dncTags?: string[];
  pausedTags?: string[];
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
    if (matchedDncTag !== undefined) {
      dncTagNoteByGhlContactId.set(gc.id, `GHL tag: ${matchedDncTag}`);
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
