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
  Shield,
  Search,
  Loader2,
  Copy,
  Check,
  Trash2,
  UserX,
  UserCheck,
  Mail,
  ListChecks,
  Plus,
  Pencil,
  X,
  PhoneOff,
  Construction,
  ChevronUp,
  ChevronDown,
  Trophy,
} from 'lucide-react';
import { usePhoneNumbers } from '@/contexts/PhoneNumbersContext';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import { useBreakpoint } from '@/hooks/useBreakpoint';
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
  searchPhoneNumbers,
  purchasePhoneNumber,
  getMyProfile,
  updateMyProfile,
  listOrgMembers,
  createOrgInvite,
  changeMemberRole,
  disableMember,
  enableMember,
  removeMember,
  updateMemberGhlUserId,
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
  listDncNumbers,
  addDncNumber,
  removeDncNumber,
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
  type BillingEvent,
  type InboundSettings,
  type VoicemailDropInfo,
  type OrgMember,
  type GhlIntegrationStatus,
  type GhlCampaignMapping,
  type GhlPipelineStageOption,
  type CampaignWithStats,
  type CrmSyncJob,
  type TelnyxConnectionStatus,
  type Disposition,
  type DispositionLeadEffect,
  type DncNumber,
} from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ListSkeleton, TableSkeleton } from '@/components/app/skeletons';
import { normalizePhoneStrict } from '@/lib/phone-normalize';

type SettingsTab =
  'profile' | 'phone' | 'team' | 'integrations' | 'dispositions' | 'dnc' | 'security';

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

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', agent: 'Agent' };

function TeamTab() {
  const { user } = useAuth();
  const { role } = useOrg();
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'agent'>('agent');
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const canManage = role === 'owner' || role === 'admin';

  const load = useCallback(() => {
    setLoading(true);
    listOrgMembers()
      .then(setMembers)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteSubmitting(true);
    setActionError(null);
    setInviteLink(null);
    try {
      const { token } = await createOrgInvite(inviteEmail.trim(), inviteRole);
      setInviteLink(`${window.location.origin}/?invite=${token}`);
      setInviteEmail('');
    } catch (e) {
      setActionError(String(e));
    } finally {
      setInviteSubmitting(false);
    }
  };

  const handleCopyLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Clipboard API unavailable -- the link is still selectable text in the field below.
    }
  };

  const runAction = async (userId: string, fn: () => Promise<void>) => {
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
                setInviteLink(null);
              }}
            >
              Invite member
            </Button>
          )
        }
      />

      {canManage && showInvite && (
        <div className="bg-gradient-to-r from-accent-from/10 to-accent-to/10 rounded-app-lg p-6 border border-accent-from/20 mb-6">
          <h3 className="text-section-title text-text-primary mb-4">Invite a teammate</h3>
          {inviteLink ? (
            <div>
              <p className="text-sm text-text-secondary mb-3">
                Send this single-use link (expires in 7 days). Anyone with it can join as{' '}
                {inviteRole}.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={inviteLink}
                  className="flex-1 bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white text-sm"
                  onFocus={(e) => e.target.select()}
                />
                <button
                  onClick={handleCopyLink}
                  className="px-4 py-3 bg-accent-to/20 hover:bg-accent-to/30 border border-accent-to/30 rounded-app-md text-accent-to flex items-center gap-2"
                >
                  {linkCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {linkCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleCreateInvite} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-sm text-text-secondary mb-2">Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                  className="w-full bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
                  placeholder="teammate@company.com"
                />
              </div>
              <div>
                <label className="block text-sm text-text-secondary mb-2">Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'admin' | 'agent')}
                  className="bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white focus:outline-none focus:border-accent-to"
                >
                  <option value="agent">Agent</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
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
                Send invite
              </button>
            </form>
          )}
        </div>
      )}

      {(error || actionError) && (
        <div className="mb-6 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error || actionError}
        </div>
      )}

      {loading ? (
        isDesktop ? (
          <TableSkeleton rows={4} columns={4} />
        ) : (
          <ListSkeleton rows={4} />
        )
      ) : isDesktop ? (
        <div className="rounded-app-lg border border-border-subtle bg-surface-1 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-border-subtle hover:bg-transparent">
                <TableHead className="text-text-secondary">Name</TableHead>
                <TableHead className="text-text-secondary">Status</TableHead>
                <TableHead className="text-text-secondary">Role</TableHead>
                <TableHead className="text-right text-text-secondary">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => {
                const name =
                  [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || 'Unnamed';
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
                            {name}{' '}
                            {isSelf && <span className="text-text-secondary text-xs">(you)</span>}
                          </div>
                          <div className="text-meta text-text-secondary truncate">{m.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'px-2.5 py-1 rounded-full text-xs border',
                          m.status === 'disabled'
                            ? 'bg-white/5 text-text-secondary border-white/10'
                            : 'bg-success/10 text-success border-success/20'
                        )}
                      >
                        {m.status === 'disabled' ? 'Disabled' : 'Active'}
                      </span>
                    </TableCell>
                    <TableCell>
                      {canManage && !isOwner ? (
                        <select
                          value={m.role}
                          disabled={busy}
                          onChange={(e) =>
                            runAction(m.user_id, () =>
                              changeMemberRole(m.user_id, e.target.value as 'admin' | 'agent')
                            )
                          }
                          className="bg-surface-2 border border-border-subtle rounded-app-sm px-3 py-1.5 text-text-primary text-sm focus:outline-none focus:border-accent-to"
                        >
                          <option value="admin">Admin</option>
                          <option value="agent">Agent</option>
                        </select>
                      ) : (
                        <span className="text-sm text-text-secondary">{ROLE_LABEL[m.role]}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {canManage && !isOwner && (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            disabled={busy}
                            onClick={() =>
                              runAction(m.user_id, () =>
                                m.status === 'disabled'
                                  ? enableMember(m.user_id)
                                  : disableMember(m.user_id)
                              )
                            }
                            title={m.status === 'disabled' ? 'Enable' : 'Disable'}
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
                            onClick={() => {
                              if (confirm(`Remove ${name} from the team?`)) {
                                runAction(m.user_id, () => removeMember(m.user_id));
                              }
                            }}
                            title="Remove"
                            className="p-2 rounded-app-sm hover:bg-danger/10 text-text-secondary hover:text-danger transition-colors disabled:opacity-50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="space-y-3">
          {members.map((m) => {
            const name =
              [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || 'Unnamed';
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
                  <span
                    className={cn(
                      'px-2.5 py-1 rounded-full text-xs border',
                      m.status === 'disabled'
                        ? 'bg-white/5 text-text-secondary border-white/10'
                        : 'bg-success/10 text-success border-success/20'
                    )}
                  >
                    {m.status === 'disabled' ? 'Disabled' : 'Active'}
                  </span>

                  {canManage && !isOwner ? (
                    <>
                      <select
                        value={m.role}
                        disabled={busy}
                        onChange={(e) =>
                          runAction(m.user_id, () =>
                            changeMemberRole(m.user_id, e.target.value as 'admin' | 'agent')
                          )
                        }
                        className="bg-surface-2 border border-border-subtle rounded-app-sm px-3 py-1.5 text-text-primary text-sm focus:outline-none focus:border-accent-to"
                      >
                        <option value="admin">Admin</option>
                        <option value="agent">Agent</option>
                      </select>
                      <button
                        disabled={busy}
                        onClick={() =>
                          runAction(m.user_id, () =>
                            m.status === 'disabled'
                              ? enableMember(m.user_id)
                              : disableMember(m.user_id)
                          )
                        }
                        title={m.status === 'disabled' ? 'Enable' : 'Disable'}
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
                        onClick={() => {
                          if (confirm(`Remove ${name} from the team?`)) {
                            runAction(m.user_id, () => removeMember(m.user_id));
                          }
                        }}
                        title="Remove"
                        className="p-2 rounded-app-sm hover:bg-danger/10 text-text-secondary hover:text-danger transition-colors disabled:opacity-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <span className="text-sm text-text-secondary px-2">{ROLE_LABEL[m.role]}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {canManage && members.length > 0 && (
        <GhlMemberMappingSection members={members} onSaved={load} />
      )}
    </motion.div>
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

  const saveConsentSettings = async (nextMode: AnnounceRecordingMode, nextStatesText: string) => {
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
      });
    } catch (e) {
      setConsentError(String(e));
    } finally {
      setConsentSaving(false);
    }
  };

  const handleConsentModeChange = (next: AnnounceRecordingMode) => {
    setConsentMode(next);
    void saveConsentSettings(next, consentStatesText);
  };

  const handleConsentStatesBlur = () => {
    void saveConsentSettings(consentMode, consentStatesText);
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
    <div className="mb-8">
      <h2 className="text-section-title text-text-primary mb-4">Phone Numbers</h2>

      {error && (
        <div className="mb-4 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      {/* CID-2's two org-level defaults. */}
      <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle mb-6 flex flex-wrap gap-6 items-end">
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
            className="w-32 bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
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
            className="w-32 bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
          />
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
          <p className="text-text-secondary">No phone numbers yet. Search and purchase below.</p>
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
    </div>
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
    <div className="mb-8">
      <h2 className="text-section-title text-text-primary mb-4">Spend &amp; Billing</h2>

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
    </div>
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
    <div className="mb-8">
      <h2 className="text-section-title text-text-primary mb-4">Inbound Calls</h2>

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
    </div>
  );
}

export function Settings() {
  const { refetch: refetchPhoneNumbers } = usePhoneNumbers();
  const { role, loading: orgLoading } = useOrg();
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  const [searchAreaCode, setSearchAreaCode] = useState('');
  const [searchResults, setSearchResults] = useState<
    { phone_number: string; monthly_cost?: string }[]
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [purchaseLoading, setPurchaseLoading] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

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
  const tabs = [
    { id: 'profile' as SettingsTab, label: 'Profile', icon: User },
    // "Phone Numbers" mount point: eng2 owns the Telephony/BYO-Telnyx backend (org_telephony,
    // telnyx-connect/-disconnect) and is expected to extend this tab -- coordinate through this
    // task's log rather than restructuring it here.
    ...(!isAgent ? [{ id: 'phone' as SettingsTab, label: 'Telephony', icon: Phone }] : []),
    ...(!isAgent ? [{ id: 'team' as SettingsTab, label: 'Team', icon: UsersIcon }] : []),
    ...(!isAgent ? [{ id: 'integrations' as SettingsTab, label: 'Integrations', icon: Zap }] : []),
    ...(!isAgent
      ? [{ id: 'dispositions' as SettingsTab, label: 'Dispositions', icon: ListChecks }]
      : []),
    ...(!isAgent ? [{ id: 'dnc' as SettingsTab, label: 'Do-not-call list', icon: PhoneOff }] : []),
    { id: 'security' as SettingsTab, label: 'Security', icon: Shield },
  ];

  useEffect(() => {
    if (
      isAgent &&
      (activeTab === 'phone' ||
        activeTab === 'team' ||
        activeTab === 'integrations' ||
        activeTab === 'dispositions' ||
        activeTab === 'dnc')
    ) {
      setActiveTab('profile');
    }
  }, [isAgent, activeTab]);

  const handleSearchNumbers = async () => {
    setSearchLoading(true);
    setPhoneError(null);
    setSearchResults([]);
    setSearchAttempted(false);
    try {
      const numbers = await searchPhoneNumbers(searchAreaCode);
      setSearchResults(numbers);
    } catch (e) {
      setPhoneError(String(e));
    } finally {
      setSearchLoading(false);
      setSearchAttempted(true);
    }
  };

  const handlePurchaseNumber = async (phoneNumber: string) => {
    setPurchaseLoading(phoneNumber);
    setPhoneError(null);
    try {
      await purchasePhoneNumber(phoneNumber);
      await refetchPhoneNumbers();
      setSearchResults((prev) => prev.filter((n) => n.phone_number !== phoneNumber));
    } catch (e) {
      setPhoneError(String(e));
    } finally {
      setPurchaseLoading(null);
    }
  };

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

              {activeTab === 'phone' && !isAgent && (
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

                  {phoneError && (
                    <div className="mb-6 p-4 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
                      {phoneError}
                    </div>
                  )}

                  <NumberPoolCard />

                  {isTelnyxConnected && <SpendSettingsCard />}

                  {isTelnyxConnected && <InboundSettingsCard />}

                  {!isTelnyxConnected ? (
                    <div className="bg-gradient-to-r from-accent-from/10 to-accent-to/10 rounded-app-lg p-8 border border-accent-from/20 text-center">
                      <p className="text-text-secondary">
                        Connect your org's Telnyx account above to search and purchase numbers.
                      </p>
                    </div>
                  ) : (
                    <div className="bg-gradient-to-r from-accent-from/10 to-accent-to/10 rounded-app-lg p-8 border border-accent-from/20">
                      <h3 className="text-section-title text-text-primary mb-4">
                        Purchase Numbers
                      </h3>
                      <p className="text-text-secondary mb-4">
                        Search by area code (e.g. 415, 920) or leave blank to browse US numbers.
                      </p>
                      <div className="flex gap-2 mb-4">
                        <input
                          type="text"
                          placeholder="Area code (e.g. 415) or leave blank"
                          value={searchAreaCode}
                          onChange={(e) =>
                            setSearchAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))
                          }
                          className="flex-1 bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
                        />
                        <button
                          onClick={handleSearchNumbers}
                          disabled={searchLoading}
                          className="px-6 py-3 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white font-semibold disabled:opacity-50 flex items-center gap-2"
                        >
                          {searchLoading ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                          ) : (
                            <Search className="w-5 h-5" />
                          )}
                          Search
                        </button>
                      </div>
                      {searchLoading && (
                        <div className="py-4 text-center text-text-secondary">
                          Searching Telnyx marketplace…
                        </div>
                      )}
                      {searchAttempted && !searchLoading && searchResults.length === 0 && (
                        <div className="py-4 text-center text-text-secondary text-sm">
                          No numbers found for this area. Try a different area code or leave blank
                          for US numbers.
                        </div>
                      )}
                      {searchResults.length > 0 && (
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {searchResults.map((n) => (
                            <div
                              key={n.phone_number}
                              className="flex items-center justify-between p-3 bg-surface-2/60 rounded-lg"
                            >
                              <span className="text-white font-medium">{n.phone_number}</span>
                              <span className="text-text-secondary text-sm">
                                {n.monthly_cost ? `$${n.monthly_cost}/mo` : ''}
                              </span>
                              <button
                                onClick={() => handlePurchaseNumber(n.phone_number)}
                                disabled={purchaseLoading === n.phone_number}
                                className="px-4 py-2 bg-success/20 hover:bg-success/30 border border-success/30 rounded-lg text-success text-sm font-medium disabled:opacity-50 flex items-center gap-1"
                              >
                                {purchaseLoading === n.phone_number ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : null}
                                Purchase
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <RecordingSettingsCard />
                  <ExternalTransferSettingsCard />
                  <VoicemailDropCard />
                  <AutoResumeSettingsCard />
                </motion.div>
              )}

              {activeTab === 'team' && !isAgent && <TeamTab />}

              {activeTab === 'integrations' && !isAgent && <IntegrationsTab />}

              {activeTab === 'dispositions' && !isAgent && <DispositionsTab />}

              {activeTab === 'dnc' && !isAgent && <DncTab />}

              {activeTab === 'security' ? (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                  <PageHeader title="Security" />
                  <EmptyState
                    icon={Construction}
                    title="Coming soon"
                    body="This feature is under development."
                  />
                </motion.div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
