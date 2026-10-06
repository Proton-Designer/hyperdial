import type { ShiftActivity, ShiftPowerWindow, ShiftRequestType } from '@/lib/api';

/** Every shift time renders in the org's `settings.timezone`, never the browser's (docs/design/
 *  shifts.md §4) -- an intern travelling or a manager in another zone still sees the schedule
 *  the way the rest of the team does. */

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts });
    dtfCache.set(key, f);
  }
  return f;
}

/** "Tue Oct 13" */
export function fmtDay(iso: string, tz: string): string {
  return dtf(tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** "2:00 PM" */
export function fmtTime(iso: string, tz: string): string {
  return dtf(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

function meridiem(iso: string, tz: string): string {
  return fmtTime(iso, tz).slice(-2);
}

/** "2:00–4:00 PM", or "11:00 AM–2:00 PM" when the meridiem differs. */
export function fmtRange(startIso: string, endIso: string, tz: string): string {
  const s = fmtTime(startIso, tz);
  const e = fmtTime(endIso, tz);
  return meridiem(startIso, tz) === meridiem(endIso, tz) ? `${s.slice(0, -3)}–${e}` : `${s}–${e}`;
}

/** "Tue Oct 13 · 2:00–4:00 PM" */
export function fmtShiftWhen(startIso: string, endIso: string, tz: string): string {
  return `${fmtDay(startIso, tz)} · ${fmtRange(startIso, endIso, tz)}`;
}

/** "Oct 13, 6:00 PM CDT" -- for deadlines and other one-off instants. */
export function fmtInstant(iso: string, tz: string): string {
  return dtf(tz, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

/** "Sun 6 PM CT"-style short deadline for banners. */
export function fmtDeadline(iso: string, tz: string): string {
  const d = new Date(iso);
  const day = dtf(tz, { weekday: 'long' }).format(d);
  const parts = dtf(tz, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const minute = get('minute');
  const time = `${get('hour')}${minute === '00' ? '' : `:${minute}`} ${get('dayPeriod')}`;
  return `${day} ${time} ${get('timeZoneName')}`;
}

/** Local YYYY-MM-DD of an instant in `tz`. */
export function localDateKey(iso: string, tz: string): string {
  const p = dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
    new Date(iso)
  );
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Minutes since local midnight of an instant in `tz` (DST-correct, unlike offset math). */
export function localMinutes(iso: string, tz: string): number {
  const p = dtf(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
    new Date(iso)
  );
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return g('hour') * 60 + g('minute');
}

/** The UTC instant (ms) at which local `date` (YYYY-MM-DD) + `minutes` after midnight happens in
 *  `tz`. Two correction passes make it DST-correct; a time that doesn't exist (spring-forward gap)
 *  lands on the next valid instant. */
export function zonedInstant(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const iso = new Date(guess).toISOString();
    const shown = Date.UTC(
      ...(localDateKey(iso, tz)
        .split('-')
        .map(Number)
        .map((v, k) => (k === 1 ? v - 1 : v)) as [number, number, number]),
      0,
      localMinutes(iso, tz)
    );
    guess += wall - shown;
  }
  return guess;
}

/** ISO weekday (1=Mon..7=Sun) of an instant in `tz`. */
export function localIsoWeekday(iso: string, tz: string): number {
  const w = dtf(tz, { weekday: 'short' }).format(new Date(iso));
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(w) + 1;
}

/** A plain YYYY-MM-DD calendar date as text -- parsed at noon UTC so no zone can shift the day. */
export function fmtDateOnly(
  ymd: string,
  opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(
    new Date(`${ymd}T12:00:00Z`)
  );
}

/** "Oct 12 – 18", or "Oct 26 – Nov 1" across a month. */
export function fmtWeekRange(weekStart: string): string {
  const start = new Date(`${weekStart}T12:00:00Z`);
  const end = new Date(start.getTime() + 6 * 86400000);
  const sm = fmtDateOnly(weekStart);
  const endYmd = end.toISOString().slice(0, 10);
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  return `${sm} – ${sameMonth ? end.getUTCDate() : fmtDateOnly(endYmd)}`;
}

/** "9.5 hrs", "1 hr", "0 hrs" */
export function fmtHours(h: number): string {
  const rounded = Math.round(h * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${rounded === 1 ? 'hr' : 'hrs'}`;
}

/** "1h 20m", "45m" */
export function fmtMinutes(m: number): string {
  const r = Math.round(m);
  if (r < 60) return `${r}m`;
  const h = Math.floor(r / 60);
  const rest = r % 60;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** A person's name for display. A member with no profile name arrives as their email; show its
 *  local part ("qa-agent") instead of the long address. Pair with `title={name}` where it truncates. */
export function displayName(name: string): string {
  const n = name.trim();
  const at = n.indexOf('@');
  return at > 0 && !n.includes(' ') ? n.slice(0, at) : n;
}

/** First word of a display name, for "Note to Sara". */
export function firstName(name: string): string {
  return displayName(name).split(/\s+/)[0] || 'them';
}

/** "Sara K." from a full name; names the server already abbreviated pass through unchanged. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full.trim();
  const last = parts[parts.length - 1];
  return last.endsWith('.') ? full.trim() : `${parts[0]} ${last[0].toUpperCase()}.`;
}

export const ACTIVITY_LABEL: Record<ShiftActivity, string> = {
  dialing: 'Dialing',
  follow_up: 'Follow-up',
  social: 'Social',
};

export const REQUEST_TYPE_LABEL: Record<ShiftRequestType, string> = {
  move: 'Move shift',
  drop: 'Drop shift',
  add: 'Add time',
  light_week: 'Light week',
};

const FLAG_LABEL: Record<string, string> = {
  no_show: 'No dials',
  late_start: 'Late start',
  left_early: 'Left early',
  long_idle: 'Long idle',
  low_adherence: 'Low adherence',
};
export function flagLabel(flag: string): string {
  return FLAG_LABEL[flag] ?? flag.replace(/_/g, ' ');
}

/** Whether a shift overlaps any active power window. The server's `powerMinutes` is the source
 *  of truth for My Shifts; this local check exists only for picker highlighting (F02+). */
export function windowsOnDay(windows: ShiftPowerWindow[], isoWeekday: number): ShiftPowerWindow[] {
  return windows.filter((w) => w.active && w.isoWeekdays.includes(isoWeekday));
}
