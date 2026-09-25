import { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
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
  getGhlIntegrationStatus,
  connectGhl,
  disconnectGhl,
  updateGhlBlockedTags,
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
  getMyVoicemailDrop,
  getOrgDefaultVoicemailDrop,
  uploadMyVoicemailDrop,
  uploadOrgDefaultVoicemailDrop,
  getNumberPoolSettings,
  updateNumberPoolSettings,
  assignPhoneNumber,
  setPhoneNumberStatus,
  type NumberPoolSettings,
  type VoicemailDropInfo,
  type OrgMember,
  type GhlIntegrationStatus,
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
  }, []);

  const initials =
    (firstName[0] ?? '') + (lastName[0] ?? '') || (user?.email ?? 'U').slice(0, 2).toUpperCase();

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateMyProfile({ first_name: firstName, last_name: lastName });
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
    </motion.div>
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
  };

  const saveEdit = async (id: string) => {
    setSavingId(id);
    setError(null);
    try {
      await updateDisposition(id, {
        label: editLabel.trim(),
        ghl_tag: editGhlTag.trim() || null,
        creates_task: editCreatesTask,
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

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    getRecordingEnabled()
      .then(setEnabled)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
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
                    <button
                      type="button"
                      disabled={rowBusyId === n.id}
                      onClick={() => void handleRetireToggle(n.id, n.status)}
                      className="text-meta text-text-secondary hover:text-text-primary disabled:opacity-50"
                    >
                      {n.status === 'retired' ? 'Reactivate' : 'Retire'}
                    </button>
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
                  <VoicemailDropCard />
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
