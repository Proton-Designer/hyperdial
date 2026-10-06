import {
  ShiftsApiError,
  type Shift,
  type ShiftSurveyInput,
  type ShiftSurveySummary,
  type SlowedBy,
  type TopObjection,
} from '@/lib/api';

/** Clock in/out + end-of-shift survey (docs/design/shifts.md §4b). The server clock and the server's
 *  rules are the truth; everything here only decides what to offer and words it. */

/** Start opens this long before the shift's start time (server rule). */
export const CLOCK_LEAD_MS = 15 * 60 * 1000;
export const NOTE_MIN = 3;
export const NOTE_MAX = 500;

export const OBJECTION_LABEL: Record<TopObjection, string> = {
  too_busy: 'Too busy',
  enough_work: 'Already have enough work',
  fees: 'Fees',
  dont_trust_apps: "Don't trust apps",
  not_interested_app_jobs: 'Not interested in app jobs',
  other: 'Other',
};
export const OBJECTION_ORDER = Object.keys(OBJECTION_LABEL) as TopObjection[];

export const SLOWED_LABEL: Record<SlowedBy, string> = {
  bad_numbers: 'Bad numbers',
  dialer_issue: 'Dialer issue',
  didnt_know_answer: "Didn't know how to answer something",
  script_off: 'Script felt off',
  nothing: 'Nothing',
};
export const SLOWED_ORDER = Object.keys(SLOWED_LABEL) as SlowedBy[];

export const QUALITY_HINT: Record<number, string> = {
  1: 'Poor',
  2: 'Weak',
  3: 'Okay',
  4: 'Good',
  5: 'Great',
};

export type ClockPhase =
  | { kind: 'none' }
  /** Before the start window opens. */
  | { kind: 'waiting'; opensAt: number }
  | { kind: 'ready' }
  | { kind: 'on'; since: string; late: number }
  | { kind: 'ended'; at: string; since: string | null; late: number; surveyed: boolean };

/** What the clock UI offers for one of the caller's own shifts right now. */
export function clockPhase(shift: Shift, now: number): ClockPhase {
  const late = shift.clockInLateMinutes ?? 0;
  if (shift.clockedOutAt) {
    return {
      kind: 'ended',
      at: shift.clockedOutAt,
      since: shift.clockedInAt ?? null,
      late,
      surveyed: !!shift.survey,
    };
  }
  if (shift.status !== 'scheduled') return { kind: 'none' };
  if (shift.clockedInAt) return { kind: 'on', since: shift.clockedInAt, late };
  const start = new Date(shift.startsAt).getTime();
  const end = new Date(shift.endsAt).getTime();
  if (now < start - CLOCK_LEAD_MS) return { kind: 'waiting', opensAt: start - CLOCK_LEAD_MS };
  if (now < end) return { kind: 'ready' };
  return { kind: 'none' };
}

/** "12 min", "2 hr 10 min", "1 hr" -- rounded up so "Starts in 1 min" never reads as 0. */
export function fmtUntil(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export function lateText(minutes: number): string {
  return `${minutes} min late`;
}

/** The shift's start is far enough away that a countdown would just be noise. */
export const COUNTDOWN_MAX_MS = 12 * 60 * 60 * 1000;

export interface SurveyDraft {
  topObjection: TopObjection | null;
  objectionNote: string;
  whatWorked: string;
  slowedBy: SlowedBy | null;
  slowedNote: string;
  listQuality: number | null;
}

export const EMPTY_DRAFT: SurveyDraft = {
  topObjection: null,
  objectionNote: '',
  whatWorked: '',
  slowedBy: null,
  slowedNote: '',
  listQuality: null,
};

/** Drafts live for the page session so an accidental close (or a Cancel) never loses typing. */
const drafts = new Map<string, SurveyDraft>();
export const loadDraft = (shiftId: string): SurveyDraft => drafts.get(shiftId) ?? EMPTY_DRAFT;
export const saveDraft = (shiftId: string, d: SurveyDraft) => void drafts.set(shiftId, d);
export const clearDraft = (shiftId: string) => void drafts.delete(shiftId);

export type SurveyField =
  'topObjection' | 'objectionNote' | 'whatWorked' | 'slowedBy' | 'slowedNote' | 'listQuality';
export const FIELD_ORDER: SurveyField[] = [
  'topObjection',
  'objectionNote',
  'whatWorked',
  'slowedBy',
  'slowedNote',
  'listQuality',
];

const noteLen = (s: string) => s.trim().length;

/** Inline validation, same rules as the server: notes 3..500 trimmed, the slowed-down note only
 *  when something slowed them down. */
export function validateSurvey(d: SurveyDraft): Partial<Record<SurveyField, string>> {
  const e: Partial<Record<SurveyField, string>> = {};
  if (!d.topObjection) e.topObjection = 'Pick the objection you heard most.';
  if (noteLen(d.objectionNote) < NOTE_MIN)
    e.objectionNote = `Add a few words on how you handled it (at least ${NOTE_MIN} characters).`;
  if (noteLen(d.whatWorked) < NOTE_MIN)
    e.whatWorked = `Add a few words on what worked (at least ${NOTE_MIN} characters).`;
  if (!d.slowedBy) e.slowedBy = 'Pick what slowed you down, or Nothing.';
  else if (d.slowedBy !== 'nothing' && noteLen(d.slowedNote) < NOTE_MIN)
    e.slowedNote = `Add a few words on what happened (at least ${NOTE_MIN} characters).`;
  if (!d.listQuality) e.listQuality = 'Rate the list from 1 to 5.';
  return e;
}

/** Only call after `validateSurvey` came back empty. */
export function toSurveyInput(d: SurveyDraft): ShiftSurveyInput {
  return {
    topObjection: d.topObjection!,
    objectionNote: d.objectionNote.trim(),
    whatWorked: d.whatWorked.trim(),
    slowedBy: d.slowedBy!,
    slowedNote: d.slowedBy === 'nothing' ? null : d.slowedNote.trim(),
    listQuality: d.listQuality as ShiftSurveyInput['listQuality'],
  };
}

/** Counts sorted high to low (ties in the form's own order), zero counts dropped. */
export function sortedCounts<K extends string>(
  counts: Record<K, number> | undefined,
  order: K[]
): [K, number][] {
  if (!counts) return [];
  return order
    .map((k, i) => ({ k, n: counts[k] ?? 0, i }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => [x.k, x.n]);
}

export function hasSurveyAnswers(s: ShiftSurveySummary | undefined): s is ShiftSurveySummary {
  return !!s && s.responses > 0;
}

/** Whether `ShiftClock` has anything to draw for this phase (so a caller can skip its wrapper). */
export function clockHasContent(phase: ClockPhase, shift: Shift, now: number): boolean {
  if (phase.kind === 'none') return false;
  if (phase.kind === 'waiting') return new Date(shift.startsAt).getTime() - now <= COUNTDOWN_MAX_MS;
  return true;
}

/** Server refusals in plain language (codes: docs/design/shifts.md §4b). */
export function describeClockError(e: unknown): string {
  if (e instanceof ShiftsApiError) {
    switch (e.code) {
      case 'survey_required':
        return 'This shift needs the quick survey before it can end.';
      case 'bad_survey':
        return `Check your answers: notes need at least ${NOTE_MIN} characters.`;
      case 'already_ended':
        return 'This shift was already ended.';
      case 'not_clocked_in':
        return 'Start the shift before ending it.';
      case 'shift_over':
        return 'This shift is already over, so it can no longer be started.';
      case 'shift_not_scheduled':
        return 'This shift is no longer scheduled.';
      case 'not_found':
        return 'That shift no longer exists. Refresh your shifts.';
      case 'shifts_disabled':
        return 'Shifts is turned off for your team right now.';
    }
  }
  return e instanceof Error ? e.message : 'Something went wrong. Try again.';
}

/** Copy only the clock fields of a shift the server returned from shift-clock onto our copy. The
 *  response doesn't know about pending requests (`hasPendingRequest` is always false there), so
 *  the rest of the row must stay as we had it. */
export function applyClock(x: Shift, u: Shift): Shift {
  return {
    ...x,
    clockedInAt: u.clockedInAt ?? null,
    clockedOutAt: u.clockedOutAt ?? null,
    clockInLateMinutes: u.clockInLateMinutes ?? null,
    survey: u.survey ?? null,
  };
}
