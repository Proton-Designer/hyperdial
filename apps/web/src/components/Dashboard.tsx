import { useState, useEffect, useCallback } from 'react';
import '@/styles/touch.css';
import { motion, useReducedMotion } from 'motion/react';
import {
  Phone,
  Target,
  Clock,
  MessagesSquare,
  Upload,
  Plus,
  PhoneCall,
  Trophy,
  AlertTriangle,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/PageHeader';
import { StatCard } from '@/components/app/StatCard';
import { EmptyState } from '@/components/app/EmptyState';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import {
  getDashboardStats,
  getTeamPerformanceChart,
  getUserPreferences,
  saveUserPreferences,
  getSpendStatus,
  type TeamPerformancePoint,
  type UserPreferences,
  type SpendStatus,
} from '@/lib/api';
import { MyGoalHeader } from '@/components/goals/MyGoalHeader';
import { MyScorecardTrendMini } from '@/components/Recordings';

type PerfRange = '7d' | '30d' | 'custom';

type DashboardProps = {
  onNavigateToDialer?: () => void;
  onNavigateToContacts?: () => void;
  onNavigateToCampaigns?: () => void;
};

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Dashboard({
  onNavigateToDialer,
  onNavigateToContacts,
  onNavigateToCampaigns,
}: DashboardProps = {}) {
  const { user } = useAuth();
  const { role, firstName } = useOrg();
  const reduceMotion = useReducedMotion();
  // Fail CLOSED, matching MainApp.tsx/Sidebar.tsx: treat "role not yet confirmed owner/admin"
  // (null, e.g. right after an invite accept) the same as agent, not the same as manager. NOT
  // also gated on OrgContext's `loading` -- that flips true on every refetch, including one an
  // already-confirmed owner triggers themselves (saving their profile in Settings.tsx), and
  // `role` alone already fails closed without flashing "My Performance" at an owner on every
  // unrelated refetch (re-review regression/nit).
  const isManager = role === 'owner' || role === 'admin';
  const isAgent = !isManager;
  const [stats, setStats] = useState<{
    callsToday: number;
    connectRate: number;
    talkTimeFormatted: string;
    conversationsToday: number;
    dialingHoursToday: number;
    conversationsPerHour: number | null;
    winsToday: number;
  } | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  // TASK-SP: manager-only low-balance banner. Fetched once on mount, not polled -- the hourly
  // cron (spend-alert-check) is the actual alerting mechanism; this is just a passive display
  // for whoever happens to load the Dashboard, same cadence as every other Dashboard stat here.
  const [spendStatus, setSpendStatus] = useState<SpendStatus | null>(null);
  useEffect(() => {
    if (!isManager) return;
    getSpendStatus()
      .then(setSpendStatus)
      .catch(() => setSpendStatus(null)); // silent -- a passive banner isn't worth an error state
  }, [isManager]);
  const isLowBalance =
    spendStatus?.available && spendStatus.availableCreditUsd < spendStatus.lowBalanceAlertUsd;

  const [perfRange, setPerfRange] = useState<PerfRange>('7d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [chartData, setChartData] = useState<TeamPerformancePoint[]>([]);
  const [chartLoading, setChartLoading] = useState(true);

  const fetchChart = useCallback(async (range: PerfRange, start?: string, end?: string) => {
    setChartLoading(true);
    try {
      const data = await getTeamPerformanceChart(range, start, end);
      setChartData(data);
    } catch {
      setChartData([]);
    } finally {
      setChartLoading(false);
    }
  }, []);

  useEffect(() => {
    getDashboardStats()
      .then((data) =>
        setStats({
          callsToday: data.callsToday,
          connectRate: data.connectRate,
          talkTimeFormatted: data.talkTimeFormatted,
          conversationsToday: data.conversationsToday,
          dialingHoursToday: data.dialingHoursToday,
          conversationsPerHour: data.conversationsPerHour,
          winsToday: data.winsToday,
        })
      )
      .catch((e) => setStatsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStatsLoading(false));
  }, []);

  useEffect(() => {
    getUserPreferences()
      .then((prefs: UserPreferences | null) => {
        if (prefs?.team_performance_range) {
          setPerfRange((prefs.team_performance_range as PerfRange) || '7d');
          if (prefs.custom_start) setCustomStart(prefs.custom_start);
          if (prefs.custom_end) setCustomEnd(prefs.custom_end);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (perfRange === 'custom' && customStart && customEnd) {
      fetchChart('custom', customStart, customEnd);
    } else {
      fetchChart(perfRange);
    }
  }, [perfRange, customStart, customEnd, fetchChart]);

  const handlePerfRange = (range: PerfRange) => {
    setPerfRange(range);
    if (range !== 'custom') {
      fetchChart(range);
      if (user?.id) {
        saveUserPreferences(user.id, {
          team_performance_range: range,
          custom_start: undefined,
          custom_end: undefined,
        }).catch(() => {});
      }
    }
  };

  const handleCustomApply = () => {
    if (!customStart || !customEnd) return;
    fetchChart('custom', customStart, customEnd);
    if (user?.id) {
      saveUserPreferences(user.id, {
        team_performance_range: 'custom',
        custom_start: customStart,
        custom_end: customEnd,
      }).catch(() => {});
    }
  };

  const metrics = [
    {
      icon: Phone,
      label: 'Calls today',
      value: statsError ? '—' : String(stats?.callsToday ?? 0),
    },
    {
      icon: Target,
      label: 'Connect rate',
      value: statsError ? '—' : `${stats?.connectRate ?? 0}%`,
    },
    {
      icon: MessagesSquare,
      label: 'Conversations / hr',
      value:
        statsError || stats?.conversationsPerHour == null
          ? '—'
          : String(stats.conversationsPerHour),
      subtext:
        statsError || !stats
          ? undefined
          : `${stats.conversationsToday} conversation${stats.conversationsToday === 1 ? '' : 's'} · ${stats.dialingHoursToday.toFixed(1)}h dialing`,
      tooltip:
        'Contact calls bridged to you and talked for 30 seconds or more, divided by hours spent in an active dialing session today.',
    },
    {
      icon: Trophy,
      label: 'Wins today',
      value: statsError ? '—' : String(stats?.winsToday ?? 0),
    },
    {
      icon: Clock,
      label: 'Talk time',
      value: statsError ? '—' : (stats?.talkTimeFormatted ?? '0m'),
    },
  ];

  const chartIsEmpty =
    !chartLoading && chartData.every((d) => (d.calls ?? 0) === 0 && (d.connections ?? 0) === 0);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="hd-touch p-6 sm:p-8 max-w-[1440px] mx-auto">
      <PageHeader
        title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
        description={today}
        actions={
          <>
            <Button variant="primary" onClick={onNavigateToDialer}>
              <PhoneCall className="w-4 h-4" />
              Start dialing
            </Button>
            {!isAgent && (
              <>
                <Button variant="fe-secondary" onClick={onNavigateToContacts}>
                  <Upload className="w-4 h-4" />
                  Upload contacts
                </Button>
                <Button variant="fe-secondary" onClick={onNavigateToCampaigns}>
                  <Plus className="w-4 h-4" />
                  New campaign
                </Button>
              </>
            )}
          </>
        }
      />

      {isLowBalance && spendStatus?.available && (
        <div className="mb-6 p-4 rounded-app-md bg-warning-soft border border-warning/30 text-warning text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          Telnyx balance is low: ${spendStatus.availableCreditUsd.toFixed(2)} available, below your
          ${spendStatus.lowBalanceAlertUsd.toFixed(2)} alert threshold. Check Settings → Telephony.
        </div>
      )}

      {/* MISSION-5 TASK-M5-A6: "My stats" -- today's goal attainment, self-view only (an
          owner/admin already gets an org-wide Team Performance chart below, not a personal one).
          Renders nothing at all (title included) if no goal is set anywhere for this org. */}
      {isAgent && (
        <MyGoalHeader
          title="Today's goals"
          cardClassName="mb-6 rounded-app-lg border border-border-subtle bg-surface-1 p-4 sm:p-6 shadow-app-sm"
        />
      )}

      {/* MISSION-5 TASK-M5-B5: renders nothing if this agent has never been scored -- see the
          component's own header comment. */}
      {isAgent && (
        <div className="mb-6">
          <MyScorecardTrendMini />
        </div>
      )}

      {/* Compact stat row -- 2x2 on mobile, 4-across from md up. Shares one shape between the
          loading and loaded states (StatCard renders its own skeleton via `loading`), so nothing
          shifts once the real values land. */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-6">
        {metrics.map((metric, index) => (
          <motion.div
            key={metric.label}
            className="h-full"
            initial={statsLoading || reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.04, duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <StatCard loading={statsLoading} {...metric} className="h-full" />
          </motion.div>
        ))}
      </div>

      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 sm:p-6 shadow-app-sm">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <h2 className="text-section-title text-text-primary">
            {isAgent ? 'My Performance' : 'Team Performance'}
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant={perfRange === '7d' ? 'fe-secondary' : 'fe-ghost'}
              onClick={() => handlePerfRange('7d')}
            >
              7D
            </Button>
            <Button
              size="sm"
              variant={perfRange === '30d' ? 'fe-secondary' : 'fe-ghost'}
              onClick={() => handlePerfRange('30d')}
            >
              30D
            </Button>
            <Button
              size="sm"
              variant={perfRange === 'custom' ? 'fe-secondary' : 'fe-ghost'}
              onClick={() => setPerfRange('custom')}
            >
              Custom
            </Button>
            {perfRange === 'custom' && (
              <>
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="bg-surface-2 border border-border-subtle rounded-app-sm px-2 py-1.5 text-sm text-text-primary"
                />
                <span className="text-text-muted">–</span>
                <input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="bg-surface-2 border border-border-subtle rounded-app-sm px-2 py-1.5 text-sm text-text-primary"
                />
                <Button size="sm" variant="primary" onClick={handleCustomApply}>
                  Apply
                </Button>
              </>
            )}
          </div>
        </div>

        {chartLoading ? (
          <Skeleton className="h-[320px] w-full rounded-app-lg" />
        ) : chartIsEmpty ? (
          <EmptyState
            icon={MessagesSquare}
            title="No calls yet this week"
            body="Start a session to see your team's activity."
            action={
              <Button variant="primary" onClick={onNavigateToDialer}>
                <PhoneCall className="w-4 h-4" />
                Start dialing
              </Button>
            }
          />
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="colorCalls" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0066FF" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#0066FF" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorConnections" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00D9FF" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#00D9FF" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="day"
                stroke="#B0BEC5"
                tick={{ fill: '#B0BEC5' }}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
              />
              <YAxis
                stroke="#B0BEC5"
                tick={{ fill: '#B0BEC5' }}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1A2332',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '12px',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                }}
                itemStyle={{ color: '#fff' }}
                labelStyle={{ color: '#B0BEC5' }}
              />
              {/* FE-A: legend text is the muted body colour, not each series' own bright stroke
                  colour -- only the dot keeps the series colour. */}
              <Legend
                wrapperStyle={{ paddingTop: '20px' }}
                iconType="circle"
                formatter={(value) => <span style={{ color: '#B0BEC5' }}>{value}</span>}
              />
              <Area
                type="monotone"
                dataKey="calls"
                stroke="#0066FF"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorCalls)"
                name="Total Calls"
              />
              <Area
                type="monotone"
                dataKey="connections"
                stroke="#00D9FF"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorConnections)"
                name="Connections"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
