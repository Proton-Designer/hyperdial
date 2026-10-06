import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { cn } from '@/components/ui/utils';
import type { AdminShiftsOverview } from '@/lib/api';
import { CoverageDayView, CoverageGrid, CoverageLegend, type SelectedSlot } from './CoverageGrid';
import { CoverageSummary, SlotShifts } from './CoveragePanels';
import { buildCoverage, buildStats, maxHeadcount } from './coverageModel';
import { ShiftEditDialog, type EditTarget } from './ShiftEditDialog';

/** Coverage: heatmap + side panel + direct shift editing. */
export function CoverageTab({
  overview,
  onChanged,
  onOpenRequests,
}: {
  overview: AdminShiftsOverview;
  /** A shift edit saved; the shell refetches the week. */
  onChanged: () => void;
  onOpenRequests: () => void;
}) {
  const isMobile = useBreakpoint() === 'mobile';
  const model = useMemo(() => buildCoverage(overview), [overview]);
  const stats = useMemo(() => buildStats(overview), [overview]);
  const max = useMemo(() => maxHeadcount(model), [model]);
  const alertBelow = overview.settings.powerCoverageAlert;
  const [selected, setSelected] = useState<SelectedSlot | null>(null);
  const [target, setTarget] = useState<EditTarget | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  if (model.days.length === 0) {
    return (
      <p className="rounded-app-lg border border-dashed border-border-subtle p-6 text-center text-body text-text-secondary">
        No days are open for shifts. Set open hours in Setup to see coverage.
      </p>
    );
  }

  const grid = isMobile ? (
    <CoverageDayView
      model={model}
      alertBelow={alertBelow}
      selected={selected}
      onSelect={setSelected}
    />
  ) : (
    <CoverageGrid
      model={model}
      alertBelow={alertBelow}
      selected={selected}
      onSelect={setSelected}
    />
  );
  const summary = (
    <CoverageSummary
      stats={stats}
      minHours={overview.week.minHours}
      onOpenRequests={onOpenRequests}
    />
  );

  return (
    <div className="space-y-4">
      <CoverageLegend alertBelow={alertBelow} max={max} />

      {isMobile && (
        <div className="rounded-app-lg border border-border-subtle bg-surface-1">
          <button
            type="button"
            aria-expanded={summaryOpen}
            onClick={() => setSummaryOpen((o) => !o)}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-body font-medium text-text-primary"
          >
            <span className="flex-1">
              Team summary
              <span className="ml-2 text-meta font-normal text-text-muted">
                {stats.underMinimum.length} under minimum · {stats.pendingRequests} requests
              </span>
            </span>
            <ChevronDown
              className={cn('h-4 w-4 transition-transform', summaryOpen && 'rotate-180')}
            />
          </button>
          {summaryOpen && <div className="border-t border-border-subtle p-3">{summary}</div>}
        </div>
      )}

      <div
        className={cn('grid items-start gap-5', !isMobile && 'lg:grid-cols-[minmax(0,1fr)_300px]')}
      >
        <div className="min-w-0 space-y-4">
          {grid}
          <SlotShifts
            slot={selected}
            model={model}
            timezone={overview.week.timezone}
            onEdit={(shift) => setTarget({ kind: 'edit', shift })}
            onAdd={(slot) =>
              setTarget({ kind: 'create', date: slot?.date, start: slot ? slot.min : undefined })
            }
          />
        </div>
        {!isMobile && (
          <aside aria-label="Team summary" className="lg:sticky lg:top-4">
            <h3 className="mb-2 text-meta font-medium uppercase tracking-wide text-text-muted">
              This week
            </h3>
            {summary}
          </aside>
        )}
      </div>

      <ShiftEditDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        target={target}
        overview={overview}
        onSaved={onChanged}
      />
    </div>
  );
}
