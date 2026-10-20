/**
 * MISSION-4 TASK-T1 (GHL-6): "sensible defaults by field name" for the org's GHL custom-field
 * mapping editor. Pure/network-free -- the caller (an edge function) fetches the location's real
 * custom field definitions via `GhlClient.listContactCustomFieldDefs` and hands them here.
 *
 * Exact match only (case-insensitive, trimmed), never a substring match -- same "exact after
 * trim+lowercase" rule `ghl-import.ts`'s own tag matching already establishes for this codebase,
 * to avoid a field named e.g. "Website Note" being wrongly suggested for the "website" target key.
 */
import type { GhlCustomFieldDef } from './ghl-client.ts';

/** The task's own example target keys (business name, website, rating, review count, license #,
 *  service ZIPs, tier, list source) -- an open-ended set in practice (org_integrations.
 *  ghl_field_mapping is a plain jsonb object, not a fixed enum), but these are the ones worth a
 *  built-in name-matching guess.
 *
 *  MISSION-4 TASK-T2 (GHL-11/13): `last_call_at`/`last_call_outcome`/`call_attempts` are the
 *  three PUSH-direction keys ("push custom fields: last call time, last outcome, attempt
 *  count ... field keys configurable in the same GHL field mapping as T1") -- the SAME
 *  `ghl_field_mapping` jsonb (target key -> GHL custom-field-definition id) is reused unchanged
 *  in its natural stored direction for push, no separate mapping/migration needed. Unlike the
 *  first eight, these three are never read FROM a pulled GHL contact (there's no dedicated-column
 *  question for them), only ever WRITTEN to one at push time -- so they never appear in
 *  `GHL_FIELD_MAPPING_KNOWN_COLUMNS` below (that set is pull-direction only).
 *
 *  TASK-G02 (spec §1): `callback_at`/`call_duration`/`recording_url` are three more push-only keys
 *  (callback date/time, call duration in seconds, recording link). */
export const GHL_FIELD_MAPPING_TARGET_KEYS = [
  'business_name',
  'website',
  'rating',
  'review_count',
  'license_number',
  'service_zips',
  'tier',
  'list_source',
  'last_call_at',
  'last_call_outcome',
  'call_attempts',
  'callback_at',
  'call_duration',
  'recording_url',
] as const;

/** TASK-T1 (GHL-6): `business_name`/`website`/`rating`/`review_count` already have DEDICATED,
 *  actively-used `contacts` columns (from the original CSV-import schema, `2025021400001` --
 *  Contacts.tsx already reads/displays them) -- a value mapped to one of these four target keys
 *  is written straight onto that existing column, not into `ghl_custom_fields`. Every other
 *  target key (license_number, service_zips, tier, list_source, and any future org-added one --
 *  ghl_field_mapping is an open-ended jsonb object, not a fixed enum) has no dedicated column and
 *  goes into `ghl_custom_fields` instead. See `ghl-import.ts`'s own enrichment-application code
 *  for where this set is consulted. */
export const GHL_FIELD_MAPPING_KNOWN_COLUMNS = new Set<string>([
  'business_name',
  'website',
  'rating',
  'review_count',
]);

const TARGET_KEY_SYNONYMS: Record<string, string[]> = {
  business_name: ['business name', 'company name', 'business', 'company'],
  website: ['website', 'web site', 'url', 'site'],
  rating: ['rating', 'review rating', 'stars', 'star rating'],
  review_count: ['review count', 'number of reviews', 'reviews count', '# of reviews'],
  license_number: ['license number', 'license #', 'license no', 'license'],
  service_zips: ['service zips', 'service area', 'zip codes', 'service zip codes', 'service areas'],
  tier: ['tier', 'lead tier', 'quality tier'],
  list_source: ['list source', 'source list', 'lead source', 'list'],
  last_call_at: ['last call at', 'last call date', 'last call time', 'last called'],
  last_call_outcome: ['last call outcome', 'last outcome', 'last disposition', 'call outcome'],
  call_attempts: ['call attempts', 'attempts', 'attempt count', 'number of attempts'],
  callback_at: ['callback date/time', 'callback date', 'callback time', 'callback at'],
  call_duration: ['call duration', 'call duration (sec)', 'call length', 'duration'],
  recording_url: ['recording link', 'recording url', 'recording'],
};

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Returns targetKey -> GHL custom-field-definition id for every target key that found an EXACT
 *  (case-insensitive, trimmed) name match among `defs` -- a target key with no match is simply
 *  absent from the result, never guessed at a lower confidence. If two fields somehow share the
 *  same normalized name, the first one in `defs` wins (deterministic, not an error -- an org's own
 *  duplicate field names are its problem to fix in GHL, not this function's to adjudicate). */
export function suggestGhlFieldMapping(defs: GhlCustomFieldDef[]): Record<string, string> {
  const byNormalizedName = new Map<string, string>();
  for (const d of defs) {
    if (!d.name || !d.id) continue;
    const key = normalize(d.name);
    if (!byNormalizedName.has(key)) byNormalizedName.set(key, d.id);
  }

  const suggestions: Record<string, string> = {};
  for (const targetKey of GHL_FIELD_MAPPING_TARGET_KEYS) {
    const synonyms = TARGET_KEY_SYNONYMS[targetKey] ?? [];
    for (const synonym of synonyms) {
      const fieldId = byNormalizedName.get(synonym);
      if (fieldId) {
        suggestions[targetKey] = fieldId;
        break;
      }
    }
  }
  return suggestions;
}
