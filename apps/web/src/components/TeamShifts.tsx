import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarRange, ChevronLeft, ChevronRight, RefreshCw, ServerCrash } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';
import {
  ShiftsApiError,
  getAdminShiftsOverview,
  updateShiftSettings,
  type AdminShiftsOverview,
} from '@/lib/api';
import { CoverageTab } from './team-shifts/CoverageTab';
import { RequestQueue } from './team-shifts/RequestQueue';
import { SetupPanel } from './team-shifts/SetupPanel';
import { ShiftKpiTable } from './team-shifts/ShiftKpiTable';
import { fmtWeekRange } from './shifts/shiftFormat';
import { addDaysYmd } from './shifts/pickerModel';

type LoadState = 'loading' | 'ready' | 'disabled' | 'error';
type TeamTab = 'coverage' | 'requests' | 'kpis' | 'setup';

const TRIGGER_CLASS =
  'h-10 flex-none rounded-none border-b-2 border-transparent bg-transparent px-2 text-body sm:px-3 text-text-secondary data-[state=active]:border-accent-to data-[state=active]:bg-transparent data-[state=active]:text-text-primary data-[state=active]:shadow-none';

interface TeamShiftsProps {
  /** Only owners and admins can switch Shifts on; managers are told to ask. */
  canEnable?: boolean;
  /** "Manage pods" in Setup: the existing pods assignment lives in Settings. */
  onNavigateToSettings?: () => void;
}

/** Team Shifts (manager-level): Coverage, Requests, Shift KPIs and Setup for one week at a time. */
export function TeamShifts({ canEnable = false, onNavigateToSettings }: TeamShiftsProps) {
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<AdminShiftsOverview | null>(null);
  /** undefined = the current week (server decides, in the org timezone). */
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TeamTab>('coverage');
  const [enabling, setEnabling] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (target: string | undefined, quiet: boolean) => {
    const mine = ++seq.current;
    if (quiet) setRefreshing(true);
    else setState('loading');
    try {
      const data = await getAdminShiftsOverview(target);
      if (mine !== seq.current) return;
      setOverview(data);
      setState('ready');
    } catch (e) {
      if (mine !== seq.current) return;
      if (e instanceof ShiftsApiError && e.code === 'shifts_disabled') {
        setState('disabled');
        return;
      }
      if (quiet && overview) {
        toast.error(e instanceof Error ? e.message : 'Could not load that week.');
      } else {
        setError(e instanceof Error ? e.message : 'Could not load Team Shifts.');
        setState('error');
      }
    } finally {
      if (mine === seq.current) setRefreshing(false);
    }
    // `overview` only decides how to report a failed quiet refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load(week, overview !== null);
    // Reload when the week changes; the first load is not quiet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, load]);

  const enable = async () => {
    setEnabling(true);
    try {
      await updateShiftSettings({ enabled: true });
      toast.success('Shifts is on for your team');
      await load(week, false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not turn Shifts on.');
    } finally {
      setEnabling(false);
    }
  };

  if (state === 'loading') return <TeamSkeleton />;

  if (state === 'disabled') {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <PageHeader title="Team Shifts" description="Coverage, requests and shift results." />
        <EmptyState
          icon={CalendarRange}
          title="Shifts isn't turned on yet"
          body={
            canEnable
              ? 'Turn it on to let interns pick weekly hours and let you see coverage. You can set open hours and high leverage windows right after.'
              : 'An owner or admin has to turn Shifts on for your team first. Ask them to enable it.'
          }
          action={
            canEnable ? (
              <Button variant="primary" onClick={() => void enable()} loading={enabling}>
                Turn on Shifts
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  if (state === 'error' || !overview) {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <PageHeader title="Team Shifts" />
        <EmptyState
          icon={ServerCrash}
          title="Couldn't load Team Shifts"
          body={error ?? 'Something went wrong. Try again.'}
          action={
            <Button variant="fe-secondary" size="sm" onClick={() => void load(week, false)}>
              <RefreshCw /> Try again
            </Button>
          }
        />
      </div>
    );
  }

  const weekStart = overview.week.weekStart;
  const pending = overview.requests.filter((r) => r.status === 'pending').length;
  const label = overview.week.isCurrentWeek
    ? 'This week'
    : overview.week.isNextWeek
      ? 'Next week'
      : 'Week of';

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Team Shifts"
        description="Coverage, requests and shift results."
        actions={
          <div className="flex items-center gap-1" role="group" aria-label="Week">
            <Button
              variant="fe-secondary"
              size="icon"
              aria-label="Previous week"
              onClick={() => setWeek(addDaysYmd(weekStart, -7))}
            >
              <ChevronLeft />
            </Button>
            <div className="min-w-[10.5rem] px-2 text-center" aria-live="polite">
              <div className="text-body font-medium text-text-primary">{label}</div>
              <div className="text-meta text-text-muted">{fmtWeekRange(weekStart)}</div>
            </div>
            <Button
              variant="fe-secondary"
              size="icon"
              aria-label="Next week"
              onClick={() => setWeek(addDaysYmd(weekStart, 7))}
            >
              <ChevronRight />
            </Button>
            {!overview.week.isCurrentWeek && (
              <Button variant="fe-ghost" size="sm" onClick={() => setWeek(undefined)}>
                This week
              </Button>
            )}
          </div>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as TeamTab)} className="gap-5">
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border-subtle bg-transparent p-0">
          <TabsTrigger value="coverage" className={TRIGGER_CLASS}>
            Coverage
          </TabsTrigger>
          <TabsTrigger value="requests" className={TRIGGER_CLASS}>
            Requests
            {pending > 0 && (
              <span className="rounded-full bg-warning-soft px-1.5 text-[11px] font-medium leading-4 text-warning">
                {pending}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="kpis" className={TRIGGER_CLASS}>
            Shift KPIs
          </TabsTrigger>
          <TabsTrigger value="setup" className={TRIGGER_CLASS}>
            Setup
          </TabsTrigger>
        </TabsList>

        <div
          className={refreshing ? 'pointer-events-none opacity-60 transition-opacity' : undefined}
        >
          <TabsContent value="coverage">
            <CoverageTab
              // A new week starts with no slot selected.
              key={weekStart}
              overview={overview}
              onChanged={() => void load(week, true)}
              onOpenRequests={() => setTab('requests')}
            />
          </TabsContent>
          <TabsContent value="requests">
            <RequestQueue
              requests={overview.requests}
              timezone={overview.week.timezone}
              minimumHours={overview.settings.minWeeklyHours}
              onDecided={() => void load(week, true)}
            />
          </TabsContent>
          <TabsContent value="kpis">
            <ShiftKpiTable overview={overview} onRefreshed={() => void load(week, true)} />
          </TabsContent>
          <TabsContent value="setup">
            <SetupPanel
              overview={overview}
              canManage={canEnable}
              onChanged={() => void load(week, true)}
              onManagePods={onNavigateToSettings}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function TeamSkeleton() {
  return (
    <div
      className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6"
      aria-busy="true"
      aria-label="Loading team shifts"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-9 w-80" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}
