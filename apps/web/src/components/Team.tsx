import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Users, ArrowUpDown } from 'lucide-react';
import {
  getTeamDailyStats,
  getTeamLiveBoard,
  type TeamDailyStatsRow,
  type TeamLiveBoardRow,
  type TeamLiveStatus,
} from '@/lib/api';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

type Range = 'today' | 'yesterday' | '7d' | 'custom';

const LIVE_POLL_MS = 5000;

/**
 * TASK-M2 (ADM-6/ADM-7): manager team view. Live board polls `team_live_board` every 5s (a
 * single RPC per poll -- see api.ts); the daily table below re-fetches `team_daily_stats` only
 * when the range changes. Both RPCs are owner/admin-gated by the DB itself (return empty for
 * anyone else), so there's no separate client-side role check needed here -- same trust model as
 * `contact_disposition_history`.
 */

// --- America/Chicago day-boundary math (matches dialing_hours_today's own convention, see
// .brain/domains/analytics.md) -- verified by round-tripping the guess through Intl rather than
// hardcoding a UTC offset, so it stays correct across the DST transition.
function chicagoTodayParts(): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), day: get('day') };
}

function chicagoMidnightUtc(y: number, month: number, day: number): Date {
  for (const offsetHours of [5, 6]) {
    const guess = new Date(Date.UTC(y, month - 1, day, offsetHours, 0, 0));
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(guess);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    if (
      get('hour') === '00' &&
      get('minute') === '00' &&
      Number(get('year')) === y &&
      Number(get('month')) === month &&
      Number(get('day')) === day
    ) {
      return guess;
    }
  }
  return new Date(Date.UTC(y, month - 1, day, 5, 0, 0)); // unreachable for America/Chicago
}

function addDays(
  y: number,
  m: number,
  day: number,
  delta: number
): { y: number; m: number; day: number } {
  const d = new Date(Date.UTC(y, m - 1, day + delta));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function resolveRange(
  range: Range,
  customStart: string,
  customEnd: string
): { start: Date; end: Date } | null {
  const today = chicagoTodayParts();
  if (range === 'today') {
    const start = chicagoMidnightUtc(today.y, today.m, today.day);
    const tomorrow = addDays(today.y, today.m, today.day, 1);
    return { start, end: chicagoMidnightUtc(tomorrow.y, tomorrow.m, tomorrow.day) };
  }
  if (range === 'yesterday') {
    const y = addDays(today.y, today.m, today.day, -1);
    return {
      start: chicagoMidnightUtc(y.y, y.m, y.day),
      end: chicagoMidnightUtc(today.y, today.m, today.day),
    };
  }
  if (range === '7d') {
    const start7 = addDays(today.y, today.m, today.day, -6);
    const endExclusive = addDays(today.y, today.m, today.day, 1);
    return {
      start: chicagoMidnightUtc(start7.y, start7.m, start7.day),
      end: chicagoMidnightUtc(endExclusive.y, endExclusive.m, endExclusive.day),
    };
  }
  // custom
  if (!customStart || !customEnd) return null;
  const [sy, sm, sd] = customStart.split('-').map(Number);
  const [ey, em, ed] = customEnd.split('-').map(Number);
  const endExclusive = addDays(ey, em, ed, 1);
  return {
    start: chicagoMidnightUtc(sy, sm, sd),
    end: chicagoMidnightUtc(endExclusive.y, endExclusive.m, endExclusive.day),
  };
}

const STATUS_META: Record<TeamLiveStatus, { label: string; dot: string; text: string }> = {
  offline: { label: 'Offline', dot: 'bg-text-muted', text: 'text-text-secondary' },
  ready: { label: 'Ready', dot: 'bg-accent-to', text: 'text-accent-to' },
  dialing: { label: 'Dialing', dot: 'bg-warning', text: 'text-warning' },
  on_call: { label: 'On call', dot: 'bg-success', text: 'text-success' },
  wrap_up: { label: 'Wrap-up', dot: 'bg-warning', text: 'text-warning' },
  paused: { label: 'Paused', dot: 'bg-danger', text: 'text-danger' },
};

function formatElapsed(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return '0m';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function statusLine(row: TeamLiveBoardRow): string {
  const meta = STATUS_META[row.status];
  if (row.status === 'dialing' && row.lines) return `${meta.label} (${row.lines} lines)`;
  if (row.status === 'on_call' && row.contact_name) return `${meta.label} — ${row.contact_name}`;
  return meta.label;
}

function LiveBoardCard({ row }: { row: TeamLiveBoardRow }) {
  const meta = STATUS_META[row.status];
  return (
    <div className="rounded-app-md border border-border-subtle bg-surface-2 p-4 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2.5 min-w-[160px] flex-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
        <div className="min-w-0">
          <div className="font-medium text-text-primary truncate">{row.name}</div>
          <div className={`text-meta ${meta.text}`}>{statusLine(row)}</div>
        </div>
      </div>
      <div className="flex items-center gap-6 text-meta text-text-secondary">
        <div>
          <div className="text-text-muted">Time in state</div>
          <div className="text-text-primary font-medium">{formatElapsed(row.state_since)}</div>
        </div>
        <div>
          <div className="text-text-muted">Session</div>
          <div className="text-text-primary font-medium">
            {formatElapsed(row.session_started_at)}
          </div>
        </div>
        <div>
          <div className="text-text-muted">Calls today</div>
          <div className="text-text-primary font-medium">{row.calls_today}</div>
        </div>
        <div>
          <div className="text-text-muted">Conversations</div>
          <div className="text-text-primary font-medium">{row.conversations_today}</div>
        </div>
      </div>
    </div>
  );
}

type SortKey = keyof Pick<
  TeamDailyStatsRow,
  | 'name'
  | 'dials'
  | 'connects'
  | 'connect_rate'
  | 'conversations'
  | 'conversations_per_hr'
  | 'wins'
  | 'callbacks_set'
  | 'talk_time_seconds'
  | 'dialing_hours'
>;

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Agent' },
  { key: 'dials', label: 'Dials' },
  { key: 'connects', label: 'Connects' },
  { key: 'connect_rate', label: 'Connect %' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'conversations_per_hr', label: 'Conv/hr' },
  { key: 'wins', label: 'Wins' },
  { key: 'callbacks_set', label: 'Callbacks' },
  { key: 'talk_time_seconds', label: 'Talk time' },
  { key: 'dialing_hours', label: 'Dialing hrs' },
];

function formatTalkTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

export function Team() {
  const [range, setRange] = useState<Range>('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [daily, setDaily] = useState<TeamDailyStatsRow[] | null>(null);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [live, setLive] = useState<TeamLiveBoardRow[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('dials');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const resolved = useMemo(
    () => resolveRange(range, customStart, customEnd),
    [range, customStart, customEnd]
  );

  const loadDaily = useCallback(() => {
    if (!resolved) return;
    setDailyLoading(true);
    setDailyError(null);
    getTeamDailyStats(resolved.start, resolved.end)
      .then(setDaily)
      .catch((e) => setDailyError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDailyLoading(false));
  }, [resolved]);

  useEffect(() => {
    loadDaily();
  }, [loadDaily]);

  // ADM-7: poll every 5s -- a single RPC round trip, cleaned up on unmount/tab switch (Team.tsx
  // is only ever mounted while the Team tab is active, unlike Dialer's always-mounted client).
  const pollingRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (pollingRef.current) return; // never overlap a slow poll with the next tick
      pollingRef.current = true;
      try {
        const rows = await getTeamLiveBoard();
        if (!cancelled) {
          setLive(rows);
          setLiveError(null);
        }
      } catch (e) {
        if (!cancelled) setLiveError(e instanceof Error ? e.message : String(e));
      } finally {
        pollingRef.current = false;
      }
    };
    void poll();
    const interval = setInterval(poll, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortedDaily = useMemo(() => {
    if (!daily) return [];
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...daily].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' || typeof bv === 'string') {
        return dir * String(av ?? '').localeCompare(String(bv ?? ''));
      }
      return dir * (((av ?? 0) as number) - ((bv ?? 0) as number));
    });
  }, [daily, sortKey, sortDir]);

  const totals = useMemo(() => {
    if (!daily || daily.length === 0) return null;
    const sum = (f: (r: TeamDailyStatsRow) => number) => daily.reduce((s, r) => s + f(r), 0);
    const dials = sum((r) => r.dials);
    const connects = sum((r) => r.connects);
    const conversations = sum((r) => r.conversations);
    const dialingHours = sum((r) => r.dialing_hours);
    return {
      dials,
      connects,
      connectRate: dials > 0 ? Math.round((connects / dials) * 1000) / 10 : 0,
      conversations,
      conversationsPerHr:
        dialingHours >= 0.1 ? Math.round((conversations / dialingHours) * 100) / 100 : null,
      wins: sum((r) => r.wins),
      callbacksSet: sum((r) => r.callbacks_set),
      talkTimeSeconds: sum((r) => r.talk_time_seconds),
      dialingHours: Math.round(dialingHours * 10) / 10,
    };
  }, [daily]);

  return (
    <div className="p-4 sm:p-8 max-w-[1440px] mx-auto">
      <PageHeader title="Team" description="Live status and daily performance across your team" />

      {/* ADM-7: live board */}
      <div className="mb-8">
        <h2 className="text-section-title text-text-primary mb-4">Live board</h2>
        {liveError && (
          <div className="mb-3 p-3 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-meta">
            {liveError}
          </div>
        )}
        {live === null ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[76px] rounded-app-md" />
            ))}
          </div>
        ) : live.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No team members yet"
            body="Invite interns from Settings to see them here."
          />
        ) : (
          <div className="space-y-2">
            {live.map((row) => (
              <LiveBoardCard key={row.agent_id} row={row} />
            ))}
          </div>
        )}
      </div>

      {/* ADM-6: daily numbers */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-section-title text-text-primary">Daily numbers</h2>
          <div className="flex items-center gap-1 bg-surface-1 rounded-app-md p-1 border border-border-subtle">
            {(['today', 'yesterday', '7d', 'custom'] as Range[]).map((r) => (
              <Button
                key={r}
                size="sm"
                variant={range === r ? 'fe-secondary' : 'fe-ghost'}
                onClick={() => setRange(r)}
              >
                {r === 'today'
                  ? 'Today'
                  : r === 'yesterday'
                    ? 'Yesterday'
                    : r === '7d'
                      ? 'Last 7 days'
                      : 'Custom'}
              </Button>
            ))}
          </div>
        </div>

        {range === 'custom' && (
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
            />
            <span className="text-text-secondary">to</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
            />
          </div>
        )}

        {dailyError && (
          <div className="mb-4 p-4 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
            {dailyError}
          </div>
        )}

        {dailyLoading ? (
          <Skeleton className="h-[300px] rounded-app-lg" />
        ) : !daily || daily.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No data for this range"
            body="Once your team starts dialing, their numbers will show up here."
          />
        ) : (
          <>
            {/* Desktop/tablet: real table. Mobile (<768): stacked cards. */}
            <div className="hidden md:block rounded-app-lg border border-border-subtle bg-surface-1 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border-subtle text-text-secondary">
                    {COLUMNS.map((col) => (
                      <th key={col.key} className="p-3 font-medium">
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className="flex items-center gap-1 hover:text-text-primary"
                        >
                          {col.label}
                          {sortKey === col.key && <ArrowUpDown className="w-3 h-3" />}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedDaily.map((row) => (
                    <tr key={row.agent_id} className="border-b border-border-subtle last:border-0">
                      <td className="p-3 text-white font-medium">{row.name}</td>
                      <td className="p-3 text-text-secondary">{row.dials}</td>
                      <td className="p-3 text-text-secondary">{row.connects}</td>
                      <td className="p-3 text-text-secondary">{row.connect_rate}%</td>
                      <td className="p-3 text-text-secondary">{row.conversations}</td>
                      <td className="p-3 text-text-secondary">
                        {row.conversations_per_hr !== null
                          ? row.conversations_per_hr.toFixed(2)
                          : '—'}
                      </td>
                      <td className="p-3 text-text-secondary">{row.wins}</td>
                      <td className="p-3 text-text-secondary">{row.callbacks_set}</td>
                      <td className="p-3 text-text-secondary">
                        {formatTalkTime(row.talk_time_seconds)}
                      </td>
                      <td className="p-3 text-text-secondary">{row.dialing_hours.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t border-border-subtle font-semibold text-text-primary">
                      <td className="p-3">Total</td>
                      <td className="p-3">{totals.dials}</td>
                      <td className="p-3">{totals.connects}</td>
                      <td className="p-3">{totals.connectRate}%</td>
                      <td className="p-3">{totals.conversations}</td>
                      <td className="p-3">
                        {totals.conversationsPerHr !== null
                          ? totals.conversationsPerHr.toFixed(2)
                          : '—'}
                      </td>
                      <td className="p-3">{totals.wins}</td>
                      <td className="p-3">{totals.callbacksSet}</td>
                      <td className="p-3">{formatTalkTime(totals.talkTimeSeconds)}</td>
                      <td className="p-3">{totals.dialingHours.toFixed(1)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {sortedDaily.map((row) => (
                <div
                  key={row.agent_id}
                  className="rounded-app-md border border-border-subtle bg-surface-2 p-4"
                >
                  <div className="font-medium text-text-primary mb-2">{row.name}</div>
                  <div className="grid grid-cols-2 gap-2 text-meta text-text-secondary">
                    <div>
                      Dials: <span className="text-text-primary">{row.dials}</span>
                    </div>
                    <div>
                      Connects: <span className="text-text-primary">{row.connects}</span>
                    </div>
                    <div>
                      Connect %: <span className="text-text-primary">{row.connect_rate}%</span>
                    </div>
                    <div>
                      Conversations: <span className="text-text-primary">{row.conversations}</span>
                    </div>
                    <div>
                      Conv/hr:{' '}
                      <span className="text-text-primary">
                        {row.conversations_per_hr !== null
                          ? row.conversations_per_hr.toFixed(2)
                          : '—'}
                      </span>
                    </div>
                    <div>
                      Wins: <span className="text-text-primary">{row.wins}</span>
                    </div>
                    <div>
                      Callbacks: <span className="text-text-primary">{row.callbacks_set}</span>
                    </div>
                    <div>
                      Talk time:{' '}
                      <span className="text-text-primary">
                        {formatTalkTime(row.talk_time_seconds)}
                      </span>
                    </div>
                    <div>
                      Dialing hrs:{' '}
                      <span className="text-text-primary">{row.dialing_hours.toFixed(1)}</span>
                    </div>
                  </div>
                </div>
              ))}
              {totals && (
                <div className="rounded-app-md border border-border-subtle bg-surface-1 p-4">
                  <div className="font-semibold text-text-primary mb-2">Total</div>
                  <div className="grid grid-cols-2 gap-2 text-meta text-text-secondary">
                    <div>
                      Dials: <span className="text-text-primary">{totals.dials}</span>
                    </div>
                    <div>
                      Connects: <span className="text-text-primary">{totals.connects}</span>
                    </div>
                    <div>
                      Connect %: <span className="text-text-primary">{totals.connectRate}%</span>
                    </div>
                    <div>
                      Conversations:{' '}
                      <span className="text-text-primary">{totals.conversations}</span>
                    </div>
                    <div>
                      Conv/hr:{' '}
                      <span className="text-text-primary">
                        {totals.conversationsPerHr !== null
                          ? totals.conversationsPerHr.toFixed(2)
                          : '—'}
                      </span>
                    </div>
                    <div>
                      Wins: <span className="text-text-primary">{totals.wins}</span>
                    </div>
                    <div>
                      Callbacks: <span className="text-text-primary">{totals.callbacksSet}</span>
                    </div>
                    <div>
                      Talk time:{' '}
                      <span className="text-text-primary">
                        {formatTalkTime(totals.talkTimeSeconds)}
                      </span>
                    </div>
                    <div>
                      Dialing hrs:{' '}
                      <span className="text-text-primary">{totals.dialingHours.toFixed(1)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
