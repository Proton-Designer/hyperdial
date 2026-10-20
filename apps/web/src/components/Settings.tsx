import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import {
  User,
  Phone,
  Users as UsersIcon,
  Zap,
  Search,
  Loader2,
  Trash2,
  UserX,
  UserCheck,
  Mail,
  ListChecks,
  Plus,
  Pencil,
  X,
  PhoneOff,
  ChevronUp,
  ChevronDown,
  Trophy,
  History,
  Download,
  Share2,
  Bell,
  AlertTriangle,
  UserCog,
} from 'lucide-react';
import { usePhoneNumbers } from '@/contexts/PhoneNumbersContext';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { NumberHealthPanel } from '@/components/settings/NumberHealthPanel';
import { SystemHealthPanel } from '@/components/settings/SystemHealthPanel';
import { CollapsibleSection } from '@/components/settings/CollapsibleSection';
import { PurchaseNumbersModal } from '@/components/settings/PurchaseNumbersModal';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/components/ui/utils';
import {
  getMyProfile,
  updateMyProfile,
  listOrgMembers,
  createOrgInvites,
  listOrgInvites,
  resendOrgInvite,
  revokeOrgInvite,
  changeMemberRole,
  disableMember,
  enableMember,
  removeMember,
  restoreMember,
  getOffboardPreview,
  releaseQueuedLeads,
  assignCampaignLeads,
  type OffboardPreview,
  updateMemberGhlUserId,
  listOrgPods,
  createOrgPod,
  renameOrgPod,
  deleteOrgPod,
  setMemberPod,
  setManagerPods,
  getManagerPods,
  type OrgPod,
  getGhlIntegrationStatus,
  connectGhl,
  disconnectGhl,
  updateGhlBlockedTags,
  updateGhlPullSettings,
  getGhlFieldSuggestions,
  listGhlCampaignMappings,
  createGhlTagCampaignMapping,
  createGhlStageCampaignMapping,
  deleteGhlCampaignMapping,
  listGhlPipelineStages,
  listCampaigns,
  listCrmSyncJobs,
  getTelnyxConnectionStatus,
  connectTelnyx,
  disconnectTelnyx,
  listDispositions,
  createDisposition,
  updateDisposition,
  deleteDisposition,
  getOrgQualityChecksEnabled,
  setOrgQualityChecksEnabled,
  listDispositionQualityRules,
  setDispositionQualityRule,
  type QualityRuleType,
  type DispositionQualityRule,
  listDncNumbers,
  addDncNumber,
  removeDncNumber,
  listAuditLog,
  type AuditLogEntry,
  getRecordingEnabled,
  setRecordingEnabled,
  getRecordingConsentSettings,
  setRecordingConsentSettings,
  type AnnounceRecordingMode,
  getAllowExternalTransfers,
  setAllowExternalTransfers,
  getUserPreferences,
  saveUserPreferences,
  getMyVoicemailDrop,
  getOrgDefaultVoicemailDrop,
  uploadMyVoicemailDrop,
  uploadOrgDefaultVoicemailDrop,
  getNumberPoolSettings,
  updateNumberPoolSettings,
  assignPhoneNumber,
  setPhoneNumberStatus,
  getSpendSettings,
  updateSpendSettings,
  getDistributionSettings,
  updateDistributionSettings,
  type DistributionSettings,
  getSpendStatus,
  getInboundSettings,
  updateInboundSettings,
  getMyForwardNumber,
  setMyForwardNumber,
  getBillingInfo,
  updateAutoRecharge,
  addFunds,
  listRecentBillingEvents,
  BillingActionError,
  type NumberPoolSettings,
  type SpendSettings,
  type SpendStatus,
  type AutoRechargePrefs,
  type AutoRechargePreference,
  type NotificationPrefType,
  type BillingEvent,
  type InboundSettings,
  type VoicemailDropInfo,
  type OrgMember,
  type OrgInvite,
  type BulkInviteResult,
  type GhlIntegrationStatus,
  type GhlCampaignMapping,
  type GhlPipelineStageOption,
  type CampaignWithStats,
  type CrmSyncJob,
  type TelnyxConnectionStatus,
  type Disposition,
  type DispositionLeadEffect,
  type DncNumber,
  getSupervisorAlertSettings,
  updateSupervisorAlertSettings,
  type SupervisorAlertSettings,
  getCallTakeoverSettings,
  updateCallTakeoverSettings,
  getUserNotificationPreferences,
  setUserNotificationPreference,
  getCurrentUserId,
} from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ListSkeleton, TableSkeleton } from '@/components/app/skeletons';
import { rowsToCsv, downloadCsv } from '@/lib/csv';
import { normalizePhoneStrict } from '@/lib/phone-normalize';

type SettingsTab =
  | 'profile'
  | 'phone'
  | 'team'
  | 'integrations'
  | 'dispositions'
  | 'dnc'
  | 'distribution'
  | 'activity';

function ProfileTab() {
  const { user } = useAuth();
  const { firstName: ctxFirstName, lastName: ctxLastName, refetch: refetchOrg } = useOrg();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [forwardNumber, setForwardNumber] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        setFirstName(p?.first_name ?? '');
        setLastName(p?.last_name ?? '');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // TASK-I1 (INB-3): every role's own optional cell fallback, self-service via
    // org_members' "member can update own heartbeat and forward number" RLS policy --
    // not owner/admin gated, unlike the org-level InboundSettingsCard on the Telephony tab.
    getMyForwardNumber()
      .then((n) => setForwardNumber(n ?? ''))
      .catch((e) => setError(String(e)));
  }, []);

  const initials =
    (firstName[0] ?? '') + (lastName[0] ?? '') || (user?.email ?? 'U').slice(0, 2).toUpperCase();

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateMyProfile({ first_name: firstName, last_name: lastName });
      await setMyForwardNumber(forwardNumber.trim() || null);
      await refetchOrg();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div>
        <Skeleton className="h-8 w-56 mb-8" />
        <div className="space-y-4 max-w-xl">
          <Skeleton className="h-12 w-full rounded-app-md" />
          <Skeleton className="h-12 w-full rounded-app-md" />
          <Skeleton className="h-12 w-full rounded-app-md" />
          <Skeleton className="h-10 w-32 rounded-app-md" />
        </div>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <PageHeader title="Profile" />

      <div className="bg-surface-1 rounded-app-lg p-8 border border-border-subtle shadow-app-sm mb-8">
        <div className="flex items-center gap-6 mb-8">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-accent-from to-accent-to flex items-center justify-center text-white text-3xl font-bold">
            {initials.toUpperCase() || (ctxFirstName?.[0] ?? '') + (ctxLastName?.[0] ?? '')}
          </div>
          <div>
            <h3 className="text-2xl font-bold text-white mb-1">
              {firstName || lastName ? `${firstName} ${lastName}`.trim() : 'Your profile'}
            </h3>
            <p className="text-text-secondary">{user?.email}</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
            {error}
          </div>
        )}

        <div className="space-y-6">
          <div>
            <h4 className="text-section-title text-text-primary mb-4">Personal Information</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-text-secondary mb-2">First Name</label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white focus:outline-none focus:border-accent-to transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm text-text-secondary mb-2">Last Name</label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white focus:outline-none focus:border-accent-to transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm text-text-secondary mb-2">Email</label>
                <input
                  type="email"
                  value={user?.email ?? ''}
                  readOnly
                  className="w-full bg-surface-2/60 border border-white/10 rounded-app-md px-4 py-3 text-text-secondary cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-section-title text-text-primary mb-4">Call Forwarding</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-text-secondary mb-2">Your cell number</label>
                <input
                  type="tel"
                  value={forwardNumber}
                  onChange={(e) => setForwardNumber(e.target.value)}
                  placeholder="+15551234567"
                  className="w-full bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to transition-colors"
                />
                <p className="text-xs text-text-muted mt-1.5">
                  Optional. If you don't answer an inbound call in your browser, it rings this
                  number next, before the org's shared line and voicemail.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 mt-8 pt-6 border-t border-border-subtle">
          {saved && <span className="text-sm text-success mr-auto">Saved</span>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-3 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white font-semibold shadow-[0_4px_24px_rgba(0,217,255,0.3)] hover:shadow-[0_6px_32px_rgba(0,217,255,0.4)] transition-all disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
  manager: 'Manager',
};

/** Optional deep-link target inside the Team tab (used by Team Shifts -> Manage pods). */
export type SettingsSection = 'pods' | 'integrations';

function TeamTab({ scrollTo }: { scrollTo?: SettingsSection }) {
  const { user } = useAuth();
  const { role } = useOrg();
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  // TASK-A2: bulk -- paste many emails (comma/newline-separated), one role + one optional
  // campaign set for the whole batch (matches the task's own "choose role and optional campaigns"
  // wording -- per-email role/campaigns would need a much heavier per-row form for a rare need).
  const [inviteEmailsText, setInviteEmailsText] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'agent' | 'manager'>('agent');
  const [inviteCampaignIds, setInviteCampaignIds] = useState<string[]>([]);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkInviteResult[] | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  // MISSION-5 TASK-M5-A3: 'removed' members are hidden by default -- this toggle is the only way
  // an owner/admin reaches the Restore button within the 72h window.
  const [showRemoved, setShowRemoved] = useState(false);
  // TASK-U1 (user request): the Agents group is collapsed by default -- an agent roster can grow
  // a lot, and owner/admin/manager (who ARE in the always-visible top group) is who most needs to
  // scan quickly without scrolling past a long agent list first.
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [offboardTarget, setOffboardTarget] = useState<{
    member: OrgMember;
    mode: 'disable' | 'remove';
  } | null>(null);

  // MISSION-5 TASK-M5-A5: pods (owner/admin manage them; a manager's own SCOPE -- which pods they
  // supervise -- is a separate per-manager list, see the migration header for why the two are
  // distinct relationships).
  const [pods, setPods] = useState<OrgPod[]>([]);
  const [managerPodIds, setManagerPodIds] = useState<Record<string, string[]>>({});
  const [newPodName, setNewPodName] = useState('');
  const [podBusy, setPodBusy] = useState(false);
  const podsHeadingRef = useRef<HTMLHeadingElement>(null);
  // Deep link (Team Shifts -> Manage pods): once the roster has loaded, bring Pods into view.
  useEffect(() => {
    if (scrollTo !== 'pods' || loading) return;
    const el = podsHeadingRef.current;
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  }, [scrollTo, loading]);
  const [podError, setPodError] = useState<string | null>(null);

  const canManage = role === 'owner' || role === 'admin';

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      listOrgMembers(showRemoved),
      canManage ? listOrgInvites() : Promise.resolve([]),
      canManage ? listCampaigns() : Promise.resolve([]),
      canManage ? listOrgPods() : Promise.resolve([]),
    ])
      .then(async ([m, i, c, p]) => {
        setMembers(m);
        setInvites(i);
        setCampaigns(c);
        setPods(p);
        const managers = m.filter((mem) => mem.role === 'manager');
        if (canManage && managers.length > 0) {
          const entries = await Promise.all(
            managers.map(async (mgr) => [mgr.user_id, await getManagerPods(mgr.user_id)] as const)
          );
          setManagerPodIds(Object.fromEntries(entries));
        } else {
          setManagerPodIds({});
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [canManage, showRemoved]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreateInvites = async (e: React.FormEvent) => {
    e.preventDefault();
    const emails = inviteEmailsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (emails.length === 0) return;
    setInviteSubmitting(true);
    setActionError(null);
    setBulkResults(null);
    try {
      const results = await createOrgInvites(emails, inviteRole, inviteCampaignIds);
      setBulkResults(results);
      setInviteEmailsText('');
      load();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setInviteSubmitting(false);
    }
  };

  const handleCopyLink = async (token: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/?invite=${token}`);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      // Clipboard API unavailable -- the link is still visible as plain text.
    }
  };

  const runAction = async (userId: string, fn: () => Promise<unknown>) => {
    setBusyUserId(userId);
    setActionError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRestore = (m: OrgMember) => {
    runAction(m.user_id, () => restoreMember(m.user_id));
  };

  const handleCreatePod = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newPodName.trim();
    if (!name) return;
    setPodBusy(true);
    setPodError(null);
    try {
      await createOrgPod(name);
      setNewPodName('');
      load();
    } catch (e) {
      setPodError(String(e));
    } finally {
      setPodBusy(false);
    }
  };

  const handleRenamePod = async (pod: OrgPod) => {
    const name = window.prompt('Rename pod', pod.name)?.trim();
    if (!name || name === pod.name) return;
    setPodBusy(true);
    setPodError(null);
    try {
      await renameOrgPod(pod.id, name);
      load();
    } catch (e) {
      setPodError(String(e));
    } finally {
      setPodBusy(false);
    }
  };

  const handleDeletePod = async (pod: OrgPod) => {
    if (!confirm(`Delete pod "${pod.name}"? Members in it become unassigned.`)) return;
    setPodBusy(true);
    setPodError(null);
    try {
      await deleteOrgPod(pod.id);
      load();
    } catch (e) {
      setPodError(String(e));
    } finally {
      setPodBusy(false);
    }
  };

  const handleToggleManagerPod = async (managerUserId: string, podId: string) => {
    const current = managerPodIds[managerUserId] ?? [];
    const next = current.includes(podId)
      ? current.filter((id) => id !== podId)
      : [...current, podId];
    setManagerPodIds((prev) => ({ ...prev, [managerUserId]: next }));
    try {
      await setManagerPods(managerUserId, next);
    } catch (e) {
      setActionError(String(e));
      setManagerPodIds((prev) => ({ ...prev, [managerUserId]: current })); // revert on failure
    }
  };

  const handleResendInvite = async (inviteId: string) => {
    setBusyInviteId(inviteId);
    setActionError(null);
    try {
      const result = await resendOrgInvite(inviteId);
      setBulkResults([result]);
      load();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusyInviteId(null);
    }
  };

  const handleRevokeInvite = async (inviteId: string, email: string) => {
    if (!confirm(`Revoke the invite to ${email}?`)) return;
    setBusyInviteId(inviteId);
    setActionError(null);
    try {
      await revokeOrgInvite(inviteId);
      load();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusyInviteId(null);
    }
  };

  // MISSION-5 TASK-M5-A2 fix-forward (eng2 review BLOCKER 2b): an expired invite needs a visible
  // Resend path too -- it used to be filtered out of this list entirely (status !== 'pending'),
  // leaving no UI way to fix one without a manual SQL update.
  const pendingInvites = invites.filter((i) => i.status === 'pending' || i.status === 'expired');
  const seatCounts = {
    active: members.filter((m) => m.status === 'active').length,
    disabled: members.filter((m) => m.status === 'disabled').length,
    pending: pendingInvites.length,
  };

  // TASK-U1 (user request): owners/admins/managers stay in one always-visible top group (a
  // manager is grouped WITH admins here, labelled by their own role via ROLE_LABEL, not treated
  // as an "agent" for this split); everyone else (role === 'agent') goes in the collapsible
  // group below. Both groups are derived from `members`, the SAME array/filtering the page
  // already uses (respects `showRemoved`; a disabled agent is still in `members` and still
  // counts here, same as the Disabled badge/seatCounts above already show them).
  const nonAgentMembers = members.filter((m) => m.role !== 'agent');
  const agentMembers = members.filter((m) => m.role === 'agent');

  function expiryLabel(expiresAt: string): string {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'Expired';
    const days = Math.ceil(ms / 86400000);
    return days === 1 ? '1 day left' : `${days} days left`;
  }

  // TASK-U1: shared row/card renderers -- used for BOTH the always-visible top group
  // (owner/admin/manager) and the collapsible Agents group below, so every existing per-member
  // action (role change, pod assignment, disable/enable, remove/restore) works identically in
  // either group without duplicating this markup a third time.
  const renderDesktopMemberRow = (m: OrgMember) => {
    const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || 'Unnamed';
    const isSelf = m.user_id === user?.id;
    const isOwner = m.role === 'owner';
    const busy = busyUserId === m.user_id;
    return (
      <TableRow key={m.user_id} className="border-border-subtle">
        <TableCell>
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-accent-from to-accent-to flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
              {name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-text-primary font-medium truncate">
                {name} {isSelf && <span className="text-text-secondary text-xs">(you)</span>}
              </div>
              <div className="text-meta text-text-secondary truncate">{m.email}</div>
            </div>
          </div>
        </TableCell>
        <TableCell>
          <span
            className={cn(
              'px-2.5 py-1 rounded-full text-xs border',
              m.status === 'removed'
                ? 'bg-danger/10 text-danger border-danger/20'
                : m.status === 'disabled'
                  ? 'bg-white/5 text-text-secondary border-white/10'
                  : 'bg-success/10 text-success border-success/20'
            )}
          >
            {m.status === 'removed' ? 'Removed' : m.status === 'disabled' ? 'Disabled' : 'Active'}
          </span>
          {m.status === 'removed' && m.restorable_until && (
            <div className="text-meta text-text-secondary mt-1">
              {restorableLabel(m.restorable_until)}
            </div>
          )}
        </TableCell>
        <TableCell>
          {canManage && !isOwner && m.status !== 'removed' ? (
            <select
              value={m.role}
              disabled={busy}
              onChange={(e) =>
                runAction(m.user_id, () =>
                  changeMemberRole(m.user_id, e.target.value as 'admin' | 'agent' | 'manager')
                )
              }
              className="bg-surface-2 border border-border-subtle rounded-app-sm px-3 py-1.5 text-text-primary text-sm focus:outline-none focus:border-accent-to"
            >
              <option value="admin">Admin</option>
              <option value="manager">Manager</option>
              <option value="agent">Agent</option>
            </select>
          ) : (
            <span className="text-sm text-text-secondary">{ROLE_LABEL[m.role]}</span>
          )}
        </TableCell>
        <TableCell>
          {canManage && !isOwner && m.status !== 'removed' ? (
            <div className="space-y-2">
              <select
                value={m.pod_id ?? ''}
                disabled={busy || pods.length === 0}
                onChange={(e) =>
                  runAction(m.user_id, () => setMemberPod(m.user_id, e.target.value || null))
                }
                className="bg-surface-2 border border-border-subtle rounded-app-sm px-2 py-1 text-text-primary text-xs focus:outline-none focus:border-accent-to"
              >
                <option value="">No pod</option>
                {pods.map((pod) => (
                  <option key={pod.id} value={pod.id}>
                    {pod.name}
                  </option>
                ))}
              </select>
              {m.role === 'manager' && pods.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-meta text-text-secondary">Supervises:</span>
                  {pods.map((pod) => (
                    <label
                      key={pod.id}
                      className="flex items-center gap-1.5 text-meta text-text-secondary"
                    >
                      <input
                        type="checkbox"
                        checked={(managerPodIds[m.user_id] ?? []).includes(pod.id)}
                        onChange={() => handleToggleManagerPod(m.user_id, pod.id)}
                      />
                      {pod.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <span className="text-sm text-text-secondary">
              {pods.find((p) => p.id === m.pod_id)?.name ?? '—'}
            </span>
          )}
        </TableCell>
        <TableCell>
          {canManage && !isOwner && (
            <div className="flex items-center justify-end gap-1">
              {m.status === 'removed' ? (
                <button
                  disabled={busy}
                  onClick={() => handleRestore(m)}
                  title="Restore"
                  aria-label="Restore"
                  className="p-2 rounded-app-sm hover:bg-white/5 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                >
                  <UserCheck className="w-4 h-4" />
                </button>
              ) : (
                <>
                  <button
                    disabled={busy}
                    onClick={() =>
                      m.status === 'disabled'
                        ? runAction(m.user_id, () => enableMember(m.user_id))
                        : setOffboardTarget({ member: m, mode: 'disable' })
                    }
                    title={m.status === 'disabled' ? 'Enable' : 'Disable'}
                    aria-label={m.status === 'disabled' ? 'Enable' : 'Disable'}
                    className="p-2 rounded-app-sm hover:bg-white/5 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                  >
                    {m.status === 'disabled' ? (
                      <UserCheck className="w-4 h-4" />
                    ) : (
                      <UserX className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setOffboardTarget({ member: m, mode: 'remove' })}
                    title="Remove"
                    aria-label="Remove"
                    className="p-2 rounded-app-sm hover:bg-danger/10 text-text-secondary hover:text-danger transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          )}
        </TableCell>
      </TableRow>
    );
  };

  const renderMobileMemberCard = (m: OrgMember) => {
    const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || 'Unnamed';
    const isSelf = m.user_id === user?.id;
    const isOwner = m.role === 'owner';
    const busy = busyUserId === m.user_id;
    return (
      <div
        key={m.user_id}
        className="flex items-center justify-between p-4 bg-surface-1 rounded-app-md border border-border-subtle"
      >
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-accent-from to-accent-to flex items-center justify-center text-white text-sm font-semibold flex-shrink-0">
            {name.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-text-primary font-medium truncate">
              {name} {isSelf && <span className="text-text-secondary text-xs">(you)</span>}
            </div>
            <div className="text-sm text-text-secondary truncate">{m.email}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex flex-col items-end">
            <span
              className={cn(
                'px-2.5 py-1 rounded-full text-xs border',
                m.status === 'removed'
                  ? 'bg-danger/10 text-danger border-danger/20'
                  : m.status === 'disabled'
                    ? 'bg-white/5 text-text-secondary border-white/10'
                    : 'bg-success/10 text-success border-success/20'
              )}
            >
              {m.status === 'removed' ? 'Removed' : m.status === 'disabled' ? 'Disabled' : 'Active'}
            </span>
            {m.status === 'removed' && m.restorable_until && (
              <div className="text-meta text-text-secondary mt-1">
                {restorableLabel(m.restorable_until)}
              </div>
            )}
          </div>

          {canManage && !isOwner ? (
            m.status === 'removed' ? (
              <button
                disabled={busy}
                onClick={() => handleRestore(m)}
                title="Restore"
                aria-label="Restore"
                className="p-2 rounded-app-sm hover:bg-white/5 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
              >
                <UserCheck className="w-4 h-4" />
              </button>
            ) : (
              <>
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) =>
                    runAction(m.user_id, () =>
                      changeMemberRole(m.user_id, e.target.value as 'admin' | 'agent' | 'manager')
                    )
                  }
                  className="bg-surface-2 border border-border-subtle rounded-app-sm px-3 py-1.5 text-text-primary text-sm focus:outline-none focus:border-accent-to"
                >
                  <option value="admin">Admin</option>
                  <option value="manager">Manager</option>
                  <option value="agent">Agent</option>
                </select>
                <button
                  disabled={busy}
                  onClick={() =>
                    m.status === 'disabled'
                      ? runAction(m.user_id, () => enableMember(m.user_id))
                      : setOffboardTarget({ member: m, mode: 'disable' })
                  }
                  title={m.status === 'disabled' ? 'Enable' : 'Disable'}
                  aria-label={m.status === 'disabled' ? 'Enable' : 'Disable'}
                  className="p-2 rounded-app-sm hover:bg-white/5 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                >
                  {m.status === 'disabled' ? (
                    <UserCheck className="w-4 h-4" />
                  ) : (
                    <UserX className="w-4 h-4" />
                  )}
                </button>
                <button
                  disabled={busy}
                  onClick={() => setOffboardTarget({ member: m, mode: 'remove' })}
                  title="Remove"
                  aria-label="Remove"
                  className="p-2 rounded-app-sm hover:bg-danger/10 text-text-secondary hover:text-danger transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )
          ) : (
            <span className="text-sm text-text-secondary px-2">{ROLE_LABEL[m.role]}</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <PageHeader
        title="Team"
        actions={
          canManage && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setShowInvite((v) => !v);
                setBulkResults(null);
              }}
            >
              Invite members
            </Button>
          )
        }
      />

      {canManage && (
        <div className="flex flex-wrap items-center gap-4 mb-6 text-meta text-text-secondary">
          <span>
            <span className="text-text-primary font-semibold">{seatCounts.active}</span> active
          </span>
          <span>
            <span className="text-text-primary font-semibold">{seatCounts.pending}</span> pending
          </span>
          <span>
            <span className="text-text-primary font-semibold">{seatCounts.disabled}</span> disabled
          </span>
        </div>
      )}

      {/* MISSION-5 TASK-M5-A5: pod management -- owner/admin only. A pod is just a name; which
          member sits in which pod is set per-row in the roster table below (the "Pod" column),
          and a manager's own SCOPE (which pods they supervise) is the checkbox list under their
          row -- two different relationships, see the migration header. */}
      {canManage && (
        <div
          id="settings-pods"
          className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle mb-6 scroll-mt-4"
        >
          <h3
            ref={podsHeadingRef}
            tabIndex={-1}
            className="text-section-title text-text-primary mb-4 outline-none"
          >
            Pods
          </h3>
          {podError && <p className="text-body text-danger mb-3">{podError}</p>}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {pods.length === 0 ? (
              <span className="text-sm text-text-secondary">No pods yet.</span>
            ) : (
              pods.map((pod) => (
                <span
                  key={pod.id}
                  className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 border border-white/10 rounded-full text-sm text-text-primary"
                >
                  {pod.name}
                  <button
                    type="button"
                    disabled={podBusy}
                    onClick={() => handleRenamePod(pod)}
                    className="text-text-secondary hover:text-text-primary disabled:opacity-50"
                    title="Rename pod"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={podBusy}
                    onClick={() => handleDeletePod(pod)}
                    className="text-text-secondary hover:text-danger disabled:opacity-50"
                    title="Delete pod"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))
            )}
          </div>
          <form onSubmit={handleCreatePod} className="flex items-center gap-2">
            <input
              type="text"
              value={newPodName}
              onChange={(e) => setNewPodName(e.target.value)}
              placeholder="New pod name"
              className="bg-surface-2 border border-white/10 rounded-app-sm px-3 py-1.5 text-sm text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
            />
            <Button
              type="submit"
              size="sm"
              variant="fe-secondary"
              disabled={podBusy || !newPodName.trim()}
            >
              Add pod
            </Button>
          </form>
        </div>
      )}

      {/* TASK-U1 (user request): "Team members" moved up to right below Pods. Owners/admins/
          managers stay in one always-visible top group (a manager sits WITH admins here, labelled
          by their own role via ROLE_LABEL -- not treated as an "agent" for this split); everyone
          else (role === 'agent') collapses into its own "Agents (N)" group, collapsed by default
          since that list can grow a lot. Every existing per-member action still works identically
          in either group -- renderDesktopMemberRow/renderMobileMemberCard are the SAME functions
          for both. */}
      <div className="mb-6">
        <h3 className="text-section-title text-text-primary mb-4">Team members</h3>

        {(error || actionError) && (
          <div className="mb-4 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
            {error || actionError}
          </div>
        )}

        {canManage && (
          <label className="mb-3 flex items-center gap-2 text-meta text-text-secondary">
            <input
              type="checkbox"
              checked={showRemoved}
              onChange={(e) => setShowRemoved(e.target.checked)}
              className="rounded border-border-subtle"
            />
            Show removed members (restorable for 72h)
          </label>
        )}

        {loading ? (
          isDesktop ? (
            <TableSkeleton rows={4} columns={4} />
          ) : (
            <ListSkeleton rows={4} />
          )
        ) : (
          <>
            {isDesktop ? (
              <div className="rounded-app-lg border border-border-subtle bg-surface-1 overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border-subtle hover:bg-transparent">
                      <TableHead className="text-text-secondary">Name</TableHead>
                      <TableHead className="text-text-secondary">Status</TableHead>
                      <TableHead className="text-text-secondary">Role</TableHead>
                      <TableHead className="text-text-secondary">Pod</TableHead>
                      <TableHead className="text-right text-text-secondary">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{nonAgentMembers.map(renderDesktopMemberRow)}</TableBody>
                </Table>
              </div>
            ) : (
              <div className="space-y-3">{nonAgentMembers.map(renderMobileMemberCard)}</div>
            )}

            {agentMembers.length > 0 && (
              <div className="mt-4">
                <button
                  type="button"
                  aria-expanded={agentsExpanded}
                  onClick={() => setAgentsExpanded((v) => !v)}
                  className="flex items-center gap-2 text-body font-medium text-text-primary hover:text-white"
                >
                  {agentsExpanded ? (
                    <ChevronUp className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                  Agents ({agentMembers.length})
                </button>
                {agentsExpanded &&
                  (isDesktop ? (
                    <div className="mt-2 rounded-app-lg border border-border-subtle bg-surface-1 overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="border-border-subtle hover:bg-transparent">
                            <TableHead className="text-text-secondary">Name</TableHead>
                            <TableHead className="text-text-secondary">Status</TableHead>
                            <TableHead className="text-text-secondary">Role</TableHead>
                            <TableHead className="text-text-secondary">Pod</TableHead>
                            <TableHead className="text-right text-text-secondary">
                              Actions
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>{agentMembers.map(renderDesktopMemberRow)}</TableBody>
                      </Table>
                    </div>
                  ) : (
                    <div className="mt-2 space-y-3">{agentMembers.map(renderMobileMemberCard)}</div>
                  ))}
              </div>
            )}
          </>
        )}
      </div>

      {canManage && (
        <>
          <SupervisorAlertSettingsCard />
          <CallTakeoverSettingsCard />
          <NotificationPreferencesCard members={members} />
        </>
      )}

      {canManage && showInvite && (
        <div className="bg-gradient-to-r from-accent-from/10 to-accent-to/10 rounded-app-lg p-6 border border-accent-from/20 mb-6">
          <h3 className="text-section-title text-text-primary mb-4">Invite teammates</h3>
          <form onSubmit={handleCreateInvites} className="space-y-3">
            <div>
              <label className="block text-sm text-text-secondary mb-2">
                Emails (comma or newline-separated)
              </label>
              <textarea
                value={inviteEmailsText}
                onChange={(e) => setInviteEmailsText(e.target.value)}
                required
                rows={3}
                className="w-full bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
                placeholder={'jane@company.com\njohn@company.com'}
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-sm text-text-secondary mb-2">Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'admin' | 'agent' | 'manager')}
                  className="bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white focus:outline-none focus:border-accent-to"
                >
                  <option value="agent">Agent</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {campaigns.length > 0 && (
                <div className="flex-1 min-w-[220px]">
                  <label className="block text-sm text-text-secondary mb-2">
                    Join campaigns (optional)
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {campaigns.map((c) => {
                      const checked = inviteCampaignIds.includes(c.id);
                      return (
                        <label
                          key={c.id}
                          className={cn(
                            'px-2.5 py-1 rounded-full text-xs border cursor-pointer',
                            checked
                              ? 'bg-accent-to/20 border-accent-to/40 text-accent-to'
                              : 'bg-surface-2 border-border-subtle text-text-secondary'
                          )}
                        >
                          <input
                            type="checkbox"
                            className="hidden"
                            checked={checked}
                            onChange={() =>
                              setInviteCampaignIds((prev) =>
                                checked ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                              )
                            }
                          />
                          {c.name}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              <button
                type="submit"
                disabled={inviteSubmitting}
                className="px-6 py-3 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white font-semibold disabled:opacity-50 flex items-center gap-2"
              >
                {inviteSubmitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Mail className="w-4 h-4" />
                )}
                Send invites
              </button>
            </div>
          </form>

          {bulkResults && (
            <div className="mt-4 space-y-1.5">
              {bulkResults.map((r, i) => (
                <div
                  key={`${r.email}-${i}`}
                  className="flex flex-wrap items-center gap-2 text-meta"
                >
                  <span className="text-text-primary">{r.email || '(resent)'}</span>
                  <span
                    className={cn(
                      'px-1.5 py-0.5 rounded-full text-[10px] uppercase',
                      r.status === 'sent'
                        ? 'bg-success/10 text-success'
                        : r.status === 'invalid'
                          ? 'bg-danger/10 text-danger'
                          : 'bg-white/5 text-text-secondary'
                    )}
                  >
                    {r.status.replace('_', ' ')}
                  </span>
                  {r.status === 'sent' && r.token && (
                    <button
                      type="button"
                      onClick={() => handleCopyLink(r.token!)}
                      className="text-accent-to hover:underline"
                    >
                      {copiedToken === r.token ? 'Copied' : 'Copy link'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {canManage && pendingInvites.length > 0 && (
        <div className="mb-8">
          <h3 className="text-section-title text-text-primary mb-3">Pending invites</h3>
          <div className="rounded-app-lg border border-border-subtle bg-surface-1 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border-subtle hover:bg-transparent">
                  <TableHead className="text-text-secondary">Email</TableHead>
                  <TableHead className="text-text-secondary">Role</TableHead>
                  <TableHead className="text-text-secondary">Invited by</TableHead>
                  <TableHead className="text-text-secondary">Expires</TableHead>
                  <TableHead className="text-right text-text-secondary">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingInvites.map((inv) => {
                  const busy = busyInviteId === inv.id;
                  return (
                    <TableRow key={inv.id} className="border-border-subtle">
                      <TableCell className="text-white">{inv.email}</TableCell>
                      <TableCell className="text-text-secondary">{ROLE_LABEL[inv.role]}</TableCell>
                      <TableCell className="text-text-secondary">
                        {inv.invitedByName ?? '—'}
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {expiryLabel(inv.expiresAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            disabled={busy}
                            onClick={() => handleResendInvite(inv.id)}
                            title="Resend"
                            className="p-2 rounded-app-sm hover:bg-white/5 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                          >
                            <Mail className="w-4 h-4" />
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => handleRevokeInvite(inv.id, inv.email)}
                            title="Revoke"
                            className="p-2 rounded-app-sm hover:bg-danger/10 text-text-secondary hover:text-danger transition-colors disabled:opacity-50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* TASK-U1 fix-forward (the lead's visual check): moved here, after invites/pending
          invites, so the members module + supervisor alerts/call takeover the user asked for
          right after it aren't interrupted by this GHL sync/mapping utility -- it's a per-member
          extra, not part of active roster management, so it reads best as the last thing on the
          page rather than wedged between two things the user explicitly wanted adjacent. */}
      {canManage && members.length > 0 && (
        <GhlMemberMappingSection members={members} onSaved={load} />
      )}

      <OffboardWizardModal
        open={offboardTarget !== null}
        member={offboardTarget?.member ?? null}
        mode={offboardTarget?.mode ?? 'disable'}
        onClose={() => setOffboardTarget(null)}
        onDone={load}
      />
    </motion.div>
  );
}

/** MISSION-5 TASK-M5-B4: per-org opt-in supervisor alerts -- owner/admin only, same
 *  load/save/error shape as RecordingSettingsCard above. Each of the 4 conditions is an
 *  independent checkbox + its own editable minutes threshold; saving one field re-sends the
 *  FULL current settings object (updateSupervisorAlertSettings' own patch semantics only send
 *  defined fields, but this card always has every field defined once loaded, so there's no
 *  partial-overwrite risk). */
function SupervisorAlertSettingsCard() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';

  const [settings, setSettings] = useState<SupervisorAlertSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    getSupervisorAlertSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [isAdmin]);

  const save = async (next: SupervisorAlertSettings) => {
    setSettings(next);
    setSaving(true);
    setError(null);
    try {
      await updateSupervisorAlertSettings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) return null;
  if (loading) return <Skeleton className="h-48 rounded-app-lg max-w-2xl mt-6" />;
  if (!settings) return null;

  const rows: {
    key: 'wrapUp' | 'paused' | 'call' | 'zeroConnects';
    label: string;
    minutesLabel: string;
  }[] = [
    { key: 'wrapUp', label: 'Agent stuck in wrap-up', minutesLabel: 'minutes' },
    { key: 'paused', label: 'Agent paused too long', minutesLabel: 'minutes' },
    { key: 'call', label: 'Agent on a call too long', minutesLabel: 'minutes' },
    { key: 'zeroConnects', label: 'Zero connects while dialing', minutesLabel: 'minute window' },
  ];
  const fieldsFor = (key: (typeof rows)[number]['key']) =>
    ({
      wrapUp: {
        enabledKey: 'wrapUpAlertEnabled',
        minutesKey: 'wrapUpAlertMinutes',
      } as const,
      paused: {
        enabledKey: 'pausedAlertEnabled',
        minutesKey: 'pausedAlertMinutes',
      } as const,
      call: {
        enabledKey: 'callAlertEnabled',
        minutesKey: 'callAlertMinutes',
      } as const,
      zeroConnects: {
        enabledKey: 'zeroConnectsAlertEnabled',
        minutesKey: 'zeroConnectsWindowMinutes',
      } as const,
    })[key];

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle mb-6">
      <h3 className="text-section-title text-text-primary mb-1 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-warning" />
        Supervisor alerts
      </h3>
      <p className="text-sm text-text-secondary mb-4">
        Off by default. Each alert fires once per agent per episode -- it won't repeat until the
        agent leaves and re-enters that condition. Delivered to owner/admin and, for an agent in a
        pod, that pod's manager.
      </p>
      {error && <p className="text-body text-danger mb-3">{error}</p>}
      <div className="space-y-3">
        {rows.map(({ key, label, minutesLabel }) => {
          const { enabledKey, minutesKey } = fieldsFor(key);
          const enabled = settings[enabledKey];
          const minutes = settings[minutesKey];
          return (
            <div key={key} className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-text-primary flex-1">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={saving}
                  onChange={(e) => save({ ...settings, [enabledKey]: e.target.checked })}
                />
                {label}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={minutes}
                  disabled={saving || !enabled}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (!Number.isFinite(n) || n <= 0) return;
                    void save({ ...settings, [minutesKey]: n });
                  }}
                  className="w-16 bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1 text-sm text-white focus:outline-none focus:border-accent-to"
                />
                <span className="text-meta text-text-muted">{minutesLabel}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** MISSION-5 TASK-M5-N1 (deferred backlog item): org-level gate for supervisor call takeover --
 *  same load/save/error shape as ExternalTransferSettingsCard. OFF by default; server-side
 *  rejects the takeover action itself if this is off (TAKEOVER_DISABLED), this toggle is not the
 *  only enforcement. */
function CallTakeoverSettingsCard() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';

  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    getCallTakeoverSettings()
      .then((s) => setEnabled(s.enabled))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [isAdmin]);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      await updateCallTakeoverSettings(next);
    } catch (e) {
      setError(String(e));
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) return null;

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle mb-6">
      <h3 className="text-section-title text-text-primary mb-1 flex items-center gap-2">
        <UserCog className="w-4 h-4 text-warning" />
        Call takeover
      </h3>
      <p className="text-sm text-text-secondary mb-4">
        Let a supervisor already monitoring/whispering/barging on a live call take it over -- the
        agent's leg leaves the call and the supervisor becomes the only agent-side party with the
        prospect. Off by default.
      </p>
      {error && <p className="text-sm text-danger mb-3">{error}</p>}
      {loading ? (
        <Skeleton className="h-6 w-40" />
      ) : (
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void handleToggle(e.target.checked)}
          />
          Allow supervisors to take over live calls
        </label>
      )}
    </div>
  );
}

/** MISSION-5 TASK-M5-B4: per-user opt-out for the 4 supervisor-alert types above (+ TASK-M5-G5's
 *  'mention', reusing the same table/RLS/card unchanged). Owner/admin may pick anyone from the
 *  roster; the picker defaults to "myself" so the common case (an owner tuning their own noise)
 *  needs no searching. A plain agent/manager has no Settings entry point today (MainApp.tsx's own
 *  tab gate) -- see the task report for why this card is owner/admin-only for now, not a narrower
 *  gap specific to this feature. */
function NotificationPreferencesCard({ members }: { members: OrgMember[] }) {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<NotificationPrefType, boolean> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    getCurrentUserId()
      .then(setSelectedUserId)
      .catch((e) => setError(String(e)));
  }, [isAdmin]);

  useEffect(() => {
    if (!selectedUserId) return;
    setLoading(true);
    setError(null);
    getUserNotificationPreferences(selectedUserId)
      .then(setPrefs)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selectedUserId]);

  const handleToggle = async (type: NotificationPrefType, enabled: boolean) => {
    if (!selectedUserId || !prefs) return;
    setPrefs({ ...prefs, [type]: enabled });
    setSaving(true);
    setError(null);
    try {
      await setUserNotificationPreference(selectedUserId, type, enabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) return null;

  const options: { type: NotificationPrefType; label: string }[] = [
    { type: 'wrap_up_stuck', label: 'Agent stuck in wrap-up' },
    { type: 'paused_stuck', label: 'Agent paused too long' },
    { type: 'call_stuck', label: 'Agent on a call too long' },
    { type: 'zero_connects', label: 'Zero connects while dialing' },
    { type: 'mention', label: 'Someone @mentions them in a contact note' },
  ];

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle mb-6">
      <h3 className="text-section-title text-text-primary mb-1 flex items-center gap-2">
        <Bell className="w-4 h-4" />
        Notification preferences
      </h3>
      <p className="text-sm text-text-secondary mb-4">
        Which supervisor alerts a person receives in-app. On by default for everyone until turned
        off here.
      </p>
      {error && <p className="text-body text-danger mb-3">{error}</p>}
      <select
        value={selectedUserId ?? ''}
        onChange={(e) => setSelectedUserId(e.target.value || null)}
        className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-sm text-white mb-4 focus:outline-none focus:border-accent-to"
      >
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>
            {[m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.user_id}
          </option>
        ))}
      </select>
      {loading ? (
        <Skeleton className="h-24 rounded-app-md" />
      ) : prefs ? (
        <div className="space-y-2">
          {options.map((opt) => (
            <label key={opt.type} className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={prefs[opt.type]}
                disabled={saving}
                onChange={(e) => handleToggle(opt.type, e.target.checked)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** MISSION-5 TASK-M5-A3: `restorable_until` -> "Restorable for Nh"/"Restorable for Nm" -- coarse
 *  on purpose, this is a countdown hint next to a status chip, not a precise timer. */
function restorableLabel(restorableUntilIso: string): string {
  const msLeft = new Date(restorableUntilIso).getTime() - Date.now();
  if (msLeft <= 0) return 'Restore window passed';
  const hoursLeft = Math.floor(msLeft / (60 * 60 * 1000));
  if (hoursLeft >= 1) return `Restorable for ${hoursLeft}h`;
  const minutesLeft = Math.max(1, Math.floor(msLeft / (60 * 1000)));
  return `Restorable for ${minutesLeft}m`;
}

/** MISSION-5 TASK-M5-A3 (extended once B3 landed, see audit/M5-B3/review-eng1.md's own "what the
 *  swap needs" section): the offboarding wizard -- opened by the Disable/Remove buttons above.
 *  Shows what the member currently holds (leads, callbacks, numbers, campaigns) before the admin
 *  commits, with two independent steps: "release queued leads to the pool" (org-wide, one RPC
 *  call) and "reassign callbacks to the pool" (per campaign, via `assign_campaign_leads`'
 *  `by_current_agent` mode -- B3's own new filter mode, the only one that also touches
 *  'callback' rows). Order-independent: `by_current_agent` re-checks each row's CURRENT
 *  `assigned_agent_id` at UPDATE time, so calling it after queued leads are already released
 *  simply finds nothing left to move for those, no double-release risk either way. */
function OffboardWizardModal({
  open,
  member,
  mode,
  onClose,
  onDone,
}: {
  open: boolean;
  member: OrgMember | null;
  mode: 'disable' | 'remove';
  onClose: () => void;
  onDone: () => void;
}) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(modalRef, open);
  const [preview, setPreview] = useState<OffboardPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [reassigningCallbacks, setReassigningCallbacks] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !member) return;
    setPreview(null);
    setError(null);
    setLoadingPreview(true);
    getOffboardPreview(member.user_id)
      .then(setPreview)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingPreview(false));
    // Re-fetch keyed on the member id + open transition only -- not on `preview` itself (that
    // would refetch every time handleReleaseLeads/handleReassignCallbacks update it below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, member?.user_id]);

  if (!open || !member) return null;

  const name =
    [member.first_name, member.last_name].filter(Boolean).join(' ') ||
    member.email ||
    'this member';
  const totalQueued = preview?.held_leads.reduce((sum, r) => sum + r.queued_leads, 0) ?? 0;
  const totalCallbacks = preview?.held_leads.reduce((sum, r) => sum + r.callbacks, 0) ?? 0;

  const handleReleaseLeads = async () => {
    setReleasing(true);
    setError(null);
    try {
      await releaseQueuedLeads(member.user_id);
      setPreview(await getOffboardPreview(member.user_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReleasing(false);
    }
  };

  const handleReassignCallbacks = async () => {
    if (!preview) return;
    setReassigningCallbacks(true);
    setError(null);
    try {
      // One RPC call per campaign the member holds a callback in -- assign_campaign_leads takes
      // a single p_campaign_id, there is no org-wide "by_current_agent across every campaign"
      // mode (unlike release_agent_queued_leads, which is already org-wide by design).
      for (const held of preview.held_leads) {
        if (held.callbacks === 0) continue;
        await assignCampaignLeads(held.campaign_id, null, {
          mode: 'by_current_agent',
          from_agent_id: member.user_id,
        });
      }
      setPreview(await getOffboardPreview(member.user_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReassigningCallbacks(false);
    }
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'disable') await disableMember(member.user_id);
      else await removeMember(member.user_id);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${mode} member`);
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="offboard-wizard-title"
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-md rounded-app-lg border border-border-subtle bg-surface-1 p-5 shadow-app-md outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="offboard-wizard-title" className="text-page-title text-text-primary mb-1">
          {mode === 'disable' ? 'Disable' : 'Remove'} {name}
        </h2>
        <p className="text-sm text-text-secondary mb-4">
          {mode === 'disable'
            ? 'Their session stops taking new calls immediately -- a live call is allowed to finish. Their numbers return to the pool.'
            : 'Soft-removed -- restorable for 72 hours. Historical stats, dispositions and recordings keep their name.'}
        </p>

        {error && (
          <div className="mb-4 p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
            {error}
          </div>
        )}

        {loadingPreview ? (
          <div className="text-sm text-text-secondary mb-4">Loading what they currently hold…</div>
        ) : (
          preview && (
            <div className="mb-4 space-y-2 text-sm">
              <div className="text-text-secondary">Currently holds:</div>
              <ul className="space-y-1 text-text-primary">
                <li>
                  {preview.numbers.length} number{preview.numbers.length === 1 ? '' : 's'}{' '}
                  <span className="text-text-secondary">(released to the pool automatically)</span>
                </li>
                <li>
                  {totalQueued} queued lead{totalQueued === 1 ? '' : 's'}
                </li>
                <li>
                  {totalCallbacks} due/future callback{totalCallbacks === 1 ? '' : 's'}
                </li>
                <li>
                  {preview.campaigns.length} campaign{preview.campaigns.length === 1 ? '' : 's'}
                  {preview.campaigns.length > 0 && `: ${preview.campaigns.join(', ')}`}
                </li>
              </ul>
              {totalQueued > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={releasing}
                  onClick={handleReleaseLeads}
                >
                  {releasing ? 'Releasing…' : 'Release queued leads to the pool'}
                </Button>
              )}
              {totalCallbacks > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={reassigningCallbacks}
                  onClick={handleReassignCallbacks}
                >
                  {reassigningCallbacks ? 'Reassigning…' : 'Reassign callbacks to the pool'}
                </Button>
              )}
              {totalQueued === 0 && totalCallbacks === 0 && preview.held_leads.length === 0 && (
                <p className="text-xs text-text-secondary">Not holding any leads or callbacks.</p>
              )}
            </div>
          )
        )}

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={mode === 'remove' ? 'danger' : 'warning-soft'}
            size="sm"
            disabled={submitting}
            onClick={handleConfirm}
          >
            {submitting ? 'Working…' : mode === 'disable' ? 'Disable member' : 'Remove member'}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}

/** MISSION-4 TASK-T1 (GHL-8): "the contact's assigned intern comes from GHL's assignedTo, mapped
 *  via each member's GHL user id, which owner/admin can set per member." A plain per-row text
 *  input (paste the GHL user id) -- same "no live dropdown, paste the id" convention as the
 *  Settings GHL field-mapping editor. Saves per-row on blur/Enter, not a single bulk-save button,
 *  since each row is an independent edit with its own success/error outcome (a duplicate-id
 *  conflict on one row must not block saving another). */
function GhlMemberMappingSection({
  members,
  onSaved,
}: {
  members: OrgMember[];
  onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const valueFor = (m: OrgMember) => drafts[m.user_id] ?? m.ghl_user_id ?? '';

  const handleSave = async (m: OrgMember) => {
    const next = valueFor(m).trim();
    if (next === (m.ghl_user_id ?? '')) return; // unchanged -- nothing to save
    setSavingUserId(m.user_id);
    setRowError((prev) => ({ ...prev, [m.user_id]: '' }));
    try {
      await updateMemberGhlUserId(m.user_id, next || null);
      onSaved();
    } catch (e) {
      setRowError((prev) => ({
        ...prev,
        [m.user_id]: e instanceof Error ? e.message : 'Failed to save',
      }));
    } finally {
      setSavingUserId(null);
    }
  };

  return (
    <div className="mt-8 bg-surface-1 rounded-app-lg p-6 border border-border-subtle">
      <h3 className="text-white font-medium mb-1">GHL user mapping</h3>
      <p className="text-sm text-text-secondary mb-4">
        Maps each member to their GHL user id, so a pulled contact's assigned owner (GHL-8) shows up
        as this member on the contact record. HyperDial never uses this to decide who dials a
        contact -- it's informational only.
      </p>
      <div className="space-y-2">
        {members.map((m) => {
          const name =
            [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.user_id;
          return (
            <div key={m.user_id} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate text-sm text-white" title={name}>
                {name}
              </span>
              <input
                type="text"
                value={valueFor(m)}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [m.user_id]: e.target.value }))}
                onBlur={() => handleSave(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                placeholder="GHL user id"
                disabled={savingUserId === m.user_id}
                className="flex-1 bg-surface-2 border border-white/10 rounded-app-md px-3 py-1.5 text-sm text-white placeholder-text-muted focus:outline-none focus:border-accent-to disabled:opacity-50"
              />
              {rowError[m.user_id] && (
                <span className="text-xs text-danger">{rowError[m.user_id]}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IntegrationsTab() {
  const { role } = useOrg();
  const isOwner = role === 'owner';

  const [status, setStatus] = useState<GhlIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [token, setToken] = useState('');
  const [locationId, setLocationId] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getGhlIntegrationStatus()
      .then(setStatus)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    setError(null);
    try {
      await connectGhl(token.trim(), locationId.trim());
      setToken('');
      setLocationId('');
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError(null);
    try {
      await disconnectGhl();
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setDisconnecting(false);
    }
  };

  const isConnected = status?.status === 'connected';

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <PageHeader
        title="Integrations"
        description="Connect a GHL (GoHighLevel) sub-account to sync dispositions, notes, tags and callback tasks after every call."
      />

      {error && (
        <div className="mb-6 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <Skeleton className="h-[140px] w-full max-w-xl rounded-app-lg" />
      ) : (
        <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-xl">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-app-md bg-gradient-to-br from-accent-from to-accent-to flex items-center justify-center">
                <Zap className="w-5 h-5 text-white" />
              </div>
              <div>
                <div className="text-white font-medium">GoHighLevel</div>
                <div className="text-sm text-text-secondary">
                  {isConnected && status?.location_id
                    ? `Location ${status.location_id}`
                    : 'Not connected'}
                </div>
              </div>
            </div>
            <span
              className={`px-2.5 py-1 rounded-full text-xs border ${
                isConnected
                  ? 'bg-success/10 text-success border-success/20'
                  : 'bg-white/5 text-text-secondary border-white/10'
              }`}
            >
              {isConnected
                ? 'Connected'
                : status?.status === 'pending_verification'
                  ? 'Pending'
                  : 'Disconnected'}
            </span>
          </div>

          {!isOwner ? (
            <p className="text-sm text-text-secondary">
              Only the org owner can connect or disconnect GHL.
            </p>
          ) : isConnected ? (
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="px-5 py-2.5 bg-danger/10 hover:bg-danger/20 border border-danger/30 rounded-app-md text-danger text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            >
              {disconnecting && <Loader2 className="w-4 h-4 animate-spin" />}
              Disconnect
            </button>
          ) : (
            <form onSubmit={handleConnect} className="space-y-4">
              <div>
                <label className="block text-sm text-text-secondary mb-2">
                  Private Integration Token
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  className="w-full bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
                  placeholder="pit-..."
                />
              </div>
              <div>
                <label className="block text-sm text-text-secondary mb-2">Location ID</label>
                <input
                  type="text"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  required
                  className="w-full bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
                  placeholder="Sub-account location ID"
                />
              </div>
              <button
                type="submit"
                disabled={connecting}
                className="px-6 py-3 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white font-semibold disabled:opacity-50 flex items-center gap-2"
              >
                {connecting && <Loader2 className="w-4 h-4 animate-spin" />}
                Connect GHL
              </button>
            </form>
          )}
        </div>
      )}

      {isConnected && (
        <GhlBlockedTagsEditor
          status={status}
          onSaved={load}
          isAdmin={isOwner || role === 'admin'}
        />
      )}
      {isConnected && status && (isOwner || role === 'admin') && (
        <GhlPullSettingsCard status={status} onSaved={load} />
      )}
      {isConnected && (isOwner || role === 'admin') && <GhlCampaignMappingsEditor />}
      {isConnected && <SyncStatusList />}
    </motion.div>
  );
}

/** TASK-G7 (GHL-7): owner/admin-editable lists of GHL tags that mean "do not call" / "paused" for
 *  this org. Both lists start from `status`'s current values (the DB's own defaults the first
 *  time an org connects) and are edited as a simple add/remove chip list -- no reason for
 *  anything fancier for a handful of short tag strings. */
function GhlBlockedTagsEditor({
  status,
  onSaved,
  isAdmin,
}: {
  status: GhlIntegrationStatus | null;
  onSaved: () => void;
  isAdmin: boolean;
}) {
  const [dncTags, setDncTags] = useState<string[]>(status?.ghl_dnc_tags ?? []);
  const [pausedTags, setPausedTags] = useState<string[]>(status?.ghl_paused_tags ?? []);
  const [dncDraft, setDncDraft] = useState('');
  const [pausedDraft, setPausedDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDncTags(status?.ghl_dnc_tags ?? []);
    setPausedTags(status?.ghl_paused_tags ?? []);
  }, [status]);

  const addTag = (
    list: string[],
    setList: (v: string[]) => void,
    draft: string,
    setDraft: (v: string) => void
  ) => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (list.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      setDraft('');
      return;
    }
    setList([...list, trimmed]);
    setDraft('');
  };

  const removeTag = (list: string[], setList: (v: string[]) => void, tag: string) => {
    setList(list.filter((t) => t !== tag));
  };

  const dirty =
    JSON.stringify(dncTags) !== JSON.stringify(status?.ghl_dnc_tags ?? []) ||
    JSON.stringify(pausedTags) !== JSON.stringify(status?.ghl_paused_tags ?? []);

  const handleSave = async () => {
    if (dncTags.length === 0 || pausedTags.length === 0) {
      setError('Each list needs at least one tag.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateGhlBlockedTags(dncTags, pausedTags);
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const tagList = (
    label: string,
    hint: string,
    list: string[],
    setList: (v: string[]) => void,
    draft: string,
    setDraft: (v: string) => void,
    inputId: string
  ) => (
    <div>
      <label htmlFor={inputId} className="block text-sm text-text-secondary mb-1">
        {label}
      </label>
      <p className="text-xs text-text-secondary mb-2">{hint}</p>
      <div className="flex flex-wrap gap-2 mb-2">
        {list.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-surface-2 border border-white/10 text-white"
          >
            {tag}
            {isAdmin && (
              <button
                type="button"
                onClick={() => removeTag(list, setList, tag)}
                className="text-text-secondary hover:text-danger"
                aria-label={`Remove ${tag}`}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {isAdmin && (
        <div className="flex gap-2">
          <input
            id={inputId}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag(list, setList, draft, setDraft);
              }
            }}
            className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
            placeholder="Add a tag"
          />
          <button
            type="button"
            onClick={() => addTag(list, setList, draft, setDraft)}
            className="px-3 py-2 bg-surface-2 border border-white/10 rounded-lg text-sm text-white hover:bg-surface-3"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-xl mt-4 space-y-5">
      <div>
        <div className="text-white font-medium mb-1">Blocked tags</div>
        <p className="text-sm text-text-secondary">
          Contacts tagged with any of these in GHL are never queued or dialed.
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {tagList(
        'Do-not-call tags',
        'A contact with one of these tags is marked do-not-call and added to the org-wide DNC list.',
        dncTags,
        setDncTags,
        dncDraft,
        setDncDraft,
        'ghl-dnc-tags-input'
      )}

      {tagList(
        'Paused tags',
        "A contact with one of these tags is skipped by new imports and pulled off any campaign it's already queued in, until the tag is removed and you re-queue it yourself.",
        pausedTags,
        setPausedTags,
        pausedDraft,
        setPausedDraft,
        'ghl-paused-tags-input'
      )}

      {isAdmin && (
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="px-5 py-2.5 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saved && !dirty ? 'Saved' : 'Save changes'}
        </button>
      )}
    </div>
  );
}

// MISSION-4 TASK-T2: keep in sync with supabase/functions/_shared/ghl-field-mapping.ts's
// GHL_FIELD_MAPPING_TARGET_KEYS -- duplicated because this Vite app can't import a Deno
// `_shared/*.ts` module (same three-copies reasoning as area-code-tz.ts).
const GHL_FIELD_MAPPING_TARGET_KEYS = [
  'business_name',
  'website',
  'rating',
  'review_count',
  'license_number',
  'service_zips',
  'tier',
  'list_source',
  'last_call_at',
  'last_call_outcome',
  'call_attempts',
  'callback_at',
  'call_duration',
  'recording_url',
] as const;

const GHL_FIELD_MAPPING_LABELS: Record<(typeof GHL_FIELD_MAPPING_TARGET_KEYS)[number], string> = {
  business_name: 'Business name',
  website: 'Website',
  rating: 'Rating',
  review_count: 'Review count',
  license_number: 'License #',
  service_zips: 'Service ZIPs',
  tier: 'Tier',
  list_source: 'List source',
  last_call_at: 'Last call time',
  last_call_outcome: 'Last call outcome',
  call_attempts: 'Call attempts',
  callback_at: 'Callback date/time',
  call_duration: 'Call duration (sec)',
  recording_url: 'Recording link',
};

/** MISSION-4 TASK-T1 (GHL-5/6): the 5-minute auto-pull toggle (disabled by default) + last-run
 *  status, and the custom-field mapping editor (target key -> GHL custom-field-definition id,
 *  paste-the-id same convention as the Telnyx API key field -- no live dropdown, see
 *  decisions.md for why). "Suggest" fetches the location's real field defs and a name-matched
 *  guess for any key not already configured. */
function GhlPullSettingsCard({
  status,
  onSaved,
}: {
  status: GhlIntegrationStatus;
  onSaved: () => void;
}) {
  const [pullEnabled, setPullEnabled] = useState(status.ghl_pull_enabled);
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>(
    status.ghl_field_mapping ?? {}
  );
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableFields, setAvailableFields] = useState<{ id: string; name: string }[] | null>(
    null
  );

  const dirty =
    pullEnabled !== status.ghl_pull_enabled ||
    JSON.stringify(fieldMapping) !== JSON.stringify(status.ghl_field_mapping ?? {});

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateGhlPullSettings(pullEnabled, fieldMapping);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save GHL pull settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const result = await getGhlFieldSuggestions();
      setAvailableFields(result.fields);
      setFieldMapping((prev) => ({ ...result.suggestedMapping, ...prev }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch GHL field suggestions');
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-xl mt-6">
      <h3 className="text-white font-medium mb-1">Scheduled pull + field mapping</h3>
      <p className="text-sm text-text-secondary mb-4">
        Every 5 minutes, HyperDial can automatically pull GHL contacts matching your tag/stage
        mappings below into their mapped campaign. Disabled by default -- turn it on once your
        mappings look right.
      </p>

      <label className="flex items-center gap-2 mb-4">
        <input
          type="checkbox"
          checked={pullEnabled}
          onChange={(e) => setPullEnabled(e.target.checked)}
        />
        <span className="text-sm text-white">Enable the 5-minute auto-pull</span>
      </label>

      {status.ghl_last_pull_at && (
        <p className="text-xs text-text-muted mb-4">
          Last run {new Date(status.ghl_last_pull_at).toLocaleString()} --{' '}
          <span
            className={status.ghl_last_pull_status === 'error' ? 'text-danger' : 'text-success'}
          >
            {status.ghl_last_pull_status}
          </span>
          {status.ghl_last_pull_counts &&
            ` (${status.ghl_last_pull_counts.created} created, ${status.ghl_last_pull_counts.updated} updated)`}
        </p>
      )}

      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm text-white font-medium">Custom field mapping</h4>
        <button
          type="button"
          onClick={handleSuggest}
          disabled={suggesting}
          className="text-xs text-accent-to hover:underline disabled:opacity-50"
        >
          {suggesting ? 'Checking GHL...' : 'Suggest from GHL'}
        </button>
      </div>
      <div className="space-y-2 mb-4">
        {GHL_FIELD_MAPPING_TARGET_KEYS.map((key) => (
          <div key={key} className="flex items-center gap-2">
            <label className="w-32 shrink-0 text-xs text-text-secondary">
              {GHL_FIELD_MAPPING_LABELS[key]}
            </label>
            <input
              type="text"
              list={availableFields ? 'ghl-field-defs' : undefined}
              value={fieldMapping[key] ?? ''}
              onChange={(e) => setFieldMapping((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder="GHL custom field id"
              className="flex-1 bg-surface-2 border border-white/10 rounded-app-md px-3 py-1.5 text-sm text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
            />
          </div>
        ))}
        {availableFields && (
          <datalist id="ghl-field-defs">
            {availableFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </datalist>
        )}
      </div>

      {error && <p className="text-sm text-danger mb-4">{error}</p>}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !dirty}
        className="px-5 py-2.5 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        Save changes
      </button>
    </div>
  );
}

/** MISSION-4 TASK-T1 (GHL-4): the org's tag/stage -> campaign mappings. Direct RLS CRUD (the
 *  table has real client policies, unlike org_integrations) -- no edge function needed for
 *  reads/writes here, only for listing the real pipeline/stage options (a live GHL call). */
function GhlCampaignMappingsEditor() {
  const [mappings, setMappings] = useState<GhlCampaignMapping[] | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignWithStats[]>([]);
  const [stages, setStages] = useState<GhlPipelineStageOption[] | null>(null);
  const [matchType, setMatchType] = useState<'tag' | 'stage'>('tag');
  const [tag, setTag] = useState('');
  const [stageKey, setStageKey] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([listGhlCampaignMappings(), listCampaigns()])
      .then(([m, c]) => {
        setMappings(m);
        setCampaigns(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleLoadStages = async () => {
    try {
      setStages(await listGhlPipelineStages());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load GHL pipelines');
    }
  };

  const handleAdd = async () => {
    if (!campaignId) {
      setError('Pick a campaign first.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (matchType === 'tag') {
        if (!tag.trim()) throw new Error('Enter a tag.');
        await createGhlTagCampaignMapping(tag.trim(), campaignId);
        setTag('');
      } else {
        const [pipelineId, pipelineStageId] = stageKey.split('|');
        if (!pipelineStageId) throw new Error('Pick a stage.');
        await createGhlStageCampaignMapping(pipelineId, pipelineStageId, campaignId);
        setStageKey('');
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add the mapping');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteGhlCampaignMapping(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the mapping');
    }
  };

  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.name ?? id;
  const stageName = (pipelineStageId: string) =>
    stages?.find((s) => s.stageId === pipelineStageId)?.stageName ?? pipelineStageId;

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-xl mt-6">
      <h3 className="text-white font-medium mb-1">Tag/stage → campaign mappings</h3>
      <p className="text-sm text-text-secondary mb-4">
        Contacts matching a tag or pipeline stage below are pulled and queued onto the mapped
        campaign, on-demand ("Sync now" on Campaigns) and automatically if the scheduled pull above
        is enabled.
      </p>

      {error && <p className="text-sm text-danger mb-3">{error}</p>}

      {mappings && mappings.length > 0 && (
        <div className="mb-4 divide-y divide-border-subtle border border-border-subtle rounded-app-md">
          {mappings.map((m) => (
            <div key={m.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="text-white">
                {m.match_type === 'tag'
                  ? `Tag "${m.tag}"`
                  : `Stage "${stageName(m.pipeline_stage_id!)}"`}
                <span className="text-text-muted"> -&gt; {campaignName(m.campaign_id)}</span>
              </span>
              <button
                type="button"
                onClick={() => handleDelete(m.id)}
                className="text-xs text-danger hover:underline"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mb-2">
        <select
          value={matchType}
          onChange={(e) => setMatchType(e.target.value as 'tag' | 'stage')}
          className="bg-surface-2 border border-white/10 rounded-app-md px-2 py-1.5 text-sm text-white"
        >
          <option value="tag">Tag</option>
          <option value="stage">Pipeline stage</option>
        </select>
        {matchType === 'tag' ? (
          <input
            type="text"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="GHL tag"
            className="flex-1 bg-surface-2 border border-white/10 rounded-app-md px-3 py-1.5 text-sm text-white placeholder-text-muted"
          />
        ) : stages ? (
          <select
            value={stageKey}
            onChange={(e) => setStageKey(e.target.value)}
            className="flex-1 bg-surface-2 border border-white/10 rounded-app-md px-3 py-1.5 text-sm text-white"
          >
            <option value="">Pick a stage...</option>
            {stages.map((s) => (
              <option key={s.stageId} value={`${s.pipelineId}|${s.stageId}`}>
                {s.pipelineName} / {s.stageName}
              </option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            onClick={handleLoadStages}
            className="flex-1 text-sm text-accent-to hover:underline text-left"
          >
            Load pipeline stages from GHL...
          </button>
        )}
        <select
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          className="bg-surface-2 border border-white/10 rounded-app-md px-2 py-1.5 text-sm text-white"
        >
          <option value="">Campaign...</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAdd}
          disabled={saving}
          className="px-3 py-1.5 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white text-sm font-medium disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

const SYNC_STATUS_BADGE: Record<CrmSyncJob['status'], string> = {
  queued: 'bg-white/5 text-text-secondary border-white/10',
  running: 'bg-accent-from/10 text-accent-from border-accent-from/20',
  done: 'bg-success/10 text-success border-success/20',
  failed: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  dead: 'bg-danger/10 text-danger border-danger/30',
};

/** Last 20 crm_sync_jobs for this org (TASK-P3-P3) -- a read-only status list, no retry/cancel
 *  action here (out of this task's scope; the worker's own backoff already retries queued
 *  rows automatically). */
function SyncStatusList() {
  const [jobs, setJobs] = useState<CrmSyncJob[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listCrmSyncJobs()
      .then(setJobs)
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mt-6 bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-xl">
      <h3 className="text-section-title text-text-primary mb-4">Sync status</h3>
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-text-secondary">No sync activity yet.</p>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center justify-between gap-3 py-2 border-b border-border-subtle last:border-0"
            >
              <div className="min-w-0">
                <div className="text-sm text-white capitalize">{job.kind.replace('_', ' ')}</div>
                {job.status === 'dead' && job.last_error && (
                  <div className="text-xs text-danger truncate" title={job.last_error}>
                    {job.last_error}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {job.attempts > 0 && (
                  <span className="text-xs text-text-secondary">{job.attempts} attempt(s)</span>
                )}
                <span
                  className={`px-2.5 py-1 rounded-full text-xs border ${SYNC_STATUS_BADGE[job.status]}`}
                >
                  {job.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const LEAD_EFFECT_LABEL: Record<DispositionLeadEffect, string> = {
  completed: 'Completed',
  callback: 'Callback',
  exhausted: 'Exhausted',
  dnc: 'Do not call',
  queued: 'Requeue (+1 attempt)',
};

/** Settings -> Dispositions editor (TASK-P3-E1, design §5), admin+ only. A simple list edit per
 *  the task spec: `key`/`lead_effect` are fixed at creation (see api.ts's UpdateDispositionInput
 *  comment for why) -- editing here covers label/GHL tag/task-creation/sort/active. The mandatory
 *  wrap-up form (E4, not built yet) is the other consumer of this table; nothing here depends on
 *  it landing. */
function DispositionsTab() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';

  const [dispositions, setDispositions] = useState<Disposition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newLeadEffect, setNewLeadEffect] = useState<DispositionLeadEffect>('completed');
  const [newGhlTag, setNewGhlTag] = useState('');
  const [newCreatesTask, setNewCreatesTask] = useState(false);
  const [newIsWin, setNewIsWin] = useState(false);
  const [newRequiresLicense, setNewRequiresLicense] = useState(false);
  const [newRequiresZips, setNewRequiresZips] = useState(false);

  const [editLabel, setEditLabel] = useState('');
  const [editGhlTag, setEditGhlTag] = useState('');
  const [editCreatesTask, setEditCreatesTask] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  // MISSION-4 TASK-T2 (GHL-12): "pipelineId|stageId", same combined-<select>-value convention
  // GhlCampaignMappingsEditor already uses -- '' means "unmapped, no move".
  const [editStageKey, setEditStageKey] = useState('');
  const [ghlStages, setGhlStages] = useState<GhlPipelineStageOption[] | null>(null);
  const [loadingStages, setLoadingStages] = useState(false);

  // TASK-M5-E7: disposition quality checks. Org-wide master switch + per-disposition rule
  // toggles -- a completely separate concern from the fields above (key/label/GHL/lead effect),
  // loaded alongside them but tracked in its own state so a rule save never touches a
  // disposition's own row.
  const [qualityEnabled, setQualityEnabled] = useState(false);
  const [qualityTogglingOrg, setQualityTogglingOrg] = useState(false);
  const [qualityRules, setQualityRules] = useState<DispositionQualityRule[]>([]);
  const [expandedQualityId, setExpandedQualityId] = useState<string | null>(null);
  const [qualitySavingKey, setQualitySavingKey] = useState<string | null>(null);

  const loadQuality = useCallback(() => {
    Promise.all([getOrgQualityChecksEnabled(), listDispositionQualityRules()])
      .then(([enabled, rules]) => {
        setQualityEnabled(enabled);
        setQualityRules(rules);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (isAdmin) loadQuality();
  }, [isAdmin, loadQuality]);

  const toggleOrgQualityChecks = async () => {
    setQualityTogglingOrg(true);
    setError(null);
    try {
      await setOrgQualityChecksEnabled(!qualityEnabled);
      setQualityEnabled(!qualityEnabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setQualityTogglingOrg(false);
    }
  };

  const getQualityRule = (dispositionId: string, ruleType: QualityRuleType) =>
    qualityRules.find((r) => r.disposition_id === dispositionId && r.rule_type === ruleType) ??
    null;

  const saveQualityRule = async (
    dispositionId: string,
    ruleType: QualityRuleType,
    enabled: boolean,
    config: Record<string, unknown>
  ) => {
    setQualitySavingKey(`${dispositionId}:${ruleType}`);
    setError(null);
    try {
      await setDispositionQualityRule(dispositionId, ruleType, enabled, config);
      loadQuality();
    } catch (e) {
      setError(String(e));
    } finally {
      setQualitySavingKey(null);
    }
  };

  const handleLoadGhlStages = async () => {
    setLoadingStages(true);
    setError(null);
    try {
      setGhlStages(await listGhlPipelineStages());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load GHL pipelines');
    } finally {
      setLoadingStages(false);
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    listDispositions()
      .then(setDispositions)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startEdit = (d: Disposition) => {
    setEditingId(d.id);
    setEditLabel(d.label);
    setEditGhlTag(d.ghl_tag ?? '');
    setEditCreatesTask(d.creates_task);
    setEditStageKey(
      d.ghl_pipeline_id && d.ghl_pipeline_stage_id
        ? `${d.ghl_pipeline_id}|${d.ghl_pipeline_stage_id}`
        : ''
    );
  };

  const saveEdit = async (id: string) => {
    setSavingId(id);
    setError(null);
    try {
      const [ghlPipelineId, ghlPipelineStageId] = editStageKey
        ? editStageKey.split('|')
        : [null, null];
      await updateDisposition(id, {
        label: editLabel.trim(),
        ghl_tag: editGhlTag.trim() || null,
        creates_task: editCreatesTask,
        ghl_pipeline_id: ghlPipelineId,
        ghl_pipeline_stage_id: ghlPipelineStageId,
      });
      setEditingId(null);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingId(null);
    }
  };

  const toggleActive = async (d: Disposition) => {
    setSavingId(d.id);
    setError(null);
    try {
      await updateDisposition(d.id, { active: !d.active });
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (d: Disposition) => {
    setSavingId(d.id);
    setError(null);
    try {
      await deleteDisposition(d.id);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingId(null);
    }
  };

  // B1-009: reorder via up/down (not drag-to-reorder -- the task file offers either). Persists to
  // the live `sort` column (the task's own text says "sort_order"; the real column has always
  // been named `sort` since TASK-P3-E1 -- see known-issues.md). Re-derives the WHOLE order from
  // the swapped local array and writes sort = (position+1)*10 to every row whose value actually
  // changes -- NOT a pairwise swap of the two neighbors' existing `sort` values. A pairwise swap
  // is a no-op when the two already share a `sort` (known-issues.md #30: TASK-F-P1's ADD-only
  // migration backfill reused the seed's fixed constants, colliding with a pre-existing org's own
  // rows); renumbering the full list by position self-heals any such collision on first use,
  // fixed-forward here with no migration/backfill -- only a user-triggered reorder ever changes a
  // real org's data. WrapUpModal's 1-9 shortcuts already follow `sort` (listDispositions orders by
  // it), so this reorder takes effect there immediately on next load.
  const moveDisposition = async (index: number, direction: -1 | 1) => {
    const neighborIndex = index + direction;
    if (neighborIndex < 0 || neighborIndex >= dispositions.length) return;
    const reordered = [...dispositions];
    [reordered[index], reordered[neighborIndex]] = [reordered[neighborIndex], reordered[index]];
    setMovingId(dispositions[index].id);
    setError(null);
    try {
      const updates = reordered
        .map((d, i) => ({ d, sort: (i + 1) * 10 }))
        .filter(({ d, sort }) => d.sort !== sort);
      await Promise.all(updates.map(({ d, sort }) => updateDisposition(d.id, { sort })));
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setMovingId(null);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const requiredFields: string[] = [];
      if (newRequiresLicense) requiredFields.push('license_number');
      if (newRequiresZips) requiredFields.push('zips');
      await createDisposition({
        key: newKey.trim(),
        label: newLabel.trim(),
        lead_effect: newLeadEffect,
        ghl_tag: newGhlTag.trim() || null,
        creates_task: newCreatesTask,
        sort: dispositions.length * 10 + 10,
        is_win: newIsWin,
        required_fields: requiredFields.length > 0 ? requiredFields : null,
      });
      setNewKey('');
      setNewLabel('');
      setNewLeadEffect('completed');
      setNewGhlTag('');
      setNewCreatesTask(false);
      setNewIsWin(false);
      setNewRequiresLicense(false);
      setNewRequiresZips(false);
      setShowCreate(false);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <PageHeader
        title="Dispositions"
        description="The outcomes agents choose after each call, and their effect on the lead and on GHL."
      />

      {error && (
        <div className="mb-6 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {!isAdmin ? (
        <p className="text-sm text-text-secondary">
          Only an owner or admin can manage dispositions.
        </p>
      ) : loading ? (
        <Skeleton className="h-[320px] w-full max-w-2xl rounded-app-lg" />
      ) : (
        <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-2xl">
          <div className="flex items-center justify-between gap-3 mb-4 pb-4 border-b border-border-subtle">
            <div>
              <div className="text-sm font-medium text-white">Disposition quality checks</div>
              <div className="text-xs text-text-secondary mt-0.5">
                A failed rule never blocks or changes a disposition -- it flags the call for review.
                OFF by default; configure per-disposition rules with the "Quality" button below once
                enabled.
              </div>
            </div>
            <button
              onClick={toggleOrgQualityChecks}
              disabled={qualityTogglingOrg}
              className={`px-3 py-1.5 rounded-full text-xs border flex-shrink-0 disabled:opacity-50 ${
                qualityEnabled
                  ? 'bg-success/10 text-success border-success/20'
                  : 'bg-white/5 text-text-secondary border-white/10'
              }`}
            >
              {qualityEnabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          <div className="space-y-2 mb-4">
            {dispositions.map((d, index) => (
              <div key={d.id} className="py-3 border-b border-border-subtle last:border-0">
                {editingId === d.id ? (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
                        placeholder="Label"
                      />
                      <input
                        type="text"
                        value={editGhlTag}
                        onChange={(e) => setEditGhlTag(e.target.value)}
                        className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
                        placeholder="GHL tag (optional)"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-text-secondary">
                      <input
                        type="checkbox"
                        checked={editCreatesTask}
                        onChange={(e) => setEditCreatesTask(e.target.checked)}
                      />
                      Creates a GHL task
                    </label>
                    <div className="flex items-center gap-2">
                      {ghlStages ? (
                        <select
                          value={editStageKey}
                          onChange={(e) => setEditStageKey(e.target.value)}
                          className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                        >
                          <option value="">No GHL pipeline stage move</option>
                          {ghlStages.map((s) => (
                            <option key={s.stageId} value={`${s.pipelineId}|${s.stageId}`}>
                              {s.pipelineName} / {s.stageName}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <button
                          type="button"
                          onClick={handleLoadGhlStages}
                          disabled={loadingStages}
                          className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-text-secondary text-sm disabled:opacity-50"
                        >
                          {loadingStages
                            ? 'Loading...'
                            : 'Load pipeline stages from GHL to set a move...'}
                        </button>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveEdit(d.id)}
                        disabled={savingId === d.id}
                        className="px-4 py-2 bg-gradient-to-r from-accent-from to-accent-to rounded-lg text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                      >
                        {savingId === d.id && <Loader2 className="w-4 h-4 animate-spin" />}
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-text-secondary text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div
                        className={`text-sm font-medium flex items-center gap-1.5 ${d.active ? 'text-white' : 'text-text-secondary line-through'}`}
                      >
                        {d.label}
                        {d.is_win && (
                          <Trophy
                            className="w-3.5 h-3.5 text-warning flex-shrink-0"
                            aria-label="Counts as a win"
                          />
                        )}
                      </div>
                      <div className="text-xs text-text-secondary mt-0.5">
                        {LEAD_EFFECT_LABEL[d.lead_effect]}
                        {d.ghl_tag ? ` · GHL tag "${d.ghl_tag}"` : ' · no GHL tag'}
                        {d.creates_task ? ' · creates task' : ''}
                        {d.required_fields && d.required_fields.length > 0
                          ? ` · requires ${d.required_fields.join(', ')}`
                          : ''}
                        {d.ghl_pipeline_stage_id ? ' · moves GHL pipeline stage' : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <div className="flex flex-col">
                        <button
                          onClick={() => moveDisposition(index, -1)}
                          disabled={index === 0 || movingId !== null}
                          className="p-0.5 text-text-secondary hover:text-white disabled:opacity-30"
                          title="Move up"
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => moveDisposition(index, 1)}
                          disabled={index === dispositions.length - 1 || movingId !== null}
                          className="p-0.5 text-text-secondary hover:text-white disabled:opacity-30"
                          title="Move down"
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <button
                        onClick={() => toggleActive(d)}
                        disabled={savingId === d.id}
                        className={`px-2.5 py-1 rounded-full text-xs border disabled:opacity-50 ${
                          d.active
                            ? 'bg-success/10 text-success border-success/20'
                            : 'bg-white/5 text-text-secondary border-white/10'
                        }`}
                      >
                        {d.active ? 'Active' : 'Inactive'}
                      </button>
                      <button
                        onClick={() =>
                          setExpandedQualityId(expandedQualityId === d.id ? null : d.id)
                        }
                        className={`px-2.5 py-1 rounded-full text-xs border ${
                          getQualityRule(d.id, 'min_talk_seconds')?.enabled ||
                          getQualityRule(d.id, 'required_field')?.enabled ||
                          getQualityRule(d.id, 'rate_outlier')?.enabled
                            ? 'bg-warning/10 text-warning border-warning/20'
                            : 'bg-white/5 text-text-secondary border-white/10'
                        }`}
                        title="Quality checks (flag, never block)"
                      >
                        Quality
                      </button>
                      <button
                        onClick={() => startEdit(d)}
                        className="p-1.5 text-text-secondary hover:text-white"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(d)}
                        disabled={savingId === d.id}
                        className="p-1.5 text-text-secondary hover:text-danger disabled:opacity-50"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
                {expandedQualityId === d.id && (
                  <QualityRulesEditor
                    disposition={d}
                    minTalkRule={getQualityRule(d.id, 'min_talk_seconds')}
                    requiredFieldRule={getQualityRule(d.id, 'required_field')}
                    rateOutlierRule={getQualityRule(d.id, 'rate_outlier')}
                    savingKey={qualitySavingKey}
                    onSave={saveQualityRule}
                  />
                )}
              </div>
            ))}
          </div>

          {showCreate ? (
            <form onSubmit={handleCreate} className="space-y-3 pt-4 border-t border-border-subtle">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  required
                  pattern="[a-z0-9_]+"
                  title="lowercase letters, numbers and underscores only"
                  className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
                  placeholder="key (e.g. not_home)"
                />
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  required
                  className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
                  placeholder="Label shown to agents"
                />
              </div>
              <div className="flex gap-2">
                <select
                  value={newLeadEffect}
                  onChange={(e) => setNewLeadEffect(e.target.value as DispositionLeadEffect)}
                  className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
                >
                  {(Object.keys(LEAD_EFFECT_LABEL) as DispositionLeadEffect[]).map((k) => (
                    <option key={k} value={k}>
                      {LEAD_EFFECT_LABEL[k]}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newGhlTag}
                  onChange={(e) => setNewGhlTag(e.target.value)}
                  className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
                  placeholder="GHL tag (optional)"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={newCreatesTask}
                  onChange={(e) => setNewCreatesTask(e.target.checked)}
                />
                Creates a GHL task (only meaningful for a "Callback"-style effect)
              </label>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={newIsWin}
                  onChange={(e) => setNewIsWin(e.target.checked)}
                />
                Counts as a win (Dashboard's "Wins today")
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={newRequiresLicense}
                    onChange={(e) => setNewRequiresLicense(e.target.checked)}
                  />
                  Requires license number
                </label>
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={newRequiresZips}
                    onChange={(e) => setNewRequiresZips(e.target.checked)}
                  />
                  Requires ZIP codes
                </label>
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 bg-gradient-to-r from-accent-from to-accent-to rounded-lg text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                  Add disposition
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-text-secondary text-sm flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              className="mt-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-text-secondary text-sm flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add disposition
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}

/** TASK-M5-E7: the per-disposition quality-rules editor, expanded inline under one disposition
 *  row in DispositionsTab. Three independent rule types, each its own enabled toggle + config --
 *  a disposition can have all three, some, or none. Saves go straight through
 *  setDispositionQualityRule (one RPC call per rule type), never a batched multi-rule save --
 *  matches the RPC's own one-rule-at-a-time upsert shape. */
function QualityRulesEditor({
  disposition,
  minTalkRule,
  requiredFieldRule,
  rateOutlierRule,
  savingKey,
  onSave,
}: {
  disposition: Disposition;
  minTalkRule: DispositionQualityRule | null;
  requiredFieldRule: DispositionQualityRule | null;
  rateOutlierRule: DispositionQualityRule | null;
  savingKey: string | null;
  onSave: (
    dispositionId: string,
    ruleType: QualityRuleType,
    enabled: boolean,
    config: Record<string, unknown>
  ) => void;
}) {
  const [minSeconds, setMinSeconds] = useState(
    String((minTalkRule?.config.min_seconds as number | undefined) ?? 30)
  );
  const [requiresNotes, setRequiresNotes] = useState(
    ((requiredFieldRule?.config.fields as string[] | undefined) ?? []).includes('notes')
  );
  const [requiresCallbackAt, setRequiresCallbackAt] = useState(
    ((requiredFieldRule?.config.fields as string[] | undefined) ?? []).includes('callback_at')
  );
  const [multiplier, setMultiplier] = useState(
    String((rateOutlierRule?.config.multiplier as number | undefined) ?? 2)
  );

  const minTalkKey = `${disposition.id}:min_talk_seconds`;
  const requiredFieldKey = `${disposition.id}:required_field`;
  const rateOutlierKey = `${disposition.id}:rate_outlier`;

  return (
    <div className="mt-3 ml-1 pl-3 border-l-2 border-warning/30 space-y-4">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={minTalkRule?.enabled ?? false}
          disabled={savingKey === minTalkKey}
          onChange={(e) =>
            onSave(disposition.id, 'min_talk_seconds', e.target.checked, {
              min_seconds: parseInt(minSeconds, 10) || 30,
            })
          }
        />
        <span className="text-sm text-text-secondary">Requires at least</span>
        <input
          type="number"
          min={1}
          max={36000}
          value={minSeconds}
          onChange={(e) => setMinSeconds(e.target.value)}
          onBlur={() =>
            minTalkRule?.enabled &&
            onSave(disposition.id, 'min_talk_seconds', true, {
              min_seconds: parseInt(minSeconds, 10) || 30,
            })
          }
          className="w-16 bg-surface-2 border border-white/10 rounded px-2 py-1 text-sm text-white"
        />
        <span className="text-sm text-text-secondary">seconds of bridged talk time</span>
      </div>

      <div className="space-y-1.5">
        <div className="text-sm text-text-secondary">
          Requires before this disposition counts as complete:
        </div>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={requiresNotes}
            disabled={savingKey === requiredFieldKey}
            onChange={(e) => {
              setRequiresNotes(e.target.checked);
              const fields = [
                ...(e.target.checked ? ['notes'] : []),
                ...(requiresCallbackAt ? ['callback_at'] : []),
              ];
              onSave(disposition.id, 'required_field', fields.length > 0, { fields });
            }}
          />
          A note
        </label>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={requiresCallbackAt}
            disabled={savingKey === requiredFieldKey}
            onChange={(e) => {
              setRequiresCallbackAt(e.target.checked);
              const fields = [
                ...(requiresNotes ? ['notes'] : []),
                ...(e.target.checked ? ['callback_at'] : []),
              ];
              onSave(disposition.id, 'required_field', fields.length > 0, { fields });
            }}
          />
          A callback/appointment time
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={rateOutlierRule?.enabled ?? false}
          disabled={savingKey === rateOutlierKey}
          onChange={(e) =>
            onSave(disposition.id, 'rate_outlier', e.target.checked, {
              multiplier: parseFloat(multiplier) || 2,
              min_sample: 5,
            })
          }
        />
        <span className="text-sm text-text-secondary">
          Flag an agent whose share of this disposition is more than
        </span>
        <input
          type="number"
          min={1.1}
          max={100}
          step={0.1}
          value={multiplier}
          onChange={(e) => setMultiplier(e.target.value)}
          onBlur={() =>
            rateOutlierRule?.enabled &&
            onSave(disposition.id, 'rate_outlier', true, {
              multiplier: parseFloat(multiplier) || 2,
              min_sample: 5,
            })
          }
          className="w-16 bg-surface-2 border border-white/10 rounded px-2 py-1 text-sm text-white"
        />
        <span className="text-sm text-text-secondary">x the team's (Team page, live)</span>
      </div>
    </div>
  );
}

/** Settings -> Do-not-call list (TASK-F-T1, QUE-7/DSP-6), owner/admin only. Small and functional
 *  per the task spec -- eng3's polish comes later. Lists the org-wide dnc_numbers table (RLS:
 *  any member can read, only owner/admin can insert/delete), with search, manual add
 *  (normalized to E.164 client-side before the insert, matching createContact's own convention),
 *  and remove. */
/** TASK-F-T2: org-wide record/don't-record toggle, owner/admin only. Own fetch-on-mount/save
 *  lifecycle (independent of any other tab's Save button), same shape as CampaignManageModal's
 *  RetryRulesCard. Rendered as a card inside the existing Telephony tab, not a new tab -- this
 *  is one setting, not a whole editor. */
function RecordingSettingsCard() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';

  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // MISSION-4 TASK-T8 (recording consent notice): a second, independent setting on the same
  // table/card -- "should recording be on at all" (above) is orthogonal to "should the prospect
  // be told it's on" (below). Own loading/saving/error state so a failure in one never blocks
  // the other.
  const [consentMode, setConsentMode] = useState<AnnounceRecordingMode>('never');
  const [consentStatesText, setConsentStatesText] = useState('');
  // MISSION-5 TASK-M5-B2 (EC-17): a third, independent flag on the same setting -- "recorded"
  // (above) vs. "recorded AND monitored" wording, relevant once this org uses live coaching.
  const [mentionMonitoring, setMentionMonitoring] = useState(false);
  const [consentLoading, setConsentLoading] = useState(true);
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      setConsentLoading(false);
      return;
    }
    getRecordingEnabled()
      .then(setEnabled)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    getRecordingConsentSettings()
      .then((s) => {
        setConsentMode(s.announceRecordingMode);
        setConsentStatesText(s.allPartyConsentStates.join(', '));
        setMentionMonitoring(s.mentionMonitoring);
      })
      .catch((e) => setConsentError(String(e)))
      .finally(() => setConsentLoading(false));
  }, [isAdmin]);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      await setRecordingEnabled(next);
    } catch (e) {
      setError(String(e));
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  };

  const saveConsentSettings = async (
    nextMode: AnnounceRecordingMode,
    nextStatesText: string,
    nextMentionMonitoring: boolean
  ) => {
    setConsentSaving(true);
    setConsentError(null);
    try {
      const states = nextStatesText
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0);
      await setRecordingConsentSettings({
        announceRecordingMode: nextMode,
        allPartyConsentStates: states,
        mentionMonitoring: nextMentionMonitoring,
      });
    } catch (e) {
      setConsentError(String(e));
    } finally {
      setConsentSaving(false);
    }
  };

  const handleConsentModeChange = (next: AnnounceRecordingMode) => {
    setConsentMode(next);
    void saveConsentSettings(next, consentStatesText, mentionMonitoring);
  };

  const handleConsentStatesBlur = () => {
    void saveConsentSettings(consentMode, consentStatesText, mentionMonitoring);
  };

  const handleMentionMonitoringChange = (next: boolean) => {
    setMentionMonitoring(next);
    void saveConsentSettings(consentMode, consentStatesText, next);
  };

  if (!isAdmin) return null;

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-2xl mt-6">
      <h3 className="text-section-title text-text-primary mb-1">Call recording</h3>
      <p className="text-sm text-text-secondary mb-4">
        Record every answered call for this org. Texas is a one-party-consent state; check your own
        state's law before enabling this.
      </p>
      {error && <p className="text-sm text-danger mb-3">{error}</p>}
      {loading ? (
        <Skeleton className="h-6 w-40" />
      ) : (
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void handleToggle(e.target.checked)}
          />
          Record calls
        </label>
      )}

      <div className="mt-5 pt-5 border-t border-border-subtle">
        <h4 className="text-body font-medium text-text-primary mb-1">Recording consent notice</h4>
        <p className="text-sm text-text-secondary mb-3">
          Whether the prospect hears "this call may be recorded" right after connecting. Not legal
          advice -- the state list below is a common reference default, editable for your own org's
          actual compliance needs.
        </p>
        {consentError && <p className="text-sm text-danger mb-3">{consentError}</p>}
        {consentLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="space-y-3">
            <select
              className="bg-surface-2 border border-border-subtle rounded-app-md px-3 py-2 text-sm text-text-primary"
              value={consentMode}
              disabled={consentSaving}
              onChange={(e) => handleConsentModeChange(e.target.value as AnnounceRecordingMode)}
            >
              <option value="never">Never announce</option>
              <option value="all">Announce on every recorded call</option>
              <option value="all_party_consent_states">
                Announce only in all-party-consent states
              </option>
            </select>
            {consentMode === 'all_party_consent_states' && (
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  All-party-consent states (comma-separated 2-letter codes)
                </label>
                <input
                  type="text"
                  className="bg-surface-2 border border-border-subtle rounded-app-md px-3 py-2 text-sm text-text-primary w-full"
                  value={consentStatesText}
                  disabled={consentSaving}
                  onChange={(e) => setConsentStatesText(e.target.value)}
                  onBlur={handleConsentStatesBlur}
                  placeholder="CA, CT, FL, ..."
                />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-white">
              <input
                type="checkbox"
                checked={mentionMonitoring}
                disabled={consentSaving}
                onChange={(e) => handleMentionMonitoringChange(e.target.checked)}
              />
              Also mention the call may be monitored
            </label>
            <p className="text-sm text-text-secondary">
              Turn this on if your team uses live coaching (Listen/Whisper/Barge) -- "may be
              recorded" alone doesn't disclose that a supervisor may be silently listening in, which
              all-party-consent states require the caller be told.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** TASK-T4 review fix-forward (BLOCKER 2): default-off org toggle for external-number transfers.
 *  Same admin-only shape as RecordingSettingsCard just above -- the server-side check in
 *  transfer-core.ts is what actually enforces this; this toggle (and TransferModal hiding the
 *  option when off) are the UX half. */
function ExternalTransferSettingsCard() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';

  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    getAllowExternalTransfers()
      .then(setEnabled)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [isAdmin]);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      await setAllowExternalTransfers(next);
    } catch (e) {
      setError(String(e));
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) return null;

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-2xl mt-6">
      <h3 className="text-section-title text-text-primary mb-1">External-number transfers</h3>
      <p className="text-sm text-text-secondary mb-4">
        Let interns warm/cold transfer a live call to an arbitrary phone number, not just a
        teammate. Off by default -- each transfer still dials out and is billed to this org.
      </p>
      {error && <p className="text-sm text-danger mb-3">{error}</p>}
      {loading ? (
        <Skeleton className="h-6 w-40" />
      ) : (
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void handleToggle(e.target.checked)}
          />
          Allow transfers to external numbers
        </label>
      )}
    </div>
  );
}

/** TASK-F-T3 (VMD-1): one sub-card per scope ('self' -- every member; 'org' -- owner/admin
 *  only). Both share the same upload/preview shape; only the loader/uploader functions differ. */
function VoicemailDropSubCard({
  title,
  description,
  load,
  upload,
}: {
  title: string;
  description: string;
  load: () => Promise<VoicemailDropInfo>;
  upload: (file: File) => Promise<VoicemailDropInfo>;
}) {
  const [info, setInfo] = useState<VoicemailDropInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load()
      .then(setInfo)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // Only re-run if the loader identity itself changes (self vs org) -- not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const result = await upload(file);
      setInfo(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="border-t border-border-subtle pt-4 mt-4 first:border-0 first:pt-0 first:mt-0">
      <h4 className="text-sm font-semibold text-white mb-1">{title}</h4>
      <p className="text-xs text-text-secondary mb-3">{description}</p>
      {error && <p className="text-sm text-danger mb-2">{error}</p>}
      {loading ? (
        <Skeleton className="h-9 w-full max-w-sm" />
      ) : (
        <div className="flex flex-col gap-2">
          {info?.hasFile && info.url && (
            <audio controls src={info.url} className="w-full max-w-sm h-9" />
          )}
          <label className="inline-flex items-center gap-2 px-3 py-2 bg-surface-2 border border-white/10 rounded-lg text-sm text-white cursor-pointer w-fit hover:bg-white/10">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {info?.hasFile ? 'Replace file (mp3/wav, max 5MB)' : 'Upload a file (mp3/wav, max 5MB)'}
            <input
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/wave,audio/x-wav"
              disabled={uploading}
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
          </label>
        </div>
      )}
    </div>
  );
}

/** TASK-F-T3 (VMD-1): "record-or-upload a file, playback preview, and the org default for
 *  owner/admin." Every member manages their own drop; only owner/admin also sees the org
 *  default sub-card. */
function VoicemailDropCard() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-2xl mt-6">
      <h3 className="text-section-title text-text-primary mb-1">Voicemail drop</h3>
      <p className="text-sm text-text-secondary mb-4">
        Played automatically when the dialer detects an answering machine (campaign-dependent -- see
        the campaign's own Dialer Settings for the voicemail mode and AMD mode).
      </p>
      <VoicemailDropSubCard
        title="Your voicemail drop"
        description="Used when you're the agent on the session, before falling back to the org default."
        load={getMyVoicemailDrop}
        upload={uploadMyVoicemailDrop}
      />
      {isAdmin && (
        <VoicemailDropSubCard
          title="Org default"
          description="Used for any agent who hasn't set their own voicemail drop."
          load={getOrgDefaultVoicemailDrop}
          upload={uploadOrgDefaultVoicemailDrop}
        />
      )}
    </div>
  );
}

const AUTO_RESUME_OPTIONS: Array<{ value: 0 | 5 | 10 | 15; label: string }> = [
  { value: 0, label: 'Manual -- I’ll click Resume myself' },
  { value: 5, label: 'Auto-resume after 5s' },
  { value: 10, label: 'Auto-resume after 10s' },
  { value: 15, label: 'Auto-resume after 15s' },
];

/** MISSION-4 TASK-T7: per-user (not org-admin-gated) pacing preference, same shape as
 *  `VoicemailDropCard`'s own "Your voicemail drop" subcard just above -- every agent sets their
 *  own value, no role check. NULL/no row (nothing selected here) is a DISTINCT state from the
 *  literal `0` on the server (NULL = submit_disposition never pauses at all, the old behaviour;
 *  `0` = pauses with no timer, a manual Resume click) -- see the migration's own header comment.
 *  This card leaves every radio unchecked until the agent picks one, rather than defaulting the
 *  UI to "Manual" (which would misrepresent the true default as a pause when it is actually no
 *  pause at all). Once touched, there is no way back to NULL from this UI -- picking "Manual"
 *  explicitly writes `0`, a real behavior change from the untouched default. */
function AutoResumeSettingsCard() {
  const { user } = useAuth();
  const [value, setValue] = useState<0 | 5 | 10 | 15 | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getUserPreferences()
      .then((prefs) => setValue(prefs?.auto_resume_seconds ?? null))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = async (next: 0 | 5 | 10 | 15) => {
    if (!user?.id) return;
    const prev = value;
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      await saveUserPreferences(user.id, { auto_resume_seconds: next });
    } catch (e) {
      setError(String(e));
      setValue(prev);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-2xl mt-6">
      <h3 className="text-section-title text-text-primary mb-1">Wrap-up auto-resume</h3>
      <p className="text-sm text-text-secondary mb-4">
        After you submit a disposition, choose how the next batch starts: right away after a short
        countdown, or only when you click Resume (or press Space).
        {value === null &&
          ' Default: resumes immediately, exactly like before this setting existed.'}
      </p>
      {error && <p className="text-sm text-danger mb-3">{error}</p>}
      {loading ? (
        <Skeleton className="h-6 w-40" />
      ) : (
        <div className="flex flex-col gap-2">
          {AUTO_RESUME_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm text-white">
              <input
                type="radio"
                name="auto-resume-seconds"
                checked={value === opt.value}
                disabled={saving}
                onChange={() => void handleChange(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** MISSION-5 TASK-A1: the Activity page -- newest first, filters (person/action/date range),
 *  paging, CSV export. Owner/admin only (route-gated the same way as every other manager-only
 *  tab in this file -- `!isAgent` in the `tabs` array below); `org-audit-log`'s own
 *  `requireOrgRole` is the real enforcement, this is cosmetic narrowing same as every other tab
 *  here (see NumberPoolCard's own comment on this exact pattern). */
const ACTIVITY_PAGE_SIZE = 50;
const ACTIVITY_EXPORT_LIMIT = 200;

const AUDIT_ACTION_LABELS: Record<string, string> = {
  'member.role_change': 'Changed a member role',
  'member.disable': 'Disabled a member',
  'member.enable': 'Re-enabled a member',
  'member.remove': 'Removed a member',
  'member.set_ghl_user_id': 'Set a member GHL mapping',
  'invite.create': 'Created an invite',
  'campaign_leads.assign': 'Assigned leads',
  'campaign_leads.callback_fallback_claim': 'Callback fallback-claimed leads',
  'coaching.start': 'Started coaching a call',
  'coaching.end': 'Ended a coaching call',
  'session.remote_pause': 'Remotely paused a session',
  'session.remote_end': 'Remotely ended a session',
  'session.remote_hangup': 'Remotely hung up a call',
  'ghl.connect': 'Connected GHL',
  'ghl.disconnect': 'Disconnected GHL',
  'ghl.update_blocked_tags': 'Updated GHL blocked tags',
  'ghl.update_pull_settings': 'Updated GHL pull settings',
  'settings.spend.update': 'Updated spend settings',
  'settings.reliability_alerts.update': 'Updated reliability alert settings',
  'settings.recording.update': 'Updated recording/consent settings',
  'settings.transfer.update': 'Updated transfer settings',
  'settings.supervisor_alerts.update': 'Updated supervisor alert settings',
  'settings.notification_preferences.update': 'Updated notification preferences',
  'export.team_csv': 'Exported the team daily CSV',
  'export.analytics_csv': 'Exported the analytics CSV',
  'goal.set': 'Set a team goal',
  'goal.delete': 'Removed a team goal',
  'broadcast.create': 'Posted a broadcast',
  'broadcast.delete': 'Removed a broadcast',
  // TASK-Q2F (Q2 finding #1): every remaining `log_org_action`/`logOrgAction` call site in the
  // repo, found by grepping every migration (direct calls + the `audit_log_settings_change_
  // trigger` wrapper) and every Edge Function, plus `org-audit-log`'s own client-event allowlist
  // -- not just the 7 the Q2 report happened to see.
  'invite.accept': 'Accepted an invite',
  'invite.resend': 'Resent an invite',
  'invite.revoke': 'Revoked an invite',
  'member.restore': 'Restored a member',
  'member.reactivate_via_invite': 'Reactivated a member via invite',
  'member.release_queued_leads': "Released a member's queued leads",
  'member.set_pod': "Set a member's pod",
  'member.set_manager_pods': "Set a manager's pod scope",
  'session.call_takeover': 'Took over a live call',
  'campaign.distribution_mode.update': "Changed a campaign's distribution mode",
  'campaign.restore_script_version': 'Restored a campaign script version',
  'campaign_leads.round_robin_assign': 'Round-robin assigned leads',
  'campaign_leads.territory_auto_assign': 'Territory-assigned leads',
  'territory_rule.create': 'Created a territory rule',
  'territory_rule.update': 'Updated a territory rule',
  'territory_rule.delete': 'Deleted a territory rule',
  'territory_rule.reorder': 'Reordered territory rules',
  'territory_rules.apply': 'Applied territory rules',
  'inbox_item.claim': 'Claimed an inbox item',
  'inbox_item.done': 'Marked an inbox item done',
  'inbox_item.dismiss': 'Dismissed an inbox item',
  'power_hour.create': 'Started a power hour',
  'power_hour.cancel': 'Cancelled a power hour',
  'quality_rule.set': 'Set a disposition quality rule',
  'quality_flag.review': 'Reviewed a quality flag',
  'scorecard.set': 'Scored a call review',
  'schedule.set_day': 'Set a schedule day',
  'schedule.set_timezone': 'Set a schedule timezone',
  'settings.distribution.update': 'Updated distribution settings',
  'settings.agent_dial_cap.update': "Set an agent's daily dial cap override",
  'settings.call_takeover.update': 'Updated call takeover settings',
  'settings.quality_checks.update': 'Updated quality check settings',
  'settings.shared_inbox.update': 'Updated shared inbox settings',
  'export.attendance_csv': 'Exported the attendance CSV',
};

/** TASK-Q2F (Q2 finding #1): any action key that reaches this page without a matching entry
 *  above (a future action nobody added a label for yet) is humanized instead of shown raw --
 *  `territory_rule.create` -> "territory rule create" -- never the literal dotted/underscored
 *  string a user has no reason to parse. */
function humanizeActionKey(action: string): string {
  return action.replace(/[._]/g, ' ');
}

function ActivityTab() {
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [actorFilter, setActorFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    listOrgMembers()
      .then(setMembers)
      .catch(() => {
        /* non-fatal -- the table still renders with raw actor names it already got back */
      });
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listAuditLog({
      actor: actorFilter || undefined,
      action: actionFilter || undefined,
      from: fromFilter ? new Date(fromFilter).toISOString() : undefined,
      to: toFilter ? new Date(new Date(toFilter).getTime() + 86400000).toISOString() : undefined,
      limit: ACTIVITY_PAGE_SIZE,
      offset: page * ACTIVITY_PAGE_SIZE,
    })
      .then((res) => {
        setEntries(res.entries);
        setTotal(res.total);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [actorFilter, actionFilter, fromFilter, toFilter, page]);

  useEffect(() => {
    load();
  }, [load]);

  // Any filter change resets to page 0 -- a stale offset into a now-different result set would
  // otherwise silently show the wrong page (or an empty one) with no indication why.
  useEffect(() => {
    setPage(0);
  }, [actorFilter, actionFilter, fromFilter, toFilter]);

  const memberLabel = (userId: string | null, fallback: string | null): string => {
    if (!userId) return 'System';
    const m = members.find((mm) => mm.user_id === userId);
    if (!m) return fallback || 'Former member';
    return [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || 'Unknown member';
  };

  const handleExportCsv = async () => {
    setExporting(true);
    setError(null);
    try {
      const res = await listAuditLog({
        actor: actorFilter || undefined,
        action: actionFilter || undefined,
        from: fromFilter ? new Date(fromFilter).toISOString() : undefined,
        to: toFilter ? new Date(new Date(toFilter).getTime() + 86400000).toISOString() : undefined,
        limit: ACTIVITY_EXPORT_LIMIT,
        offset: 0,
      });
      const csv = rowsToCsv(
        [
          { key: 'createdAt' as const, label: 'When' },
          { key: 'actorName' as const, label: 'Who' },
          { key: 'action' as const, label: 'Action' },
          { key: 'targetType' as const, label: 'Target type' },
          { key: 'targetId' as const, label: 'Target id' },
        ],
        res.entries.map((e) => ({
          ...e,
          actorName: memberLabel(e.actorUserId, e.actorName),
        }))
      );
      downloadCsv(`activity-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Activity"
        description="Who did what, when -- role changes, invites, coaching, integrations and settings"
      />

      <SystemHealthPanel />

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <label className="block text-meta text-text-secondary mb-1">Person</label>
          <select
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to min-w-[160px]"
          >
            <option value="">Everyone</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {[m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.user_id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-meta text-text-secondary mb-1">Action</label>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to min-w-[180px]"
          >
            <option value="">All actions</option>
            {Object.entries(AUDIT_ACTION_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-meta text-text-secondary mb-1">From</label>
          <input
            type="date"
            value={fromFilter}
            onChange={(e) => setFromFilter(e.target.value)}
            className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
          />
        </div>
        <div>
          <label className="block text-meta text-text-secondary mb-1">To</label>
          <input
            type="date"
            value={toFilter}
            onChange={(e) => setToFilter(e.target.value)}
            className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
          />
        </div>
        <Button size="sm" variant="fe-ghost" onClick={handleExportCsv} disabled={exporting}>
          <Download className="w-4 h-4" />
          Export CSV
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <ListSkeleton rows={5} />
      ) : !entries || entries.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No activity yet"
          body="Role changes, invites, coaching sessions and settings changes will show up here."
        />
      ) : (
        <>
          <div className="bg-surface-1 rounded-app-lg border border-border-subtle overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-text-secondary">When</TableHead>
                  <TableHead className="text-text-secondary">Who</TableHead>
                  <TableHead className="text-text-secondary">Action</TableHead>
                  <TableHead className="text-text-secondary">Target</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-text-secondary whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-white">
                      {memberLabel(e.actorUserId, e.actorName)}
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {AUDIT_ACTION_LABELS[e.action] ?? humanizeActionKey(e.action)}
                    </TableCell>
                    <TableCell className="text-text-secondary">{e.targetType ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between mt-4">
            <p className="text-meta text-text-muted">
              {total} total &middot; page {page + 1} of {totalPages}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="fe-ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="fe-ghost"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DncTab() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';

  const [numbers, setNumbers] = useState<DncNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newNumber, setNewNumber] = useState('');
  const [newNote, setNewNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listDncNumbers()
      .then(setNumbers)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const normalized = normalizePhoneStrict(newNumber);
    if (!normalized) {
      setError('Enter a valid phone number.');
      return;
    }
    setAdding(true);
    try {
      await addDncNumber(normalized.e164, newNote.trim() || undefined);
      setNewNumber('');
      setNewNote('');
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (n: DncNumber) => {
    setRemovingId(n.id);
    setError(null);
    try {
      await removeDncNumber(n.id);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemovingId(null);
    }
  };

  const filtered = numbers.filter((n) => n.e164.includes(search.trim()));

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <PageHeader
        title="Do-not-call list"
        description="Org-wide numbers excluded from dialing and from CSV/GHL imports, in addition to each contact's own DNC flag."
      />

      {error && (
        <div className="mb-6 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {!isAdmin ? (
        <p className="text-sm text-text-secondary">
          Only an owner or admin can manage the do-not-call list.
        </p>
      ) : loading ? (
        <Skeleton className="h-[220px] w-full max-w-2xl rounded-app-lg" />
      ) : (
        <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-2xl">
          <form onSubmit={handleAdd} className="flex gap-2 mb-4">
            <input
              type="text"
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
              required
              className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
              placeholder="Phone number"
            />
            <input
              type="text"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              className="flex-1 bg-surface-2 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
              placeholder="Note (optional)"
            />
            <button
              type="submit"
              disabled={adding}
              className="px-4 py-2 bg-gradient-to-r from-accent-from to-accent-to rounded-lg text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2 flex-shrink-0"
            >
              {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add
            </button>
          </form>

          <div className="relative mb-4">
            <Search className="w-4 h-4 text-text-secondary absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-surface-2 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-accent-to"
              placeholder="Search"
            />
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-text-secondary py-4 text-center">No numbers on the list.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((n) => (
                <div
                  key={n.id}
                  className="flex items-center justify-between gap-3 py-3 border-b border-border-subtle last:border-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white">{n.e164}</div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      {n.source}
                      {n.note ? ` · ${n.note}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemove(n)}
                    disabled={removingId === n.id}
                    className="p-1.5 text-text-secondary hover:text-danger disabled:opacity-50 flex-shrink-0"
                    title="Remove"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

/** MISSION-5 TASK-M5-B3: org-wide toggles only -- callback fallback (enabled + minutes) and the
 *  daily dial cap (enabled + org default). Both ship OFF. No per-agent override editor here yet
 *  (api.ts's `listAgentDialCaps`/`setAgentDialCap`/`clearAgentDialCap` exist for a future
 *  screen; this task's own time went to the enforcement + audit-log side, not a full per-agent
 *  table UI) -- said explicitly rather than silently claimed as done. */
function DistributionSettingsTab() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';

  const [settings, setSettings] = useState<DistributionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    getDistributionSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [isAdmin]);

  const handleChange = async (next: DistributionSettings) => {
    const prev = settings;
    setSettings(next);
    setSaving(true);
    setError(null);
    try {
      await updateDistributionSettings(next);
    } catch (e) {
      setError(String(e));
      setSettings(prev);
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <PageHeader
        title="Distribution"
        description="Guards for how leads and callbacks get worked across the team. Off by default."
      />

      {error && (
        <div className="mb-6 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {!isAdmin ? (
        <p className="text-sm text-text-secondary">
          Only an owner or admin can manage distribution settings.
        </p>
      ) : loading || !settings ? (
        <Skeleton className="h-[220px] w-full max-w-2xl rounded-app-lg" />
      ) : (
        <div className="flex flex-col gap-6 max-w-2xl">
          <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle">
            <h3 className="text-section-title text-text-primary mb-1">Callback fallback</h3>
            <p className="text-sm text-text-secondary mb-4">
              When on, a due callback whose owner is disabled/removed, or hasn't been in an active
              session for the window below since it came due, becomes claimable by any agent on that
              campaign. The claiming agent becomes the new owner.
            </p>
            <label className="flex items-center gap-2 text-sm text-white mb-3">
              <input
                type="checkbox"
                checked={settings.callback_fallback_enabled}
                disabled={saving}
                onChange={(e) =>
                  void handleChange({ ...settings, callback_fallback_enabled: e.target.checked })
                }
              />
              Enable callback fallback
            </label>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              Fall back after
              <input
                type="number"
                min={1}
                className="w-20 px-2 py-1 bg-surface-2 border border-white/10 rounded text-white text-sm"
                value={settings.callback_fallback_minutes}
                disabled={saving || !settings.callback_fallback_enabled}
                onChange={(e) =>
                  void handleChange({
                    ...settings,
                    callback_fallback_minutes: Math.max(1, Number(e.target.value) || 1),
                  })
                }
              />
              minutes overdue
            </label>
          </div>

          <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle">
            <h3 className="text-section-title text-text-primary mb-1">Daily dial cap</h3>
            <p className="text-sm text-text-secondary mb-4">
              When on, an agent's session pauses once they hit this many dialed contacts today (org
              timezone) -- you're notified when it happens. Set a per-agent override from the API
              for now; there's no table here yet.
            </p>
            <label className="flex items-center gap-2 text-sm text-white mb-3">
              <input
                type="checkbox"
                checked={settings.daily_dial_cap_enabled}
                disabled={saving}
                onChange={(e) =>
                  void handleChange({ ...settings, daily_dial_cap_enabled: e.target.checked })
                }
              />
              Enable daily dial cap
            </label>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              Default cap
              <input
                type="number"
                min={1}
                className="w-24 px-2 py-1 bg-surface-2 border border-white/10 rounded text-white text-sm"
                value={settings.daily_dial_cap_default}
                disabled={saving || !settings.daily_dial_cap_enabled}
                onChange={(e) =>
                  void handleChange({
                    ...settings,
                    daily_dial_cap_default: Math.max(1, Number(e.target.value) || 1),
                  })
                }
              />
              dials/agent/day
            </label>
          </div>
        </div>
      )}
    </motion.div>
  );
}

/** TASK-N1 (CID-1, CID-2, ADM-5): org-level defaults (default cap, rest days) + the assignment
 *  table. Mounted inside the existing Telephony tab (owner/admin only, per that tab's own
 *  standing invariant -- see the `isAgent` tab-visibility comment above `Settings()`), replacing
 *  the old plain number list. Interns' OWN read-only visibility is deliberately NOT here --
 *  `StartSessionPanel`'s "Your numbers: N active, M resting" line (the Dialer idle screen) is the
 *  intern-facing surface this task's own UI spec also asks for, and restructuring the Telephony
 *  tab's agent-exclusion to carve out a read-only sub-view would be a much bigger, unrelated
 *  change to an explicitly-documented existing boundary. */
function NumberPoolCard() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';
  const { numbers, loading: numbersLoading, error: numbersError, refetch } = usePhoneNumbers();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [settings, setSettings] = useState<NumberPoolSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listOrgMembers()
      .then(setMembers)
      .catch((e) => setError(String(e)));
    getNumberPoolSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  const memberLabel = (userId: string | null): string => {
    if (!userId) return 'Team pool';
    const m = members.find((mm) => mm.user_id === userId);
    if (!m) return 'Unknown member';
    const name = [m.first_name, m.last_name].filter(Boolean).join(' ');
    return name || m.email || 'Unknown member';
  };

  const handleSettingsChange = async (next: NumberPoolSettings) => {
    setSettings(next);
    setSettingsSaving(true);
    setError(null);
    try {
      await updateNumberPoolSettings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleAssign = async (numberId: string, userId: string | null) => {
    setRowBusyId(numberId);
    setError(null);
    try {
      await assignPhoneNumber(numberId, userId);
      await refetch();
    } catch (e) {
      setError(String(e));
    } finally {
      setRowBusyId(null);
    }
  };

  const handleRetireToggle = async (numberId: string, currentStatus: string) => {
    setRowBusyId(numberId);
    setError(null);
    try {
      await setPhoneNumberStatus(numberId, currentStatus === 'retired' ? 'active' : 'retired');
      await refetch();
    } catch (e) {
      setError(String(e));
    } finally {
      setRowBusyId(null);
    }
  };

  return (
    <>
      {error && (
        <div className="mb-4 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {/* CID-2's two org-level defaults. TASK-U2: equal widths/labels/helper-text lines and a
       *  column stack at phone width -- previously only the first field had a helper line, so the
       *  two columns were visibly different heights. */}
      <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle mb-6 grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div>
          <label className="block text-meta text-text-secondary mb-1">Default daily cap</label>
          <input
            type="number"
            min={1}
            value={settings?.default_daily_cap ?? ''}
            disabled={!settings || settingsSaving}
            onChange={(e) =>
              settings &&
              void handleSettingsChange({
                ...settings,
                default_daily_cap: Math.max(1, parseInt(e.target.value, 10) || 1),
              })
            }
            className="w-full bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
          />
          <p className="text-meta text-text-muted mt-1">New numbers start with this cap.</p>
        </div>
        <div>
          <label className="block text-meta text-text-secondary mb-1">Rest days after cap</label>
          <input
            type="number"
            min={0}
            value={settings?.rest_days ?? ''}
            disabled={!settings || settingsSaving}
            onChange={(e) =>
              settings &&
              void handleSettingsChange({
                ...settings,
                rest_days: Math.max(0, parseInt(e.target.value, 10) || 0),
              })
            }
            className="w-full bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
          />
          <p className="text-meta text-text-muted mt-1">
            How long a number rests once it hits its cap.
          </p>
        </div>
      </div>

      {numbersError && (
        <div className="mb-4 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {numbersError}
        </div>
      )}

      {numbersLoading ? (
        <ListSkeleton rows={2} />
      ) : numbers.length === 0 ? (
        <div className="bg-surface-1 rounded-app-lg p-8 border border-border-subtle text-center">
          <p className="text-text-secondary">
            No phone numbers yet. Use Purchase numbers to add one.
          </p>
        </div>
      ) : (
        <div className="bg-surface-1 rounded-app-lg border border-border-subtle overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-text-secondary">
                <th className="p-3 font-medium">Number</th>
                <th className="p-3 font-medium">Assigned to</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Dials today / cap</th>
                <th className="p-3 font-medium">Resting until</th>
                <th className="p-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {numbers.map((n) => (
                <tr key={n.id} className="border-b border-border-subtle last:border-0">
                  <td className="p-3 text-white font-medium">{n.phone_number}</td>
                  <td className="p-3">
                    {isAdmin ? (
                      <select
                        value={n.assigned_user_id ?? ''}
                        disabled={rowBusyId === n.id}
                        onChange={(e) => void handleAssign(n.id, e.target.value || null)}
                        className="bg-surface-2 border border-white/10 rounded-app-md px-2 py-1.5 text-white focus:outline-none focus:border-accent-to"
                      >
                        <option value="">Team pool</option>
                        {members.map((m) => (
                          <option key={m.user_id} value={m.user_id}>
                            {memberLabel(m.user_id)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-text-secondary">{memberLabel(n.assigned_user_id)}</span>
                    )}
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-1 rounded-full text-xs border ${
                        n.status === 'active'
                          ? 'bg-success/10 text-success border-success/20'
                          : n.status === 'resting'
                            ? 'bg-warning/10 text-warning border-warning/20'
                            : 'bg-white/5 text-text-secondary border-white/10'
                      }`}
                    >
                      {n.status}
                    </span>
                  </td>
                  <td className="p-3 text-text-secondary">
                    {n.dials_today} / {n.daily_cap}
                  </td>
                  <td className="p-3 text-text-secondary">
                    {n.resting_until ? new Date(n.resting_until).toLocaleString() : '—'}
                  </td>
                  <td className="p-3">
                    {isAdmin && (
                      <button
                        type="button"
                        disabled={rowBusyId === n.id}
                        onClick={() => void handleRetireToggle(n.id, n.status)}
                        className="text-meta text-text-secondary hover:text-text-primary disabled:opacity-50"
                      >
                        {n.status === 'retired' ? 'Reactivate' : 'Retire'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const ADD_FUNDS_PRESETS_USD = [10, 25, 50, 100];
const MIN_ADD_FUNDS_USD = 5;
// TASK-BF2 (user order, 2026-09-25): lowered from 1000 -- keep in sync with
// supabase/functions/_shared/billing-validation.ts's own MAX_ADD_FUNDS_USD.
const MAX_ADD_FUNDS_USD = 200;

/** TASK-BF1 fix (lead + eng2 review, MEDIUM): error codes the server can return BEFORE ever
 *  calling Telnyx (reserve_add_funds itself rejected the reservation) -- this key was never
 *  consumed, so the dialog just shows the message and lets the user retry with the SAME key once
 *  whatever blocked it (rate limit / daily cap) has passed. Anything else with a `code` -- a real
 *  Telnyx rejection -- is a DEFINITIVE failure (see handleConfirm's catch block). */
const PRE_CHARGE_ADD_FUNDS_ERROR_CODES = new Set([
  'RATE_LIMITED',
  'DAILY_CAP_EXCEEDED',
  'DUPLICATE_REQUEST',
]);

/** TASK-BF1 (user order: "fully build out/integrate the add funds capbilty"): presets + custom
 *  amount -> a confirm step -> the actual charge. Same hand-rolled portal/focus-trap/motion modal
 *  shape as AddContactModal.tsx/ParallelDialerUI.tsx's StopConfirmDialog (this codebase's real
 *  dialog convention -- the shadcn AlertDialog primitive under ui/ is unused scaffolding).
 *  `idempotencyKey` is generated once, the moment the CONFIRM step is entered. A DEFINITIVE
 *  Telnyx rejection (4xx -- declined, no payment method, etc.) frees it server-side, so the
 *  dialog mints a NEW one and returns to the amount step; an AMBIGUOUS outcome (network error/
 *  timeout/5xx) keeps it -- a same-key retry is refused (409), so Confirm is disabled until the
 *  dialog is closed and reopened. See handleConfirm's catch block (TASK-BF1 fix, lead + eng2
 *  review). */
export function AddFundsDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<'select' | 'confirm'>('select');
  const [preset, setPreset] = useState<number>(ADD_FUNDS_PRESETS_USD[0]);
  const [useCustom, setUseCustom] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TASK-BF1 fix (lead + eng2 review, MEDIUM): set when the server couldn't confirm whether
  // Telnyx actually charged the card (network error/timeout/5xx) -- the idempotency key is kept
  // server-side specifically to make a same-key retry fail with DUPLICATE_REQUEST, so Confirm is
  // disabled here too rather than letting the user hammer a button that can only ever 409.
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(modalRef, open);

  const resolvedAmount = useCustom ? Number(customAmount) : preset;
  const validAmount =
    Number.isFinite(resolvedAmount) &&
    resolvedAmount >= MIN_ADD_FUNDS_USD &&
    resolvedAmount <= MAX_ADD_FUNDS_USD;

  // The confirm step's default focus must be Cancel, not the charge button -- useFocusTrap's own
  // auto-focus only fires once, on the open:false->true transition (still on the select step at
  // that point), so this re-focuses explicitly on every entry into the confirm step.
  useEffect(() => {
    if (step === 'confirm') cancelButtonRef.current?.focus();
  }, [step]);

  const reset = () => {
    setStep('select');
    setPreset(ADD_FUNDS_PRESETS_USD[0]);
    setUseCustom(false);
    setCustomAmount('');
    setError(null);
    setOutcomeUnknown(false);
    idempotencyKeyRef.current = null;
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleContinue = () => {
    if (!validAmount) return;
    idempotencyKeyRef.current = crypto.randomUUID();
    setStep('confirm');
  };

  const handleConfirm = async () => {
    if (!validAmount || submitting || outcomeUnknown) return;
    setSubmitting(true);
    setError(null);
    try {
      // Reuse the SAME key across retries of this one charge -- never mint a new one here.
      if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();
      const result = await addFunds(resolvedAmount, idempotencyKeyRef.current);
      toast.success(
        `$${resolvedAmount.toFixed(2)} added` +
          (result.balanceUsd !== null ? ` -- new balance $${result.balanceUsd.toFixed(2)}` : '')
      );
      onSuccess();
      reset();
      onClose();
    } catch (e) {
      if (e instanceof BillingActionError && e.code === 'OUTCOME_UNKNOWN') {
        // Ambiguous outcome -- Telnyx may or may not have charged the card. The server keeps
        // this key (a same-key retry would just 409 DUPLICATE_REQUEST), so there's no safe
        // "try again" left in this dialog -- the user has to close it and check the real balance.
        setError(e.message);
        setOutcomeUnknown(true);
      } else if (
        e instanceof BillingActionError &&
        e.code &&
        !PRE_CHARGE_ADD_FUNDS_ERROR_CODES.has(e.code)
      ) {
        // A DEFINITIVE Telnyx rejection (declined, no payment method, forbidden key, or any
        // other 4xx) -- no charge was attempted, so the server already freed this idempotency
        // key. Mint a fresh one and go back to the amount step instead of staying on confirm with
        // a key the server will no longer honor.
        idempotencyKeyRef.current = null;
        setStep('select');
        setError(e.message);
      } else {
        // RATE_LIMITED / DAILY_CAP_EXCEEDED / DUPLICATE_REQUEST (or a plain network error before
        // the request even reached the server) -- this key was never consumed, stay on confirm
        // and let the user try again with it once whatever blocked it has passed.
        setError(e instanceof Error ? e.message : 'Failed to add funds');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-funds-title"
    >
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} aria-hidden="true" />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-sm rounded-app-lg border border-border-subtle bg-surface-1 p-5 shadow-app-md outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="add-funds-title" className="text-page-title text-text-primary mb-4">
          Add funds
        </h2>

        {error && (
          <div className="mb-4 p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
            {error}
          </div>
        )}

        {step === 'select' ? (
          <>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {ADD_FUNDS_PRESETS_USD.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setUseCustom(false);
                    setPreset(p);
                  }}
                  className={cn(
                    'rounded-app-md border px-4 py-3 text-body font-medium',
                    !useCustom && preset === p
                      ? 'border-accent-to bg-accent-to/10 text-white'
                      : 'border-border-subtle bg-surface-2 text-text-secondary hover:border-accent-to/50'
                  )}
                >
                  ${p}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-meta text-text-secondary mb-1">
              <input
                type="checkbox"
                checked={useCustom}
                onChange={(e) => setUseCustom(e.target.checked)}
              />
              Custom amount
            </label>
            <input
              type="number"
              min={MIN_ADD_FUNDS_USD}
              max={MAX_ADD_FUNDS_USD}
              step="0.01"
              disabled={!useCustom}
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              placeholder={`$${MIN_ADD_FUNDS_USD} - $${MAX_ADD_FUNDS_USD}`}
              className="w-full mb-4 bg-surface-2 border border-border-subtle rounded-app-md px-3 py-2 text-white placeholder:text-text-muted focus:outline-none focus:border-accent-to disabled:opacity-50"
            />
            <div className="flex justify-end gap-2">
              <Button variant="fe-ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleContinue} disabled={!validAmount}>
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-body text-text-secondary mb-5">
              Charge ${resolvedAmount.toFixed(2)} to the payment method saved in your Telnyx
              account?
            </p>
            <div className="flex flex-col sm:flex-row sm:justify-end gap-2">
              <Button
                ref={cancelButtonRef}
                variant="fe-ghost"
                onClick={handleClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={outcomeUnknown ? handleClose : handleConfirm}
                disabled={submitting}
                loading={submitting}
              >
                {outcomeUnknown ? 'Close and check your balance' : 'Confirm charge'}
              </Button>
            </div>
          </>
        )}
      </motion.div>
    </div>,
    document.body
  );
}

const AUTO_RECHARGE_PREFERENCE_LABELS: Record<AutoRechargePreference, string> = {
  credit_paypal: 'Card / PayPal on file',
  ach: 'Bank account (ACH)',
};

/** TASK-BF1: Telnyx's own `auto_recharge_prefs` (account-level state, not an org_spend_settings
 *  row) -- enable/disable + threshold/recharge-amount/payment-source. Saves on every change, same
 *  convention as every other input in this file (SpendSettingsCard's own cap/alert fields
 *  immediately above). Owner+admin both get a live, editable card -- disabled read-only for
 *  neither, since this whole tab is already owner/admin-only at the route level. */
export function AutoRechargeSection({ isAdmin }: { isAdmin: boolean }) {
  const [prefs, setPrefs] = useState<AutoRechargePrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBillingInfo()
      .then((info) => {
        if (info.available) {
          setPrefs(info.autoRecharge);
        } else {
          setError(info.reason);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (next: AutoRechargePrefs) => {
    setPrefs(next);
    setSaving(true);
    setError(null);
    try {
      const saved = await updateAutoRecharge({
        enabled: next.enabled,
        thresholdAmountUsd: next.thresholdAmountUsd,
        rechargeAmountUsd: next.rechargeAmountUsd,
        invoiceEnabled: next.invoiceEnabled,
        preference: next.preference,
      });
      setPrefs(saved);
    } catch (e) {
      setError(
        e instanceof BillingActionError ? e.message : 'Failed to save auto-recharge settings'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle mt-6">
      <h3 className="text-body font-medium text-text-primary mb-4">Auto-recharge</h3>

      {error && (
        <div className="mb-4 p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <ListSkeleton rows={1} />
      ) : prefs ? (
        <div className="space-y-4">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={prefs.enabled}
              disabled={saving || !isAdmin}
              onChange={(e) => void handleSave({ ...prefs, enabled: e.target.checked })}
            />
            <span className="text-body text-text-primary">Enabled</span>
          </label>

          <div className="flex flex-wrap gap-6 items-end">
            <div>
              <label className="block text-meta text-text-secondary mb-1">
                When my balance drops below ($)
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={prefs.thresholdAmountUsd}
                disabled={saving || !isAdmin}
                onChange={(e) =>
                  void handleSave({
                    ...prefs,
                    thresholdAmountUsd: Math.max(0, Number(e.target.value) || 0),
                  })
                }
                className="w-40 bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to disabled:opacity-60"
              />
            </div>
            <div>
              <label className="block text-meta text-text-secondary mb-1">add ($)</label>
              <input
                type="number"
                min={10}
                max={5000}
                step="0.01"
                value={prefs.rechargeAmountUsd}
                disabled={saving || !isAdmin}
                onChange={(e) =>
                  void handleSave({
                    ...prefs,
                    rechargeAmountUsd: Math.max(10, Number(e.target.value) || 10),
                  })
                }
                className="w-40 bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to disabled:opacity-60"
              />
            </div>
            <div>
              <label className="block text-meta text-text-secondary mb-1">Payment source</label>
              <select
                value={prefs.preference}
                disabled={saving || !isAdmin}
                onChange={(e) =>
                  void handleSave({
                    ...prefs,
                    preference: e.target.value as AutoRechargePreference,
                  })
                }
                className="w-56 bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to disabled:opacity-60"
              >
                <option value="credit_paypal">
                  {AUTO_RECHARGE_PREFERENCE_LABELS.credit_paypal}
                </option>
                <option value="ach">{AUTO_RECHARGE_PREFERENCE_LABELS.ach}</option>
              </select>
            </div>
          </div>

          <p className="text-meta text-text-muted">
            When my balance drops below the threshold, Telnyx recharges automatically -- the actual
            amount added is whatever it takes to reach that threshold, PLUS the "add" amount above
            (Telnyx's own semantics, not a flat top-up).
          </p>
        </div>
      ) : null}
    </div>
  );
}

const BILLING_EVENT_KIND_LABEL: Record<BillingEvent['kind'], string> = {
  add_funds: 'Add funds',
  auto_recharge_update: 'Auto-recharge settings changed',
};

const BILLING_EVENT_STATUS_STYLE: Record<BillingEvent['status'], string> = {
  pending: 'bg-surface-3 text-text-secondary',
  succeeded: 'bg-success/10 text-success',
  failed: 'bg-danger/10 text-danger',
  // TASK-BF1 fix: an ambiguous outcome (network error/timeout/5xx) -- distinct from a definite
  // failure, since the charge may actually have gone through on Telnyx's side.
  unknown: 'bg-warning/10 text-warning',
};

/** TASK-BF1: the last 10 org_billing_events, read directly under RLS (owner/admin SELECT-only --
 *  no edge function needed, same shape as getSpendSettings). `refreshKey` bumps to reload after a
 *  successful add-funds or auto-recharge save elsewhere on this same page. */
export function RecentBillingActivity({ refreshKey }: { refreshKey: number }) {
  const [events, setEvents] = useState<BillingEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRecentBillingEvents()
      .then(setEvents)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [refreshKey]);

  return (
    <div className="mt-6">
      <h3 className="text-body font-medium text-text-primary mb-3">Recent billing activity</h3>
      {error && (
        <div className="p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}
      {!error && events && events.length === 0 && (
        <p className="text-meta text-text-muted">No billing activity yet.</p>
      )}
      {!error && events && events.length > 0 && (
        <div className="bg-surface-1 rounded-app-lg border border-border-subtle divide-y divide-border-subtle">
          {events.map((ev) => (
            <div key={ev.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <div>
                <div className="text-text-primary">
                  {BILLING_EVENT_KIND_LABEL[ev.kind]}
                  {ev.amount_usd !== null && ` -- $${Number(ev.amount_usd).toFixed(2)}`}
                </div>
                <div className="text-meta text-text-muted">
                  {new Date(ev.created_at).toLocaleString()}
                  {ev.error ? ` -- ${ev.error}` : ''}
                </div>
              </div>
              <span
                className={cn(
                  'px-2 py-1 rounded-app-md text-meta capitalize',
                  BILLING_EVENT_STATUS_STYLE[ev.status]
                )}
              >
                {ev.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** TASK-SP: monthly spend cap + low-balance threshold + the current balance/MTD estimate
 *  display. Same card shape as NumberPoolCard right above it (role-gated inputs, owner/admin
 *  write via RLS, a shared card-level error banner) -- deliberately a separate card, not folded
 *  into NumberPoolCard, since it's a distinct settings group (spend/billing vs. the pool
 *  itself) with its own read (a live Telnyx call, telnyx-spend-status) the pool card doesn't
 *  need. */
function SpendSettingsCard() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';
  const [settings, setSettings] = useState<SpendSettings | null>(null);
  const [status, setStatus] = useState<SpendStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addFundsOpen, setAddFundsOpen] = useState(false);
  const [billingRefreshKey, setBillingRefreshKey] = useState(0);

  const loadStatus = () => {
    setStatusLoading(true);
    getSpendStatus()
      .then(setStatus)
      .catch((e) => setError(String(e)))
      .finally(() => setStatusLoading(false));
  };

  useEffect(() => {
    getSpendSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
    loadStatus();
    // load once on mount only -- loadStatus/getSpendSettings are stable module-level functions
  }, []);

  const handleChange = async (next: SpendSettings) => {
    setSettings(next);
    setSaving(true);
    setError(null);
    try {
      await updateSpendSettings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const isLow =
    status?.available && status.availableCreditUsd < status.lowBalanceAlertUsd ? true : false;

  return (
    <>
      {error && (
        <div className="mb-4 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {isLow && (
        <div className="mb-4 p-4 rounded-app-md bg-warning-soft border border-warning/30 text-warning text-sm">
          Balance is low: ${status && status.available ? status.availableCreditUsd.toFixed(2) : ''}{' '}
          available, below your ${settings?.low_balance_alert_usd.toFixed(2)} alert threshold.
        </div>
      )}

      <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle mb-6">
        <div className="flex items-center justify-between mb-4">
          <span className="text-meta text-text-secondary">Current balance</span>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={loadStatus}
              disabled={statusLoading}
              className="text-meta text-accent-to hover:underline disabled:opacity-50"
            >
              {statusLoading ? 'Refreshing…' : 'Refresh'}
            </button>
            {isAdmin && (
              <Button variant="primary" onClick={() => setAddFundsOpen(true)}>
                Add funds
              </Button>
            )}
          </div>
        </div>
        {statusLoading ? (
          <ListSkeleton rows={1} />
        ) : !status?.available ? (
          <p className="text-text-secondary text-sm">
            {status?.reason ?? 'Balance is not available right now.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-8">
            <div>
              <div className="text-page-title text-white">
                ${status.availableCreditUsd.toFixed(2)}
              </div>
              <div className="text-meta text-text-muted">Available to spend</div>
            </div>
            <div>
              <div className="text-page-title text-white">
                ${status.mtdSpendEstimateUsd.toFixed(2)}
              </div>
              <div className="text-meta text-text-muted">
                Estimated spend this month
                {status.monthlySpendCapUsd !== null &&
                  ` / $${status.monthlySpendCapUsd.toFixed(2)} cap`}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle flex flex-wrap gap-6 items-end">
        <div>
          <label className="block text-meta text-text-secondary mb-1">Monthly spend cap ($)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            placeholder="No cap"
            value={settings?.monthly_spend_cap_usd ?? ''}
            disabled={!settings || saving || !isAdmin}
            onChange={(e) =>
              settings &&
              void handleChange({
                ...settings,
                monthly_spend_cap_usd: e.target.value === '' ? null : Number(e.target.value),
              })
            }
            className="w-36 bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to disabled:opacity-60"
          />
        </div>
        <div>
          <label className="block text-meta text-text-secondary mb-1">Low-balance alert ($)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={settings?.low_balance_alert_usd ?? ''}
            disabled={!settings || saving || !isAdmin}
            onChange={(e) =>
              settings &&
              void handleChange({
                ...settings,
                low_balance_alert_usd: Math.max(0, Number(e.target.value) || 0),
              })
            }
            className="w-36 bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to disabled:opacity-60"
          />
        </div>
      </div>
      <p className="text-meta text-text-muted mt-2">
        A low balance never blocks dialing -- it only shows a warning (at Go Ready, on the
        Dashboard, and as an in-app alert) once the balance drops below the threshold above. Monthly
        spend is estimated from call minutes and number count -- Telnyx has no reliable live
        month-to-date figure to read instead. Real-time balance above is exact.
      </p>

      {isAdmin && <AutoRechargeSection isAdmin={isAdmin} />}

      <RecentBillingActivity refreshKey={billingRefreshKey} />

      <AddFundsDialog
        open={addFundsOpen}
        onClose={() => setAddFundsOpen(false)}
        onSuccess={() => {
          loadStatus();
          setBillingRefreshKey((k) => k + 1);
        }}
      />
    </>
  );
}

/** TASK-I1 (INB-3): the org-level fallback destination + voicemail greeting, once an inbound
 *  call's assigned intern doesn't answer (their own cell, set on the Profile tab, is tried
 *  first). Owner/admin only, same disabled-input-when-not-admin shape as SpendSettingsCard right
 *  above it -- there's no per-row gating to do here, just two org-wide fields. */
function InboundSettingsCard() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';
  const [settings, setSettings] = useState<InboundSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getInboundSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
  }, []);

  const handleChange = async (next: InboundSettings) => {
    setSettings(next);
    setSaving(true);
    setError(null);
    try {
      await updateInboundSettings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {error && (
        <div className="mb-4 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle space-y-4">
        <div>
          <label className="block text-meta text-text-secondary mb-1">
            Shared destination number
          </label>
          <input
            type="tel"
            placeholder="Not set -- falls straight to voicemail"
            value={settings?.shared_destination_number ?? ''}
            disabled={!settings || saving || !isAdmin}
            onChange={(e) =>
              settings &&
              void handleChange({
                ...settings,
                shared_destination_number: e.target.value.trim() || null,
              })
            }
            className="w-full max-w-sm bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white placeholder-text-muted focus:outline-none focus:border-accent-to disabled:opacity-60"
          />
          <p className="text-meta text-text-muted mt-1">
            Tried after the assigned intern's own cell number, before voicemail.
          </p>
        </div>
        <div>
          <label className="block text-meta text-text-secondary mb-1">Voicemail greeting</label>
          <textarea
            rows={2}
            value={settings?.voicemail_greeting_text ?? ''}
            disabled={!settings || saving || !isAdmin}
            onChange={(e) =>
              settings &&
              void handleChange({ ...settings, voicemail_greeting_text: e.target.value })
            }
            className="w-full max-w-lg bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to disabled:opacity-60"
          />
          <p className="text-meta text-text-muted mt-1">
            Read aloud (text-to-speech) before recording. Use {'{org_name}'} for your org's name.
          </p>
        </div>
      </div>
    </>
  );
}

export function Settings({ section }: { section?: SettingsSection } = {}) {
  const { role, loading: orgLoading } = useOrg();
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    section === 'pods' ? 'team' : section === 'integrations' ? 'integrations' : 'profile'
  );
  const [purchaseModalOpen, setPurchaseModalOpen] = useState(false);

  const [telnyxStatus, setTelnyxStatus] = useState<TelnyxConnectionStatus | null>(null);
  const [telnyxStatusLoading, setTelnyxStatusLoading] = useState(true);
  const [telnyxError, setTelnyxError] = useState<string | null>(null);
  const [telnyxApiKey, setTelnyxApiKey] = useState('');
  const [telnyxWebhookPublicKey, setTelnyxWebhookPublicKey] = useState('');
  const [telnyxConnecting, setTelnyxConnecting] = useState(false);
  const [telnyxDisconnecting, setTelnyxDisconnecting] = useState(false);

  const loadTelnyxStatus = useCallback(() => {
    setTelnyxStatusLoading(true);
    getTelnyxConnectionStatus()
      .then(setTelnyxStatus)
      .catch((e) => setTelnyxError(String(e)))
      .finally(() => setTelnyxStatusLoading(false));
  }, []);

  useEffect(() => {
    loadTelnyxStatus();
  }, [loadTelnyxStatus]);

  const handleConnectTelnyx = async (e: React.FormEvent) => {
    e.preventDefault();
    setTelnyxConnecting(true);
    setTelnyxError(null);
    try {
      await connectTelnyx(telnyxApiKey.trim(), telnyxWebhookPublicKey.trim());
      setTelnyxApiKey('');
      setTelnyxWebhookPublicKey('');
      loadTelnyxStatus();
    } catch (e) {
      setTelnyxError(String(e));
    } finally {
      setTelnyxConnecting(false);
    }
  };

  const handleDisconnectTelnyx = async () => {
    setTelnyxDisconnecting(true);
    setTelnyxError(null);
    try {
      await disconnectTelnyx();
      loadTelnyxStatus();
    } catch (e) {
      setTelnyxError(String(e));
    } finally {
      setTelnyxDisconnecting(false);
    }
  };

  const isTelnyxConnected = telnyxStatus?.status === 'connected';

  // Design §2: Team management and number purchase ("Buy or release numbers") are owner/admin
  // only. This is cosmetic tab-visibility narrowing -- org-members/org-invite-create/
  // user_phone_numbers RLS all independently reject an agent regardless of what this array
  // contains (see this task's invariant).
  const isAgent = role === 'agent';
  // MISSION-5 TASK-M5-A5 (Security tab removed, TASK-U1): a manager gets ONLY Activity (their own
  // audit-log scope) -- plus Profile, always available to everyone -- not Telephony/Team/
  // Integrations/Dispositions/DNC/Distribution, all of which are billing/numbers/org-settings-
  // adjacent and explicitly NOT a manager's capability ("cannot buy numbers, change billing/
  // spend, change roles, or edit org settings"). Pod management/role picker live in the 'team'
  // tab, which stays owner/admin-only for exactly this reason -- a manager never restructures
  // pods or roles.
  const isManagerRole = role === 'manager';
  const hideFromManager = isAgent || isManagerRole;
  const tabs = [
    { id: 'profile' as SettingsTab, label: 'Profile', icon: User },
    // "Phone Numbers" mount point: eng2 owns the Telephony/BYO-Telnyx backend (org_telephony,
    // telnyx-connect/-disconnect) and is expected to extend this tab -- coordinate through this
    // task's log rather than restructuring it here.
    ...(!hideFromManager ? [{ id: 'phone' as SettingsTab, label: 'Telephony', icon: Phone }] : []),
    ...(!hideFromManager ? [{ id: 'team' as SettingsTab, label: 'Team', icon: UsersIcon }] : []),
    ...(!hideFromManager
      ? [{ id: 'integrations' as SettingsTab, label: 'Integrations', icon: Zap }]
      : []),
    ...(!hideFromManager
      ? [{ id: 'dispositions' as SettingsTab, label: 'Dispositions', icon: ListChecks }]
      : []),
    ...(!hideFromManager
      ? [{ id: 'dnc' as SettingsTab, label: 'Do-not-call list', icon: PhoneOff }]
      : []),
    ...(!hideFromManager
      ? [{ id: 'distribution' as SettingsTab, label: 'Distribution', icon: Share2 }]
      : []),
    ...(!isAgent ? [{ id: 'activity' as SettingsTab, label: 'Activity', icon: History }] : []),
  ];

  useEffect(() => {
    if (
      isAgent &&
      (activeTab === 'phone' ||
        activeTab === 'team' ||
        activeTab === 'integrations' ||
        activeTab === 'dispositions' ||
        activeTab === 'dnc' ||
        activeTab === 'distribution' ||
        activeTab === 'activity')
    ) {
      setActiveTab('profile');
    }
    if (
      isManagerRole &&
      (activeTab === 'phone' ||
        activeTab === 'team' ||
        activeTab === 'integrations' ||
        activeTab === 'dispositions' ||
        activeTab === 'dnc' ||
        activeTab === 'distribution')
    ) {
      setActiveTab('profile');
    }
  }, [isAgent, isManagerRole, activeTab]);

  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';

  return (
    <div className={isDesktop ? 'flex h-full' : 'flex flex-col h-full'}>
      {/* Sub-nav: a left sidebar on desktop, a horizontal scrollable tab bar on mobile/tablet. */}
      {isDesktop ? (
        <div className="w-64 flex-shrink-0 bg-surface-1 border-r border-border-subtle p-6">
          <h2 className="text-text-primary font-bold text-lg mb-6">Settings</h2>
          <nav className="space-y-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 rounded-app-md transition-colors',
                    activeTab === tab.id
                      ? 'bg-accent-from/10 text-text-primary border-l-4 border-accent-to'
                      : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
                  )}
                >
                  <Icon className="w-5 h-5" />
                  <span className="font-medium">{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      ) : (
        <div className="flex-shrink-0 border-b border-border-subtle bg-surface-1 px-4 pt-3">
          <nav className="flex gap-1 overflow-x-auto pb-3 -mx-1 px-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-app-sm text-meta font-medium whitespace-nowrap transition-colors',
                    activeTab === tab.id
                      ? 'bg-accent-from/15 text-accent-to'
                      : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-8">
        <div className="max-w-4xl">
          {orgLoading ? (
            <div>
              <Skeleton className="h-8 w-40 mb-8" />
              <Skeleton className="h-[140px] w-full rounded-app-lg mb-4" />
              <Skeleton className="h-[140px] w-full rounded-app-lg" />
            </div>
          ) : (
            <>
              {activeTab === 'profile' && <ProfileTab />}

              {activeTab === 'phone' && !hideFromManager && (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                  <PageHeader
                    title="Telephony"
                    description="Connect your org's own Telnyx account, then buy and share phone numbers across the team."
                  />

                  {telnyxError && (
                    <div className="mb-6 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
                      {telnyxError}
                    </div>
                  )}

                  {telnyxStatusLoading ? (
                    <Skeleton className="h-[104px] w-full rounded-app-lg mb-8" />
                  ) : (
                    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle mb-8">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-app-md bg-gradient-to-br from-accent-from to-accent-to flex items-center justify-center">
                            <Phone className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <div className="text-white font-medium">Telnyx</div>
                            <div className="text-sm text-text-secondary">
                              {isTelnyxConnected && telnyxStatus?.api_key_last4
                                ? `Key ending in ${telnyxStatus.api_key_last4}`
                                : 'Not connected'}
                            </div>
                          </div>
                        </div>
                        <span
                          className={`px-2.5 py-1 rounded-full text-xs border ${
                            isTelnyxConnected
                              ? 'bg-success/10 text-success border-success/20'
                              : 'bg-white/5 text-text-secondary border-white/10'
                          }`}
                        >
                          {isTelnyxConnected
                            ? 'Connected'
                            : telnyxStatus?.status === 'pending_verification'
                              ? 'Pending'
                              : 'Disconnected'}
                        </span>
                      </div>

                      {role !== 'owner' ? (
                        <p className="text-sm text-text-secondary">
                          Only the org owner can connect or disconnect Telnyx.
                        </p>
                      ) : isTelnyxConnected ? (
                        <button
                          onClick={handleDisconnectTelnyx}
                          disabled={telnyxDisconnecting}
                          className="px-5 py-2.5 bg-danger/10 hover:bg-danger/20 border border-danger/30 rounded-app-md text-danger text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                        >
                          {telnyxDisconnecting && <Loader2 className="w-4 h-4 animate-spin" />}
                          Disconnect
                        </button>
                      ) : (
                        <form onSubmit={handleConnectTelnyx} className="space-y-4">
                          <div>
                            <label className="block text-sm text-text-secondary mb-2">
                              Telnyx API Key
                            </label>
                            <input
                              type="password"
                              value={telnyxApiKey}
                              onChange={(e) => setTelnyxApiKey(e.target.value)}
                              required
                              className="w-full bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
                              placeholder="KEY..."
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-text-secondary mb-2">
                              Webhook Public Key
                            </label>
                            <input
                              type="text"
                              value={telnyxWebhookPublicKey}
                              onChange={(e) => setTelnyxWebhookPublicKey(e.target.value)}
                              required
                              className="w-full bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
                              placeholder="From your Telnyx portal's public keys page"
                            />
                            <p className="text-xs text-text-muted mt-1.5">
                              Find this in your{' '}
                              <a
                                href="https://portal.telnyx.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent-to hover:underline"
                              >
                                Telnyx Portal
                              </a>{' '}
                              under API Keys → Public Key.
                            </p>
                          </div>
                          <button
                            type="submit"
                            disabled={telnyxConnecting}
                            className="px-6 py-3 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white font-semibold disabled:opacity-50 flex items-center gap-2"
                          >
                            {telnyxConnecting && <Loader2 className="w-4 h-4 animate-spin" />}
                            Connect Telnyx
                          </button>
                        </form>
                      )}
                    </div>
                  )}

                  <CollapsibleSection
                    title="Phone numbers"
                    subtitle="The caller-ID numbers your dialer rotates through. Assign a number to one
                      agent or leave it in the shared team pool -- either way, a number automatically
                      rests for a few days once it hits its daily dial cap, to protect deliverability."
                    defaultOpen
                    actions={
                      <button
                        type="button"
                        onClick={() => isTelnyxConnected && setPurchaseModalOpen(true)}
                        disabled={!isTelnyxConnected}
                        title={isTelnyxConnected ? undefined : 'Connect Telnyx to purchase numbers'}
                        className="px-4 py-2 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Search className="w-4 h-4" />
                        Purchase numbers
                      </button>
                    }
                  >
                    <NumberPoolCard />
                    <NumberHealthPanel />
                  </CollapsibleSection>

                  <PurchaseNumbersModal
                    open={purchaseModalOpen}
                    onClose={() => setPurchaseModalOpen(false)}
                  />

                  {isTelnyxConnected && (
                    <CollapsibleSection title="Spend & billing">
                      <SpendSettingsCard />
                    </CollapsibleSection>
                  )}

                  {isTelnyxConnected && (
                    <CollapsibleSection title="Inbound calls">
                      <InboundSettingsCard />
                    </CollapsibleSection>
                  )}

                  <CollapsibleSection title="Call handling">
                    <RecordingSettingsCard />
                    <ExternalTransferSettingsCard />
                    <VoicemailDropCard />
                    <AutoResumeSettingsCard />
                  </CollapsibleSection>
                </motion.div>
              )}

              {activeTab === 'team' && !hideFromManager && <TeamTab scrollTo={section} />}

              {activeTab === 'integrations' && !hideFromManager && <IntegrationsTab />}

              {activeTab === 'dispositions' && !hideFromManager && <DispositionsTab />}

              {activeTab === 'dnc' && !hideFromManager && <DncTab />}

              {activeTab === 'distribution' && !hideFromManager && <DistributionSettingsTab />}

              {activeTab === 'activity' && !isAgent && <ActivityTab />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
