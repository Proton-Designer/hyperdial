/**
 * Per-org LeadConnector (GoHighLevel API v2) REST client (design §6). No env-level
 * token inside -- every call receives the caller's own Private Integration Token via
 * `createGhlClient(token)`, since each org connects its own GHL sub-account.
 *
 * Endpoint shapes, required headers and request/response fields below were verified
 * 2026-09-23 against GHL's own published OpenAPI specs (the marketplace.gohighlevel.com
 * docs site is a client-rendered Docusaurus app that doesn't expose parameter tables to
 * a plain fetch; these specs are the same JSON that site renders from):
 *   https://raw.githubusercontent.com/GoHighLevel/highlevel-api-docs/main/apps/contacts.json
 *   https://raw.githubusercontent.com/GoHighLevel/highlevel-api-docs/main/apps/locations.json
 * Confirmed: base URL `https://services.leadconnectorhq.com`; every request needs a
 * `Version: 2021-07-28` header (an enum of exactly one value in both specs -- not "v3",
 * which is the docs *site's* Docusaurus version, not the API's Version header, and is
 * what a naive fetch-and-summarize of the rendered HTML page returns); auth is a bearer
 * token, and a Private Integration Token satisfies the `Location-Access` security
 * scheme the same as an OAuth access token.
 *
 * `searchContacts` uses `GET /contacts/` (locationId + query + limit + cursor params),
 * not `POST /contacts/search`: the search endpoint's request body
 * (`SearchBodyV2DTO`) is `{"type": "object", "properties": {}}` in the published spec --
 * genuinely undocumented, not just terse -- while `GET /contacts/`'s query parameters
 * are fully typed. `GET /contacts/` is also what the design's "pull by tag or search"
 * language maps onto most directly (`query` is a free-text search; a future pull-import
 * task filtering by tag can extend this with GHL's tag-list params without touching the
 * request shape here).
 *
 * UNVERIFIED (TASK-P3-P2, no live GHL location in this environment): GHL's own spec
 * declares `GET /contacts/`'s response schema (`ContactsSearchSchema`) WITHOUT
 * `firstName`/`lastName`/`phone`/`dnd` -- only `id`/`email`/`timezone`/`tags`/etc --
 * even though `GET /contacts/{contactId}`'s schema (`GetContectByIdSchema`) has the
 * full field set including all four. `GhlContact` and `_shared/ghl-import.ts` assume
 * the list endpoint's *actual* runtime response includes them anyway (a pull-import
 * feature is pointless without a phone number on the list response, and GHL's docs
 * have already been shown twice in this codebase to under-document real behavior --
 * see the `Version` header and `POST /contacts/search` notes above). If a live GHL
 * verify pass finds the list response genuinely omits these fields, `ghl-import`'s
 * per-contact loop needs a `getContact(id)` detail call added to `GhlClient` as a
 * fallback -- not built here since there's no evidence yet that it's needed.
 *
 * apiBase override (TASK-P3-P2, same shape as telnyx-client.ts's TASK-P2-E2 addition):
 * `createGhlClient(token, { apiBase })` -- an explicit constructor option, not a Deno.env
 * read inside this file, so the bare `deno test supabase/functions/_shared` command never
 * needs --allow-env to exercise it. A caller that wants an env-driven override (e.g.
 * ghl-import/index.ts's GHL_API_BASE, for a local mock-GHL curl verification) reads it
 * server-side and passes it through. Production never sets that env var, so every real
 * caller gets the default.
 *
 * TASK-T1 (MISSION-4) additions -- GHL-3/4/5/6/8 -- verified 2026-09-26 the same way (curled
 * raw.githubusercontent.com/GoHighLevel/highlevel-api-docs/main/apps/{opportunities,users,
 * custom-fields}.json, parsed with python, never WebFetch):
 *   - `GET /opportunities/search?location_id&pipeline_stage_id&limit&startAfterId&startAfter` --
 *     note `location_id`/`pipeline_stage_id`/`contact_id`/`pipeline_id` on THIS ONE endpoint are
 *     snake_case in the real spec (`opportunities.json`'s own `parameters` list for
 *     `/opportunities/search`), unlike every other GHL query param in this file (`locationId` on
 *     `/contacts/`, `/opportunities/pipelines`, `/users/`, `/custom-fields/object-key/{objectKey}`
 *     is camelCase) -- a genuine GHL API inconsistency, re-confirmed against the raw spec during
 *     TASK-T2's review fix-forward (review-eng2.md #1/#2 both claimed a mismatch here based on
 *     the marketplace docs SITE, not the spec; the spec and this file's `buildSearchOpportunities-
 *     Query`/`moveOpportunityStage` already agreed -- see audit/T2/ghl-param-evidence.md) --
 *     the ONLY server-side way to filter by pipeline stage (GHL-4's "pull by ... pipeline
 *     stage"); `GET /contacts/` has no stage param at all, same as it has no tag param (see
 *     above). Response: `SearchOpportunitiesResponseSchema` -- `pipelineId`, `pipelineStageId`,
 *     `assignedTo` (a GHL user id), `contactId`, `updatedAt`, `customFields` (OPPORTUNITY-level,
 *     not the contact's own) are all real top-level fields in the published schema, not an
 *     under-documented guess this time.
 *   - `GET /opportunities/pipelines?locationId` -- `{pipelines: [{id, name, stages}]}`. The
 *     spec types `stages` as a bare untyped array (`{"type": "array", "items": {"type":
 *     "array"}}`) -- a lazy/incomplete spec entry, not a real shape; GHL's own product UI proves
 *     each pipeline has named stages, so this client types `stages` as `{id, name}[]` and flags
 *     it UNVERIFIED live (same category as the contacts-list-response gap noted above).
 *   - `GET /contacts/{contactId}` -- `GetContectByIdSchema` (sic, GHL's own typo) is the only
 *     schema in the contacts spec confirmed to carry `assignedTo`, `dateUpdated`, and
 *     `customFields` (`{id, value}[]`, `id` being the location's custom-FIELD-DEFINITION id, not
 *     a per-contact id) all at once. Used for a STAGE-mode pull's per-contact detail fetch
 *     (opportunity search only returns a stripped-down nested contact: id/name/companyName/
 *     email/phone/tags, no assignedTo/customFields/dateUpdated of its own).
 *   - `GET /custom-fields/object-key/{objectKey}?locationId` (`objectKey='contact'`) --
 *     `{fields: [{id, name, ...}], folders}` -- the location's custom FIELD DEFINITIONS, used to
 *     resolve a contact's `customFields[].id` to a human field name (GHL-6's "map GHL custom
 *     fields ... sensible defaults by field name").
 *   - `GET /users/?locationId` -- `{users: [{id, name, firstName, lastName, email, phone}]}` --
 *     the location's GHL users, for GHL-8's "map [a member] via each member's GHL user id."
 *   - Rate limits are NOT modeled in GHL's OpenAPI specs (no `x-ratelimit-*` anywhere in any of
 *     the 5 spec files fetched for this task) -- the marketplace docs SITE states them in prose
 *     (100 requests/10s burst, 200,000/day, per sub-account), but that site is the same
 *     client-rendered Docusaurus app already documented above as unreachable by a plain fetch.
 *     `_shared/ghl-rate-limit.ts` cites this as the best available source and flags it as such;
 *     correct it the first time a live 429 response's own headers are actually observed.
 */

const DEFAULT_GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

interface GhlEnvelope<T> {
  [key: string]: unknown;
}

async function ghlRequest<T = unknown>(
  token: string,
  apiBase: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Version: GHL_API_VERSION,
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const errBody =
      typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed) : String(parsed);
    throw new Error(`GHL API ${method} ${path} failed (${res.status}): ${errBody}`);
  }

  return parsed as T;
}

// ---------------------------------------------------------------------------
// Pure payload/query builders — exported for `deno test` without a network call.
// ---------------------------------------------------------------------------

export interface UpsertContactArgs {
  locationId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  timezone?: string;
  tags?: string[];
  dnd?: boolean;
  source?: string;
}

export interface GhlUpsertContactPayload {
  locationId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  timezone?: string;
  tags?: string[];
  dnd?: boolean;
  source?: string;
}

/** locationId is the only field GHL's spec marks required; everything else passes through as given. */
export function buildUpsertContactPayload(args: UpsertContactArgs): GhlUpsertContactPayload {
  const { locationId, firstName, lastName, email, phone, timezone, tags, dnd, source } = args;
  return {
    locationId,
    ...(firstName !== undefined && { firstName }),
    ...(lastName !== undefined && { lastName }),
    ...(email !== undefined && { email }),
    ...(phone !== undefined && { phone }),
    ...(timezone !== undefined && { timezone }),
    ...(tags !== undefined && { tags }),
    ...(dnd !== undefined && { dnd }),
    ...(source !== undefined && { source }),
  };
}

export interface SearchContactsArgs {
  locationId: string;
  query?: string;
  limit?: number;
  startAfterId?: string;
  startAfter?: number;
}

/** Builds the GET /contacts/ query string (locationId is the one required param). */
export function buildSearchContactsQuery(args: SearchContactsArgs): string {
  const params = new URLSearchParams({ locationId: args.locationId });
  if (args.query !== undefined) params.set('query', args.query);
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  if (args.startAfterId !== undefined) params.set('startAfterId', args.startAfterId);
  if (args.startAfter !== undefined) params.set('startAfter', String(args.startAfter));
  return params.toString();
}

export interface SearchOpportunitiesArgs {
  locationId: string;
  pipelineStageId?: string;
  /** TASK-G30: only this contact's opportunities (`contact_id`, as the existing contact+pipeline lookup uses). */
  contactId?: string;
  limit?: number;
  startAfterId?: string;
  startAfter?: number;
}

/** Builds the GET /opportunities/search query string. locationId is the one required param;
 *  pipeline_stage_id is GHL's own server-side stage filter (GHL-4). */
export function buildSearchOpportunitiesQuery(args: SearchOpportunitiesArgs): string {
  const params = new URLSearchParams({ location_id: args.locationId });
  if (args.pipelineStageId !== undefined) params.set('pipeline_stage_id', args.pipelineStageId);
  if (args.contactId !== undefined) params.set('contact_id', args.contactId);
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  if (args.startAfterId !== undefined) params.set('startAfterId', args.startAfterId);
  if (args.startAfter !== undefined) params.set('startAfter', String(args.startAfter));
  return params.toString();
}

export interface AddNoteArgs {
  body: string;
  userId?: string;
}

export function buildAddNotePayload(args: AddNoteArgs): { body: string; userId?: string } {
  return { body: args.body, ...(args.userId !== undefined && { userId: args.userId }) };
}

export interface CreateTaskArgs {
  title: string;
  dueDate: string;
  body?: string;
  assignedTo?: string;
}

/** title, dueDate and completed are all required by GHL's spec; a new task always starts incomplete. */
export function buildCreateTaskPayload(args: CreateTaskArgs): {
  title: string;
  dueDate: string;
  completed: boolean;
  body?: string;
  assignedTo?: string;
} {
  return {
    title: args.title,
    dueDate: args.dueDate,
    completed: false,
    ...(args.body !== undefined && { body: args.body }),
    ...(args.assignedTo !== undefined && { assignedTo: args.assignedTo }),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface GhlLocation {
  id: string;
  name: string;
}

export interface GhlCustomFieldValue {
  id: string;
  value: unknown;
}

export interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  tags?: string[];
  dnd?: boolean;
  dateAdded?: string;
  /** TASK-T1: confirmed on `GetContectByIdSchema` only (see module header) -- assumed present on
   *  the list response too, same "GHL under-documents the list endpoint's real shape" reasoning
   *  already applied to firstName/lastName/phone/dnd above. */
  dateUpdated?: string;
  assignedTo?: string;
  customFields?: GhlCustomFieldValue[];
  companyName?: string;
  website?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  [key: string]: unknown;
}

export interface GhlPipelineStage {
  id: string;
  name: string;
}

export interface GhlPipeline {
  id: string;
  name: string;
  stages: GhlPipelineStage[];
}

export interface GhlOpportunity {
  id: string;
  pipelineId: string;
  pipelineStageId: string;
  assignedTo?: string;
  contactId: string;
  updatedAt?: string;
  contact?: { id: string; name?: string; companyName?: string; email?: string; phone?: string };
}

export interface GhlUser {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface GhlCustomFieldDef {
  id: string;
  name: string;
}

export interface GhlTag {
  id: string;
  name: string;
}

export interface GhlClient {
  /** GET /locations/{locationId} — used by ghl-connect to validate a token and confirm the location. */
  getLocation(locationId: string): Promise<GhlLocation>;
  /** POST /contacts/upsert — creates or updates by GHL's own dedupe rules (email/phone, per the location's "Allow Duplicate Contact" setting). */
  upsertContact(args: UpsertContactArgs): Promise<{ contactId: string; isNew: boolean }>;
  /** GET /contacts/ — free-text search, cursor-paginated. See the module header for why this is used instead of POST /contacts/search. */
  searchContacts(args: SearchContactsArgs): Promise<{ contacts: GhlContact[]; count: number }>;
  /** POST /contacts/{contactId}/notes */
  addNote(contactId: string, args: AddNoteArgs): Promise<{ noteId: string }>;
  /** POST /contacts/{contactId}/tags */
  addTags(contactId: string, tags: string[]): Promise<void>;
  /** POST /contacts/{contactId}/tasks — used for the callback-disposition task. */
  createTask(contactId: string, args: CreateTaskArgs): Promise<{ taskId: string }>;
  /** PUT /contacts/{contactId} with only { dnd } — turns DND on/off for a known contact id (DNC disposition). */
  setDnd(contactId: string, dnd: boolean): Promise<void>;
  /** MISSION-4 TASK-T2 (GHL-11/13): PUT /contacts/{contactId} with only `customFields` —
   *  verified against contacts.json's `UpdateContactDto`: each entry is `{id, field_value}`
   *  (`id` is the custom-field DEFINITION id, required; `field_value` the value — note the
   *  write-side key is `field_value`, NOT `value`, unlike the READ side's `GhlCustomFieldValue`
   *  T1 already defined for a pulled contact's own `customFields[]`). Never touches any other
   *  contact field (same minimal-PUT shape as `setDnd`). */
  updateContactCustomFields(
    contactId: string,
    fields: { id: string; fieldValue: string }[]
  ): Promise<void>;
  /** GET /contacts/{contactId} — the only endpoint confirmed to return assignedTo/dateUpdated/
   *  customFields together (TASK-T1). Used for a stage-mode pull's per-contact detail fetch. */
  getContact(contactId: string): Promise<GhlContact>;
  /** GET /opportunities/search?pipeline_stage_id=... — TASK-T1 (GHL-4): the only server-side way
   *  to pull contacts by pipeline stage. */
  searchOpportunities(
    args: SearchOpportunitiesArgs
  ): Promise<{ opportunities: GhlOpportunity[]; count: number }>;
  /** GET /opportunities/pipelines — TASK-T1: pipeline/stage id -> name, for resolving a stored
   *  ghl_pipeline_stage to a human label and for the tag/stage -> campaign mapping admin UI. */
  getPipelines(locationId: string): Promise<GhlPipeline[]>;
  /** GET /users/?locationId — TASK-T1 (GHL-8): the location's GHL users, so an owner/admin can
   *  map a member to a real ghl_user_id instead of pasting an opaque string. */
  listUsers(locationId: string): Promise<GhlUser[]>;
  /** GET /custom-fields/object-key/contact?locationId — TASK-T1 (GHL-6): the location's custom
   *  field DEFINITIONS (id -> name), used to resolve `GhlContact.customFields[].id` to a name
   *  and to compute the field-mapping editor's "sensible defaults by field name". */
  listContactCustomFieldDefs(locationId: string): Promise<GhlCustomFieldDef[]>;
  /** TASK-G28: GET /locations/{locationId}/tags -- the location's existing tags (locations.json `get-location-tags`,
   *  200 -> `{ tags: [{ id, name, locationId }] }`; scope locations/tags.readonly). */
  listTags(locationId: string): Promise<GhlTag[]>;
  /** TASK-G28: POST /locations/{locationId}/tags with `{ name }` (locations.json `create-tag`, body `tagBody`
   *  {name} required; 200 -> `{ tag: { id, name, locationId } }`; scope locations/tags.write). */
  createTag(locationId: string, name: string): Promise<GhlTag>;
  /** MISSION-4 TASK-T2 (GHL-12): moves (or creates) the contact's opportunity in the given
   *  pipeline to the given stage. Verified against opportunities.json: `GET
   *  /opportunities/search?contact_id=&pipeline_id=` is the only way to find an existing
   *  opportunity for a contact within one specific pipeline (no "get opportunity by contact+
   *  pipeline" endpoint exists); `PUT /opportunities/{id}` (`UpdateOpportunityDto`) accepts
   *  `pipelineStageId` alone to move an EXISTING opportunity; `POST /opportunities/`
   *  (`CreateOpportunityDto`, required: pipelineId/locationId/name/status/contactId) creates one
   *  already AT the target stage when the contact has none yet in this pipeline — a pulled
   *  contact (or one that's never reached this outcome before) commonly has no opportunity at
   *  all, so "move" must be able to fall back to "create". */
  moveOpportunityStage(args: {
    locationId: string;
    contactId: string;
    pipelineId: string;
    pipelineStageId: string;
    opportunityName: string;
  }): Promise<{ opportunityId: string; created: boolean }>;
}

export interface CreateGhlClientOptions {
  apiBase?: string;
}

export function createGhlClient(token: string, options: CreateGhlClientOptions = {}): GhlClient {
  const apiBase = options.apiBase || DEFAULT_GHL_BASE_URL;
  return {
    async getLocation(locationId) {
      const res = await ghlRequest<{ location?: { id?: string; name?: string } }>(
        token,
        apiBase,
        `/locations/${locationId}`
      );
      if (!res.location?.id) {
        throw new Error('GHL getLocation: response had no location.id');
      }
      return { id: res.location.id, name: res.location.name ?? '' };
    },

    async upsertContact(args) {
      const payload = buildUpsertContactPayload(args);
      const res = await ghlRequest<{ new?: boolean; contact?: { id?: string } }>(
        token,
        apiBase,
        '/contacts/upsert',
        { method: 'POST', body: JSON.stringify(payload) }
      );
      if (!res.contact?.id) {
        throw new Error('GHL upsertContact: response had no contact.id');
      }
      return { contactId: res.contact.id, isNew: res.new === true };
    },

    async searchContacts(args) {
      const qs = buildSearchContactsQuery(args);
      const res = await ghlRequest<{ contacts?: GhlContact[]; count?: number }>(
        token,
        apiBase,
        `/contacts/?${qs}`
      );
      return { contacts: res.contacts ?? [], count: res.count ?? 0 };
    },

    async addNote(contactId, args) {
      const payload = buildAddNotePayload(args);
      const res = await ghlRequest<{ id?: string; note?: { id?: string } }>(
        token,
        apiBase,
        `/contacts/${contactId}/notes`,
        { method: 'POST', body: JSON.stringify(payload) }
      );
      const noteId = res.note?.id ?? res.id;
      if (!noteId) {
        throw new Error('GHL addNote: response had no note id');
      }
      return { noteId };
    },

    async addTags(contactId, tags) {
      await ghlRequest(token, apiBase, `/contacts/${contactId}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tags }),
      });
    },

    async createTask(contactId, args) {
      const payload = buildCreateTaskPayload(args);
      const res = await ghlRequest<{ id?: string }>(
        token,
        apiBase,
        `/contacts/${contactId}/tasks`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      );
      if (!res.id) {
        throw new Error('GHL createTask: response had no task id');
      }
      return { taskId: res.id };
    },

    async setDnd(contactId, dnd) {
      await ghlRequest(token, apiBase, `/contacts/${contactId}`, {
        method: 'PUT',
        body: JSON.stringify({ dnd }),
      });
    },

    async updateContactCustomFields(contactId, fields) {
      await ghlRequest(token, apiBase, `/contacts/${contactId}`, {
        method: 'PUT',
        body: JSON.stringify({
          customFields: fields.map((f) => ({ id: f.id, field_value: f.fieldValue })),
        }),
      });
    },

    async getContact(contactId) {
      const res = await ghlRequest<{ contact?: GhlContact }>(
        token,
        apiBase,
        `/contacts/${contactId}`
      );
      if (!res.contact?.id) {
        throw new Error('GHL getContact: response had no contact.id');
      }
      return res.contact;
    },

    async searchOpportunities(args) {
      const qs = buildSearchOpportunitiesQuery(args);
      const res = await ghlRequest<{ opportunities?: GhlOpportunity[]; meta?: { total?: number } }>(
        token,
        apiBase,
        `/opportunities/search?${qs}`
      );
      return { opportunities: res.opportunities ?? [], count: res.meta?.total ?? 0 };
    },

    async getPipelines(locationId) {
      const qs = new URLSearchParams({ locationId }).toString();
      const res = await ghlRequest<{ pipelines?: GhlPipeline[] }>(
        token,
        apiBase,
        `/opportunities/pipelines?${qs}`
      );
      return res.pipelines ?? [];
    },

    async listUsers(locationId) {
      const qs = new URLSearchParams({ locationId }).toString();
      const res = await ghlRequest<{ users?: GhlUser[] }>(token, apiBase, `/users/?${qs}`);
      return res.users ?? [];
    },

    async listContactCustomFieldDefs(locationId) {
      const qs = new URLSearchParams({ locationId }).toString();
      const res = await ghlRequest<{ fields?: GhlCustomFieldDef[] }>(
        token,
        apiBase,
        `/custom-fields/object-key/contact?${qs}`
      );
      return res.fields ?? [];
    },

    async listTags(locationId) {
      const res = await ghlRequest<{ tags?: { id?: string; name?: string }[] }>(
        token,
        apiBase,
        `/locations/${encodeURIComponent(locationId)}/tags`
      );
      return (res.tags ?? [])
        .filter((t) => typeof t.id === 'string' && typeof t.name === 'string')
        .map((t) => ({ id: t.id as string, name: t.name as string }));
    },

    async createTag(locationId, name) {
      const res = await ghlRequest<{ tag?: { id?: string; name?: string } }>(
        token,
        apiBase,
        `/locations/${encodeURIComponent(locationId)}/tags`,
        { method: 'POST', body: JSON.stringify({ name }) }
      );
      if (!res.tag?.id) {
        throw new Error('GHL createTag: response had no tag.id');
      }
      return { id: res.tag.id, name: res.tag.name ?? name };
    },

    async moveOpportunityStage(args) {
      const qs = new URLSearchParams({
        location_id: args.locationId,
        pipeline_id: args.pipelineId,
        contact_id: args.contactId,
        limit: '1',
      }).toString();
      const searchRes = await ghlRequest<{ opportunities?: GhlOpportunity[] }>(
        token,
        apiBase,
        `/opportunities/search?${qs}`
      );
      const existing = searchRes.opportunities?.[0];
      if (existing?.id) {
        await ghlRequest(token, apiBase, `/opportunities/${existing.id}`, {
          method: 'PUT',
          body: JSON.stringify({ pipelineStageId: args.pipelineStageId }),
        });
        return { opportunityId: existing.id, created: false };
      }
      const createRes = await ghlRequest<{ opportunity?: { id?: string } }>(
        token,
        apiBase,
        '/opportunities/',
        {
          method: 'POST',
          body: JSON.stringify({
            pipelineId: args.pipelineId,
            locationId: args.locationId,
            name: args.opportunityName,
            pipelineStageId: args.pipelineStageId,
            status: 'open',
            contactId: args.contactId,
          }),
        }
      );
      if (!createRes.opportunity?.id) {
        throw new Error('GHL moveOpportunityStage: create response had no opportunity.id');
      }
      return { opportunityId: createRes.opportunity.id, created: true };
    },
  };
}
