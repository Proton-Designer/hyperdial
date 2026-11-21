/**
 * TASK-G28: make sure every tag HyperDial is configured to read or write EXISTS in the org's GHL location.
 * The tags are: the "Remove from call lists" exclude tags, the DNC and paused tags, and every disposition's
 * ghl_tag. GHL creates a tag implicitly when it is added to a contact, but the reconcile only READS tags, and a
 * workflow trigger cannot be built on a tag that does not exist yet -- so connect and every tag save create the
 * missing ones up front (GET /locations/{id}/tags, then POST for each missing name).
 *
 * Never blocks: a failure is returned in the result (and shown in Settings), the connect / save itself goes on.
 * GHL tag names are compared case-insensitively (GHL stores them lower-cased).
 */
import type { GhlTag } from './ghl-client.ts';

export const MAX_TAG_LENGTH = 100;
/** A location can hold many tags; creating more than this in one go means the config is wrong, not the location. */
export const MAX_TAGS_CREATED_PER_RUN = 60;

export interface GhlTagApi {
  listTags(locationId: string): Promise<GhlTag[]>;
  createTag(locationId: string, name: string): Promise<GhlTag>;
}

export interface EnsureTagsResult {
  /** tags that were already in the location */
  existing: string[];
  /** tags created now */
  created: string[];
  /** tags that could not be created, with the reason */
  failed: { tag: string; error: string }[];
  /** set when the existing tags could not be listed: nothing was created (a blind create could duplicate) */
  listError: string | null;
}

/** Trim and collapse inner whitespace. Returns null for a blank or over-long name. */
export function cleanTagName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const t = input.trim().replace(/\s+/g, ' ');
  if (!t || t.length > MAX_TAG_LENGTH) return null;
  return t;
}

/** Union of the given tag lists: cleaned, de-duplicated case-insensitively (first spelling wins), blanks dropped. */
export function uniqueTags(...lists: (readonly unknown[] | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const t = cleanTagName(raw);
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/** The wanted tags that are not in `existingNames` (case-insensitive). */
export function missingTags(wanted: readonly string[], existingNames: readonly string[]): string[] {
  const have = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  return wanted.filter((t) => !have.has(t.toLowerCase()));
}

export async function ensureGhlTags(
  api: GhlTagApi,
  locationId: string,
  wantedRaw: readonly string[]
): Promise<EnsureTagsResult> {
  const wanted = uniqueTags(wantedRaw);
  const result: EnsureTagsResult = { existing: [], created: [], failed: [], listError: null };
  if (wanted.length === 0) return result;

  let names: string[];
  try {
    names = (await api.listTags(locationId)).map((t) => t.name);
  } catch (err) {
    result.listError = err instanceof Error ? err.message : String(err);
    return result;
  }
  const missing = missingTags(wanted, names);
  const missingKeys = new Set(missing.map((t) => t.toLowerCase()));
  result.existing = wanted.filter((t) => !missingKeys.has(t.toLowerCase()));

  for (const tag of missing) {
    if (result.created.length >= MAX_TAGS_CREATED_PER_RUN) {
      result.failed.push({ tag, error: 'too many new tags in one run' });
      continue;
    }
    try {
      await api.createTag(locationId, tag);
      result.created.push(tag);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // created by someone else between our list and our create: the tag exists, which is what we wanted
      if (/already exist|duplicate/i.test(error)) result.existing.push(tag);
      else result.failed.push({ tag, error });
    }
  }
  return result;
}

export type TagsBody = { action: 'list' } | { action: 'create'; name: string };

/** Request body of the ghl-tags endpoint. */
export function parseTagsBody(
  raw: unknown
): { ok: true; value: TagsBody } | { ok: false; error: string } {
  const body = (raw ?? {}) as { action?: unknown; name?: unknown };
  if (body.action === 'list') return { ok: true, value: { action: 'list' } };
  if (body.action === 'create') {
    const name = cleanTagName(body.name);
    if (!name) return { ok: false, error: `name must be 1-${MAX_TAG_LENGTH} characters` };
    return { ok: true, value: { action: 'create', name } };
  }
  return { ok: false, error: "action must be 'list' or 'create'" };
}

export function sortTagNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
