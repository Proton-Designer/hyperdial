/**
 * TASK-G29: "Create the missing fields in GoHighLevel". Takes the Field coverage result (ghl-field-coverage.ts)
 * and creates every catalog field that is missing in the org's GHL location, with the catalog's name, type and
 * EXACT dropdown options, then reports per field. Provider fields are also mapped (ghl_field_mapping) to the
 * field that was created, or to an existing field that already has the key HyperDial would give it.
 *
 * Raw spec (GoHighLevel/highlevel-api-docs apps/custom-fields.json, fetched 2026-10-19; audit/G29/api-evidence.md):
 *   POST /custom-fields/  body CreateCustomFieldsDTO { locationId, name, dataType, fieldKey, objectKey, parentId,
 *     showInForms, options?: [{key, label}] }  -> 201 { field: { id, ... } }   scope locations/customFields.write
 *   POST /custom-fields/folder  body { objectKey, name, locationId }  -> 201 { id, ... }   (parentId must be a folder)
 *   GET  /custom-fields/object-key/contact?locationId  -> { fields: [...], folders: [...] }
 * Idempotent: a second run plans nothing (everything exists / is mapped). A field that cannot be created is
 * reported and the rest continue; a permission or rate-limit answer stops the run (nothing more would succeed).
 * Unverified live: that GHL accepts the explicit `contact.<key>` fieldKey and our option keys.
 */
import { INTERN_SHIFT_FIELDS, PROVIDER_PUSH_FIELDS, type FieldSpec } from './ghl-field-catalog.ts';
import {
  classifyFieldCoverage,
  type CoverageDef,
  type FieldCoverage,
} from './ghl-field-coverage.ts';
import type { GhlRateLimiter } from './ghl-rate-limit.ts';

const GHL_DEFAULT_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
export const HYPERDIAL_FOLDER_NAME = 'HyperDial';
/** The whole catalog is under 100 fields; more than this in one run means something is wrong. */
export const MAX_FIELDS_PER_RUN = 120;

export const PERMISSION_MESSAGE =
  'GoHighLevel refused to create fields: the Private Integration token needs the Custom Fields write permission ' +
  '(in GoHighLevel: Settings -> Private Integrations -> your integration -> Scopes -> Custom Fields: view and edit).';
export const NOT_FINISHED_MESSAGE =
  'Not finished: press the button again; it only creates what is still missing.';
/** Overall budget of one create run (the Edge Function wall time is longer). */
export const CREATE_RUN_BUDGET_MS = 90_000;
export const RATE_LIMIT_MESSAGE =
  'GoHighLevel is rate limiting requests. Wait a minute and press the button again; fields already created are kept.';

export interface PlannedField {
  group: 'provider' | 'intern';
  spec: FieldSpec;
}
export interface PlannedMapping {
  key: string;
  label: string;
  id: string;
}
export interface NameClash {
  key: string;
  label: string;
  id: string;
  /** the GHL field's own key, e.g. `contact.some_other_key` */
  actualKey: string;
}
export interface CreatePlan {
  toCreate: PlannedField[];
  /** provider keys whose GHL field already exists under `contact.<key>`: just map them */
  toMap: PlannedMapping[];
  /** fields NOT created because a GHL field with the same name already exists under another key (TASK-G29.1) */
  nameClash?: NameClash[];
}

const fieldKeyFor = (key: string) => `contact.${key}`;

/** What is missing, from a coverage result and the location's current definitions. */
export function planCreateMissing(coverage: FieldCoverage, defs: CoverageDef[]): CreatePlan {
  const byKey = new Map(defs.map((d) => [d.fieldKey.replace(/^contact\./, ''), d]));
  const plan: Required<CreatePlan> = { toCreate: [], toMap: [], nameClash: [] };
  // TASK-G29.1: a field with the catalog's NAME but another key (GHL renamed our key, or someone made it by hand) must not be
  // created a second time on a re-press. The folder is not part of CoverageDef, so the whole location is searched.
  const byName = new Map<string, CoverageDef>();
  for (const d of defs) {
    const n = d.name.trim().toLowerCase();
    if (n && !byName.has(n)) byName.set(n, d);
  }
  const planCreate = (group: 'provider' | 'intern', spec: FieldSpec) => {
    const clash = byName.get(spec.label.trim().toLowerCase());
    if (clash) {
      plan.nameClash.push({
        key: spec.key,
        label: spec.label,
        id: clash.id,
        actualKey: clash.fieldKey,
      });
    } else {
      plan.toCreate.push({ group, spec });
    }
  };
  const providerSpecs = new Map(PROVIDER_PUSH_FIELDS.map((s) => [s.key as string, s]));
  const internSpecs = new Map(INTERN_SHIFT_FIELDS.map((s) => [s.key, s]));
  for (const it of coverage.provider.items) {
    if (it.status !== 'not_mapped' && it.status !== 'missing_in_ghl') continue;
    const spec = providerSpecs.get(it.key);
    if (!spec) continue;
    const existing = byKey.get(spec.key);
    if (existing) plan.toMap.push({ key: spec.key, label: spec.label, id: existing.id });
    else planCreate('provider', spec);
  }
  for (const it of coverage.intern.items) {
    if (it.status !== 'missing') continue;
    const spec = internSpecs.get(it.key);
    if (spec) planCreate('intern', spec);
  }
  return plan;
}

/** `Bad numbers` -> `bad_numbers`; unique within one field (a clash gets a numeric suffix). */
export function optionKeys(labels: readonly string[]): string[] {
  const used = new Set<string>();
  return labels.map((label, i) => {
    let key =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || `option_${i + 1}`;
    while (used.has(key)) key = `${key}_${i + 1}`;
    used.add(key);
    return key;
  });
}

export function buildCreateFieldBody(
  spec: FieldSpec,
  locationId: string,
  parentId: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    locationId,
    name: spec.label,
    dataType: spec.type,
    fieldKey: fieldKeyFor(spec.key),
    objectKey: 'contact',
    parentId,
    showInForms: true,
  };
  if (spec.type === 'SINGLE_OPTIONS' && spec.options) {
    const keys = optionKeys(spec.options);
    body.options = spec.options.map((label, i) => ({ key: keys[i], label }));
  }
  return body;
}

export class GhlFieldHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface CreateIo {
  token: string;
  locationId: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  limiter?: GhlRateLimiter;
  /** absolute epoch ms: no new field is created after it (TASK-G29.1) */
  deadlineMs?: number;
}

async function call(
  io: CreateIo,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  await io.limiter?.throttle();
  const res = await (io.fetchImpl ?? fetch)(`${io.apiBase ?? GHL_DEFAULT_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${io.token}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    const msg =
      typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed).slice(0, 200);
    throw new GhlFieldHttpError(
      res.status,
      `GHL ${method} ${path.split('?')[0]} failed (${res.status}): ${msg}`
    );
  }
  return parsed;
}

/** The "HyperDial" folder of the contact object (created when absent): custom fields need a parentId folder. */
export async function resolveFolderId(io: CreateIo): Promise<string> {
  const qs = new URLSearchParams({ locationId: io.locationId }).toString();
  const list = await call(io, 'GET', `/custom-fields/object-key/contact?${qs}`);
  const folders = Array.isArray(list.folders) ? (list.folders as Record<string, unknown>[]) : [];
  const found = folders.find(
    (f) =>
      typeof f.id === 'string' &&
      typeof f.name === 'string' &&
      f.name.trim().toLowerCase() === HYPERDIAL_FOLDER_NAME.toLowerCase()
  );
  if (found) return found.id as string;
  const made = await call(io, 'POST', '/custom-fields/folder', {
    objectKey: 'contact',
    name: HYPERDIAL_FOLDER_NAME,
    locationId: io.locationId,
  });
  const folder = (made.folder ?? made) as Record<string, unknown>;
  if (typeof folder.id !== 'string') throw new Error('GHL created the folder but returned no id');
  return folder.id;
}

export interface CreateFieldResult {
  key: string;
  label: string;
  id: string;
}
export interface CreateMissingResult {
  created: CreateFieldResult[];
  /** provider fields that already existed in GHL and were only mapped */
  mapped: CreateFieldResult[];
  failed: { key: string; label: string; error: string }[];
  /** created, but GHL stored them under a different key than requested (`actualKey`): the intern sync matches by key, so
   *  such a field will keep showing as missing until it is renamed in GHL (TASK-G29.1) */
  keyMismatch: { key: string; label: string; id: string; actualKey: string }[];
  /** not created: a GHL field with this name already exists under another key (map/rename it in GHL) */
  nameClash: NameClash[];
  /** fields not tried because the run stopped (permission / rate limit / cap) */
  notAttempted: number;
  /** plain-words reason the run stopped early, else null */
  stopped: string | null;
  /** provider key -> GHL field id to merge into ghl_field_mapping (created + mapped) */
  mappingAdditions: Record<string, string>;
}

export async function createMissingFields(
  io: CreateIo,
  plan: CreatePlan
): Promise<CreateMissingResult> {
  const result: CreateMissingResult = {
    created: [],
    mapped: [],
    failed: [],
    keyMismatch: [],
    nameClash: plan.nameClash ?? [],
    notAttempted: 0,
    stopped: null,
    mappingAdditions: {},
  };
  for (const m of plan.toMap) {
    result.mapped.push({ key: m.key, label: m.label, id: m.id });
    result.mappingAdditions[m.key] = m.id;
  }
  const todo = plan.toCreate.slice(0, MAX_FIELDS_PER_RUN);
  result.notAttempted = plan.toCreate.length - todo.length;
  if (todo.length === 0) return result;

  const stopWith = (message: string, from: number) => {
    result.stopped = message;
    result.notAttempted += todo.length - from;
  };

  let parentId: string;
  try {
    parentId = await resolveFolderId(io);
  } catch (err) {
    if (err instanceof GhlFieldHttpError && (err.status === 401 || err.status === 403)) {
      stopWith(PERMISSION_MESSAGE, 0);
    } else if (err instanceof GhlFieldHttpError && err.status === 429) {
      stopWith(RATE_LIMIT_MESSAGE, 0);
    } else {
      stopWith(
        `Could not prepare the HyperDial folder in GoHighLevel: ${err instanceof Error ? err.message : String(err)}`,
        0
      );
    }
    return result;
  }

  for (let i = 0; i < todo.length; i++) {
    const { group, spec } = todo[i];
    if (io.deadlineMs !== undefined && Date.now() > io.deadlineMs) {
      stopWith(NOT_FINISHED_MESSAGE, i);
      return result;
    }
    try {
      const res = await call(
        io,
        'POST',
        '/custom-fields/',
        buildCreateFieldBody(spec, io.locationId, parentId)
      );
      const field = (res.field ?? res.customField ?? res) as Record<string, unknown>;
      if (typeof field.id !== 'string') throw new Error('GHL answered without a field id');
      result.created.push({ key: spec.key, label: spec.label, id: field.id });
      // the 201 body carries the key GHL really stored; a different one is reported (and mapped by id for provider fields)
      const requested = fieldKeyFor(spec.key);
      if (typeof field.fieldKey === 'string' && field.fieldKey !== requested) {
        result.keyMismatch.push({
          key: spec.key,
          label: spec.label,
          id: field.id,
          actualKey: field.fieldKey,
        });
      }
      if (group === 'provider') result.mappingAdditions[spec.key] = field.id;
    } catch (err) {
      if (err instanceof GhlFieldHttpError && (err.status === 401 || err.status === 403)) {
        stopWith(PERMISSION_MESSAGE, i);
        return result;
      }
      if (err instanceof GhlFieldHttpError && err.status === 429) {
        stopWith(RATE_LIMIT_MESSAGE, i);
        return result;
      }
      result.failed.push({
        key: spec.key,
        label: spec.label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export interface CreateFlowDeps {
  /** the org's current ghl_field_mapping */
  mapping: Record<string, string>;
  loadDefs: () => Promise<CoverageDef[]>;
  io: CreateIo;
  /** persists the merged mapping (ghl_field_mapping); only called when something was added */
  saveMapping: (mapping: Record<string, string>) => Promise<void>;
}
export interface CreateFlowOutput {
  coverage: FieldCoverage;
  result: CreateMissingResult;
  /** set when the new mapping could not be saved (the fields exist in GHL; pressing the button again maps them) */
  mappingError: string | null;
}

/** Coverage -> plan -> create -> save the provider mapping -> coverage again (so the card shows the new state). */
export async function runCreateMissing(deps: CreateFlowDeps): Promise<CreateFlowOutput> {
  const defs = await deps.loadDefs();
  const before = classifyFieldCoverage(deps.mapping, defs);
  const plan = planCreateMissing(before, defs);
  const result = await createMissingFields(deps.io, plan);
  const added = Object.keys(result.mappingAdditions).length;
  if (added === 0 && result.created.length === 0) {
    return { coverage: before, result, mappingError: null };
  }
  const merged = { ...deps.mapping, ...result.mappingAdditions };
  let mappingError: string | null = null;
  if (added > 0) {
    try {
      await deps.saveMapping(merged);
    } catch (err) {
      mappingError = err instanceof Error ? err.message : String(err);
    }
  }
  let after = before;
  try {
    after = classifyFieldCoverage(mappingError ? deps.mapping : merged, await deps.loadDefs());
  } catch {
    // the card keeps the previous numbers until the next check
  }
  return { coverage: after, result, mappingError };
}
