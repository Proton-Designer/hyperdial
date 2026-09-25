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
  /** `ghl_contact_id`s tagged `dialer:paused` (TASK-L3, GHL-7): the contact is still
   *  inserted/updated normally (paused is a queueing decision, not a stored field --
   *  there's no `contacts.paused` column), but the caller must exclude these ids from
   *  whatever campaign_leads it queues after this plan runs. */
  pausedGhlContactIds: Set<string>;
}

/** GHL-7 / audit/final.json: "dialer:dnc and dialer:paused tags never queued". Case-insensitive,
 * same matching discipline as the tag-mode filter above. */
const DIALER_DNC_TAG = 'dialer:dnc';
const DIALER_PAUSED_TAG = 'dialer:paused';

function hasTag(gc: GhlContact, tag: string): boolean {
  const tags = Array.isArray(gc.tags) ? gc.tags : [];
  return tags.some((t) => typeof t === 'string' && t.toLowerCase() === tag);
}

export interface PlanGhlImportArgs {
  mode: 'tag' | 'search';
  /** The tag to match (tag mode) or the query that was already sent to GHL (search
   *  mode, kept only for symmetry -- search mode does no client-side filtering, GHL
   *  already filtered server-side). */
  value: string;
  ghlContacts: GhlContact[];
  existing: ExistingContactRow[];
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

    const timezone = timezoneForAreaCode(normalized.areaCode) ?? undefined;
    const fields: GhlImportContactFields = {
      first_name: typeof gc.firstName === 'string' ? gc.firstName : null,
      last_name: typeof gc.lastName === 'string' ? gc.lastName : null,
      phone_number: normalized.e164,
      phone_raw: rawPhone,
      ghl_contact_id: gc.id,
      ...(timezone && { timezone }),
      // dnd is GHL's own do-not-disturb flag; dialer:dnc is our own tag convention -- either one
      // is enough to mark the contact DNC (TASK-L3, GHL-7).
      ...((gc.dnd === true || hasTag(gc, DIALER_DNC_TAG)) && { dnc: true }),
    };
    if (hasTag(gc, DIALER_PAUSED_TAG)) {
      pausedGhlContactIds.add(gc.id);
    }

    const match = existingByGhlId.get(gc.id) ?? existingByPhone.get(digits);
    if (match) {
      toUpdate.push({ id: match.id, patch: fields });
      updated++;
    } else {
      toInsert.push(fields);
      created++;
    }
  }

  return { toInsert, toUpdate, created, updated, skipped, invalid, pausedGhlContactIds };
}
