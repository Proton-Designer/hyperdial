/**
 * TASK-G17: what HyperDial pushes to GoHighLevel, as data (label, expected GHL field type, dropdown
 * options), so the Settings "field coverage" checklist and the push code cannot drift apart.
 *
 *  - PROVIDER contact: keys of `org_integrations.ghl_field_mapping` (target key -> GHL field id), the
 *    same keys `buildPushCustomFields` (ghl-sync-worker.ts) writes. Typed against
 *    GHL_FIELD_MAPPING_TARGET_KEYS, and a unit test pins the catalog to buildPushCustomFields.
 *  - INTERN contact: GHL custom-field definitions matched by field key (`contact.<key>`), the keys
 *    private.shift_last_fields / private.enqueue_shift_event emit (shift-ghl.ts buildCustomFields). They
 *    live in SQL, so a unit test scans the shifts migrations for drift in both directions.
 */
import { GHL_FIELD_MAPPING_TARGET_KEYS } from './ghl-field-mapping.ts';
import { TOP_OBJECTION_GHL_LABELS } from './call-objection.ts';

const CALL_OBJECTION_LABELS = Object.values(TOP_OBJECTION_GHL_LABELS);

/** GHL `dataType` enum (raw spec custom-fields.json, ICustomField.dataType). */
export type GhlDataType = 'TEXT' | 'LARGE_TEXT' | 'NUMERICAL' | 'SINGLE_OPTIONS' | 'DATE';

export interface FieldSpec {
  key: string;
  label: string;
  type: GhlDataType;
  /** Dropdown options we send, EXACT text (only for SINGLE_OPTIONS). */
  options?: string[];
  /** GHL dataTypes besides the default set for `type` that can hold our value without a warning
   *  (TASK-G20: a free-label field an admin may legitimately make a dropdown). */
  alsoAccepts?: string[];
}

type ProviderKey = (typeof GHL_FIELD_MAPPING_TARGET_KEYS)[number];

/** Provider keys written by buildPushCustomFields (the other target keys are pull-only). */
export const PROVIDER_PUSH_FIELDS: (FieldSpec & { key: ProviderKey })[] = [
  // our values are labels (org-editable dispositions + inbound codes): text OR a dropdown is fine
  {
    key: 'last_call_outcome',
    label: 'Last Call Outcome',
    type: 'TEXT',
    alsoAccepts: ['SINGLE_OPTIONS', 'RADIO'],
  },
  { key: 'last_call_at', label: 'Last Call At', type: 'TEXT' },
  { key: 'call_attempts', label: 'Call Attempts', type: 'NUMERICAL' },
  { key: 'callback_at', label: 'Callback Date/Time', type: 'TEXT' },
  { key: 'call_duration', label: 'Call Duration (sec)', type: 'NUMERICAL' },
  { key: 'recording_url', label: 'Recording Link', type: 'TEXT' },
  { key: 'called_by', label: 'Called By', type: 'TEXT' },
  { key: 'called_by_ghl_user_id', label: 'Called By (GHL user id)', type: 'TEXT' },
  { key: 'lead_list', label: 'Lead List / Batch ID', type: 'TEXT' },
  {
    key: 'top_objection',
    label: 'Top Objection',
    type: 'SINGLE_OPTIONS',
    options: [...CALL_OBJECTION_LABELS],
  },
  { key: 'license_number', label: 'License Number', type: 'TEXT' },
  { key: 'service_zips', label: 'Service ZIPs', type: 'LARGE_TEXT' },
];

const YES_NO = ['Yes', 'No'];
const n = (key: string, label: string): FieldSpec => ({ key, label, type: 'NUMERICAL' });
const t = (key: string, label: string): FieldSpec => ({ key, label, type: 'TEXT' });
const lt = (key: string, label: string): FieldSpec => ({ key, label, type: 'LARGE_TEXT' });
const dd = (key: string, label: string, options: string[]): FieldSpec => ({
  key,
  label,
  type: 'SINGLE_OPTIONS',
  options,
});

/** Intern contact keys (audit/G07/ghl-fields-intern.md). Date-like values are sent as text. */
export const INTERN_SHIFT_FIELDS: FieldSpec[] = [
  { key: 'last_shift_date', label: 'Last shift date', type: 'DATE' },
  dd('last_shift_status', 'Last shift status', ['completed', 'missed']),
  n('last_shift_active_minutes', 'Last shift active minutes'),
  n('last_shift_power_active_minutes', 'Last shift power active minutes'),
  n('last_shift_adherence_pct', 'Last shift adherence %'),
  n('last_shift_dials', 'Last shift dials'),
  n('last_shift_connects', 'Last shift connects'),
  n('last_shift_conversations', 'Last shift conversations'),
  n('last_shift_talk_minutes', 'Last shift talk minutes'),
  n('last_shift_longest_idle_minutes', 'Last shift longest idle minutes'),
  n('last_shift_late_start_minutes', 'Last shift late start minutes'),
  t('last_shift_flags', 'Last shift flags'),
  n('last_shift_sign_ups', 'Last shift sign-ups'),
  n('last_shift_connect_rate_pct', 'Last shift connect rate %'),
  n('last_shift_conversion_rate_pct', 'Last shift conversion rate %'),
  t('last_shift_scheduled_start', 'Last shift scheduled start'),
  t('last_shift_scheduled_end', 'Last shift scheduled end'),
  t('last_shift_clock_in_at', 'Last shift clock-in at'),
  t('last_shift_clock_out_at', 'Last shift clock-out at'),
  n('last_shift_clock_in_late_minutes', 'Last shift clock-in late minutes'),
  dd('last_shift_top_objection', 'Last shift top objection', [...CALL_OBJECTION_LABELS]),
  lt('last_shift_objection_note', 'Last shift objection note'),
  lt('last_shift_what_worked', 'Last shift what worked'),
  dd('last_shift_slowed_by', 'Last shift slowed by', [
    'Bad numbers',
    'Dialer issue',
    'Did not know the answer',
    'Script felt off',
    'Nothing',
  ]),
  lt('last_shift_slowed_note', 'Last shift slowed note'),
  n('last_shift_list_quality', 'Last shift list quality'),
  n('week_dial_minutes', 'Week dial minutes'),
  n('week_power_dial_minutes', 'Week power dial minutes'),
  n('week_power_dial_pct', 'Week power dial %'),
  n('week_dials', 'Week dials'),
  n('week_conversations', 'Week conversations'),
  n('week_adherence_pct', 'Week adherence %'),
  n('week_missed_shifts', 'Week missed shifts'),
  n('week_sign_ups', 'Week sign-ups'),
  n('week_connects', 'Week connects'),
  n('week_hours_vs_min', 'Week hours vs minimum'),
  dd('week_under_minimum', 'Week under minimum', YES_NO),
  dd('week_power_week', 'Week power week', YES_NO),
  t('week_power_summary', 'Week power summary'),
  n('power_weeks_total', 'Power weeks total'),
  n('shifts_missed_total', 'Shifts missed total'),
  n('shift_hours_this_week', 'Shift hours this week'),
  n('shift_hours_next_week', 'Shift hours next week'),
  n('shift_min_hours_this_week', 'Shift min hours this week'),
  n('shift_power_hours_this_week', 'Shift power hours this week'),
  n('shift_power_hours_next_week', 'Shift power hours next week'),
  dd('shift_week_submitted', 'Shift week submitted', YES_NO),
  dd('shift_light_week', 'Shift light week', YES_NO),
  lt('shift_schedule_this_week', 'Shift schedule this week'),
  lt('shift_schedule_next_week', 'Shift schedule next week'),
  { key: 'shift_next_shift_at', label: 'Shift next shift at', type: 'DATE' },
  n('shift_requests_pending', 'Shift requests pending'),
  t('shift_last_request_type', 'Shift last request type'),
  lt('shift_last_request_reason', 'Shift last request reason'),
  lt('shift_last_request_note', 'Shift last request note'),
  dd('shift_last_request_status', 'Shift last request status', [
    'pending',
    'approved',
    'denied',
    'withdrawn',
  ]),
  dd('shift_last_request_late', 'Shift last request late', YES_NO),
  t('hyper_dialer_user_id', 'Hyper Dialer user id'),
];
