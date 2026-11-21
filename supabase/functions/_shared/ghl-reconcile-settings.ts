/**
 * TASK-G12: validation for the owner/admin "Remove from call lists" (GHL reconcile) settings
 * endpoint. Pure, so it is `deno test`-able without auth or a database.
 */

export const MAX_TAGS = 50;
export const MAX_TAG_LENGTH = 100;
export const MAX_STAGE_IDS = 20;
const STAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Trims, drops blanks, dedupes case-insensitively, caps at MAX_TAGS; null on a non-array, a
 *  non-string entry or an entry longer than MAX_TAG_LENGTH. */
export function cleanTagList(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_TAG_LENGTH) return null;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** GHL pipeline-stage ids: strings of letters, digits, `-`, `_`; trimmed, deduped, capped at MAX_STAGE_IDS. */
export function cleanStageIds(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!STAGE_ID_RE.test(trimmed)) return null;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_STAGE_IDS) break;
  }
  return out;
}

export type ReconcileSettingsRequest =
  | { action: 'get' }
  | { action: 'set'; enabled: boolean; excludeTags: string[]; excludeStageIds: string[] };

export function parseReconcileSettingsBody(
  body: unknown
): { ok: true; value: ReconcileSettingsRequest } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Invalid body' };
  const b = body as Record<string, unknown>;
  if (b.action === 'get') return { ok: true, value: { action: 'get' } };
  if (b.action !== 'set') return { ok: false, error: "action must be 'get' or 'set'" };
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  const excludeTags = cleanTagList(b.excludeTags);
  if (excludeTags === null) {
    return {
      ok: false,
      error: `excludeTags must be an array of strings (max ${MAX_TAG_LENGTH} characters each)`,
    };
  }
  const excludeStageIds = cleanStageIds(b.excludeStageIds);
  if (excludeStageIds === null) {
    return { ok: false, error: 'excludeStageIds must be an array of GHL stage ids' };
  }
  return { ok: true, value: { action: 'set', enabled: b.enabled, excludeTags, excludeStageIds } };
}
