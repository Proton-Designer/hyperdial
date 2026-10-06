/**
 * TASK-S04: drains `shift_ghl_outbox` rows to GoHighLevel. Pure of Supabase: the caller (the
 * `shift-ghl-sync` function) claims rows, builds the deps below and persists each outcome; this
 * module owns request building, the per-contact ordering rules and the retry classification.
 *
 * Every endpoint, header and body key is pinned in audit/S04/api-evidence.md (raw OpenAPI keys).
 * Appointments use `Version: 2021-04-15`; contacts and custom-fields use `2021-07-28`.
 */

export const GHL_DEFAULT_BASE = 'https://services.leadconnectorhq.com';
export const GHL_APPT_VERSION = '2021-04-15';
export const GHL_CONTACT_VERSION = '2021-07-28';
export const MAX_ATTEMPTS = 6;

export type OutboxKind =
  | 'appointment_upsert'
  | 'appointment_cancel'
  | 'appointment_status'
  | 'contact_fields'
  | 'contact_note'
  | 'contact_tags_add'
  | 'contact_tags_remove';

export interface OutboxRow {
  id: number;
  org_id: string;
  kind: OutboxKind;
  event: string | null;
  shift_id: string | null;
  user_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: string;
}

export interface ShiftForSync {
  id: string;
  status: string;
  activity: string;
  starts_at: string;
  ends_at: string;
  ghl_appointment_id: string | null;
}

export interface FieldDef {
  id: string;
  fieldKey: string;
  dataType?: string;
}

/** What happened to one outbox row. `release` = not attempted (held, deferred, or batch stopped):
 *  the lease is dropped without counting an attempt. */
export type RowResult =
  | { id: number; outcome: 'done'; appointmentId?: string }
  | { id: number; outcome: 'retry'; error: string }
  | { id: number; outcome: 'error'; error: string }
  | { id: number; outcome: 'release'; error?: string; delaySeconds?: number };

export class ShiftGhlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** Seconds from a Retry-After header (429), when GHL sent one. */
    readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
  /** 401/403: the org's token (or scope) is the problem, not this row. */
  get orgLevel(): boolean {
    return this.status === 401 || this.status === 403;
  }
  get timedOut(): boolean {
    return this.status === 0 && this.message === TIMEOUT_MESSAGE;
  }
}

/** Seconds to hold rows after a 429 (Retry-After when sent, else a minute; never more than an hour). */
export const RATE_LIMIT_DELAY_SECONDS = 60;
/** Seconds to hold an org's rows after a 401/403 from GHL. */
export const TOKEN_REJECTED_DELAY_SECONDS = 600;
export const TOKEN_REJECTED_MESSAGE = 'GHL token rejected (401/403): reconnect GoHighLevel';
/** 403 is more often a missing scope or calendar permission than a dead token. */
export const ACCESS_DENIED_MESSAGE =
  'GHL denied access (403): check the integration scopes and calendar permissions';
export const TIMEOUT_MESSAGE = 'GHL request timed out';
/** After this many timeouts in one run the org is paused for a few minutes. */
export const MAX_TIMEOUTS_PER_RUN = 3;
export const GHL_NOT_ANSWERING_MESSAGE = 'GHL is not answering (repeated timeouts); will retry';
export const GHL_TIMEOUT_MS = 20_000;

// ---- HTTP ---------------------------------------------------------------------------------------

export interface ShiftGhlHttp {
  request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    version: string,
    body?: unknown
  ): Promise<Record<string, unknown>>;
}

export interface HttpOptions {
  token: string;
  apiBase?: string;
  fetchFn?: typeof fetch;
  throttle?: () => Promise<void>;
  /** Per-call timeout; an abort is a retryable network error. */
  timeoutMs?: number;
}

export function createShiftGhlHttp(opts: HttpOptions): ShiftGhlHttp {
  const base = opts.apiBase || GHL_DEFAULT_BASE;
  const doFetch = opts.fetchFn ?? fetch;
  return {
    async request(method, path, version, body) {
      if (opts.throttle) await opts.throttle();
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Version: version,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? GHL_TIMEOUT_MS),
        });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        throw new ShiftGhlError(
          name === 'TimeoutError' || name === 'AbortError'
            ? TIMEOUT_MESSAGE
            : `network error: ${String(e)}`,
          0,
          true
        );
      }
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const ra = Number(res.headers.get('Retry-After'));
        throw new ShiftGhlError(
          `GHL ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          retryable,
          res.status === 429 && Number.isFinite(ra) && ra > 0 ? ra : undefined
        );
      }
      try {
        return text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    },
  };
}

// ---- Time formatting (all in the org's shift timezone, per date) ------------------------------------

function parts(ms: number, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms))) {
    out[p.type] = p.value;
  }
  return out;
}

/** "2026-10-13T14:00:00-05:00": local wall time with that DATE's own UTC offset. */
export function offsetIso(iso: string, tz: string): string {
  const ms = new Date(iso).getTime();
  const p = parts(ms, tz);
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offMin = Math.round((wall - ms) / 60000);
  const sign = offMin < 0 ? '-' : '+';
  const a = Math.abs(offMin);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

function clock12(ms: number, tz: string): { t: string; ap: string } {
  const p = parts(ms, tz);
  const h = +p.hour;
  return {
    t: `${h % 12 === 0 ? 12 : h % 12}:${p.minute}`,
    ap: h < 12 ? 'AM' : 'PM',
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ACTIVITY_TITLE: Record<string, string> = {
  dialing: 'Dialing',
  follow_up: 'Follow up',
  social: 'Social',
};

/** "Shift: Dialing, Tue Oct 13, 2:00-4:00 PM" (same wording rules as the SQL time-range text). */
export function shiftTitle(
  s: Pick<ShiftForSync, 'activity' | 'starts_at' | 'ends_at'>,
  tz: string
): string {
  const a = new Date(s.starts_at).getTime();
  const b = new Date(s.ends_at).getTime();
  const pa = parts(a, tz);
  const ca = clock12(a, tz);
  const cb = clock12(b, tz);
  const range = ca.ap === cb.ap ? `${ca.t}-${cb.t} ${cb.ap}` : `${ca.t} ${ca.ap}-${cb.t} ${cb.ap}`;
  return `Shift: ${ACTIVITY_TITLE[s.activity] ?? s.activity}, ${pa.weekday} ${
    MONTHS[+pa.month - 1]
  } ${+pa.day}, ${range}`;
}

// ---- Request builders (pure; pinned by tests) -----------------------------------------------------

export interface SyncSettings {
  timezone: string;
  calendarId: string | null;
  ownerUserId: string | null;
}

/** shifts.status -> GHL appointmentStatus (the shift row is the truth, never a stale outbox payload). */
export function appointmentStatusFor(shiftStatus: string): string {
  switch (shiftStatus) {
    case 'completed':
      return 'showed';
    case 'missed':
      return 'noshow';
    case 'cancelled':
    case 'excused':
      return 'cancelled';
    default:
      return 'confirmed';
  }
}

export function createAppointmentBody(
  s: ShiftForSync,
  ctx: { locationId: string; contactId: string; settings: SyncSettings }
): Record<string, unknown> {
  const { settings } = ctx;
  return {
    calendarId: settings.calendarId,
    locationId: ctx.locationId,
    contactId: ctx.contactId,
    startTime: offsetIso(s.starts_at, settings.timezone),
    endTime: offsetIso(s.ends_at, settings.timezone),
    title: shiftTitle(s, settings.timezone),
    appointmentStatus: appointmentStatusFor(s.status),
    ignoreDateRange: true,
    ignoreFreeSlotValidation: true,
    toNotify: true,
    ...(settings.ownerUserId ? { assignedUserId: settings.ownerUserId } : {}),
  };
}

/** PUT body: the edit schema has no contactId/locationId. */
export function editAppointmentBody(
  s: ShiftForSync,
  ctx: { settings: SyncSettings }
): Record<string, unknown> {
  const { settings } = ctx;
  return {
    calendarId: settings.calendarId,
    startTime: offsetIso(s.starts_at, settings.timezone),
    endTime: offsetIso(s.ends_at, settings.timezone),
    title: shiftTitle(s, settings.timezone),
    appointmentStatus: appointmentStatusFor(s.status),
    ignoreDateRange: true,
    ignoreFreeSlotValidation: true,
    toNotify: true,
    ...(settings.ownerUserId ? { assignedUserId: settings.ownerUserId } : {}),
  };
}

/** Our field keys -> `customFields` items. GHL requires the definition id on every item; `NUMERICAL`
 *  definitions take a number, everything else a string. Null values are sent as "" so GHL clears
 *  the field. Returns the keys that have no definition in the location. */
export function buildCustomFields(
  fields: Record<string, unknown>,
  defs: FieldDef[]
): {
  items: { id: string; field_value: string | number }[];
  missing: string[];
} {
  const byKey = new Map(defs.map((d) => [d.fieldKey.replace(/^contact\./, ''), d]));
  const items: { id: string; field_value: string | number }[] = [];
  const missing: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const def = byKey.get(key);
    if (!def) {
      missing.push(key);
      continue;
    }
    // null clears the field (GHL "" ; NEEDS-LIVE-VERIFY for DATE/NUMERICAL definitions).
    items.push({
      id: def.id,
      field_value:
        value === null
          ? ''
          : def.dataType === 'NUMERICAL' && typeof value === 'number'
            ? value
            : String(value),
    });
  }
  return { items, missing };
}

// ---- Processing -----------------------------------------------------------------------------------

export interface ProcessDeps {
  http: ShiftGhlHttp;
  locationId: string;
  settings: SyncSettings;
  /** shift_members.ghl_contact_id for the row's user, or null. */
  contactIdFor(userId: string | null): string | null;
  loadShift(id: string): Promise<ShiftForSync | null>;
  loadFieldDefs(): Promise<FieldDef[]>;
  /** Called (awaited) after every row, right away, so a saved appointment id survives a crash. */
  record(result: RowResult): Promise<void>;
  /** Wall-clock budget: past this instant the rest of the batch is released unsent (no attempt counted). */
  deadlineMs?: number;
  now?: () => number;
}

const eventGroup = (r: OutboxRow) => `${r.user_id}|${r.event}|${r.created_at}`;

export async function processOutbox(rows: OutboxRow[], deps: ProcessDeps): Promise<RowResult[]> {
  const results: RowResult[] = [];
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const held = new Set<string>(); // users with a retryable failure earlier in this batch
  const failedFields = new Set<string>(); // event groups whose contact_fields step failed
  const apptIds = new Map<string, string>(); // shift id -> appointment id created in this batch
  let defs: FieldDef[] | null = null;
  // Set by a 429 (rate limit) or a 401/403 (token): the rest of the batch is released, delayed.
  let stop: { delaySeconds: number; error?: string } | null = null;
  let timeouts = 0;
  const now = deps.now ?? Date.now;

  const finish = async (r: RowResult) => {
    results.push(r);
    await deps.record(r);
  };

  for (const row of ordered) {
    const user = row.user_id ?? `row-${row.id}`;
    if (!stop && deps.deadlineMs !== undefined && now() >= deps.deadlineMs) {
      stop = { delaySeconds: 0 };
    }
    if (stop) {
      await finish({
        id: row.id,
        outcome: 'release',
        delaySeconds: stop.delaySeconds,
        ...(stop.error ? { error: stop.error } : {}),
      });
      continue;
    }
    if (held.has(user)) {
      await finish({ id: row.id, outcome: 'release' });
      continue;
    }
    const group = eventGroup(row);
    if (
      row.kind !== 'contact_fields' &&
      !row.kind.startsWith('appointment') &&
      failedFields.has(group)
    ) {
      await finish({
        id: row.id,
        outcome: 'error',
        error: 'skipped: earlier step failed',
      });
      continue;
    }
    try {
      const contactId = deps.contactIdFor(row.user_id);
      if (!contactId) {
        throw new ShiftGhlError('intern has no GHL contact id', 0, false);
      }
      const appointmentId = await processRow(row, contactId, deps, apptIds, async () => {
        defs ??= await deps.loadFieldDefs();
        return defs;
      });
      await finish({
        id: row.id,
        outcome: 'done',
        ...(appointmentId ? { appointmentId } : {}),
      });
    } catch (e) {
      const err = e instanceof ShiftGhlError ? e : new ShiftGhlError(String(e), 0, true);
      if (err.orgLevel) {
        // The org's token is the problem: nothing of this org can be sent. Keep every row pending.
        stop = {
          delaySeconds: TOKEN_REJECTED_DELAY_SECONDS,
          error: err.status === 403 ? ACCESS_DENIED_MESSAGE : TOKEN_REJECTED_MESSAGE,
        };
        await finish({ id: row.id, outcome: 'release', ...stop });
      } else if (err.retryable) {
        held.add(user);
        if (err.status === 429) {
          stop = {
            delaySeconds: Math.min(
              3600,
              Math.max(RATE_LIMIT_DELAY_SECONDS, err.retryAfterSeconds ?? 0)
            ),
          };
        }
        if (err.timedOut && ++timeouts >= MAX_TIMEOUTS_PER_RUN && !stop) {
          stop = { delaySeconds: 120, error: GHL_NOT_ANSWERING_MESSAGE };
        }
        await finish({ id: row.id, outcome: 'retry', error: err.message });
      } else {
        if (row.kind === 'contact_fields') failedFields.add(group);
        await finish({ id: row.id, outcome: 'error', error: err.message });
      }
    }
  }
  return results;
}

async function processRow(
  row: OutboxRow,
  contactId: string,
  deps: ProcessDeps,
  apptIds: Map<string, string>,
  getDefs: () => Promise<FieldDef[]>
): Promise<string | undefined> {
  const { http, settings } = deps;
  switch (row.kind) {
    case 'appointment_upsert':
    case 'appointment_cancel':
    case 'appointment_status': {
      if (!row.shift_id) {
        throw new ShiftGhlError('appointment row has no shift', 0, false);
      }
      const shift = await deps.loadShift(row.shift_id);
      if (!shift) throw new ShiftGhlError('shift no longer exists', 0, false);
      const apptId = apptIds.get(shift.id) ?? shift.ghl_appointment_id;
      const cancelled =
        row.kind === 'appointment_cancel' ||
        shift.status === 'cancelled' ||
        shift.status === 'excused';
      if (cancelled) {
        // Never created in GHL: nothing to cancel.
        if (!apptId) return undefined;
        await http.request('PUT', `/calendars/events/appointments/${apptId}`, GHL_APPT_VERSION, {
          appointmentStatus: 'cancelled',
        });
        return undefined;
      }
      if (!settings.calendarId) {
        throw new ShiftGhlError('no GHL calendar is set in Shift settings', 0, false);
      }
      if (row.kind === 'appointment_status') {
        // Derived from the shift row (re-read above), never from the payload queued earlier.
        const status = appointmentStatusFor(shift.status);
        if (status !== 'showed' && status !== 'noshow') {
          throw new ShiftGhlError(`shift is ${shift.status}, not completed or missed`, 0, false);
        }
        if (!apptId) {
          throw new ShiftGhlError('shift has no GHL appointment to update', 0, false);
        }
        await http.request('PUT', `/calendars/events/appointments/${apptId}`, GHL_APPT_VERSION, {
          appointmentStatus: status,
        });
        return undefined;
      }
      if (!apptId) {
        const res = await http.request(
          'POST',
          '/calendars/events/appointments',
          GHL_APPT_VERSION,
          createAppointmentBody(shift, {
            locationId: deps.locationId,
            contactId,
            settings,
          })
        );
        const id = typeof res.id === 'string' ? res.id : null;
        if (!id) {
          throw new ShiftGhlError('GHL did not return an appointment id', 0, false);
        }
        apptIds.set(shift.id, id);
        return id;
      }
      await http.request(
        'PUT',
        `/calendars/events/appointments/${apptId}`,
        GHL_APPT_VERSION,
        editAppointmentBody(shift, { settings })
      );
      return undefined;
    }
    case 'contact_fields': {
      const fields = (row.payload.fields ?? {}) as Record<string, unknown>;
      const { items, missing } = buildCustomFields(fields, await getDefs());
      if (missing.length > 0) {
        throw new ShiftGhlError(`GHL custom fields missing: ${missing.join(', ')}`, 0, false);
      }
      if (items.length === 0) return undefined;
      await http.request('PUT', `/contacts/${contactId}`, GHL_CONTACT_VERSION, {
        customFields: items,
      });
      return undefined;
    }
    case 'contact_note': {
      const body = String(row.payload.body ?? '');
      if (!body) return undefined;
      await http.request('POST', `/contacts/${contactId}/notes`, GHL_CONTACT_VERSION, { body });
      return undefined;
    }
    case 'contact_tags_remove':
    case 'contact_tags_add': {
      const tags = ((row.payload.tags ?? []) as unknown[]).map(String).filter(Boolean);
      if (tags.length === 0) return undefined;
      await http.request(
        row.kind === 'contact_tags_remove' ? 'DELETE' : 'POST',
        `/contacts/${contactId}/tags`,
        GHL_CONTACT_VERSION,
        { tags }
      );
      return undefined;
    }
  }
}

/** GET /custom-fields/object-key/contact?locationId=... (Version 2021-07-28). */
export async function fetchContactFieldDefs(
  http: ShiftGhlHttp,
  locationId: string
): Promise<FieldDef[]> {
  const qs = new URLSearchParams({ locationId }).toString();
  const res = await http.request(
    'GET',
    `/custom-fields/object-key/contact?${qs}`,
    GHL_CONTACT_VERSION
  );
  const fields = (res.fields ?? []) as Record<string, unknown>[];
  return fields
    .filter((f) => typeof f.id === 'string' && typeof f.fieldKey === 'string')
    .map((f) => ({
      id: f.id as string,
      fieldKey: f.fieldKey as string,
      dataType: f.dataType as string | undefined,
    }));
}
