/**
 * TASK-G17: "is my GoHighLevel set up for the data sync?" Pure classification of what HyperDial
 * pushes (ghl-field-catalog.ts) against the location's contact custom-field definitions, plus the one
 * read-only GHL call that lists them. Never creates anything in GHL.
 *
 *  - provider keys: mapped in `ghl_field_mapping` AND the mapped id exists in GHL -> ready;
 *    mapped but the id is gone -> missing_in_ghl; no mapping -> not_mapped (the push skips it).
 *  - intern keys: a definition whose fieldKey is `contact.<key>` exists -> ready; else missing
 *    (shift-ghl.ts buildCustomFields skips and logs it).
 * `issues` are warnings on a ready field, not blockers: the field type cannot hold what we send, or a
 * dropdown lacks some of the exact option texts we send.
 */
import {
  INTERN_SHIFT_FIELDS,
  PROVIDER_PUSH_FIELDS,
  type FieldSpec,
  type GhlDataType,
} from './ghl-field-catalog.ts';

const GHL_DEFAULT_BASE = 'https://services.leadconnectorhq.com';
const GHL_CONTACT_VERSION = '2021-07-28';

export interface CoverageDef {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string | null;
  /** Option texts of a dropdown definition (label, else key); [] for other types. */
  options: string[];
}

export type CoverageStatus = 'ready' | 'missing_in_ghl' | 'not_mapped' | 'missing';
export type CoverageIssue = 'type' | 'options';

export interface CoverageItem {
  key: string;
  label: string;
  type: GhlDataType;
  options: string[] | null;
  status: CoverageStatus;
  ghlType: string | null;
  issues: CoverageIssue[];
  /** Expected dropdown options absent from the GHL definition (only when issues includes 'options'). */
  missingOptions: string[];
}

export interface CoverageGroup {
  items: CoverageItem[];
  ready: number;
  total: number;
}

export interface FieldCoverage {
  provider: CoverageGroup;
  intern: CoverageGroup;
  ready: number;
  total: number;
}

/** Which GHL dataTypes can hold what we send (we send text; numbers as text/number). */
const ACCEPTS: Record<GhlDataType, string[]> = {
  TEXT: ['TEXT', 'LARGE_TEXT'],
  LARGE_TEXT: ['TEXT', 'LARGE_TEXT'],
  NUMERICAL: ['NUMERICAL'],
  SINGLE_OPTIONS: ['SINGLE_OPTIONS', 'RADIO'],
  DATE: ['DATE', 'TEXT', 'LARGE_TEXT'],
};

function check(spec: FieldSpec, def: CoverageDef): { issues: CoverageIssue[]; missing: string[] } {
  const issues: CoverageIssue[] = [];
  let missing: string[] = [];
  if (def.dataType && !ACCEPTS[spec.type].includes(def.dataType)) issues.push('type');
  if (spec.options && def.options.length > 0) {
    const have = new Set(def.options.map((o) => o.trim()));
    missing = spec.options.filter((o) => !have.has(o));
    if (missing.length > 0) issues.push('options');
  }
  return { issues, missing };
}

function item(spec: FieldSpec, status: CoverageStatus, def?: CoverageDef): CoverageItem {
  const c = def ? check(spec, def) : { issues: [], missing: [] };
  return {
    key: spec.key,
    label: spec.label,
    type: spec.type,
    options: spec.options ?? null,
    status,
    ghlType: def?.dataType ?? null,
    issues: c.issues,
    missingOptions: c.missing,
  };
}

const group = (items: CoverageItem[]): CoverageGroup => ({
  items,
  ready: items.filter((i) => i.status === 'ready').length,
  total: items.length,
});

export function classifyFieldCoverage(
  mapping: Record<string, string> | null | undefined,
  defs: CoverageDef[]
): FieldCoverage {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const byKey = new Map(defs.map((d) => [d.fieldKey.replace(/^contact\./, ''), d]));
  const provider = group(
    PROVIDER_PUSH_FIELDS.map((spec) => {
      const id = mapping?.[spec.key];
      if (typeof id !== 'string' || id === '') return item(spec, 'not_mapped');
      const def = byId.get(id);
      return def ? item(spec, 'ready', def) : item(spec, 'missing_in_ghl');
    })
  );
  const intern = group(
    INTERN_SHIFT_FIELDS.map((spec) => {
      const def = byKey.get(spec.key);
      return def ? item(spec, 'ready', def) : item(spec, 'missing');
    })
  );
  return {
    provider,
    intern,
    ready: provider.ready + intern.ready,
    total: provider.total + intern.total,
  };
}

/** GET /custom-fields/object-key/contact?locationId= -- the ONE GHL call per coverage request. */
export async function fetchCoverageDefs(
  token: string,
  locationId: string,
  apiBase: string = GHL_DEFAULT_BASE,
  fetchImpl: typeof fetch = fetch
): Promise<CoverageDef[]> {
  const qs = new URLSearchParams({ locationId }).toString();
  const res = await fetchImpl(`${apiBase}/custom-fields/object-key/contact?${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_CONTACT_VERSION },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL API GET /custom-fields failed (${res.status})`);
  let body: { fields?: unknown } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('GHL returned an unreadable custom-fields response');
  }
  const fields = Array.isArray(body.fields) ? (body.fields as Record<string, unknown>[]) : [];
  return fields
    .filter((f) => typeof f.id === 'string' && typeof f.fieldKey === 'string')
    .map((f) => ({
      id: f.id as string,
      name: typeof f.name === 'string' ? f.name : '',
      fieldKey: f.fieldKey as string,
      dataType: typeof f.dataType === 'string' ? f.dataType : null,
      options: (Array.isArray(f.options) ? f.options : [])
        .map((o) =>
          typeof o === 'string'
            ? o
            : o && typeof o === 'object'
              ? (((o as Record<string, unknown>).label ??
                  (o as Record<string, unknown>).key) as unknown)
              : null
        )
        .filter((o): o is string => typeof o === 'string'),
    }));
}
