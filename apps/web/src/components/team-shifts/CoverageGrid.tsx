import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { minLabel, minRangeLabel, SLOT, type PickDay } from '../shifts/pickerModel';
import { fmtDateOnly } from '../shifts/shiftFormat';
import {
  heatColor,
  maxHeadcount,
  isOpen,
  isPowerSlot,
  slotKey,
  uniqueNames,
  type CoverageModel,
  type SlotKey,
} from './coverageModel';

export interface SelectedSlot {
  date: string;
  min: number;
}

interface CoverageProps {
  model: CoverageModel;
  /** Power-window slots with fewer people than this are flagged red. */
  alertBelow: number;
  selected: SelectedSlot | null;
  onSelect: (slot: SelectedSlot) => void;
}

function headcountAt(model: CoverageModel, key: SlotKey): number {
  const list = model.bySlot.get(key);
  return list ? new Set(list.map((s) => s.userId)).size : 0;
}

function slotLabel(day: PickDay, min: number, count: number, power: boolean, flagged: boolean) {
  return `${day.long} ${fmtDateOnly(day.date)}, ${minRangeLabel(min, min + SLOT)}, ${count} ${
    count === 1 ? 'person' : 'people'
  }${power ? ', high leverage' : ''}${flagged ? ', needs more coverage' : ''}`;
}

export function CoverageLegend({ alertBelow, max }: { alertBelow: number; max: number }) {
  const steps = [1, Math.max(2, Math.ceil(max / 2)), Math.max(3, max)];
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-meta text-text-secondary">
      <li className="inline-flex items-center gap-1.5">
        People on
        {steps.map((n, i) => (
          <span
            key={i}
            className="inline-flex h-4 min-w-6 items-center justify-center rounded-sm px-1 text-[10px] font-medium text-white"
            style={{ background: heatColor(n, max) }}
          >
            {n}
            {i === steps.length - 1 ? '+' : ''}
          </span>
        ))}
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="h-3 w-4 rounded-sm border border-warning/60" aria-hidden />
        <Zap className="h-3 w-3 text-warning" /> High leverage window
      </li>
      {alertBelow > 0 && (
        <li className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-4 rounded-sm border border-danger/50 bg-[repeating-linear-gradient(135deg,rgba(255,61,0,0.25)_0_3px,transparent_3px_6px)]"
            aria-hidden
          />
          Under {alertBelow} in a high leverage window
        </li>
      )}
    </ul>
  );
}

/** Desktop heatmap: columns = open weekdays, rows = 30-minute slots. Every cell is a button with a
 *  text count, so colour is never the only signal. */
export function CoverageGrid({ model, alertBelow, selected, onSelect }: CoverageProps) {
  const { days, rows, bySlot } = model;
  const max = useMemo(() => maxHeadcount(model), [model]);
  const [hover, setHover] = useState<{ day: PickDay; min: number } | null>(null);
  const hoverNames = hover ? uniqueNames(bySlot.get(slotKey(hover.day.date, hover.min))) : [];
  // Rows are memoised: a hover or focus move re-renders the readout and nothing else, so the
  // callbacks handed down must be stable.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const stableSelect = useCallback((s: SelectedSlot) => onSelectRef.current(s), []);
  // Roving tab stop: one cell is in the tab order, arrow keys move between cells.
  const firstOpen = useMemo(() => {
    for (const min of rows) for (const d of days) if (isOpen(d, min)) return slotKey(d.date, min);
    return null;
  }, [rows, days]);
  const [tabKey, setTabKey] = useState<string | null>(null);
  const stopKey =
    tabKey ?? (selected ? slotKey(selected.date, selected.min) : firstOpen) ?? firstOpen;
  const gridRef = useRef<HTMLDivElement>(null);
  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-slot-date]');
    if (!t) return;
    const di = days.findIndex((d) => d.date === t.dataset.slotDate);
    const mi = rows.indexOf(Number(t.dataset.slotMin));
    if (di < 0 || mi < 0) return;
    let dd = 0;
    let dm = 0;
    if (e.key === 'ArrowRight') dd = 1;
    else if (e.key === 'ArrowLeft') dd = -1;
    else if (e.key === 'ArrowDown') dm = 1;
    else if (e.key === 'ArrowUp') dm = -1;
    else if (e.key === 'Home') dm = -mi;
    else if (e.key === 'End') dm = rows.length - 1 - mi;
    else return;
    e.preventDefault();
    let ni = di;
    let nm = mi;
    // Step in the direction until an open cell turns up (closed cells are not focusable).
    for (;;) {
      ni += dd;
      nm += dm === 0 ? 0 : Math.sign(dm);
      if (dm !== 0 && Math.abs(nm - mi) >= Math.abs(dm)) nm = mi + dm;
      if (ni < 0 || ni >= days.length || nm < 0 || nm >= rows.length) return;
      if (isOpen(days[ni], rows[nm])) break;
      if (dm !== 0 && Math.abs(nm - mi) >= Math.abs(dm) && nm === mi + dm) return;
    }
    const next = gridRef.current?.querySelector<HTMLElement>(
      `[data-slot-date="${days[ni].date}"][data-slot-min="${rows[nm]}"]`
    );
    next?.focus();
  };

  return (
    <div>
      <div
        className="mb-2 flex min-h-9 items-center gap-2 text-meta text-text-secondary"
        aria-live="polite"
      >
        {hover ? (
          <>
            <span className="font-medium text-text-primary">
              {hover.day.short} {minRangeLabel(hover.min, hover.min + SLOT)}
            </span>
            <span className="truncate">
              {hoverNames.length ? hoverNames.join(', ') : 'Nobody scheduled'}
            </span>
          </>
        ) : (
          <span className="text-text-muted">Hover a slot to see who is on. Click it to edit.</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[640px] gap-px rounded-app-md border border-border-subtle bg-border-subtle"
          style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}
          role="group"
          aria-label="Team coverage by 30-minute slot. Arrow keys move between slots, Enter edits."
          ref={gridRef}
          onKeyDown={onGridKeyDown}
        >
          <div className="sticky top-0 z-10 bg-surface-1" />
          {days.map((d) => (
            <div key={d.date} className="sticky top-0 z-10 bg-surface-1 px-2 py-2 text-center">
              <div className="text-body font-medium text-text-primary">{d.short}</div>
              <div className="text-meta text-text-muted">{fmtDateOnly(d.date)}</div>
            </div>
          ))}
          {rows.map((min) => (
            <GridRow
              key={min}
              min={min}
              model={model}
              max={max}
              alertBelow={alertBelow}
              selDate={selected?.min === min ? selected.date : null}
              stopDate={stopKey?.endsWith(`|${min}`) ? stopKey.split('|')[0] : null}
              onSelect={stableSelect}
              onHover={setHover}
              onStop={setTabKey}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const GridRow = memo(function GridRow({
  min,
  model,
  max,
  alertBelow,
  selDate,
  stopDate,
  onSelect,
  onHover,
  onStop,
}: {
  min: number;
  model: CoverageModel;
  max: number;
  alertBelow: number;
  /** Date of the selected cell in this row, if any (primitive so unrelated rows stay memoised). */
  selDate: string | null;
  /** Date of the cell holding the roving tab stop, if it is in this row. */
  stopDate: string | null;
  onSelect: (s: SelectedSlot) => void;
  onHover: (h: { day: PickDay; min: number } | null) => void;
  onStop: (key: string) => void;
}) {
  return (
    <>
      <div className="flex items-start justify-end bg-surface-1 pr-2 text-[11px] leading-none text-text-muted">
        {min % 60 === 0 ? minLabel(min) : ''}
      </div>
      {model.days.map((day) => {
        if (!isOpen(day, min)) {
          return <div key={day.date} className="h-[22px] bg-surface-0/60" aria-hidden />;
        }
        const key = slotKey(day.date, min);
        const count = headcountAt(model, key);
        const power = isPowerSlot(day, min);
        const flagged = power && count < alertBelow;
        const prevPower = isPowerSlot(day, min - SLOT) && isOpen(day, min - SLOT);
        const nextPower = isPowerSlot(day, min + SLOT) && isOpen(day, min + SLOT);
        const isSel = selDate === day.date;
        return (
          <button
            key={day.date}
            type="button"
            data-slot-date={day.date}
            data-slot-min={min}
            tabIndex={stopDate === day.date ? 0 : -1}
            aria-label={slotLabel(day, min, count, power, flagged)}
            aria-pressed={isSel}
            onClick={() => onSelect({ date: day.date, min })}
            onMouseEnter={() => onHover({ day, min })}
            onMouseLeave={() => onHover(null)}
            onFocus={() => {
              onHover({ day, min });
              onStop(slotKey(day.date, min));
            }}
            onBlur={() => onHover(null)}
            style={{ background: flagged ? undefined : (heatColor(count, max) ?? undefined) }}
            className={cn(
              'relative h-[22px] bg-surface-1 text-[11px] font-medium leading-none outline-none transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent-to',
              count > 0 ? 'text-white' : 'text-transparent hover:bg-white/5',
              power && 'border-x border-warning/50',
              power && !prevPower && 'border-t',
              power && !nextPower && 'border-b',
              flagged &&
                'border-danger/50 bg-[repeating-linear-gradient(135deg,rgba(255,61,0,0.18)_0_3px,transparent_3px_6px)] text-danger',
              isSel && 'z-10 ring-2 ring-text-primary'
            )}
          >
            {count > 0 ? count : flagged ? '0' : ''}
          </button>
        );
      })}
    </>
  );
});

/** Phone: one day at a time, one row per 30-minute slot with a bar for headcount. */
export function CoverageDayView({ model, alertBelow, selected, onSelect }: CoverageProps) {
  const { days, bySlot } = model;
  const max = useMemo(() => maxHeadcount(model), [model]);
  const [dayIdx, setDayIdx] = useState(0);
  const day = days[Math.min(dayIdx, days.length - 1)];
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [dayIdx]);
  if (!day) return null;
  const slots: number[] = [];
  for (let m = day.openFrom; m < day.openUntil; m += SLOT) slots.push(m);

  return (
    <div className="space-y-3">
      <div
        ref={tabsRef}
        role="tablist"
        aria-label="Day"
        className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1"
      >
        {days.map((d, i) => {
          const active = i === dayIdx;
          return (
            <button
              key={d.date}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setDayIdx(i)}
              className={cn(
                'flex min-w-[56px] shrink-0 flex-col items-center rounded-app-md border px-3 py-1.5 transition-colors',
                active
                  ? 'border-accent-to/40 bg-accent-to/10 text-text-primary'
                  : 'border-border-subtle bg-surface-1 text-text-secondary'
              )}
            >
              <span className="text-body font-medium">{d.short}</span>
              <span className="text-meta text-text-muted">{fmtDateOnly(d.date)}</span>
            </button>
          );
        })}
      </div>
      <ul className="divide-y divide-border-subtle overflow-hidden rounded-app-md border border-border-subtle bg-surface-1">
        {slots.map((min) => {
          const key = slotKey(day.date, min);
          const count = headcountAt(model, key);
          const power = isPowerSlot(day, min);
          const flagged = power && count < alertBelow;
          const names = uniqueNames(bySlot.get(key));
          const isSel = selected?.date === day.date && selected.min === min;
          return (
            <li key={min}>
              <button
                type="button"
                aria-label={slotLabel(day, min, count, power, flagged)}
                aria-pressed={isSel}
                onClick={() => onSelect({ date: day.date, min })}
                className={cn(
                  'flex min-h-11 w-full items-center gap-3 px-3 py-1.5 text-left transition-colors',
                  isSel ? 'bg-accent-to/10' : 'hover:bg-white/5',
                  flagged && 'bg-danger-soft'
                )}
              >
                <span className="w-16 shrink-0 text-meta text-text-secondary">{minLabel(min)}</span>
                <span
                  className="flex h-2 flex-1 overflow-hidden rounded-full bg-white/5"
                  aria-hidden
                >
                  <span
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (count / Math.max(3, max)) * 100)}%`,
                      background: flagged
                        ? 'var(--danger)'
                        : (heatColor(count, max) ?? 'transparent'),
                    }}
                  />
                </span>
                <span
                  className={cn(
                    'w-5 shrink-0 text-right text-body font-medium',
                    flagged ? 'text-danger' : 'text-text-primary'
                  )}
                >
                  {count}
                </span>
                <span className="inline-flex w-4 shrink-0 justify-center">
                  {power && <Zap className="h-3.5 w-3.5 text-warning" aria-label="High leverage" />}
                </span>
                <span className="sr-only">{names.join(', ')}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
