import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/components/ui/utils';
import {
  ACTIVITY_FILL,
  SLOT,
  minLabel,
  minRangeLabel,
  paintRange,
  slotPowerMinutes,
  type Headcount,
  type Locked,
  type PickDay,
  type Picks,
} from './pickerModel';
import { fmtDateOnly } from './shiftFormat';

const ROW_H = 26;
const TIME_COL = 52;

interface Draft {
  dayIdx: number;
  anchor: number;
  current: number;
  mode: 'paint' | 'erase';
}

interface Hover {
  dayIdx: number;
  min: number;
  rect: DOMRect;
}

interface PickGridProps {
  days: PickDay[];
  picks: Picks;
  locked: Locked;
  headcount: Headcount;
  onChange: (next: Picks) => void;
}

/** Desktop week calendar: paint 30-minute slots by click or drag, drag from a painted slot to
 *  erase. One pointer-captured gesture handles mouse, pen and touch; Escape cancels a drag.
 *  Arrow keys move a focus cell and Space/Enter toggles it. */
export function PickGrid({ days, picks, locked, headcount, onChange }: PickGridProps) {
  const gridStart = Math.min(...days.map((d) => d.openFrom));
  const gridEnd = Math.max(...days.map((d) => d.openUntil));
  const rows = Math.max(0, (gridEnd - gridStart) / SLOT);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [focus, setFocus] = useState<{ dayIdx: number; min: number }>(() => ({
    dayIdx: 0,
    min: days[0]?.openFrom ?? gridStart,
  }));

  const setDraftBoth = useCallback((d: Draft | null) => {
    draftRef.current = d;
    setDraft(d);
  }, []);

  const effective = useMemo(() => {
    if (!draft) return picks;
    return paintRange(
      picks,
      days[draft.dayIdx],
      draft.anchor,
      draft.current,
      draft.mode,
      'dialing',
      locked
    );
  }, [draft, picks, days, locked]);

  // Escape cancels an in-flight drag without committing it.
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDraftBoth(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, setDraftBoth]);

  const cellOf = (el: EventTarget | null) => {
    const node = (el as HTMLElement | null)?.closest?.('[data-cell]') as HTMLElement | null;
    if (!node) return null;
    return { dayIdx: Number(node.dataset.day), min: Number(node.dataset.min), el: node };
  };

  const minFromY = (clientY: number, day: PickDay) => {
    const top = bodyRef.current?.getBoundingClientRect().top ?? 0;
    const row = Math.floor((clientY - top) / ROW_H);
    const m = gridStart + row * SLOT;
    return Math.min(day.openUntil - SLOT, Math.max(day.openFrom, m));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const c = cellOf(e.target);
    if (!c) return;
    const day = days[c.dayIdx];
    if (c.min < day.openFrom || c.min >= day.openUntil) return;
    if (locked[day.date]?.has(c.min)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const painted = picks[day.date]?.[c.min] !== undefined;
    setHover(null);
    setFocus({ dayIdx: c.dayIdx, min: c.min });
    setDraftBoth({
      dayIdx: c.dayIdx,
      anchor: c.min,
      current: c.min,
      mode: painted ? 'erase' : 'paint',
    });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = draftRef.current;
    if (d) {
      const m = minFromY(e.clientY, days[d.dayIdx]);
      if (m !== d.current) setDraftBoth({ ...d, current: m });
      return;
    }
    if (e.pointerType === 'touch') return;
    const c = cellOf(e.target);
    if (!c) return setHover(null);
    const day = days[c.dayIdx];
    if (c.min < day.openFrom || c.min >= day.openUntil) return setHover(null);
    setHover((h) =>
      h && h.dayIdx === c.dayIdx && h.min === c.min
        ? h
        : { dayIdx: c.dayIdx, min: c.min, rect: c.el.getBoundingClientRect() }
    );
  };

  const endDrag = (commit: boolean) => {
    const d = draftRef.current;
    if (!d) return;
    setDraftBoth(null);
    if (commit) {
      onChange(paintRange(picks, days[d.dayIdx], d.anchor, d.current, d.mode, 'dialing', locked));
    }
  };

  const focusCell = (dayIdx: number, min: number) => {
    setFocus({ dayIdx, min });
    const date = days[dayIdx].date;
    bodyRef.current?.querySelector<HTMLElement>(`[data-key="${date}|${min}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const c = cellOf(e.target);
    if (!c) return;
    const { dayIdx, min } = c;
    const day = days[dayIdx];
    const clamp = (d: PickDay, m: number) => Math.min(d.openUntil - SLOT, Math.max(d.openFrom, m));
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return focusCell(dayIdx, clamp(day, min + SLOT));
      case 'ArrowUp':
        e.preventDefault();
        return focusCell(dayIdx, clamp(day, min - SLOT));
      case 'ArrowRight':
      case 'ArrowLeft': {
        e.preventDefault();
        const ni = Math.min(
          days.length - 1,
          Math.max(0, dayIdx + (e.key === 'ArrowRight' ? 1 : -1))
        );
        return focusCell(ni, clamp(days[ni], min));
      }
      case 'Home':
        e.preventDefault();
        return focusCell(dayIdx, day.openFrom);
      case 'End':
        e.preventDefault();
        return focusCell(dayIdx, day.openUntil - SLOT);
      case ' ':
      case 'Enter': {
        e.preventDefault();
        if (locked[day.date]?.has(min)) return;
        const painted = picks[day.date]?.[min] !== undefined;
        onChange(paintRange(picks, day, min, min, painted ? 'erase' : 'paint', 'dialing', locked));
        return;
      }
    }
  };

  const hoverNames = hover ? (headcount.get(`${days[hover.dayIdx].date}|${hover.min}`) ?? []) : [];

  return (
    <div
      className="select-none"
      role="group"
      aria-label="Pick your times. Drag to paint, drag from a picked slot to erase."
    >
      {/* Day headers */}
      <div
        className="sticky top-0 z-10 grid border-b border-border-subtle bg-surface-0/95 backdrop-blur"
        style={{ gridTemplateColumns: `${TIME_COL}px repeat(${days.length}, minmax(0, 1fr))` }}
      >
        <div />
        {days.map((d) => {
          const n = Object.keys(effective[d.date] ?? {}).length;
          return (
            <div key={d.date} className="px-2 py-2 text-center">
              <div className="text-body font-medium text-text-primary">{d.short}</div>
              <div className="whitespace-nowrap text-meta text-text-muted">
                {fmtDateOnly(d.date)}
              </div>
              <div className="h-4 whitespace-nowrap text-meta text-accent-to">
                {n > 0 ? `${(n * SLOT) / 60}h picked` : ''}
              </div>
            </div>
          );
        })}
      </div>

      <div
        ref={bodyRef}
        className="grid"
        style={{
          gridTemplateColumns: `${TIME_COL}px repeat(${days.length}, minmax(0, 1fr))`,
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
        onPointerLeave={() => !draftRef.current && setHover(null)}
        onKeyDown={onKeyDown}
      >
        {/* Time labels */}
        <div aria-hidden>
          {Array.from({ length: rows }, (_, i) => {
            const m = gridStart + i * SLOT;
            return (
              <div
                key={m}
                className="pr-2 text-right text-[10px] leading-none text-text-muted"
                style={{ height: ROW_H }}
              >
                {m % 60 === 0 ? <span className="relative -top-[1px]">{minLabel(m)}</span> : null}
              </div>
            );
          })}
        </div>

        {days.map((day, dayIdx) => (
          <div key={day.date} className="border-l border-border-subtle">
            {Array.from({ length: rows }, (_, i) => {
              const m = gridStart + i * SLOT;
              const open = m >= day.openFrom && m < day.openUntil;
              if (!open) {
                return (
                  <div
                    key={m}
                    aria-hidden
                    className="border-t border-border-subtle bg-white/[0.02]"
                    style={{ height: ROW_H }}
                  />
                );
              }
              const act = effective[day.date]?.[m];
              const joinsPrev = act !== undefined && effective[day.date]?.[m - SLOT] === act;
              const joinsNext = act !== undefined && effective[day.date]?.[m + SLOT] === act;
              return (
                <SlotCell
                  key={m}
                  day={day}
                  dayIdx={dayIdx}
                  m={m}
                  act={act}
                  joinsPrev={joinsPrev}
                  joinsNext={joinsNext}
                  isLocked={locked[day.date]?.has(m) ?? false}
                  names={headcount.get(`${day.date}|${m}`)}
                  isFocus={focus.dayIdx === dayIdx && focus.min === m}
                  erasing={draft?.dayIdx === dayIdx && draft.mode === 'erase'}
                  blockLabel={
                    act !== undefined && !joinsPrev
                      ? compactRange(m, blockEnd(effective[day.date] ?? {}, m, act))
                      : null
                  }
                  draftRef={draftRef}
                  setFocus={setFocus}
                  setHover={setHover}
                />
              );
            })}
          </div>
        ))}
      </div>

      {hover && !draft && <SlotPopover hover={hover} day={days[hover.dayIdx]} names={hoverNames} />}
    </div>
  );
}

interface SlotCellProps {
  day: PickDay;
  dayIdx: number;
  m: number;
  act: string | undefined;
  joinsPrev: boolean;
  joinsNext: boolean;
  isLocked: boolean;
  names: string[] | undefined;
  isFocus: boolean;
  erasing: boolean;
  blockLabel: string | null;
  draftRef: React.MutableRefObject<Draft | null>;
  setFocus: (f: { dayIdx: number; min: number }) => void;
  setHover: (h: Hover | null) => void;
}

/** One 30-minute cell. Memoised on primitives so a pointer move, a focus move or a drag
 *  re-renders only the cells whose own look changed, not all ~170. */
const SlotCell = memo(function SlotCell({
  day,
  dayIdx,
  m,
  act,
  joinsPrev,
  joinsNext,
  isLocked,
  names,
  isFocus,
  erasing,
  blockLabel,
  draftRef,
  setFocus,
  setHover,
}: SlotCellProps) {
  const power = slotPowerMinutes(day, m) > 0;
  const windowStart = day.windows.find((w) => w.start <= m && m < w.start + SLOT);
  return (
    <button
      type="button"
      tabIndex={isFocus ? 0 : -1}
      data-cell
      data-day={dayIdx}
      data-min={m}
      data-key={`${day.date}|${m}`}
      aria-pressed={act !== undefined}
      aria-disabled={isLocked || undefined}
      aria-label={`${day.long} ${fmtDateOnly(day.date)}, ${minRangeLabel(m, m + SLOT)}${
        isLocked ? ', set by your manager' : act ? ', picked' : ''
      }${power ? ', high leverage' : ''}${names ? `, ${names.length} ${names.length === 1 ? 'other' : 'others'} working` : ''}`}
      onFocus={(e) => {
        setFocus({ dayIdx, min: m });
        if (!draftRef.current && e.currentTarget.matches(':focus-visible')) {
          setHover({ dayIdx, min: m, rect: e.currentTarget.getBoundingClientRect() });
        }
      }}
      onBlur={() => setHover(null)}
      className={cn(
        'relative block w-full overflow-hidden text-left outline-none',
        'border-t focus-visible:z-[2] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-to',
        m % 60 === 0 ? 'border-white/10' : 'border-border-subtle',
        act === undefined &&
          (power ? 'bg-warning/[0.13] hover:bg-warning/[0.22]' : 'hover:bg-white/[0.06]'),
        act !== undefined && ACTIVITY_FILL[act as keyof typeof ACTIVITY_FILL],
        joinsPrev && 'border-t-transparent',
        act !== undefined &&
          !joinsPrev &&
          'mx-[2px] w-[calc(100%-4px)] rounded-t-md border-t-transparent',
        act !== undefined && joinsPrev && 'mx-[2px] w-[calc(100%-4px)]',
        act !== undefined && !joinsNext && 'rounded-b-md',
        isLocked &&
          'cursor-not-allowed bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.10)_0_4px,transparent_4px_8px)]',
        erasing && 'cursor-cell'
      )}
      style={{ height: ROW_H, touchAction: 'none' }}
    >
      {blockLabel && (
        <span
          className={cn(
            'pointer-events-none absolute left-1.5 top-[5px] truncate text-[10px] font-medium leading-none text-white/95',
            // Leave room for the headcount digit on the right so the two never collide.
            names ? 'right-5' : 'right-1.5'
          )}
        >
          {blockLabel}
        </span>
      )}
      {act === undefined && windowStart && (
        <span className="pointer-events-none absolute left-1.5 top-[5px] text-[9px] font-medium uppercase leading-none tracking-wide text-warning/80">
          {windowStart.label}
        </span>
      )}
      {names && (
        <span
          className={cn(
            'pointer-events-none absolute right-1.5 top-[5px] text-[10px] font-medium leading-none',
            act !== undefined ? 'text-white/80' : 'text-text-secondary'
          )}
        >
          {names.length}
        </span>
      )}
    </button>
  );
});

/** "7:30–10:00" -- the meridiem is dropped to fit a narrow column; the header and the picks list
 *  carry the full times. */
function compactRange(a: number, b: number): string {
  const t = (m: number) => {
    const h = Math.floor(m / 60) % 12 || 12;
    return `${h}:${String(m % 60).padStart(2, '0')}`;
  };
  return `${t(a)}–${t(b)}`;
}

function blockEnd(dayPicks: Record<number, string>, start: number, act: string): number {
  let e = start + SLOT;
  while (dayPicks[e] === act) e += SLOT;
  return e;
}

function SlotPopover({ hover, day, names }: { hover: Hover; day: PickDay; names: string[] }) {
  const { rect } = hover;
  const flip = rect.right + 232 > window.innerWidth;
  return (
    <div
      role="status"
      className="pointer-events-none fixed z-50 w-52 rounded-app-md border border-border-strong bg-surface-1 p-2.5 shadow-app-md"
      style={{
        top: Math.min(rect.top - 6, window.innerHeight - 140),
        left: flip ? rect.left - 216 : rect.right + 8,
      }}
    >
      <div className="text-meta font-medium text-text-primary">
        {day.short} {minRangeLabel(hover.min, hover.min + SLOT)}
      </div>
      {names.length === 0 ? (
        <div className="mt-0.5 text-meta text-text-muted">No one else yet</div>
      ) : (
        <>
          <div className="mt-0.5 text-meta text-text-muted">
            {names.length} {names.length === 1 ? 'other' : 'others'} working
          </div>
          <div className="mt-1 text-meta text-text-secondary">{names.join(', ')}</div>
        </>
      )}
    </div>
  );
}
