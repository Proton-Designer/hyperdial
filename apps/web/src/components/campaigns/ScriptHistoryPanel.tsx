import { useState } from 'react';
import { History, RotateCcw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  listCampaignScriptVersions,
  restoreCampaignScriptVersion,
  type CampaignScriptField,
  type CampaignScriptVersion,
} from '@/lib/api';

function truncate(s: string | null, n = 300): string {
  if (!s) return '(empty)';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** MISSION-5 TASK-M5-G3 (deferred backlog item): version history + restore for one campaign field
 *  (script_text or objection_sheet_text). Self-contained -- fetches its own list on expand, same
 *  "thin editor, server is the source of truth" model as this session's other panels.
 *  `canRestore` mirrors CampaignManageModal's own `canManage` (owner/admin) -- the server
 *  re-checks it independently regardless (restore_campaign_script_version's own gate), this only
 *  hides the button so an agent/manager viewer doesn't see a control that would 403. */
export function ScriptHistoryPanel({
  campaignId,
  field,
  canRestore,
  onRestored,
}: {
  campaignId: string;
  field: CampaignScriptField;
  canRestore: boolean;
  onRestored: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<CampaignScriptVersion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    listCampaignScriptVersions(campaignId, field)
      .then(setVersions)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load history'))
      .finally(() => setLoading(false));
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && versions === null) load();
  };

  const handleRestore = async (versionId: string) => {
    setRestoringId(versionId);
    try {
      await restoreCampaignScriptVersion(versionId);
      toast.success('Version restored');
      onRestored();
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to restore');
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-xs text-text-secondary hover:text-white"
      >
        <History className="w-3.5 h-3.5" />
        History
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-white/10 bg-surface-1 p-2 max-h-48 overflow-y-auto space-y-2">
          {loading && <p className="text-xs text-text-secondary">Loading…</p>}
          {error && <p className="text-xs text-danger">{error}</p>}
          {!loading && versions && versions.length === 0 && (
            <p className="text-xs text-text-secondary">No edits recorded yet.</p>
          )}
          {versions?.map((v) => (
            <div
              key={v.id}
              className="text-xs border-b border-white/5 pb-2 last:border-0 last:pb-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-white font-medium">
                  v{v.version} · {v.editedByName}
                </span>
                <span className="text-text-secondary">{new Date(v.editedAt).toLocaleString()}</span>
              </div>
              <p className="text-text-secondary/70 mt-1">
                {truncate(v.oldText)} → {truncate(v.newText)}
              </p>
              {canRestore && (
                <button
                  type="button"
                  onClick={() => handleRestore(v.id)}
                  disabled={restoringId === v.id}
                  className="mt-1 flex items-center gap-1 text-accent-to hover:underline disabled:opacity-60"
                >
                  {restoringId === v.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3 h-3" />
                  )}
                  Restore this version
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
