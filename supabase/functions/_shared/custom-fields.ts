/** TASK-H01: turns CSV headers with no canonical match into per-org custom fields. Pure planning, no I/O. */

export const CUSTOM_FIELD_MARKER = 'Custom field';
export const MAX_CUSTOM_FIELDS_PER_ORG = 50;
export const MAX_CUSTOM_LABEL_LENGTH = 60;
export const MAX_CUSTOM_VALUE_LENGTH = 500;
const MAX_KEY_LENGTH = 40;

/** Keys that would shadow a real contacts column or a jsonb helper, so a header like "phone_raw" gets a suffix. */
const RESERVED_KEYS = new Set([
  'id',
  'user_id',
  'org_id',
  'business_name',
  'business_link',
  'business_type',
  'rating',
  'review_count',
  'open_hours',
  'phone_number',
  'phone_raw',
  'website',
  'notes',
  'first_name',
  'last_name',
  'owner_contact',
  'address',
  'city',
  'category',
  'contact_status',
  'timezone',
  'dnc',
  'custom_values',
]);

/** Lowercased, NFKC-normalised, whitespace-collapsed header: what the stable hash below is computed from. */
function normalizeForHash(header: string): string {
  return (header ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** FNV-1a 32-bit over the UTF-16 code units, as 8 hex chars. Sync on purpose (planning is pure and sync). */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Header -> field key. Plain Latin headers slugify as before ("Years in Business?" -> years_in_business). A header whose
 * slug is empty, or that loses non-ASCII letters/digits in the slug ("رقم", "城市", "Ciudad 城市"), gets a stable key
 * with a short hash of the normalised header appended (field_1a2b3c4d, ciudad_9f8e7d6c): the same header gives the same
 * key in every import, whatever its column position, and two different such headers never share one. Accents alone
 * ("Año") are not a loss: NFKD turns them into ASCII + marks.
 */
export function slugifyHeader(header: string): string {
  const decomposed = (header ?? '').normalize('NFKD').replace(/\p{M}+/gu, '');
  const slug = decomposed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const lostLetters = /[^\x00-\x7F]/u.test(decomposed.replace(/[^\p{L}\p{N}\x00-\x7F]/gu, ''));
  if (!slug || lostLetters) {
    const base = slug && /^[a-z]/.test(slug) ? slug : slug ? `f_${slug}` : 'field';
    const hash = shortHash(normalizeForHash(header));
    return `${base.slice(0, MAX_KEY_LENGTH - 9).replace(/_+$/, '')}_${hash}`;
  }
  const keyed = /^[a-z]/.test(slug) ? slug : `f_${slug}`;
  return keyed.slice(0, MAX_KEY_LENGTH).replace(/_+$/, '');
}

export function normalizeLabel(header: string): string {
  const label = (header ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CUSTOM_LABEL_LENGTH);
  return label || 'Field';
}

export function normalizeCustomValue(raw: unknown): string | null {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return null;
  return v.slice(0, MAX_CUSTOM_VALUE_LENGTH);
}

export interface CustomFieldPlan {
  /** original CSV header -> the def key its values are stored under */
  keyByHeader: Map<string, string>;
  /** defs that do not exist yet for the org */
  newDefs: { key: string; label: string }[];
  /** headers that asked for a custom field but fell back to Skip because the org is at the cap */
  overCapHeaders: string[];
}

/**
 * `headers` are the CSV headers the user left on "Create custom field". `existingKeys` are the org's current def keys.
 * The same slug (two headers, or a header matching an existing def) maps to ONE field, so re-imports are idempotent;
 * a slug that would shadow a real column gets a numeric suffix.
 */
export function planCustomFields(args: {
  headers: string[];
  existingKeys: Iterable<string>;
}): CustomFieldPlan {
  const existing = new Set(args.existingKeys);
  const keyByHeader = new Map<string, string>();
  const newDefs: { key: string; label: string }[] = [];
  const overCapHeaders: string[] = [];
  const usedThisRun = new Set<string>();

  for (const header of args.headers) {
    if (keyByHeader.has(header)) continue;
    let key = slugifyHeader(header);
    if (RESERVED_KEYS.has(key)) key = `${key.slice(0, MAX_KEY_LENGTH - 2)}_2`;
    // Two DIFFERENT headers in one file that slugify the same ("Foo Bar" / "foo_bar") stay two fields.
    for (let n = 2; usedThisRun.has(key) && n < 100; n++) {
      key = `${slugifyHeader(header).slice(0, MAX_KEY_LENGTH - 3)}_${n}`;
    }
    if (!existing.has(key) && existing.size + newDefs.length >= MAX_CUSTOM_FIELDS_PER_ORG) {
      overCapHeaders.push(header);
      continue;
    }
    usedThisRun.add(key);
    keyByHeader.set(header, key);
    if (!existing.has(key)) newDefs.push({ key, label: normalizeLabel(header) });
  }
  return { keyByHeader, newDefs, overCapHeaders };
}
