import { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
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

type Range = '7d' | '30d';

const SLICE_COLORS = ['#00E676', '#FFB300', '#B0BEC5', '#FF3D00', '#0066FF', '#00D9FF', '#9C27B0'];

function ChangeBadge({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const positive = pct >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  const color = positive ? '#00E676' : '#FF3D00';
  return (
    <div className="flex items-center gap-1 text-sm">
      <Icon className="w-4 h-4" style={{ color }} />
      <span style={{ color }}>
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

  return (
    <div className="p-8 max-w-[1440px] mx-auto">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Analytics</h1>
          <p className="text-[#B0BEC5]">Track your team's performance and insights</p>
        </div>
        <div className="flex items-center gap-2 bg-[#1A2332]/60 rounded-xl p-1 border border-white/5">
          {(['7d', '30d'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                range === r
                  ? 'bg-[#0066FF]/10 text-[#00D9FF] border-[#0066FF]/20 font-medium'
                  : 'text-[#B0BEC5] hover:bg-white/5 border-transparent'
              }`}
            >
              {r === '7d' ? 'Last 7 days' : 'Last 30 days'}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[126px] rounded-2xl" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
            <Skeleton className="lg:col-span-2 h-[380px] rounded-2xl" />
            <Skeleton className="h-[380px] rounded-2xl" />
          </div>
          <Skeleton className="h-[240px] rounded-2xl" />
        </>
      ) : !hasData ? (
        <div className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-12 border border-white/5 text-center">
          <Phone className="w-10 h-10 text-[#B0BEC5] mx-auto mb-4" />
          <div className="text-white font-medium mb-1">No calls in this range yet</div>
          <p className="text-sm text-[#B0BEC5]">
            Once your team starts dialing, real call volume, dispositions and agent performance will
            show up here.
          </p>
        </div>
      ) : (
        summary && (
          <>
            {/* Key Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
              {[
                {
                  label: 'Total Calls',
                  value: summary.totals.totalCalls.toLocaleString(),
                  change: summary.totals.totalCallsChangePct,
                  icon: Phone,
                  color: '#0066FF',
                },
                {
                  label: 'Avg Connect Rate',
                  value: `${summary.totals.connectRate}%`,
                  change: summary.totals.connectRateChangePct,
                  icon: Target,
                  color: '#00E676',
                },
                {
                  label: 'Total Talk Time',
                  value: summary.totals.talkTimeFormatted,
                  change: summary.totals.talkTimeChangePct,
                  icon: Clock,
                  color: '#FFB300',
                },
                {
                  label: 'Conversations / Agent Hour',
                  value:
                    summary.totals.conversationsPerAgentHour !== null
                      ? summary.totals.conversationsPerAgentHour.toFixed(2)
                      : '—',
                  change: summary.totals.conversationsPerAgentHourChangePct,
                  icon: Gauge,
                  color: '#00D9FF',
                },
              ].map((metric, index) => {
                const Icon = metric.icon;
                return (
                  <motion.div
                    key={metric.label}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                    className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 shadow-[0_4px_24px_rgba(0,102,255,0.15)]"
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div
                        className="w-12 h-12 rounded-xl flex items-center justify-center"
                        style={{ backgroundColor: `${metric.color}15` }}
                      >
                        <Icon className="w-6 h-6" style={{ color: metric.color }} />
                      </div>
                      <ChangeBadge pct={metric.change} />
                    </div>
                    <div className="text-3xl font-bold text-white mb-1">{metric.value}</div>
                    <div className="text-sm text-[#B0BEC5]">{metric.label}</div>
                  </motion.div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
              {/* Call Volume Chart */}
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.4 }}
                className="lg:col-span-2 bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 shadow-[0_4px_24px_rgba(0,102,255,0.15)]"
              >
                <h2 className="text-xl font-bold text-white mb-6">Call Volume & Performance</h2>
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
                    <Legend />
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
              </motion.div>

              {/* Disposition Breakdown */}
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.5 }}
                className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 shadow-[0_4px_24px_rgba(0,102,255,0.15)]"
              >
                <h2 className="text-xl font-bold text-white mb-6">Call Outcomes</h2>
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
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: SLICE_COLORS[index % SLICE_COLORS.length] }}
                        />
                        <span className="text-sm text-[#B0BEC5]">{item.name}</span>
                      </div>
                      <span className="text-sm font-semibold text-white">{item.value}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            </div>

            {/* Agent Performance */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 shadow-[0_4px_24px_rgba(0,102,255,0.15)]"
            >
              <h2 className="text-xl font-bold text-white mb-6">
                {summary.agentPerformance.length === 1 ? 'Your performance' : 'Top Performers'}
              </h2>

              <div className="space-y-3">
                {summary.agentPerformance.map((agent, index) => (
                  <div
                    key={agent.agentId}
                    className="bg-[#1E2A3A]/60 rounded-xl p-4 border border-white/5 hover:border-[#00D9FF]/30 transition-all"
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-3 flex-1">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#00D9FF] to-[#0066FF] flex items-center justify-center text-white font-semibold">
                          #{index + 1}
                        </div>
                        <div>
                          <div className="font-semibold text-white">{agent.name}</div>
                          <div className="text-sm text-[#B0BEC5]">{agent.calls} calls made</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-6">
                        <div>
                          <div className="text-sm text-[#B0BEC5] mb-1">Connections</div>
                          <div className="text-xl font-bold text-white">{agent.connections}</div>
                        </div>
                        <div>
                          <div className="text-sm text-[#B0BEC5] mb-1">Connect Rate</div>
                          <div className="text-xl font-bold text-[#00E676]">{agent.rate}%</div>
                        </div>
                      </div>

                      <div className="w-32">
                        <div className="h-2 bg-[#1E2A3A] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-[#00D9FF] to-[#00E676] rounded-full"
                            style={{ width: `${agent.rate}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </>
        )
      )}
    </div>
  );
}
