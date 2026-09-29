import { useCallback, useEffect, useState } from 'react';
import { Inbox as InboxIcon, Phone, Check, X, RotateCcw, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  listInboxItems,
  claimInboxItem,
  unclaimInboxItem,
  markInboxItemDone,
  dismissInboxItem,
  getSharedInboxSettings,
  setSharedInboxSettings,
  listOrgMembers,
  type InboxItem,
  type OrgMember,
} from '@/lib/api';
import { setPendingManualDialNumber } from '@/lib/dialerLaunchIntent';
import { useVisibilityPacedPolling } from '@/hooks/useVisibilityPacedPolling';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useOrg } from '@/contexts/OrgContext';
import { useAuth } from '@/contexts/AuthContext';

const POLL_MS = 20000;

const STATUS_LABEL: Record<InboxItem['status'], string> = {
  open: 'Open',
  claimed: 'Claimed',
  done: 'Done',
  dismissed: 'Dismissed',
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface InboxProps {
  onNavigateToDialer: () => void;
}

/**
 * MISSION-5 TASK-M5-G6: the shared team callback inbox. Every visibility/authorization decision
 * (who sees which items, who can claim/unclaim/done/dismiss) is enforced server-side
 * (`private.can_view_inbox_item`, the write RPCs' own role checks) -- this component only hides
 * actions the caller almost certainly can't use, as a UX nicety; it never trusts the client for
 * scope, and a hidden-but-attempted action still fails cleanly server-side with the RPC's own
 * message (see handleAction's catch).
 */
export function Inbox({ onNavigateToDialer }: InboxProps) {
  const { role } = useOrg();
  const { user } = useAuth();
  const isManagerOrBetter = role === 'owner' || role === 'admin' || role === 'manager';
  // G6 review (eng1): set_shared_inbox_settings is owner/admin only, so the settings card is too.
  const canEditSettings = role === 'owner' || role === 'admin';

  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [sharedInboxEnabled, setSharedInboxEnabled] = useState(false);
  const [claimStaleMinutes, setClaimStaleMinutes] = useState(30);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const refresh = useCallback(() => {
    listInboxItems()
      .then((rows) => {
        setItems(rows);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load inbox'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  // TASK-M5-L1 (EC-9): paused while the tab is hidden, refreshed immediately on becoming
  // visible, backs off 20s->120s->240s on an error streak.
  useVisibilityPacedPolling(refresh, POLL_MS, error !== null);

  // Best-effort display names only -- a manager's own roster call is already pod-scoped
  // server-side, so a cross-pod item's target agent may not resolve to a name here; falls back
  // to showing nothing rather than guessing.
  useEffect(() => {
    listOrgMembers()
      .then(setMembers)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!canEditSettings) return;
    getSharedInboxSettings()
      .then((s) => {
        setSharedInboxEnabled(s.sharedInboxEnabled);
        setClaimStaleMinutes(s.claimStaleMinutes);
      })
      // TASK-Q3F: a silent failure here left the card showing its INITIAL state values (off,
      // 30 minutes), indistinguishable from the real saved settings -- an admin could then hit
      // Save and overwrite the real settings with those defaults. Surfaced, since Save depends
      // on this having actually loaded.
      .catch(() => toast.error('Failed to load shared inbox settings -- reload before saving.'));
  }, [canEditSettings]);

  const nameFor = (userId: string | null): string | null => {
    if (!userId) return null;
    const m = members.find((m) => m.user_id === userId);
    if (!m) return null;
    const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
    return name || m.email || null;
  };

  const handleAction = (id: string, action: () => Promise<void>, successMessage: string) => {
    setActioningId(id);
    action()
      .then(() => {
        toast.success(successMessage);
        refresh();
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Action failed'))
      .finally(() => setActioningId(null));
  };

  const handleCallBack = (item: InboxItem) => {
    setPendingManualDialNumber(item.fromE164);
    onNavigateToDialer();
  };

  const handleCopyNumber = (e164: string) => {
    navigator.clipboard
      .writeText(e164)
      .then(() => toast.success('Number copied'))
      .catch(() => toast.error('Could not copy number'));
  };

  const handleSaveSettings = () => {
    setSettingsSaving(true);
    setSharedInboxSettings({ sharedInboxEnabled, claimStaleMinutes })
      .then(() => toast.success('Shared inbox settings saved'))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to save settings'))
      .finally(() => setSettingsSaving(false));
  };

  const openCount = items?.filter((i) => i.status === 'open').length ?? 0;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        title="Inbox"
        description="Missed calls and voicemails the team hasn't followed up on yet."
        actions={
          openCount > 0 ? (
            <Badge variant="destructive">
              {openCount} open{openCount === 1 ? '' : ''}
            </Badge>
          ) : undefined
        }
      />

      {canEditSettings && (
        <div className="mb-6 rounded-app-lg border border-border-subtle bg-surface-1 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-body font-medium text-text-primary">
                Let agents see each other's missed calls
              </div>
              <p className="text-sm text-text-secondary mt-0.5">
                When on, any agent can see and claim an unclaimed item, not just their own. A claim
                goes back to open after {claimStaleMinutes} minutes of inactivity.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <input
                type="number"
                min={1}
                value={claimStaleMinutes}
                onChange={(e) => setClaimStaleMinutes(Math.max(1, Number(e.target.value) || 1))}
                className="w-16 bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary"
                aria-label="Claim stale minutes"
              />
              <Button
                variant={sharedInboxEnabled ? 'primary' : 'fe-secondary'}
                size="sm"
                onClick={() => setSharedInboxEnabled((v) => !v)}
              >
                {sharedInboxEnabled ? 'On' : 'Off'}
              </Button>
              <Button size="sm" onClick={handleSaveSettings} disabled={settingsSaving}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-app-lg" />
          ))}
        </div>
      )}

      {!loading && error && (
        <EmptyState icon={InboxIcon} title="Couldn't load the inbox" body={error} />
      )}

      {!loading && !error && items && items.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          title="Nothing here"
          body="Missed calls and voicemails that need a follow-up will show up here."
        />
      )}

      {!loading && !error && items && items.length > 0 && (
        <div className="space-y-2">
          {items.map((item) => {
            const claimerName = nameFor(item.claimedBy);
            const targetName = nameFor(item.targetAgentId);
            const isMyClaim = item.claimedBy === user?.id;
            const canActOnClaim = isMyClaim || isManagerOrBetter;
            const busy = actioningId === item.id;

            return (
              <div
                key={item.id}
                className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 flex flex-col sm:flex-row sm:items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-body font-medium text-text-primary">{item.fromE164}</span>
                    <Badge
                      variant={
                        item.status === 'open'
                          ? 'destructive'
                          : item.status === 'claimed'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {STATUS_LABEL[item.status]}
                    </Badge>
                    {item.repeatCount > 1 && <Badge variant="outline">{item.repeatCount}x</Badge>}
                    {item.contactId && <Badge variant="outline">Contact on file</Badge>}
                  </div>
                  <p className="text-sm text-text-secondary mt-1">
                    {targetName ? `For ${targetName} · ` : ''}
                    Last call {formatWhen(item.lastReceivedAt)}
                    {item.status === 'claimed' && claimerName ? ` · Claimed by ${claimerName}` : ''}
                  </p>
                  {item.note && (
                    <p className="text-sm text-text-secondary mt-1 italic">"{item.note}"</p>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
                  <Button variant="fe-secondary" size="sm" onClick={() => handleCallBack(item)}>
                    <Phone className="w-3.5 h-3.5" />
                    Call back
                  </Button>
                  <Button
                    variant="fe-ghost"
                    size="sm"
                    onClick={() => handleCopyNumber(item.fromE164)}
                    aria-label="Copy number"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </Button>

                  {item.status === 'open' && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        handleAction(item.id, () => claimInboxItem(item.id), 'Claimed')
                      }
                    >
                      Claim
                    </Button>
                  )}

                  {item.status === 'claimed' && canActOnClaim && (
                    <Button
                      variant="fe-secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        handleAction(item.id, () => unclaimInboxItem(item.id), 'Unclaimed')
                      }
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Unclaim
                    </Button>
                  )}

                  {(item.status === 'open' || item.status === 'claimed') && canActOnClaim && (
                    <Button
                      variant="fe-secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        handleAction(item.id, () => markInboxItemDone(item.id), 'Marked done')
                      }
                    >
                      <Check className="w-3.5 h-3.5" />
                      Done
                    </Button>
                  )}

                  {(item.status === 'open' || item.status === 'claimed') && isManagerOrBetter && (
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        handleAction(item.id, () => dismissInboxItem(item.id), 'Dismissed')
                      }
                    >
                      <X className="w-3.5 h-3.5" />
                      Dismiss
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
