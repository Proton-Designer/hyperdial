/**
 * TASK-G13 (spec §1 "Top objection"): the optional per-call objection chosen at wrap-up. Same six
 * keys as the end-of-shift survey (`shifts-core.ts` TOP_OBJECTIONS; the shift survey table check and
 * submit_disposition's check list repeat them in SQL). The GHL labels are the ones the shift push
 * already sends for `last_shift_top_objection` (20261019200743_shifts_push_v2.sql), so one GHL
 * dropdown definition can serve both.
 */
import { TOP_OBJECTIONS } from './shifts-core.ts';

export type CallTopObjection = (typeof TOP_OBJECTIONS)[number];

export const TOP_OBJECTION_GHL_LABELS: Record<CallTopObjection, string> = {
  too_busy: 'Too busy',
  enough_work: 'Has enough work',
  fees: 'Fees',
  dont_trust_apps: 'Does not trust apps',
  not_interested_app_jobs: 'Not interested in app jobs',
  other: 'Other',
};

/** Label for a stored key; null for null/unknown (an unknown stored value is never invented). */
export function topObjectionLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return (TOP_OBJECTION_GHL_LABELS as Record<string, string>)[key] ?? null;
}

/** Edge-function input check: absent/blank -> null (no objection); a known key -> itself;
 *  anything else -> invalid (the caller answers 400). */
export function parseTopObjection(
  raw: unknown
): { ok: true; value: CallTopObjection | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const v = raw.trim();
  if (v === '') return { ok: true, value: null };
  return (TOP_OBJECTIONS as readonly string[]).includes(v)
    ? { ok: true, value: v as CallTopObjection }
    : { ok: false };
}
