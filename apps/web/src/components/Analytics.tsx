import { useState, useEffect, useCallback } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { TrendingUp, TrendingDown, Phone, Clock, Target, Gauge } from 'lucide-react';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { getAnalyticsSummary, type AnalyticsSummary } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/PageHeader';
import { StatCard } from '@/components/app/StatCard';
import { EmptyState } from '@/components/app/EmptyState';

type Range = '7d' | '30d';

const SLICE_COLORS = ['#00E676', '#FFB300', '#B0BEC5', '#FF3D00', '#0066FF', '#00D9FF', '#9C27B0'];

function ChangeBadge({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const positive = pct >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <div
      className={`flex items-center gap-1 text-meta ${positive ? 'text-success' : 'text-danger'}`}
    >
      <Icon className="w-3.5 h-3.5" />
      <span>
        {positive ? '+' : ''}
        {pct}%
      </span>
    </div>
  );
}

export function Analytics() {
  const [range, setRange] = useState<Range>('7d');
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();

  const load = useCallback((r: Range) => {
    setLoading(true);
    setError(null);
    getAnalyticsSummary(r)
      .then(setSummary)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(range);
  }, [range, load]);

  const hasData = (summary?.totals.totalCalls ?? 0) > 0;

  const metrics = summary
    ? [
        {
          label: 'Total calls',
          value: summary.totals.totalCalls.toLocaleString(),
          delta: <ChangeBadge pct={summary.totals.totalCallsChangePct} />,
          icon: Phone,
        },
        {
          label: 'Avg connect rate',
          value: `${summary.totals.connectRate}%`,
          delta: <ChangeBadge pct={summary.totals.connectRateChangePct} />,
          icon: Target,
        },
        {
          label: 'Total talk time',
          value: summary.totals.talkTimeFormatted,
          delta: <ChangeBadge pct={summary.totals.talkTimeChangePct} />,
          icon: Clock,
        },
        {
          label: 'Conversations / agent hr',
          value:
            summary.totals.conversationsPerAgentHour !== null
              ? summary.totals.conversationsPerAgentHour.toFixed(2)
              : '—',
          delta: <ChangeBadge pct={summary.totals.conversationsPerAgentHourChangePct} />,
          icon: Gauge,
        },
      ]
    : [];

  return (
    <div className="p-4 sm:p-8 max-w-[1440px] mx-auto">
      <PageHeader
        title="Analytics"
        description="Track your team's performance and insights"
        actions={
          <div className="flex items-center gap-1 bg-surface-1 rounded-app-md p-1 border border-border-subtle">
            {(['7d', '30d'] as Range[]).map((r) => (
              <Button
                key={r}
                size="sm"
                variant={range === r ? 'fe-secondary' : 'fe-ghost'}
                onClick={() => setRange(r)}
              >
                {r === '7d' ? 'Last 7 days' : 'Last 30 days'}
              </Button>
            ))}
          </div>
        }
      />

      {error && (
        <div className="mb-6 p-4 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
          {error}
        </div>
      )}

      {loading ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[110px] rounded-app-lg" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            <Skeleton className="lg:col-span-2 h-[380px] rounded-app-lg" />
            <Skeleton className="h-[380px] rounded-app-lg" />
          </div>
          <Skeleton className="h-[240px] rounded-app-lg" />
        </>
      ) : !hasData ? (
        <EmptyState
          icon={Phone}
          title="No calls in this range yet"
          body="Once your team starts dialing, real call volume, dispositions and agent performance will show up here."
        />
      ) : (
        summary && (
          <>
            {/* Key Metrics -- StatCard row, same shape as the Dashboard's. */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              {metrics.map((metric, index) => (
                <motion.div
                  key={metric.label}
                  initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04, duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
                >
                  <StatCard {...metric} />
                </motion.div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
              {/* Call Volume Chart */}
              <div className="lg:col-span-2 rounded-app-lg border border-border-subtle bg-surface-1 p-6 shadow-app-sm">
                <h2 className="text-section-title text-text-primary mb-6">
                  Call volume & performance
                </h2>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={summary.callVolumeData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="day" stroke="#B0BEC5" tick={{ fill: '#B0BEC5' }} />
                    <YAxis stroke="#B0BEC5" tick={{ fill: '#B0BEC5' }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1A2332',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '12px',
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                    <Legend
                      formatter={(value) => <span style={{ color: '#B0BEC5' }}>{value}</span>}
                    />
                    <Bar dataKey="calls" fill="#0066FF" name="Total Calls" radius={[8, 8, 0, 0]} />
                    <Bar
                      dataKey="connections"
                      fill="#00E676"
                      name="Connections"
                      radius={[8, 8, 0, 0]}
                    />
                    <Bar
                      dataKey="voicemails"
                      fill="#FFB300"
                      name="Voicemails"
                      radius={[8, 8, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Disposition Breakdown */}
              <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-6 shadow-app-sm">
                <h2 className="text-section-title text-text-primary mb-6">Call outcomes</h2>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={summary.dispositionBreakdown}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {summary.dispositionBreakdown.map((_, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={SLICE_COLORS[index % SLICE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1A2332',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '12px',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2 mt-4">
                  {summary.dispositionBreakdown.map((item, index) => (
                    <div key={item.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: SLICE_COLORS[index % SLICE_COLORS.length] }}
                        />
                        <span className="text-meta text-text-secondary">{item.name}</span>
                      </div>
                      <span className="text-meta font-semibold text-text-primary">
                        {item.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Agent Performance */}
            <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-6 shadow-app-sm">
              <h2 className="text-section-title text-text-primary mb-6">
                {summary.agentPerformance.length === 1 ? 'Your performance' : 'Top performers'}
              </h2>

              <div className="space-y-2">
                {summary.agentPerformance.map((agent, index) => (
                  <div
                    key={agent.agentId}
                    className="bg-surface-2 rounded-app-md p-4 border border-border-subtle"
                  >
                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-3 flex-1 min-w-[180px]">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-accent-from to-accent-to flex items-center justify-center text-white text-meta font-semibold flex-shrink-0">
                          #{index + 1}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-text-primary truncate">{agent.name}</div>
                          <div className="text-meta text-text-secondary">
                            {agent.calls} calls made
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-6">
                        <div>
                          <div className="text-meta text-text-secondary mb-0.5">Connections</div>
                          <div className="text-body font-semibold text-text-primary">
                            {agent.connections}
                          </div>
                        </div>
                        <div>
                          <div className="text-meta text-text-secondary mb-0.5">Connect rate</div>
                          <div className="text-body font-semibold text-success">{agent.rate}%</div>
                        </div>
                      </div>

                      <div className="w-32">
                        <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-accent-to to-success rounded-full"
                            style={{ width: `${agent.rate}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
