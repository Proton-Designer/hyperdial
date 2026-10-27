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

export function slugifyHeader(header: string): string {
  let slug = (header ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) slug = 'field';
  if (!/^[a-z]/.test(slug)) slug = `f_${slug}`;
  return slug.slice(0, MAX_KEY_LENGTH).replace(/_+$/, '');
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
