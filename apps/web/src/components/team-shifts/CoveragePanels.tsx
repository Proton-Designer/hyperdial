import { CalendarPlus, ChevronRight, Inbox, Users, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { SLOT, minRangeLabel } from '../shifts/pickerModel';
import { ShiftStatusPill } from '../shifts/pills';
import { ACTIVITY_LABEL, fmtDateOnly, fmtHours, fmtRange } from '../shifts/shiftFormat';
import { slotKey, type CoverageModel, type PanelStats, type TeamShift } from './coverageModel';
import type { SelectedSlot } from './CoverageGrid';

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string | number;
  tone?: 'warning' | 'danger';
  hint?: string;
}) {
  return (
    <div className="rounded-app-md border border-border-subtle bg-surface-2 px-3 py-2.5">
      <div
        className={cn(
          'text-metric text-lg font-semibold',
          tone === 'danger'
            ? 'text-danger'
            : tone === 'warning'
              ? 'text-warning'
              : 'text-text-primary'
        )}
      >
        {value}
      </div>
      <div className="text-meta text-text-muted">{label}</div>
      {hint && <div className="text-meta text-text-muted">{hint}</div>}
    </div>
  );
}

function NameList({ title, empty, items }: { title: string; empty: string; items: string[] }) {
  return (
    <div>
      <h4 className="mb-1.5 text-meta font-medium uppercase tracking-wide text-text-muted">
        {title}
        {items.length > 0 && <span className="ml-1.5 text-text-secondary">{items.length}</span>}
      </h4>
      {items.length === 0 ? (
        <p className="text-meta text-success">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((n) => (
            <li key={n} className="text-body text-text-primary">
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Side panel: who needs attention this week, plus team totals. */
export function CoverageSummary({
  stats,
  minHours,
  onOpenRequests,
}: {
  stats: PanelStats;
  minHours: number;
  onOpenRequests: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Team hours" value={fmtHours(stats.teamHours)} />
        <Stat
          label="In high leverage windows"
          value={fmtHours(stats.powerHours)}
          hint={
            stats.teamHours > 0
              ? `${Math.round((stats.powerHours / stats.teamHours) * 100)}% of hours`
              : undefined
          }
        />
      </div>
      <button
        type="button"
        onClick={onOpenRequests}
        className={cn(
          'flex w-full items-center gap-3 rounded-app-md border px-3 py-2.5 text-left transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-to/60',
          stats.pendingRequests > 0
            ? 'border-warning/30 bg-warning-soft'
            : 'border-border-subtle bg-surface-2'
        )}
      >
        <Inbox className="h-4 w-4 shrink-0 text-text-secondary" />
        <span className="flex-1 text-body text-text-primary">
          {stats.pendingRequests === 0
            ? 'No requests waiting'
            : `${stats.pendingRequests} ${stats.pendingRequests === 1 ? 'request' : 'requests'} waiting`}
        </span>
        <ChevronRight className="h-4 w-4 text-text-muted" />
      </button>
      <NameList
        title={`Under ${fmtHours(minHours)}`}
        empty="Everyone has their minimum."
        items={stats.underMinimum.map((u) => `${u.member.name} · ${fmtHours(u.hours)}`)}
      />
      <NameList
        title="Not submitted"
        empty="Everyone has submitted."
        items={stats.notSubmitted.map((m) => m.name)}
      />
    </div>
  );
}

/** The shifts in the clicked 30-minute slot; picking one opens the editor. */
export function SlotShifts({
  slot,
  model,
  timezone,
  onEdit,
  onAdd,
}: {
  slot: SelectedSlot | null;
  model: CoverageModel;
  timezone: string;
  onEdit: (shift: TeamShift) => void;
  onAdd: (slot: SelectedSlot | null) => void;
}) {
  const shifts = slot ? (model.bySlot.get(slotKey(slot.date, slot.min)) ?? []) : [];
  const sorted = [...shifts].sort((a, b) => a.userName.localeCompare(b.userName));
  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Users className="h-4 w-4 text-text-secondary" />
        <h3 className="flex-1 text-body font-medium text-text-primary">
          {slot
            ? `${fmtDateOnly(slot.date, { weekday: 'short', month: 'short', day: 'numeric' })}, ${minRangeLabel(slot.min, slot.min + SLOT)}`
            : 'Pick a slot'}
        </h3>
        <Button variant="fe-secondary" size="sm" onClick={() => onAdd(slot)}>
          <CalendarPlus /> Add shift
        </Button>
      </div>
      {!slot ? (
        <p className="text-meta text-text-muted">
          Select a slot on the calendar to see who is working and edit their shifts.
        </p>
      ) : sorted.length === 0 ? (
        <p className="text-meta text-text-muted">Nobody is scheduled in this slot.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {sorted.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onEdit(s)}
                className="flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-to/60"
                aria-label={`Edit ${s.userName}'s shift, ${fmtRange(s.startsAt, s.endsAt, timezone)}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium text-text-primary">
                    {s.userName}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-meta text-text-muted">
                    <span className="text-metric">{fmtRange(s.startsAt, s.endsAt, timezone)}</span>
                    <span>{ACTIVITY_LABEL[s.activity]}</span>
                    {s.powerMinutes > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-warning">
                        <Zap className="h-3 w-3" /> {fmtHours(s.powerMinutes / 60)}
                      </span>
                    )}
                  </div>
                </div>
                <ShiftStatusPill status={s.status} />
                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
