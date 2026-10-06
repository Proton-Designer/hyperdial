import type {
  ShiftActivity,
  ShiftBlockInput,
  ShiftOpenHours,
  ShiftPowerWindow,
  ShiftRosterEntry,
  Shift,
} from '@/lib/api';
import { localDateKey, localMinutes } from './shiftFormat';

/** Pure model behind the week picker. A pick is a 30-minute slot on a local date with an
 *  activity; blocks (what the server stores and the intern sees) are derived by merging
 *  neighbouring slots of the same activity. All dates/minutes are LOCAL to settings.timezone. */

export const SLOT = 30;
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAY_LONG = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** date -> (slot start minute-of-day -> activity) */
export type Picks = Record<string, Record<number, ShiftActivity>>;

export interface PickDay {
  date: string;
  isoWeekday: number;
  short: string;
  long: string;
  openFrom: number;
  openUntil: number;
  windows: { label: string; start: number; end: number }[];
}

export interface PickBlock {
  date: string;
  startMin: number;
  endMin: number;
  activity: ShiftActivity;
}

export function hhmmToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function minToHhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "7:00 AM" from minutes-of-day. */
export function minLabel(m: number): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${h < 12 || h === 24 ? 'AM' : 'PM'}`;
}

/** "7:00–10:00 AM" / "11:00 AM–2:00 PM" from minutes-of-day. */
export function minRangeLabel(a: number, b: number): string {
  const sa = minLabel(a);
  const sb = minLabel(b);
  return sa.slice(-2) === sb.slice(-2) ? `${sa.slice(0, -3)}–${sb}` : `${sa}–${sb}`;
}

export function addDaysYmd(ymd: string, n: number): string {
  return new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
}

/** One entry per weekday that has an open_hours row (no row = closed = not shown). */
export function buildDays(
  weekStart: string,
  openHours: ShiftOpenHours[],
  powerWindows: ShiftPowerWindow[]
): PickDay[] {
  return openHours
    .filter((o) => o.isoWeekday >= 1 && o.isoWeekday <= 7)
    .sort((a, b) => a.isoWeekday - b.isoWeekday)
    .map((o) => ({
      date: addDaysYmd(weekStart, o.isoWeekday - 1),
      isoWeekday: o.isoWeekday,
      short: WEEKDAY_SHORT[o.isoWeekday - 1],
      long: WEEKDAY_LONG[o.isoWeekday - 1],
      openFrom: hhmmToMin(o.openFrom),
      openUntil: hhmmToMin(o.openUntil),
      windows: powerWindows
        .filter((w) => w.active && w.isoWeekdays.includes(o.isoWeekday))
        .map((w) => ({ label: w.label, start: hhmmToMin(w.startTime), end: hhmmToMin(w.endTime) })),
    }));
}

/** Minutes of the slot starting at `s` that fall inside any of the day's power windows. */
export function slotPowerMinutes(day: PickDay, s: number): number {
  let n = 0;
  for (const w of day.windows) n += Math.max(0, Math.min(s + SLOT, w.end) - Math.max(s, w.start));
  return n;
}

export function pickSlots(picks: Picks, date: string): number[] {
  return Object.keys(picks[date] ?? {})
    .map(Number)
    .sort((a, b) => a - b);
}

export function toBlocks(picks: Picks): PickBlock[] {
  const out: PickBlock[] = [];
  for (const date of Object.keys(picks).sort()) {
    let cur: PickBlock | null = null;
    for (const s of pickSlots(picks, date)) {
      const act = picks[date][s];
      if (cur && cur.endMin === s && cur.activity === act) cur.endMin = s + SLOT;
      else {
        if (cur) out.push(cur);
        cur = { date, startMin: s, endMin: s + SLOT, activity: act };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

export function toBlockInputs(picks: Picks): ShiftBlockInput[] {
  return toBlocks(picks).map((b) => ({
    date: b.date,
    start: minToHhmm(b.startMin),
    end: minToHhmm(b.endMin),
    activity: b.activity,
  }));
}

export function countSlots(picks: Picks): number {
  return Object.values(picks).reduce((n, d) => n + Object.keys(d).length, 0);
}

export function totals(picks: Picks, days: PickDay[]): { hours: number; powerHours: number } {
  let slots = 0;
  let power = 0;
  for (const d of days) {
    for (const s of pickSlots(picks, d.date)) {
      slots += 1;
      power += slotPowerMinutes(d, s);
    }
  }
  return { hours: (slots * SLOT) / 60, powerHours: power / 60 };
}

/** Stable string for dirty checking. */
export function serializePicks(picks: Picks): string {
  return JSON.stringify(toBlockInputs(picks));
}

export function paintRange(
  picks: Picks,
  day: PickDay,
  a: number,
  b: number,
  mode: 'paint' | 'erase',
  activity: ShiftActivity,
  locked: Locked
): Picks {
  const lo = Math.max(day.openFrom, Math.min(a, b));
  const hi = Math.min(day.openUntil - SLOT, Math.max(a, b));
  const dayPicks = { ...(picks[day.date] ?? {}) };
  for (let s = lo; s <= hi; s += SLOT) {
    if (locked[day.date]?.has(s)) continue;
    if (mode === 'paint') dayPicks[s] = dayPicks[s] ?? activity;
    else delete dayPicks[s];
  }
  const next = { ...picks, [day.date]: dayPicks };
  if (Object.keys(dayPicks).length === 0) delete next[day.date];
  return next;
}

export function setBlockActivity(picks: Picks, block: PickBlock, activity: ShiftActivity): Picks {
  const dayPicks = { ...(picks[block.date] ?? {}) };
  for (let s = block.startMin; s < block.endMin; s += SLOT) dayPicks[s] = activity;
  return { ...picks, [block.date]: dayPicks };
}

export function removeBlock(picks: Picks, block: PickBlock): Picks {
  const dayPicks = { ...(picks[block.date] ?? {}) };
  for (let s = block.startMin; s < block.endMin; s += SLOT) delete dayPicks[s];
  const next = { ...picks, [block.date]: dayPicks };
  if (Object.keys(dayPicks).length === 0) delete next[block.date];
  return next;
}

/** date -> set of slot minutes that cannot be painted (request/admin shifts the intern didn't
 *  pick; resubmitting only replaces source='pick' shifts). */
export type Locked = Record<string, Set<number>>;

function expandShift(
  startsAt: string,
  endsAt: string,
  tz: string,
  visit: (date: string, min: number) => void
) {
  const end = new Date(endsAt).getTime();
  for (let t = new Date(startsAt).getTime(); t < end; t += SLOT * 60000) {
    const iso = new Date(t).toISOString();
    visit(localDateKey(iso, tz), localMinutes(iso, tz));
  }
}

export function picksFromShifts(shifts: Shift[], tz: string): { picks: Picks; locked: Locked } {
  const picks: Picks = {};
  const locked: Locked = {};
  for (const s of shifts) {
    if (s.status !== 'scheduled') continue;
    expandShift(s.startsAt, s.endsAt, tz, (date, min) => {
      if (s.source === 'pick') (picks[date] ??= {})[min] = s.activity;
      else (locked[date] ??= new Set()).add(min);
    });
  }
  return { picks, locked };
}

/** "date|minute" -> names of OTHER interns working that slot. */
export type Headcount = Map<string, string[]>;

export function buildHeadcount(roster: ShiftRosterEntry[], tz: string): Headcount {
  const map: Headcount = new Map();
  for (const r of roster) {
    if (r.isMe) continue;
    expandShift(r.startsAt, r.endsAt, tz, (date, min) => {
      const key = `${date}|${min}`;
      const list = map.get(key);
      if (list) {
        if (!list.includes(r.name)) list.push(r.name);
      } else map.set(key, [r.name]);
    });
  }
  for (const list of map.values()) list.sort((a, b) => a.localeCompare(b));
  return map;
}

export function namesOnDuring(hc: Headcount, date: string, a: number, b: number): string[] {
  const set = new Set<string>();
  for (let s = a; s < b; s += SLOT) for (const n of hc.get(`${date}|${s}`) ?? []) set.add(n);
  return [...set].sort((x, y) => x.localeCompare(y));
}

export const ACTIVITY_ORDER: ShiftActivity[] = ['dialing', 'follow_up', 'social'];

/** Fill colours per activity, shared by the grid cells and the block rows' swatches. */
export const ACTIVITY_FILL: Record<ShiftActivity, string> = {
  dialing: 'bg-accent-from/70',
  follow_up: 'bg-success/45',
  social: 'bg-[#8b5cf6]/55',
};
