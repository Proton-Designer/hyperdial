import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, RefreshCw, ServerCrash } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';
import {
  ShiftsApiError,
  getShiftsWeek,
  withdrawShiftRequest,
  type Shift,
  type ShiftRequest,
  type ShiftRequestType,
  type ShiftsWeekResponse,
} from '@/lib/api';
import { MyShifts } from './shifts/MyShifts';
import { RequestsList } from './shifts/RequestsList';
import { RequestChangeModal } from './shifts/RequestChangeModal';
import { WeekPicker } from './shifts/WeekPicker';
import { fmtDeadline, fmtWeekRange } from './shifts/shiftFormat';

type SubTab = 'my-shifts' | 'pick' | 'requests';
type LoadState = 'loading' | 'ready' | 'error' | 'disabled';

const TRIGGER_CLASS =
  'flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 pb-2.5 pt-1.5 text-text-secondary shadow-none data-[state=active]:border-accent-to data-[state=active]:bg-transparent data-[state=active]:text-text-primary dark:data-[state=active]:bg-transparent dark:data-[state=active]:border-accent-to dark:text-text-secondary';

function addDays(ymd: string, days: number): string {
  return new Date(new Date(`${ymd}T12:00:00Z`).getTime() + days * 86400000)
    .toISOString()
    .slice(0, 10);
}

/** Intern-facing Shifts screen (TASK-F01): My Shifts, Pick Next Week (F02) and Requests. */
export function Shifts() {
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<ShiftsWeekResponse | null>(null);
  const [next, setNext] = useState<ShiftsWeekResponse | null>(null);
  const [requests, setRequests] = useState<ShiftRequest[]>([]);
  const [tab, setTab] = useState<SubTab>('my-shifts');
  // Bumped after a submit so the picker re-seeds from the saved week instead of its draft.
  const [pickerKey, setPickerKey] = useState(0);
  const [modal, setModal] = useState<{
    shift: Shift | null;
    week: ShiftsWeekResponse;
    type?: ShiftRequestType;
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setState('loading');
    try {
      const cur = await getShiftsWeek();
      // Next week is secondary: if it fails the rest of the screen still renders.
      const nxt = await getShiftsWeek(addDays(cur.week.weekStart, 7)).catch(() => null);
      if (!mounted.current) return;
      setCurrent(cur);
      setNext(nxt);
      setRequests(cur.myRequests);
      setState('ready');
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ShiftsApiError && e.code === 'shifts_disabled') {
        setState('disabled');
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not load your shifts.');
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleWithdraw = useCallback(
    async (request: ShiftRequest) => {
      const patch = (status: ShiftRequest['status']) =>
        setRequests((rs) => rs.map((r) => (r.id === request.id ? { ...r, status } : r)));
      patch('withdrawn'); // optimistic
      try {
        const { request: updated } = await withdrawShiftRequest(request.id);
        setRequests((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
        toast.success('Request withdrawn');
        void load({ quiet: true }); // the shift's "Change requested" tag clears
      } catch (e) {
        patch(request.status);
        toast.error(e instanceof Error ? e.message : 'Could not withdraw the request.');
        throw e;
      }
    },
    [load]
  );

  if (state === 'loading') return <ShiftsSkeleton />;

  if (state === 'disabled') {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <PageHeader title="Shifts" />
        <EmptyState
          icon={CalendarClock}
          title="Shifts isn't turned on yet"
          body="Your team hasn't switched this on. Ask your manager to enable it."
        />
      </div>
    );
  }

  if (state === 'error' || !current) {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <PageHeader title="Shifts" />
        <EmptyState
          icon={ServerCrash}
          title="Couldn't load your shifts"
          body={error ?? 'Something went wrong. Try again.'}
          action={
            <Button variant="fe-secondary" size="sm" onClick={() => void load()}>
              <RefreshCw /> Try again
            </Button>
          }
        />
      </div>
    );
  }

  const tz = current.week.timezone;
  const pickOpen = next !== null && !next.week.deadlinePassed;
  const activeTab: SubTab = tab === 'pick' && !pickOpen ? 'my-shifts' : tab;
  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader
        title="Shifts"
        description={
          next && pickOpen
            ? `Next week's picks close ${fmtDeadline(next.week.deadlineAt, tz)}.`
            : `Week of ${fmtWeekRange(current.week.weekStart)}`
        }
      />
      <Tabs value={activeTab} onValueChange={(v) => setTab(v as SubTab)} className="gap-5">
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border-subtle bg-transparent p-0">
          <TabsTrigger value="my-shifts" className={TRIGGER_CLASS}>
            My Shifts
          </TabsTrigger>
          {pickOpen && (
            <TabsTrigger value="pick" className={TRIGGER_CLASS}>
              Pick Next Week
            </TabsTrigger>
          )}
          <TabsTrigger value="requests" className={TRIGGER_CLASS}>
            Requests
            {pendingCount > 0 && (
              <span className="rounded-full bg-warning-soft px-1.5 text-[11px] font-medium leading-4 text-warning">
                {pendingCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="my-shifts">
          <MyShifts
            current={current}
            next={next}
            onRequestChange={(shift, week) => setModal({ shift, week })}
            onRequestWeek={(week, type) => setModal({ shift: null, week, type })}
            onPickNextWeek={() => setTab('pick')}
          />
        </TabsContent>
        {pickOpen && next && (
          // forceMount keeps the draft alive while the intern checks My Shifts or Requests.
          <TabsContent value="pick" forceMount className="data-[state=inactive]:hidden">
            <WeekPicker
              key={pickerKey}
              week={next}
              onSubmitted={() => {
                setTab('my-shifts');
                void load({ quiet: true }).then(() => setPickerKey((k) => k + 1));
              }}
              onClosed={() => void load({ quiet: true })}
            />
          </TabsContent>
        )}
        <TabsContent value="requests">
          <RequestsList requests={requests} timezone={tz} onWithdraw={handleWithdraw} />
        </TabsContent>
      </Tabs>

      <RequestChangeModal
        open={modal !== null}
        onOpenChange={(o) => !o && setModal(null)}
        shift={modal?.shift ?? null}
        week={modal?.week ?? current}
        initialType={modal?.type}
        onSubmitted={() => void load({ quiet: true })}
      />
    </div>
  );
}

function ShiftsSkeleton() {
  return (
    <div
      className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6"
      aria-busy="true"
      aria-label="Loading shifts"
    >
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
