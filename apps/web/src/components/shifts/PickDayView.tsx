import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/components/ui/utils';
import type { ShiftActivity } from '@/lib/api';
import { PickBlocks } from './PickBlocks';
import {
  SLOT,
  minLabel,
  minRangeLabel,
  namesOnDuring,
  paintRange,
  removeBlock,
  setBlockActivity,
  toBlocks,
  type Headcount,
  type Locked,
  type PickBlock,
  type PickDay,
  type Picks,
} from './pickerModel';
import { fmtDateOnly } from './shiftFormat';

interface PickDayViewProps {
  days: PickDay[];
  picks: Picks;
  locked: Locked;
  headcount: Headcount;
  onChange: (next: Picks) => void;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; m <= to; m += SLOT) out.push(m);
  return out;
}

/** Phone picker: one day at a time. Power-window chips add a whole window in one tap; Add custom
 *  time takes start/end in 30-minute steps within that day's open hours. */
export function PickDayView({ days, picks, locked, headcount, onChange }: PickDayViewProps) {
  const [dayIdx, setDayIdx] = useState(0);
  const day = days[Math.min(dayIdx, days.length - 1)];
  const [start, setStart] = useState(day.openFrom);
  const [end, setEnd] = useState(Math.min(day.openUntil, day.openFrom + 60));
  const tabsRef = useRef<HTMLDivElement>(null);

  // Reset the custom pickers to something sensible whenever the day changes.
  useEffect(() => {
    setStart(day.openFrom);
    setEnd(Math.min(day.openUntil, day.openFrom + 60));
  }, [day.date, day.openFrom, day.openUntil]);

  useEffect(() => {
    tabsRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [dayIdx]);

  const blocks = useMemo(
    () => toBlocks(picks).filter((b) => b.date === day.date),
    [picks, day.date]
  );
  const isPicked = (m: number) => picks[day.date]?.[m] !== undefined;
  const startOptions = range(day.openFrom, day.openUntil - SLOT);
  const endOptions = range(start + SLOT, day.openUntil);
  const customOthers = namesOnDuring(headcount, day.date, start, end);

  const toggleWindow = (w: PickDay['windows'][number]) => {
    const a = Math.max(w.start, day.openFrom);
    const b = Math.min(w.end, day.openUntil) - SLOT;
    if (b < a) return;
    const slots = range(a, b).filter((m) => !locked[day.date]?.has(m));
    const all = slots.length > 0 && slots.every(isPicked);
    onChange(paintRange(picks, day, a, b, all ? 'erase' : 'paint', 'dialing', locked));
  };

  const addCustom = () => {
    if (end <= start) return;
    onChange(paintRange(picks, day, start, end - SLOT, 'paint', 'dialing', locked));
  };

  const onActivity = (b: PickBlock, a: ShiftActivity) => onChange(setBlockActivity(picks, b, a));

  return (
    <div className="space-y-4">
      <div
        ref={tabsRef}
        role="tablist"
        aria-label="Day"
        className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1"
      >
        {days.map((d, i) => {
          const n = Object.keys(picks[d.date] ?? {}).length;
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
              <span
                className={cn(
                  'mt-0.5 h-1 w-1 rounded-full',
                  n > 0 ? 'bg-accent-to' : 'bg-transparent'
                )}
                aria-label={n > 0 ? `${(n * SLOT) / 60} hours picked` : undefined}
              />
            </button>
          );
        })}
      </div>

      <div>
        <h3 className="text-section-title text-text-primary">
          {day.long}, {fmtDateOnly(day.date)}
        </h3>
        <p className="text-meta text-text-muted">
          Open {minLabel(day.openFrom)}–{minLabel(day.openUntil)}
        </p>
      </div>

      {day.windows.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-meta font-medium text-warning">
            <Zap className="h-3.5 w-3.5" /> High leverage
          </div>
          <div className="flex flex-wrap gap-2">
            {day.windows.map((w) => {
              const a = Math.max(w.start, day.openFrom);
              const b = Math.min(w.end, day.openUntil);
              if (b <= a) return null;
              const slots = range(a, b - SLOT);
              const on = slots.every(isPicked);
              const others = namesOnDuring(headcount, day.date, a, b).length;
              return (
                <button
                  key={w.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleWindow(w)}
                  className={cn(
                    'rounded-app-md border px-3 py-2 text-left transition-colors',
                    on
                      ? 'border-accent-to/50 bg-accent-from/30 text-text-primary'
                      : 'border-warning/30 bg-warning/[0.08] text-text-primary'
                  )}
                >
                  <div className="text-body font-medium">{w.label}</div>
                  <div className="text-meta text-text-secondary">{minRangeLabel(a, b)}</div>
                  {others > 0 && (
                    <div className="text-meta text-text-muted">
                      {others} {others === 1 ? 'other' : 'others'} on
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-3">
        <div className="mb-2 text-body font-medium text-text-primary">Add custom time</div>
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-meta text-text-muted">From</span>
            <Select
              value={String(start)}
              onValueChange={(v) => {
                const s = Number(v);
                setStart(s);
                if (end <= s) setEnd(Math.min(day.openUntil, s + SLOT * 2));
              }}
            >
              <SelectTrigger className="w-full" aria-label="Start time">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {startOptions.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {minLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-meta text-text-muted">To</span>
            <Select value={String(end)} onValueChange={(v) => setEnd(Number(v))}>
              <SelectTrigger className="w-full" aria-label="End time">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {endOptions.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {minLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button
            variant="primary"
            onClick={addCustom}
            disabled={end <= start}
            className="shrink-0"
          >
            <Plus /> Add
          </Button>
        </div>
        {customOthers.length > 0 && (
          <p className="mt-2 text-meta text-text-muted">
            Also on then:{' '}
            <span className="text-text-secondary">{customOthers.slice(0, 4).join(', ')}</span>
            {customOthers.length > 4 && ` +${customOthers.length - 4} more`}
          </p>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-meta font-medium uppercase tracking-wide text-text-muted">
          {day.short} picks
        </h4>
        {blocks.length === 0 ? (
          <p className="rounded-app-md border border-dashed border-border-subtle px-3 py-4 text-center text-body text-text-muted">
            Nothing picked for {day.long} yet. Tap a window above or add a custom time.
          </p>
        ) : (
          <PickBlocks
            blocks={blocks}
            days={days}
            headcount={headcount}
            showDay={false}
            onActivity={onActivity}
            onRemove={(b) => onChange(removeBlock(picks, b))}
          />
        )}
      </div>
    </div>
  );
}
