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

export interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  tags?: string[];
  dnd?: boolean;
  dateAdded?: string;
  [key: string]: unknown;
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
  };
}
