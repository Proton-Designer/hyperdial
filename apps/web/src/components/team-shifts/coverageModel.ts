import type { AdminShiftMember, AdminShiftsOverview, Shift } from '@/lib/api';
import { SLOT, buildDays, type PickDay } from '../shifts/pickerModel';
import { localDateKey, localMinutes, displayName } from '../shifts/shiftFormat';

export type TeamShift = AdminShiftsOverview['shifts'][number];

/** Shifts that put someone on the phones: planned or worked. Missed/excused/cancelled don't. */
const COVERING = new Set<Shift['status']>(['scheduled', 'completed']);
/** Shifts that count toward the weekly minimum (same rule as the server). */
const COUNTED = new Set<Shift['status']>(['scheduled', 'completed', 'missed']);

export type SlotKey = `${string}|${number}`;
export const slotKey = (date: string, min: number): SlotKey => `${date}|${min}`;

export interface CoverageModel {
  days: PickDay[];
  /** Minute-of-day of every grid row, covering the widest open day. */
  rows: number[];
  /** slot -> shifts covering it. */
  bySlot: Map<SlotKey, TeamShift[]>;
}

export function buildCoverage(overview: AdminShiftsOverview): CoverageModel {
  const tz = overview.week.timezone;
  const days = buildDays(overview.week.weekStart, overview.openHours, overview.powerWindows);
  const bySlot = new Map<SlotKey, TeamShift[]>();
  for (const s of overview.shifts) {
    if (!COVERING.has(s.status)) continue;
    const end = new Date(s.endsAt).getTime();
    for (let t = new Date(s.startsAt).getTime(); t < end; t += SLOT * 60000) {
      const iso = new Date(t).toISOString();
      const key = slotKey(localDateKey(iso, tz), localMinutes(iso, tz));
      const list = bySlot.get(key);
      if (list) list.push(s);
      else bySlot.set(key, [s]);
    }
  }
  const from = days.length ? Math.min(...days.map((d) => d.openFrom)) : 0;
  const to = days.length ? Math.max(...days.map((d) => d.openUntil)) : 0;
  const rows: number[] = [];
  for (let m = from; m < to; m += SLOT) rows.push(m);
  return { days, rows, bySlot };
}

export function isOpen(day: PickDay, min: number): boolean {
  return min >= day.openFrom && min < day.openUntil;
}

export function isPowerSlot(day: PickDay, min: number): boolean {
  return day.windows.some((w) => min >= w.start && min < w.end);
}

export interface PanelStats {
  teamHours: number;
  powerHours: number;
  participants: AdminShiftMember[];
  underMinimum: { member: AdminShiftMember; hours: number; minimum: number }[];
  notSubmitted: AdminShiftMember[];
  pendingRequests: number;
}

export function buildStats(overview: AdminShiftsOverview): PanelStats {
  const participants = overview.members.filter((m) => m.participates);
  const hoursBy = new Map<string, number>();
  let teamHours = 0;
  let powerMin = 0;
  for (const s of overview.shifts) {
    if (!COUNTED.has(s.status)) continue;
    hoursBy.set(s.userId, (hoursBy.get(s.userId) ?? 0) + s.hours);
    teamHours += s.hours;
    powerMin += s.powerMinutes;
  }
  const commitByUser = new Map(overview.commitments.map((c) => [c.userId, c]));
  const underMinimum = participants
    .map((member) => {
      const c = commitByUser.get(member.userId);
      return {
        member,
        hours: hoursBy.get(member.userId) ?? 0,
        minimum: c?.minHoursOverride ?? overview.week.minHours,
      };
    })
    .filter((x) => x.hours < x.minimum)
    .sort((a, b) => a.member.name.localeCompare(b.member.name));
  const notSubmitted = participants
    .filter((m) => !commitByUser.get(m.userId)?.submittedAt)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    teamHours,
    powerHours: powerMin / 60,
    participants,
    underMinimum,
    notSubmitted,
    pendingRequests: overview.requests.filter((r) => r.status === 'pending').length,
  };
}

/** Sequential scale from the theme's accent: 0 = empty, then stronger per person (capped). */
export function heatColor(count: number, max: number): string | undefined {
  if (count <= 0) return undefined;
  const t = Math.min(1, count / Math.max(3, max));
  return `rgba(0, 150, 255, ${(0.16 + t * 0.62).toFixed(2)})`;
}

export function uniqueNames(shifts: TeamShift[] | undefined): string[] {
  return [...new Set((shifts ?? []).map((s) => displayName(s.userName)))].sort((a, b) =>
    a.localeCompare(b)
  );
}

export function maxHeadcount(model: CoverageModel): number {
  let max = 0;
  for (const list of model.bySlot.values())
    max = Math.max(max, new Set(list.map((s) => s.userId)).size);
  return max;
}
