import { useEffect, useMemo, useState } from 'react';
import { Headphones, Flag, MessageSquare, ClipboardList, X } from 'lucide-react';
import {
  searchRecordings,
  getRecordingUrl,
  getRecordingFlag,
  flagRecording,
  unflagRecording,
  listRecordingComments,
  addRecordingComment,
  listScorecardRubrics,
  getCallScorecard,
  setCallScorecard,
  getMyScorecardTrend,
  listDispositionQualityFlags,
  setQualityFlagStatus,
  type RecordingSearchRow,
  type RecordingFlag,
  type RecordingComment,
  type ScorecardRubric,
  type CallScorecardView,
  type ScorecardTrendPoint,
  type DispositionQualityFlag,
  type QualityFlagStatus,
} from '@/lib/api';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useOrg } from '@/contexts/OrgContext';

const PAGE_SIZE = 25;

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

const selectClass =
  'bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary';
const inputClass =
  'bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary';

interface Filters {
  agentId: string;
  campaignId: string;
  dispositionKey: string;
  minMinutes: string;
  maxMinutes: string;
  start: string;
  end: string;
  flaggedOnly: boolean;
}

const EMPTY_FILTERS: Filters = {
  agentId: '',
  campaignId: '',
  dispositionKey: '',
  minMinutes: '',
  maxMinutes: '',
  start: '',
  end: '',
  flaggedOnly: false,
};

/**
 * MISSION-5 TASK-M5-B5: the call review library. Owner/admin see every recorded call; a manager
 * sees their own pod-scoped calls; an agent sees only their own -- all enforced server-side by
 * `recordings_search`/`can_view_call_leg`, this component never re-derives that scoping. Filter
 * dropdowns (agent/campaign/disposition) are derived from the currently-loaded result set, same
 * "only offer what's actually on screen" convention Team.tsx's own liveCampaignOptions/
 * livePodOptions already use -- they narrow as other filters narrow, which is an accepted
 * tradeoff there too.
 */
export function Recordings() {
  const { role } = useOrg();
  const isAgent = role === 'agent';
  const canScore = role === 'owner' || role === 'admin' || role === 'manager';

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<RecordingSearchRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = (nextOffset: number, append: boolean) => {
    setLoading(true);
    setError(null);
    const min = filters.minMinutes ? Math.round(Number(filters.minMinutes) * 60) : undefined;
    const max = filters.maxMinutes ? Math.round(Number(filters.maxMinutes) * 60) : undefined;
    const start = filters.start ? new Date(`${filters.start}T00:00:00`) : undefined;
    const end = filters.end ? new Date(`${filters.end}T00:00:00`) : undefined;
    if (end) end.setDate(end.getDate() + 1); // exclusive next-day boundary
    searchRecordings({
      agentId: filters.agentId || undefined,
      campaignId: filters.campaignId || undefined,
      dispositionKey: filters.dispositionKey || undefined,
      minDurationSeconds: min,
      maxDurationSeconds: max,
      start,
      end,
      flaggedOnly: filters.flaggedOnly,
      limit: PAGE_SIZE,
      offset: nextOffset,
    })
      .then((result) => {
        setRows((prev) => (append && prev ? [...prev, ...result] : result));
        setHasMore(result.length === PAGE_SIZE);
        setOffset(nextOffset);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load recordings'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.agentId,
    filters.campaignId,
    filters.dispositionKey,
    filters.minMinutes,
    filters.maxMinutes,
    filters.start,
    filters.end,
    filters.flaggedOnly,
  ]);

  const agentOptions = useMemo(() => {
    if (!rows) return [];
    const seen = new Map<string, string>();
    for (const r of rows) if (!seen.has(r.agent_id)) seen.set(r.agent_id, r.agent_name);
    return [...seen.entries()];
  }, [rows]);

  const campaignOptions = useMemo(() => {
    if (!rows) return [];
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.campaign_id && !seen.has(r.campaign_id)) {
        seen.set(r.campaign_id, r.campaign_name ?? r.campaign_id);
      }
    }
    return [...seen.entries()];
  }, [rows]);

  const dispositionOptions = useMemo(() => {
    if (!rows) return [];
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.disposition_key && !seen.has(r.disposition_key)) {
        seen.set(r.disposition_key, r.disposition_label ?? r.disposition_key);
      }
    }
    return [...seen.entries()];
  }, [rows]);

  const selectedRow = rows?.find((r) => r.call_leg_id === selectedId) ?? null;

  return (
    <div className="p-4 sm:p-8 max-w-[1440px] mx-auto">
      <PageHeader
        title="Recordings"
        description={
          isAgent
            ? 'Your own recorded calls -- flag one for review, add a note, or check your scorecards.'
            : 'Browse recorded calls, flag them for review, and score them against a rubric.'
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4 rounded-app-lg border border-border-subtle bg-surface-1 p-3">
        {!isAgent && (
          <select
            value={filters.agentId}
            onChange={(e) => setFilters((f) => ({ ...f, agentId: e.target.value }))}
            className={selectClass}
          >
            <option value="">All agents</option>
            {agentOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <select
          value={filters.campaignId}
          onChange={(e) => setFilters((f) => ({ ...f, campaignId: e.target.value }))}
          className={selectClass}
        >
          <option value="">All campaigns</option>
          {campaignOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={filters.dispositionKey}
          onChange={(e) => setFilters((f) => ({ ...f, dispositionKey: e.target.value }))}
          className={selectClass}
        >
          <option value="">All dispositions</option>
          {dispositionOptions.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          placeholder="Min min"
          value={filters.minMinutes}
          onChange={(e) => setFilters((f) => ({ ...f, minMinutes: e.target.value }))}
          className={`${inputClass} w-24`}
        />
        <input
          type="number"
          min={0}
          placeholder="Max min"
          value={filters.maxMinutes}
          onChange={(e) => setFilters((f) => ({ ...f, maxMinutes: e.target.value }))}
          className={`${inputClass} w-24`}
        />
        <input
          type="date"
          value={filters.start}
          onChange={(e) => setFilters((f) => ({ ...f, start: e.target.value }))}
          className={inputClass}
          title="From"
        />
        <input
          type="date"
          value={filters.end}
          onChange={(e) => setFilters((f) => ({ ...f, end: e.target.value }))}
          className={inputClass}
          title="To"
        />
        <label className="flex items-center gap-1.5 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={filters.flaggedOnly}
            onChange={(e) => setFilters((f) => ({ ...f, flaggedOnly: e.target.checked }))}
          />
          Flagged only
        </label>
        {(filters.agentId ||
          filters.campaignId ||
          filters.dispositionKey ||
          filters.minMinutes ||
          filters.maxMinutes ||
          filters.start ||
          filters.end ||
          filters.flaggedOnly) && (
          <Button size="sm" variant="fe-ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear filters
          </Button>
        )}
      </div>

      {error && <p className="text-meta text-danger mb-4">{error}</p>}

      {loading && !rows && (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-app-md" />
          ))}
        </div>
      )}

      {rows && rows.length === 0 && !loading && (
        <EmptyState
          icon={Headphones}
          title="No recordings found"
          body="Try widening your filters, or check back after some calls have been made."
        />
      )}

      {rows && rows.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4 items-start">
          <div className="rounded-app-lg border border-border-subtle bg-surface-1 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-text-secondary text-left">
                <tr>
                  {!isAgent && <th className="px-3 py-2 font-medium">Agent</th>}
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Disposition</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Ended</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.call_leg_id}
                    onClick={() => setSelectedId(r.call_leg_id)}
                    className={`border-t border-border-subtle cursor-pointer hover:bg-white/5 ${
                      selectedId === r.call_leg_id ? 'bg-accent-to/10' : ''
                    }`}
                  >
                    {!isAgent && <td className="px-3 py-2 text-text-primary">{r.agent_name}</td>}
                    <td className="px-3 py-2 text-text-secondary">{r.campaign_name ?? '—'}</td>
                    <td className="px-3 py-2 text-text-secondary">{r.disposition_label ?? '—'}</td>
                    <td className="px-3 py-2 text-text-secondary">
                      {formatDuration(r.duration_seconds)}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">{formatWhen(r.ended_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2 text-text-muted">
                        {r.is_flagged && <Flag className="w-3.5 h-3.5 text-danger" />}
                        {r.comment_count > 0 && (
                          <span className="flex items-center gap-0.5 text-meta">
                            <MessageSquare className="w-3.5 h-3.5" />
                            {r.comment_count}
                          </span>
                        )}
                        {r.has_scorecard && <ClipboardList className="w-3.5 h-3.5 text-success" />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hasMore && (
              <div className="p-3 flex justify-center border-t border-border-subtle">
                <Button
                  size="sm"
                  variant="fe-ghost"
                  disabled={loading}
                  onClick={() => load(offset + PAGE_SIZE, true)}
                >
                  {loading ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </div>

          {selectedRow && (
            <RecordingDetailPanel
              row={selectedRow}
              canScore={canScore}
              onClose={() => setSelectedId(null)}
              onFlagChanged={() => load(0, false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RecordingDetailPanel({
  row,
  canScore,
  onClose,
  onFlagChanged,
}: {
  row: RecordingSearchRow;
  canScore: boolean;
  onClose: () => void;
  onFlagChanged: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  const [flag, setFlag] = useState<RecordingFlag | null | 'loading'>('loading');
  const [flagReason, setFlagReason] = useState('');
  const [flagBusy, setFlagBusy] = useState(false);

  // TASK-M5-E7: automated disposition quality flags -- a DIFFERENT concept from the manual
  // `flag`/`flagReason` state above (recording_flags, anyone-can-flag-a-call). These come from
  // disposition_quality_rules (min talk time / required field), evaluated server-side, and are
  // reviewed (not un-flagged) via setQualityFlagStatus.
  const [qualityFlags, setQualityFlags] = useState<DispositionQualityFlag[] | 'loading' | 'error'>(
    'loading'
  );
  const [qualityFlagBusyId, setQualityFlagBusyId] = useState<string | null>(null);

  // TASK-Q3F: a real fetch failure used to be indistinguishable from "no quality flags" (both
  // rendered as an empty list, so the whole section -- heading included -- just didn't show up).
  // Kept as a standalone function so the Retry button below can re-run the exact same fetch.
  const loadQualityFlags = () => {
    setQualityFlags('loading');
    listDispositionQualityFlags({ callLegId: row.call_leg_id })
      .then(setQualityFlags)
      .catch(() => setQualityFlags('error'));
  };

  const [comments, setComments] = useState<RecordingComment[] | null>(null);
  const [commentText, setCommentText] = useState('');
  const [commentSecond, setCommentSecond] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);

  const [rubrics, setRubrics] = useState<ScorecardRubric[]>([]);
  const [scorecard, setScorecard] = useState<CallScorecardView | null | 'loading'>('loading');
  const [scoringRubricId, setScoringRubricId] = useState('');
  const [draftScores, setDraftScores] = useState<Record<string, number | boolean>>({});
  const [scoreBusy, setScoreBusy] = useState(false);
  const [scoreMessage, setScoreMessage] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setUrlError(null);
    getRecordingUrl(row.call_leg_id)
      .then((r) => setUrl(r.url))
      .catch((e) => setUrlError(e instanceof Error ? e.message : 'Recording not available'));

    setFlag('loading');
    setFlagReason('');
    getRecordingFlag(row.call_leg_id)
      .then(setFlag)
      .catch(() => setFlag(null));

    loadQualityFlags();

    setComments(null);
    listRecordingComments(row.call_leg_id)
      .then(setComments)
      .catch(() => setComments([]));

    setScorecard('loading');
    setScoringRubricId('');
    setDraftScores({});
    setScoreMessage(null);
    getCallScorecard(row.call_leg_id)
      .then(setScorecard)
      .catch(() => setScorecard(null));

    if (canScore && rubrics.length === 0) {
      listScorecardRubrics()
        .then(setRubrics)
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.call_leg_id]);

  const handleFlag = async () => {
    if (!flagReason.trim()) return;
    setFlagBusy(true);
    try {
      await flagRecording(row.call_leg_id, flagReason.trim());
      setFlag({ reason: flagReason.trim(), flaggedBy: null, createdAt: new Date().toISOString() });
      setFlagReason('');
      onFlagChanged();
    } finally {
      setFlagBusy(false);
    }
  };

  const handleUnflag = async () => {
    setFlagBusy(true);
    try {
      await unflagRecording(row.call_leg_id);
      setFlag(null);
      onFlagChanged();
    } finally {
      setFlagBusy(false);
    }
  };

  const handleSetQualityFlagStatus = async (flagId: string, status: QualityFlagStatus) => {
    setQualityFlagBusyId(flagId);
    try {
      await setQualityFlagStatus(flagId, status);
      const fresh = await listDispositionQualityFlags({ callLegId: row.call_leg_id });
      setQualityFlags(fresh);
    } finally {
      setQualityFlagBusyId(null);
    }
  };

  const handleAddComment = async () => {
    if (!commentText.trim()) return;
    setCommentBusy(true);
    try {
      const atSecond = commentSecond ? Math.round(Number(commentSecond)) : undefined;
      await addRecordingComment(row.call_leg_id, commentText.trim(), atSecond);
      const fresh = await listRecordingComments(row.call_leg_id);
      setComments(fresh);
      setCommentText('');
      setCommentSecond('');
    } finally {
      setCommentBusy(false);
    }
  };

  const selectedRubric = rubrics.find((r) => r.id === scoringRubricId) ?? null;

  const handleSaveScorecard = async () => {
    if (!selectedRubric) return;
    setScoreBusy(true);
    setScoreMessage(null);
    try {
      const scores = selectedRubric.criteria.map((c) => {
        const v = draftScores[c.id];
        return c.kind === 'scale_1_5'
          ? { criterionId: c.id, scoreValue: typeof v === 'number' ? v : 3 }
          : { criterionId: c.id, scoreBool: typeof v === 'boolean' ? v : false };
      });
      await setCallScorecard(row.call_leg_id, selectedRubric.id, scores);
      const fresh = await getCallScorecard(row.call_leg_id);
      setScorecard(fresh);
      setScoringRubricId('');
      setDraftScores({});
      setScoreMessage('Scorecard saved.');
    } catch (e) {
      setScoreMessage(e instanceof Error ? e.message : 'Failed to save scorecard');
    } finally {
      setScoreBusy(false);
    }
  };

  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 space-y-5 sticky top-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-body font-medium text-text-primary">{row.agent_name}</div>
          <div className="text-meta text-text-secondary">
            {row.campaign_name ?? '—'} · {formatWhen(row.ended_at)}
          </div>
        </div>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div>
        {url && <audio controls src={url} className="w-full h-9" />}
        {!url && urlError && <p className="text-meta text-text-secondary">{urlError}</p>}
        {!url && !urlError && <p className="text-meta text-text-secondary">Loading recording…</p>}
      </div>

      <div className="space-y-2">
        <h4 className="text-meta font-medium text-text-secondary uppercase tracking-wide">
          Flag for review
        </h4>
        {flag === 'loading' && <Skeleton className="h-8 w-full rounded-app-sm" />}
        {flag && flag !== 'loading' && (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-text-primary">
              <Flag className="w-3.5 h-3.5 inline mr-1 text-danger" />
              {flag.reason}
            </span>
            <Button size="sm" variant="fe-ghost" disabled={flagBusy} onClick={handleUnflag}>
              Unflag
            </Button>
          </div>
        )}
        {flag === null && (
          <div className="flex gap-2">
            <input
              value={flagReason}
              onChange={(e) => setFlagReason(e.target.value)}
              placeholder="Reason for flagging…"
              className={`${inputClass} flex-1`}
            />
            <Button size="sm" variant="fe-secondary" disabled={flagBusy} onClick={handleFlag}>
              Flag
            </Button>
          </div>
        )}
      </div>

      {(qualityFlags === 'loading' || qualityFlags === 'error' || qualityFlags.length > 0) && (
        <div className="space-y-2">
          <h4 className="text-meta font-medium text-text-secondary uppercase tracking-wide">
            Quality flags
          </h4>
          {qualityFlags === 'loading' && <Skeleton className="h-8 w-full rounded-app-sm" />}
          {qualityFlags === 'error' && (
            <div className="flex items-center justify-between gap-2 rounded-app-sm border border-danger/30 bg-danger/10 p-2 text-sm text-danger">
              <span>Couldn&apos;t load quality flags.</span>
              <button
                type="button"
                onClick={loadQualityFlags}
                className="underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          )}
          {qualityFlags !== 'loading' &&
            qualityFlags !== 'error' &&
            qualityFlags.map((qf) => (
              <div
                key={qf.id}
                className="rounded-app-sm border border-warning/20 bg-warning/5 p-2 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-text-primary">
                    {qf.rule_type === 'min_talk_seconds'
                      ? `Short call (${qf.detail.talk_seconds}s, needs ${qf.detail.min_required_seconds}s)`
                      : `Missing ${(qf.detail.missing_fields as string[]).join(', ')}`}
                  </span>
                  <span className="text-meta text-text-secondary capitalize">{qf.status}</span>
                </div>
                {canScore && qf.status === 'open' && (
                  <div className="flex gap-2 mt-2">
                    <Button
                      size="sm"
                      variant="fe-ghost"
                      disabled={qualityFlagBusyId === qf.id}
                      onClick={() => handleSetQualityFlagStatus(qf.id, 'reviewed_ok')}
                    >
                      Mark OK
                    </Button>
                    <Button
                      size="sm"
                      variant="fe-secondary"
                      disabled={qualityFlagBusyId === qf.id}
                      onClick={() => handleSetQualityFlagStatus(qf.id, 'coached')}
                    >
                      Coached
                    </Button>
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-meta font-medium text-text-secondary uppercase tracking-wide">
          Comments
        </h4>
        {comments === null && <Skeleton className="h-8 w-full rounded-app-sm" />}
        {comments && comments.length === 0 && (
          <p className="text-meta text-text-secondary">No comments yet.</p>
        )}
        {comments && comments.length > 0 && (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {comments.map((c) => (
              <div key={c.id} className="text-sm">
                <span className="text-text-muted text-meta">
                  {c.atSecond != null ? `${formatDuration(c.atSecond)} · ` : ''}
                  {formatWhen(c.createdAt)}
                </span>
                <p className="text-text-primary">{c.text}</p>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            placeholder="sec"
            value={commentSecond}
            onChange={(e) => setCommentSecond(e.target.value)}
            className={`${inputClass} w-16`}
          />
          <input
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Add a comment…"
            className={`${inputClass} flex-1`}
          />
          <Button
            size="sm"
            variant="fe-secondary"
            disabled={commentBusy}
            onClick={handleAddComment}
          >
            Post
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-meta font-medium text-text-secondary uppercase tracking-wide">
          Scorecard
        </h4>
        {scorecard === 'loading' && <Skeleton className="h-8 w-full rounded-app-sm" />}
        {scorecard && scorecard !== 'loading' && (
          <div className="rounded-app-sm border border-border-subtle p-2 space-y-1">
            <div className="text-sm text-text-primary font-medium">{scorecard.rubricName}</div>
            {scorecard.scores.map((s) => (
              <div key={s.criterionId} className="flex items-center justify-between text-meta">
                <span className="text-text-secondary">{s.label}</span>
                <span className="text-text-primary">
                  {s.kind === 'scale_1_5' ? `${s.scoreValue}/5` : s.scoreBool ? 'Yes' : 'No'}
                </span>
              </div>
            ))}
          </div>
        )}
        {scorecard === null && <p className="text-meta text-text-secondary">Not yet scored.</p>}
        {canScore && (
          <div className="space-y-2 pt-1">
            <select
              value={scoringRubricId}
              onChange={(e) => {
                setScoringRubricId(e.target.value);
                setDraftScores({});
              }}
              className={`${selectClass} w-full`}
            >
              <option value="">
                {scorecard && scorecard !== 'loading' ? 'Re-score with…' : 'Score with a rubric…'}
              </option>
              {rubrics.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            {selectedRubric && (
              <div className="space-y-2">
                {selectedRubric.criteria.map((c) => (
                  <div key={c.id} className="flex items-center justify-between text-sm">
                    <span className="text-text-secondary">{c.label}</span>
                    {c.kind === 'scale_1_5' ? (
                      <div className="flex gap-1">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setDraftScores((d) => ({ ...d, [c.id]: n }))}
                            className={`w-6 h-6 rounded-app-sm text-meta border ${
                              draftScores[c.id] === n
                                ? 'bg-accent-to text-white border-accent-to'
                                : 'border-white/10 text-text-secondary'
                            }`}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        {[
                          { label: 'Yes', value: true },
                          { label: 'No', value: false },
                        ].map((opt) => (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() => setDraftScores((d) => ({ ...d, [c.id]: opt.value }))}
                            className={`px-2 py-0.5 rounded-app-sm text-meta border ${
                              draftScores[c.id] === opt.value
                                ? 'bg-accent-to text-white border-accent-to'
                                : 'border-white/10 text-text-secondary'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="fe-secondary"
                  disabled={scoreBusy}
                  onClick={handleSaveScorecard}
                >
                  {scoreBusy ? 'Saving…' : 'Save scorecard'}
                </Button>
              </div>
            )}
            {scoreMessage && <p className="text-meta text-text-secondary">{scoreMessage}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Small self-contained widget for Dashboard.tsx's My stats card -- the agent's own scorecard
 *  trend, oldest to newest. Renders nothing if the agent has never been scored (no empty-state
 *  noise on a card that already has several other sections). */
export function MyScorecardTrendMini() {
  const [trend, setTrend] = useState<ScorecardTrendPoint[] | null>(null);

  useEffect(() => {
    getMyScorecardTrend()
      .then(setTrend)
      .catch(() => setTrend([]));
  }, []);

  if (!trend || trend.length === 0) return null;

  const latest = trend[trend.length - 1];
  const avg = Math.round(trend.reduce((s, p) => s + p.scorePct, 0) / trend.length);

  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
      <h3 className="text-meta font-medium text-text-secondary uppercase tracking-wide mb-2">
        Scorecard trend
      </h3>
      <div className="flex items-baseline gap-4">
        <div>
          <div className="text-page-title text-text-primary">{latest.scorePct}%</div>
          <div className="text-meta text-text-secondary">Latest score</div>
        </div>
        <div>
          <div className="text-body text-text-primary">{avg}%</div>
          <div className="text-meta text-text-secondary">Average ({trend.length} scored)</div>
        </div>
      </div>
    </div>
  );
}
