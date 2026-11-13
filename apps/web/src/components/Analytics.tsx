import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { TrendingUp, TrendingDown, Phone, Clock, Target, Gauge, Download } from 'lucide-react';
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
import {
  getAnalyticsSummary,
  getFunnelSummary,
  getCampaignDropRateSummary,
  getAnswerRateHeatmap,
  getConnectRateByNumber,
  getConnectRateByHour,
  listCampaigns,
  logAuditEvent,
  type AnalyticsSummary,
  type FunnelSummary,
  type DropRateSummary,
  type AnswerRateHeatmapCell,
  type ConnectRateByNumberRow,
  type ConnectRateByHourRow,
  type CampaignWithStats,
} from '@/lib/api';
import { rowsToCsv, downloadCsv } from '@/lib/csv';
import { cn } from '@/components/ui/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/PageHeader';
import { StatCard } from '@/components/app/StatCard';
import { EmptyState } from '@/components/app/EmptyState';

type Range = '7d' | '30d';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function resolveDateRange(range: Range): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date(end.getTime() - (range === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000);
  return { start, end };
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

/** MISSION-4 TASK-T11 (ADM-8 + NEW): per-campaign funnel + best-time-to-call heatmap + connect
 *  rate by number/hour -- fetched independently of the main `summary` above (its own loading
 *  state), so a slow funnel query never blocks the existing StatCard row from rendering. Owner/
 *  admin see every section; an agent only sees the funnel + heatmap (both RPCs scope those to the
 *  caller's own legs for a non-admin) -- the two connect-rate RPCs return empty for an agent, so
 *  those two cards are simply omitted rather than shown empty. */
/** MISSION-4 TASK-T8: the drop-rate card's own guideline threshold -- a fraction of human answers
 *  hung up before connecting (dropped/abandoned) above this is worth a manager's attention. Not
 *  a hard limit, just a visual nudge (REQ-1's own "3% guideline warning" wording). */
const DROP_RATE_WARNING_PCT = 3;

function FunnelAndInsights({ start, end }: { start: Date; end: Date }) {
  const [campaigns, setCampaigns] = useState<CampaignWithStats[]>([]);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [funnel, setFunnel] = useState<FunnelSummary | null>(null);
  const [dropRate, setDropRate] = useState<DropRateSummary | null>(null);
  const [heatmap, setHeatmap] = useState<AnswerRateHeatmapCell[] | null>(null);
  const [byNumber, setByNumber] = useState<ConnectRateByNumberRow[] | null>(null);
  const [byHour, setByHour] = useState<ConnectRateByHourRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    listCampaigns()
      .then(setCampaigns)
      .catch(() => setCampaigns([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    // TASK-T8: the drop-rate card is always trailing 30 DAYS ("a per-campaign 30-day drop
    // rate", REQ-1's own words), independent of this page's own 7d/30d range toggle above it --
    // computed fresh each fetch, not reusing `start`/`end` (which can be a 7-day window).
    const dropRateEnd = new Date();
    const dropRateStart = new Date(dropRateEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    Promise.all([
      getFunnelSummary(campaignId, start, end),
      getCampaignDropRateSummary(campaignId, dropRateStart, dropRateEnd),
      getAnswerRateHeatmap(campaignId, start, end),
      getConnectRateByNumber(start, end).catch(() => []),
      getConnectRateByHour(start, end).catch(() => []),
    ])
      .then(([f, d, h, n, byh]) => {
        setFunnel(f);
        setDropRate(d);
        setHeatmap(h);
        setByNumber(n);
        setByHour(byh);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [campaignId, start, end]);

  const heatCellRate = useMemo(() => {
    const grid = new Map<string, number>();
    (heatmap ?? []).forEach((c) =>
      grid.set(`${c.weekday}-${c.hour}`, rate(c.human_answers, c.dials))
    );
    return (weekday: number, hour: number) => grid.get(`${weekday}-${hour}`) ?? null;
  }, [heatmap]);

  const handleExportFunnelCsv = () => {
    if (!funnel) return;
    const campaignLabel = campaigns.find((c) => c.id === campaignId)?.name ?? 'All campaigns';
    const csv = rowsToCsv(
      [
        { key: 'stage' as const, label: 'Stage' },
        { key: 'count' as const, label: 'Count' },
        { key: 'ratePct' as const, label: 'Rate vs. dials (%)' },
      ],
      [
        { stage: `Dials (${campaignLabel})`, count: funnel.dials, ratePct: 100 },
        {
          stage: 'Human answers',
          count: funnel.human_answers,
          ratePct: rate(funnel.human_answers, funnel.dials),
        },
        {
          stage: 'Conversations (>=30s)',
          count: funnel.conversations,
          ratePct: rate(funnel.conversations, funnel.dials),
        },
        { stage: 'Wins', count: funnel.wins, ratePct: rate(funnel.wins, funnel.dials) },
      ]
    );
    downloadCsv(
      `funnel-${campaignLabel.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`,
      csv
    );
    void logAuditEvent('export.analytics_csv', { campaignId: campaignId ?? 'all' });
  };

  if (loading) return <Skeleton className="h-[200px] rounded-app-lg mb-8" />;
  if (loadError) {
    return (
      <div className="mb-8 p-4 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
        {loadError}
      </div>
    );
  }

  return (
    <div className="space-y-6 mb-8">
      {/* Funnel */}
      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-6 shadow-app-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <h2 className="text-section-title text-text-primary">Funnel</h2>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <select
              value={campaignId ?? '__all__'}
              onChange={(e) => setCampaignId(e.target.value === '__all__' ? null : e.target.value)}
              className="min-w-0 max-w-full bg-surface-2 border border-border-subtle rounded-app-md px-3 py-2 text-meta text-text-primary"
            >
              <option value="__all__">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="fe-ghost"
              onClick={handleExportFunnelCsv}
              disabled={!funnel || funnel.dials === 0}
              title="Export the funnel as CSV"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </Button>
          </div>
        </div>
        {!funnel || funnel.dials === 0 ? (
          <p className="text-meta text-text-secondary">No dials in this range.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {(
              [
                { label: 'Dials', count: funnel.dials, pct: 100 },
                {
                  label: 'Human answers',
                  count: funnel.human_answers,
                  pct: rate(funnel.human_answers, funnel.dials),
                },
                {
                  label: 'Conversations',
                  count: funnel.conversations,
                  pct: rate(funnel.conversations, funnel.dials),
                },
                { label: 'Wins', count: funnel.wins, pct: rate(funnel.wins, funnel.dials) },
              ] as const
            ).map((stage) => (
              <div key={stage.label} className="bg-surface-2 rounded-app-md p-4">
                <div className="text-meta text-text-secondary mb-1">{stage.label}</div>
                <div className="text-page-title font-semibold text-text-primary">
                  {stage.count.toLocaleString()}
                </div>
                <div className="text-meta text-text-secondary">{stage.pct}% of dials</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MISSION-4 TASK-T8: drop rate, always trailing 30 days regardless of the page's own
          range toggle above -- see this card's own fetch comment. */}
      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-6 shadow-app-sm">
        <h2 className="text-section-title text-text-primary mb-1">Drop rate (last 30 days)</h2>
        <p className="text-meta text-text-secondary mb-4">
          Human answers that were hung up before connecting -- another line won the race.
        </p>
        {!dropRate || dropRate.human_answers === 0 ? (
          <p className="text-meta text-text-secondary">No human answers in the last 30 days.</p>
        ) : (
          <>
            {dropRate.drop_rate_pct > DROP_RATE_WARNING_PCT && (
              <div className="mb-4 p-3 rounded-app-md bg-warning-soft border border-warning/30 text-warning text-body">
                {dropRate.drop_rate_pct}% is above the {DROP_RATE_WARNING_PCT}% guideline --
                consider adding a line or lowering lines-per-agent for this campaign.
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div className="bg-surface-2 rounded-app-md p-4">
                <div className="text-meta text-text-secondary mb-1">Drop rate</div>
                <div
                  className={cn(
                    'text-page-title font-semibold',
                    dropRate.drop_rate_pct > DROP_RATE_WARNING_PCT
                      ? 'text-warning'
                      : 'text-text-primary'
                  )}
                >
                  {dropRate.drop_rate_pct}%
                </div>
              </div>
              <div className="bg-surface-2 rounded-app-md p-4">
                <div className="text-meta text-text-secondary mb-1">Dropped</div>
                <div className="text-page-title font-semibold text-text-primary">
                  {dropRate.dropped.toLocaleString()}
                </div>
              </div>
              <div className="bg-surface-2 rounded-app-md p-4">
                <div className="text-meta text-text-secondary mb-1">Human answers</div>
                <div className="text-page-title font-semibold text-text-primary">
                  {dropRate.human_answers.toLocaleString()}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Best-time-to-call heatmap (contact-local time) */}
      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-6 shadow-app-sm overflow-x-auto">
        <h2 className="text-section-title text-text-primary mb-6">
          Best time to call (contact's local time)
        </h2>
        {!heatmap || heatmap.length === 0 ? (
          <p className="text-meta text-text-secondary">No dials in this range.</p>
        ) : (
          <>
            <p className="text-meta text-text-muted mb-2 md:hidden">
              Swipe sideways to see all 24 hours.
            </p>
            <table className="text-meta border-collapse">
              <thead>
                <tr>
                  <th className="p-1" />
                  {Array.from({ length: 24 }).map((_, h) => (
                    <th key={h} className="p-1 font-normal text-text-secondary text-center w-8">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {WEEKDAY_LABELS.map((label, weekday) => (
                  <tr key={label}>
                    <td className="p-1 pr-2 text-text-secondary whitespace-nowrap">{label}</td>
                    {Array.from({ length: 24 }).map((_, hour) => {
                      const r = heatCellRate(weekday, hour);
                      return (
                        <td key={hour} className="p-0.5">
                          <div
                            className="w-8 h-6 rounded-app-sm"
                            title={r === null ? 'No data' : `${r}% human-answer rate`}
                            style={{
                              backgroundColor:
                                r === null
                                  ? 'rgba(255,255,255,0.03)'
                                  : `rgba(0,230,118,${r / 100})`,
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* Connect rate by caller-ID number + by hour (owner/admin only -- the RPCs return empty
          for an agent, so these two cards are simply omitted rather than shown blank). */}
      {((byNumber && byNumber.length > 0) || (byHour && byHour.length > 0)) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {byNumber && byNumber.length > 0 && (
            <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-6 shadow-app-sm">
              <h2 className="text-section-title text-text-primary mb-4">
                Connect rate by caller-ID number
              </h2>
              <div className="space-y-2">
                {byNumber.map((row) => (
                  <div
                    key={row.from_number_id ?? 'default'}
                    className="flex items-center justify-between bg-surface-2 rounded-app-md p-3"
                  >
                    <span className="text-body text-text-primary">
                      {row.phone_number ?? 'Campaign default'}
                    </span>
                    <span className="text-body font-semibold text-success">
                      {rate(row.human_answers, row.dials)}%{' '}
                      <span className="text-text-secondary font-normal">
                        ({row.dials.toLocaleString()} dials)
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {byHour && byHour.length > 0 && (
            <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-6 shadow-app-sm">
              <h2 className="text-section-title text-text-primary mb-4">
                Connect rate by hour (server time)
              </h2>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={byHour.map((r) => ({ hour: r.hour, rate: rate(r.human_answers, r.dials) }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="hour" stroke="#B0BEC5" tick={{ fill: '#B0BEC5' }} />
                  <YAxis
                    stroke="#B0BEC5"
                    tick={{ fill: '#B0BEC5' }}
                    allowDecimals={false}
                    unit="%"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1A2332',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '12px',
                    }}
                    itemStyle={{ color: '#fff' }}
                  />
                  <Bar dataKey="rate" fill="#0066FF" name="Connect rate %" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const { start: funnelStart, end: funnelEnd } = useMemo(() => resolveDateRange(range), [range]);

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
    <div className="hd-touch p-4 sm:p-8 max-w-[1440px] mx-auto">
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
                    <XAxis dataKey="day" interval={0} stroke="#B0BEC5" tick={{ fill: '#B0BEC5' }} />
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

            {/* MISSION-4 TASK-T11: funnel + best-time-to-call heatmap + connect rate by number/
                hour -- fetched independently of `summary` above, own loading/error state. */}
            <FunnelAndInsights start={funnelStart} end={funnelEnd} />
          </>
        )
      )}
    </div>
  );
}
