import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
  getGhlReconcileSettings,
  listGhlPipelineStages,
  updateGhlReconcileSettings,
  type GhlPipelineStageOption,
  type GhlReconcileSettings,
} from '@/lib/api';

/** One-line summary of the last sweep's counts (`{ error }` when it failed). */
function summarizeCounts(counts: Record<string, unknown> | null): {
  text: string;
  failed: boolean;
} {
  if (!counts) return { text: '', failed: false };
  if (typeof counts.error === 'string') return { text: counts.error, failed: true };
  const checked = Number(counts.checked ?? 0);
  const applied = (counts.applied ?? null) as Record<string, number> | null;
  const moved = applied ? Number(applied.leads_moved ?? 0) : 0;
  const dnc = applied ? Number(applied.dnc_contacts ?? 0) : 0;
  return {
    text: `${checked} checked, ${moved} lead${moved === 1 ? '' : 's'} removed${dnc > 0 ? `, ${dnc} marked do-not-call` : ''}`,
    failed: false,
  };
}

const sameList = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * TASK-G12: Settings -> GoHighLevel -> "Remove from call lists". Owner/admin only (the parent
 * renders it only for them; the endpoint enforces it too). The master switch, the "signed up /
 * active" tags and pipeline stages, and the last sweep's result.
 */
export function GhlReconcileCard() {
  const [saved, setSaved] = useState<GhlReconcileSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [stages, setStages] = useState<GhlPipelineStageOption[] | null>(null);
  const [stagesError, setStagesError] = useState<string | null>(null);
  const [loadingStages, setLoadingStages] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const apply = useCallback((s: GhlReconcileSettings) => {
    setSaved(s);
    setEnabled(s.enabled);
    setTags(s.excludeTags);
    setStageIds(s.excludeStageIds);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      apply(await getGhlReconcileSettings());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load call-list settings');
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const stageLabel = useMemo(() => {
    const map = new Map(
      (stages ?? []).map((s) => [s.stageId, `${s.pipelineName} / ${s.stageName}`])
    );
    return (id: string) => map.get(id) ?? id;
  }, [stages]);

  const loadStages = async () => {
    setLoadingStages(true);
    setStagesError(null);
    try {
      setStages(await listGhlPipelineStages());
    } catch (e) {
      setStagesError(e instanceof Error ? e.message : 'Failed to fetch GHL pipelines');
    } finally {
      setLoadingStages(false);
    }
  };

  const addTag = () => {
    const t = tagDraft.trim();
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) setTags([...tags, t]);
    setTagDraft('');
  };

  const dirty =
    saved !== null &&
    (enabled !== saved.enabled ||
      !sameList(tags, saved.excludeTags) ||
      !sameList(stageIds, saved.excludeStageIds));

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      apply(
        await updateGhlReconcileSettings({ enabled, excludeTags: tags, excludeStageIds: stageIds })
      );
      setJustSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const last = summarizeCounts(saved?.lastReconcileCounts ?? null);

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-xl mt-6">
      <h3 className="text-white font-medium mb-1">Remove from call lists</h3>
      <p className="text-sm text-text-secondary mb-4">
        Every 5 minutes HyperDial checks the GoHighLevel contacts of leads still waiting to be
        called. A contact marked Do Not Disturb (calls) or carrying one of your do-not-call tags
        becomes do-not-call here and drops off the list. Contacts with a signed-up or active tag or
        stage below are marked completed. Off by default.
      </p>

      {!saved && !loadError && (
        <div className="flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      )}

      {loadError && (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-danger">{loadError}</p>
          <button type="button" onClick={load} className="text-xs text-accent-to hover:underline">
            Try again
          </button>
        </div>
      )}

      {saved && (
        <>
          <label className="flex items-center gap-2 mb-4">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span className="text-sm text-white">Remove these contacts from call lists</span>
          </label>

          <div className="mb-4">
            <label htmlFor="ghl-exclude-tag" className="block text-sm text-text-secondary mb-1">
              Signed-up / active tags
            </label>
            <p className="text-xs text-text-secondary mb-2">
              A contact with any of these GoHighLevel tags is taken off call lists.
            </p>
            <div className="flex flex-wrap gap-2 mb-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-surface-2 border border-white/10 text-white"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => setTags(tags.filter((t) => t !== tag))}
                    className="text-text-secondary hover:text-danger"
                    aria-label={`Remove ${tag}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {tags.length === 0 && <span className="text-xs text-text-muted">None</span>}
            </div>
            <div className="flex gap-2">
              <input
                id="ghl-exclude-tag"
                type="text"
                value={tagDraft}
                maxLength={100}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder="e.g. signed up"
                className="flex-1 min-w-0 px-3 py-2 bg-surface-2 border border-white/10 rounded-app text-sm text-white"
              />
              <button
                type="button"
                onClick={addTag}
                className="px-3 py-2 rounded-app text-sm bg-surface-2 border border-white/10 text-white"
              >
                Add
              </button>
            </div>
          </div>

          <div className="mb-4">
            <p className="block text-sm text-text-secondary mb-1">Signed-up / active stages</p>
            <p className="text-xs text-text-secondary mb-2">
              A contact with an opportunity in any of these pipeline stages is taken off call lists.
            </p>
            <div className="flex flex-wrap gap-2 mb-2">
              {stageIds.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-surface-2 border border-white/10 text-white"
                >
                  {stageLabel(id)}
                  <button
                    type="button"
                    onClick={() => setStageIds(stageIds.filter((s) => s !== id))}
                    className="text-text-secondary hover:text-danger"
                    aria-label={`Remove stage ${stageLabel(id)}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {stageIds.length === 0 && <span className="text-xs text-text-muted">None</span>}
            </div>
            {stages === null ? (
              <button
                type="button"
                onClick={loadStages}
                disabled={loadingStages}
                className="text-xs text-accent-to hover:underline disabled:opacity-50"
              >
                {loadingStages ? 'Loading pipelines...' : 'Choose stages from GoHighLevel'}
              </button>
            ) : stages.length === 0 ? (
              <p className="text-xs text-text-muted">No pipeline stages found in GoHighLevel.</p>
            ) : (
              <select
                aria-label="Add a pipeline stage"
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (id && !stageIds.includes(id)) setStageIds([...stageIds, id]);
                }}
                className="w-full px-3 py-2 bg-surface-2 border border-white/10 rounded-app text-sm text-white"
              >
                <option value="">Add a stage...</option>
                {stages
                  .filter((s) => !stageIds.includes(s.stageId))
                  .map((s) => (
                    <option key={s.stageId} value={s.stageId}>
                      {s.pipelineName} / {s.stageName}
                    </option>
                  ))}
              </select>
            )}
            {stagesError && (
              <p className="text-xs text-danger mt-1" role="alert">
                {stagesError}
              </p>
            )}
          </div>

          <p className="text-xs text-text-muted mb-4">
            {saved.lastReconcileAt ? (
              <>
                Last check {new Date(saved.lastReconcileAt).toLocaleString()}
                {last.text && (
                  <>
                    {' -- '}
                    <span className={last.failed ? 'text-danger' : 'text-success'}>
                      {last.text}
                    </span>
                  </>
                )}
              </>
            ) : (
              'Has not run yet.'
            )}
          </p>

          {saveError && (
            <p className="text-sm text-danger mb-3" role="alert">
              {saveError}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="px-4 py-2 rounded-app text-sm text-white bg-gradient-to-r from-accent-from to-accent-to disabled:opacity-50 inline-flex items-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Save
            </button>
            {justSaved && !dirty && <span className="text-xs text-success">Saved</span>}
          </div>
        </>
      )}
    </div>
  );
}
