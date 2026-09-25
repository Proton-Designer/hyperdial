import { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import {
  User,
  Phone,
  Users as UsersIcon,
  Zap,
  Shield,
  Globe,
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
} from 'lucide-react';
import { usePhoneNumbers } from '@/contexts/PhoneNumbersContext';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
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
  type OrgMember,
  type GhlIntegrationStatus,
  type CrmSyncJob,
  type TelnyxConnectionStatus,
  type Disposition,
  type DispositionLeadEffect,
  type DncNumber,
} from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ListSkeleton } from '@/components/app/skeletons';
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
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-10 w-32 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <h1 className="text-3xl font-bold text-white mb-8">Profile Settings</h1>

      <div className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-8 border border-white/5 shadow-[0_4px_24px_rgba(0,102,255,0.15)] mb-8">
        <div className="flex items-center gap-6 mb-8">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-[#00D9FF] to-[#0066FF] flex items-center justify-center text-white text-3xl font-bold">
            {initials.toUpperCase() || (ctxFirstName?.[0] ?? '') + (ctxLastName?.[0] ?? '')}
          </div>
          <div>
            <h3 className="text-2xl font-bold text-white mb-1">
              {firstName || lastName ? `${firstName} ${lastName}`.trim() : 'Your profile'}
            </h3>
            <p className="text-[#B0BEC5]">{user?.email}</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-6">
          <div>
            <h4 className="text-lg font-semibold text-white mb-4">Personal Information</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[#B0BEC5] mb-2">First Name</label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#00D9FF] transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm text-[#B0BEC5] mb-2">Last Name</label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#00D9FF] transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm text-[#B0BEC5] mb-2">Email</label>
                <input
                  type="email"
                  value={user?.email ?? ''}
                  readOnly
                  className="w-full bg-[#1E2A3A]/60 border border-white/10 rounded-xl px-4 py-3 text-[#B0BEC5] cursor-not-allowed"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 mt-8 pt-6 border-t border-white/5">
          {saved && <span className="text-sm text-[#00E676] mr-auto">Saved</span>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-3 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold shadow-[0_4px_24px_rgba(0,217,255,0.3)] hover:shadow-[0_6px_32px_rgba(0,217,255,0.4)] transition-all disabled:opacity-60"
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
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold text-white">Team</h1>
        {canManage && (
          <button
            onClick={() => {
              setShowInvite((v) => !v);
              setInviteLink(null);
            }}
            className="px-5 py-2.5 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold text-sm"
          >
            Invite member
          </button>
        )}
      </div>

      {canManage && showInvite && (
        <div className="bg-gradient-to-r from-[#0066FF]/10 to-[#00D9FF]/10 backdrop-blur-xl rounded-2xl p-6 border border-[#0066FF]/20 mb-6">
          <h3 className="text-lg font-semibold text-white mb-4">Invite a teammate</h3>
          {inviteLink ? (
            <div>
              <p className="text-sm text-[#B0BEC5] mb-3">
                Send this single-use link (expires in 7 days). Anyone with it can join as{' '}
                {inviteRole}.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={inviteLink}
                  className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white text-sm"
                  onFocus={(e) => e.target.select()}
                />
                <button
                  onClick={handleCopyLink}
                  className="px-4 py-3 bg-[#00D9FF]/20 hover:bg-[#00D9FF]/30 border border-[#00D9FF]/30 rounded-xl text-[#00D9FF] flex items-center gap-2"
                >
                  {linkCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {linkCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleCreateInvite} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-sm text-[#B0BEC5] mb-2">Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                  className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF]"
                  placeholder="teammate@company.com"
                />
              </div>
              <div>
                <label className="block text-sm text-[#B0BEC5] mb-2">Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'admin' | 'agent')}
                  className="bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#00D9FF]"
                >
                  <option value="agent">Agent</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button
                type="submit"
                disabled={inviteSubmitting}
                className="px-6 py-3 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold disabled:opacity-50 flex items-center gap-2"
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
        <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error || actionError}
        </div>
      )}

      {loading ? (
        <ListSkeleton rows={4} />
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
                className="flex items-center justify-between p-4 bg-[#1A2332]/60 backdrop-blur-xl rounded-xl border border-white/5"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#00D9FF] to-[#0066FF] flex items-center justify-center text-white text-sm font-semibold flex-shrink-0">
                    {name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-white font-medium truncate">
                      {name} {isSelf && <span className="text-[#B0BEC5] text-xs">(you)</span>}
                    </div>
                    <div className="text-sm text-[#B0BEC5] truncate">{m.email}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs border ${
                      m.status === 'disabled'
                        ? 'bg-white/5 text-[#B0BEC5] border-white/10'
                        : 'bg-[#00E676]/10 text-[#00E676] border-[#00E676]/20'
                    }`}
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
                        className="bg-[#1E2A3A] border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-[#00D9FF]"
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
                        className="p-2 rounded-lg hover:bg-white/5 text-[#B0BEC5] hover:text-white transition-colors disabled:opacity-50"
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
                        className="p-2 rounded-lg hover:bg-red-500/10 text-[#B0BEC5] hover:text-[#FF3D00] transition-colors disabled:opacity-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <span className="text-sm text-[#B0BEC5] px-2">{ROLE_LABEL[m.role]}</span>
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
      <h1 className="text-3xl font-bold text-white mb-2">Integrations</h1>
      <p className="text-[#B0BEC5] mb-8">
        Connect a GHL (GoHighLevel) sub-account to sync dispositions, notes, tags and callback tasks
        after every call.
      </p>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <Skeleton className="h-[140px] w-full max-w-xl rounded-2xl" />
      ) : (
        <div className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 max-w-xl">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00D9FF] to-[#0066FF] flex items-center justify-center">
                <Zap className="w-5 h-5 text-white" />
              </div>
              <div>
                <div className="text-white font-medium">GoHighLevel</div>
                <div className="text-sm text-[#B0BEC5]">
                  {isConnected && status?.location_id
                    ? `Location ${status.location_id}`
                    : 'Not connected'}
                </div>
              </div>
            </div>
            <span
              className={`px-2.5 py-1 rounded-full text-xs border ${
                isConnected
                  ? 'bg-[#00E676]/10 text-[#00E676] border-[#00E676]/20'
                  : 'bg-white/5 text-[#B0BEC5] border-white/10'
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
            <p className="text-sm text-[#B0BEC5]">
              Only the org owner can connect or disconnect GHL.
            </p>
          ) : isConnected ? (
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="px-5 py-2.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-xl text-red-400 text-sm font-medium disabled:opacity-50 flex items-center gap-2"
            >
              {disconnecting && <Loader2 className="w-4 h-4 animate-spin" />}
              Disconnect
            </button>
          ) : (
            <form onSubmit={handleConnect} className="space-y-4">
              <div>
                <label className="block text-sm text-[#B0BEC5] mb-2">
                  Private Integration Token
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF]"
                  placeholder="pit-..."
                />
              </div>
              <div>
                <label className="block text-sm text-[#B0BEC5] mb-2">Location ID</label>
                <input
                  type="text"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  required
                  className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF]"
                  placeholder="Sub-account location ID"
                />
              </div>
              <button
                type="submit"
                disabled={connecting}
                className="px-6 py-3 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold disabled:opacity-50 flex items-center gap-2"
              >
                {connecting && <Loader2 className="w-4 h-4 animate-spin" />}
                Connect GHL
              </button>
            </form>
          )}
        </div>
      )}

      {isConnected && <SyncStatusList />}
    </motion.div>
  );
}

const SYNC_STATUS_BADGE: Record<CrmSyncJob['status'], string> = {
  queued: 'bg-white/5 text-[#B0BEC5] border-white/10',
  running: 'bg-[#0066FF]/10 text-[#0066FF] border-[#0066FF]/20',
  done: 'bg-[#00E676]/10 text-[#00E676] border-[#00E676]/20',
  failed: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  dead: 'bg-red-500/10 text-red-400 border-red-500/30',
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
    <div className="mt-6 bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 max-w-xl">
      <h3 className="text-white font-medium mb-4">Sync status</h3>
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-[#B0BEC5]">No sync activity yet.</p>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center justify-between gap-3 py-2 border-b border-white/5 last:border-0"
            >
              <div className="min-w-0">
                <div className="text-sm text-white capitalize">{job.kind.replace('_', ' ')}</div>
                {job.status === 'dead' && job.last_error && (
                  <div className="text-xs text-red-400 truncate" title={job.last_error}>
                    {job.last_error}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {job.attempts > 0 && (
                  <span className="text-xs text-[#B0BEC5]">{job.attempts} attempt(s)</span>
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

  const [editLabel, setEditLabel] = useState('');
  const [editGhlTag, setEditGhlTag] = useState('');
  const [editCreatesTask, setEditCreatesTask] = useState(false);

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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await createDisposition({
        key: newKey.trim(),
        label: newLabel.trim(),
        lead_effect: newLeadEffect,
        ghl_tag: newGhlTag.trim() || null,
        creates_task: newCreatesTask,
        sort: dispositions.length * 10 + 10,
      });
      setNewKey('');
      setNewLabel('');
      setNewLeadEffect('completed');
      setNewGhlTag('');
      setNewCreatesTask(false);
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
      <h1 className="text-3xl font-bold text-white mb-2">Dispositions</h1>
      <p className="text-[#B0BEC5] mb-8">
        The outcomes agents choose after each call, and their effect on the lead and on GHL.
      </p>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {!isAdmin ? (
        <p className="text-sm text-[#B0BEC5]">Only an owner or admin can manage dispositions.</p>
      ) : loading ? (
        <Skeleton className="h-[320px] w-full max-w-2xl rounded-2xl" />
      ) : (
        <div className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 max-w-2xl">
          <div className="space-y-2 mb-4">
            {dispositions.map((d) => (
              <div key={d.id} className="py-3 border-b border-white/5 last:border-0">
                {editingId === d.id ? (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00D9FF]"
                        placeholder="Label"
                      />
                      <input
                        type="text"
                        value={editGhlTag}
                        onChange={(e) => setEditGhlTag(e.target.value)}
                        className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00D9FF]"
                        placeholder="GHL tag (optional)"
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-[#B0BEC5]">
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
                        className="px-4 py-2 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-lg text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                      >
                        {savingId === d.id && <Loader2 className="w-4 h-4 animate-spin" />}
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-[#B0BEC5] text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div
                        className={`text-sm font-medium ${d.active ? 'text-white' : 'text-[#B0BEC5] line-through'}`}
                      >
                        {d.label}
                      </div>
                      <div className="text-xs text-[#B0BEC5] mt-0.5">
                        {LEAD_EFFECT_LABEL[d.lead_effect]}
                        {d.ghl_tag ? ` · GHL tag "${d.ghl_tag}"` : ' · no GHL tag'}
                        {d.creates_task ? ' · creates task' : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => toggleActive(d)}
                        disabled={savingId === d.id}
                        className={`px-2.5 py-1 rounded-full text-xs border disabled:opacity-50 ${
                          d.active
                            ? 'bg-[#00E676]/10 text-[#00E676] border-[#00E676]/20'
                            : 'bg-white/5 text-[#B0BEC5] border-white/10'
                        }`}
                      >
                        {d.active ? 'Active' : 'Inactive'}
                      </button>
                      <button
                        onClick={() => startEdit(d)}
                        className="p-1.5 text-[#B0BEC5] hover:text-white"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(d)}
                        disabled={savingId === d.id}
                        className="p-1.5 text-[#B0BEC5] hover:text-red-400 disabled:opacity-50"
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
            <form onSubmit={handleCreate} className="space-y-3 pt-4 border-t border-white/5">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  required
                  pattern="[a-z0-9_]+"
                  title="lowercase letters, numbers and underscores only"
                  className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00D9FF]"
                  placeholder="key (e.g. not_home)"
                />
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  required
                  className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00D9FF]"
                  placeholder="Label shown to agents"
                />
              </div>
              <div className="flex gap-2">
                <select
                  value={newLeadEffect}
                  onChange={(e) => setNewLeadEffect(e.target.value as DispositionLeadEffect)}
                  className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00D9FF]"
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
                  className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00D9FF]"
                  placeholder="GHL tag (optional)"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-[#B0BEC5]">
                <input
                  type="checkbox"
                  checked={newCreatesTask}
                  onChange={(e) => setNewCreatesTask(e.target.checked)}
                />
                Creates a GHL task (only meaningful for a "Callback"-style effect)
              </label>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-lg text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                  Add disposition
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-[#B0BEC5] text-sm flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              className="mt-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-[#B0BEC5] text-sm flex items-center gap-2"
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
      <h1 className="text-3xl font-bold text-white mb-2">Do-not-call list</h1>
      <p className="text-[#B0BEC5] mb-8">
        Org-wide numbers excluded from dialing and from CSV/GHL imports, in addition to each
        contact's own DNC flag.
      </p>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {!isAdmin ? (
        <p className="text-sm text-[#B0BEC5]">
          Only an owner or admin can manage the do-not-call list.
        </p>
      ) : loading ? (
        <Skeleton className="h-[220px] w-full max-w-2xl rounded-2xl" />
      ) : (
        <div className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 max-w-2xl">
          <form onSubmit={handleAdd} className="flex gap-2 mb-4">
            <input
              type="text"
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
              required
              className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00D9FF]"
              placeholder="Phone number"
            />
            <input
              type="text"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#00D9FF]"
              placeholder="Note (optional)"
            />
            <button
              type="submit"
              disabled={adding}
              className="px-4 py-2 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-lg text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2 flex-shrink-0"
            >
              {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add
            </button>
          </form>

          <div className="relative mb-4">
            <Search className="w-4 h-4 text-[#B0BEC5] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-[#1E2A3A] border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-[#00D9FF]"
              placeholder="Search"
            />
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-[#B0BEC5] py-4 text-center">No numbers on the list.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((n) => (
                <div
                  key={n.id}
                  className="flex items-center justify-between gap-3 py-3 border-b border-white/5 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white">{n.e164}</div>
                    <div className="text-xs text-[#B0BEC5] mt-0.5">
                      {n.source}
                      {n.note ? ` · ${n.note}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemove(n)}
                    disabled={removingId === n.id}
                    className="p-1.5 text-[#B0BEC5] hover:text-red-400 disabled:opacity-50 flex-shrink-0"
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

export function Settings() {
  const {
    numbers: phoneNumbers,
    loading: phoneNumbersLoading,
    error: phoneNumbersError,
    refetch: refetchPhoneNumbers,
  } = usePhoneNumbers();
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

  return (
    <div className="flex h-full">
      {/* Sidebar Navigation */}
      <div className="w-64 bg-[#1A2332]/60 backdrop-blur-xl border-r border-white/5 p-6">
        <h2 className="text-white font-bold text-lg mb-6">Settings</h2>
        <nav className="space-y-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                  activeTab === tab.id
                    ? 'bg-[#0066FF]/10 text-white border-l-4 border-[#00D9FF]'
                    : 'text-[#B0BEC5] hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="font-medium">{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl">
          {orgLoading ? (
            <div>
              <Skeleton className="h-8 w-40 mb-8" />
              <Skeleton className="h-[140px] w-full rounded-2xl mb-4" />
              <Skeleton className="h-[140px] w-full rounded-2xl" />
            </div>
          ) : (
            <>
              {activeTab === 'profile' && <ProfileTab />}

              {activeTab === 'phone' && !isAgent && (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                  <h1 className="text-3xl font-bold text-white mb-2">Telephony</h1>
                  <p className="text-[#B0BEC5] mb-8">
                    Connect your org's own Telnyx account, then buy and share phone numbers across
                    the team.
                  </p>

                  {telnyxError && (
                    <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                      {telnyxError}
                    </div>
                  )}

                  {telnyxStatusLoading ? (
                    <Skeleton className="h-[104px] w-full rounded-2xl mb-8" />
                  ) : (
                    <div className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 mb-8">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00D9FF] to-[#0066FF] flex items-center justify-center">
                            <Phone className="w-5 h-5 text-white" />
                          </div>
                          <div>
                            <div className="text-white font-medium">Telnyx</div>
                            <div className="text-sm text-[#B0BEC5]">
                              {isTelnyxConnected && telnyxStatus?.api_key_last4
                                ? `Key ending in ${telnyxStatus.api_key_last4}`
                                : 'Not connected'}
                            </div>
                          </div>
                        </div>
                        <span
                          className={`px-2.5 py-1 rounded-full text-xs border ${
                            isTelnyxConnected
                              ? 'bg-[#00E676]/10 text-[#00E676] border-[#00E676]/20'
                              : 'bg-white/5 text-[#B0BEC5] border-white/10'
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
                        <p className="text-sm text-[#B0BEC5]">
                          Only the org owner can connect or disconnect Telnyx.
                        </p>
                      ) : isTelnyxConnected ? (
                        <button
                          onClick={handleDisconnectTelnyx}
                          disabled={telnyxDisconnecting}
                          className="px-5 py-2.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-xl text-red-400 text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                        >
                          {telnyxDisconnecting && <Loader2 className="w-4 h-4 animate-spin" />}
                          Disconnect
                        </button>
                      ) : (
                        <form onSubmit={handleConnectTelnyx} className="space-y-4">
                          <div>
                            <label className="block text-sm text-[#B0BEC5] mb-2">
                              Telnyx API Key
                            </label>
                            <input
                              type="password"
                              value={telnyxApiKey}
                              onChange={(e) => setTelnyxApiKey(e.target.value)}
                              required
                              className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF]"
                              placeholder="KEY..."
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-[#B0BEC5] mb-2">
                              Webhook Public Key
                            </label>
                            <input
                              type="text"
                              value={telnyxWebhookPublicKey}
                              onChange={(e) => setTelnyxWebhookPublicKey(e.target.value)}
                              required
                              className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF]"
                              placeholder="From your Telnyx portal's public keys page"
                            />
                            <p className="text-xs text-[#B0BEC5]/70 mt-1.5">
                              Find this in your{' '}
                              <a
                                href="https://portal.telnyx.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[#00D9FF] hover:underline"
                              >
                                Telnyx Portal
                              </a>{' '}
                              under API Keys → Public Key.
                            </p>
                          </div>
                          <button
                            type="submit"
                            disabled={telnyxConnecting}
                            className="px-6 py-3 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold disabled:opacity-50 flex items-center gap-2"
                          >
                            {telnyxConnecting && <Loader2 className="w-4 h-4 animate-spin" />}
                            Connect Telnyx
                          </button>
                        </form>
                      )}
                    </div>
                  )}

                  <h2 className="text-xl font-bold text-white mb-4">Phone Numbers</h2>

                  {(phoneError || phoneNumbersError) && (
                    <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                      {phoneError || phoneNumbersError}
                    </div>
                  )}

                  <div className="space-y-4 mb-8">
                    {phoneNumbersLoading ? (
                      <ListSkeleton rows={2} />
                    ) : phoneNumbers.length === 0 ? (
                      <div className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-8 border border-white/5 text-center">
                        <p className="text-[#B0BEC5]">
                          No phone numbers yet. Search and purchase below.
                        </p>
                      </div>
                    ) : (
                      phoneNumbers.map((phone) => (
                        <div
                          key={phone.id}
                          className="bg-[#1A2332]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/5 shadow-[0_4px_24px_rgba(0,102,255,0.15)]"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <div className="text-2xl font-bold text-white mb-1">
                                {phone.phone_number}
                              </div>
                              <div className="flex items-center gap-4 text-sm text-[#B0BEC5]">
                                <span className="flex items-center gap-1.5">
                                  <Globe className="w-4 h-4" />
                                  US
                                </span>
                                <span className="px-2 py-1 rounded-full text-xs bg-[#00E676]/10 text-[#00E676] border border-[#00E676]/20">
                                  Active
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {!isTelnyxConnected ? (
                    <div className="bg-gradient-to-r from-[#0066FF]/10 to-[#00D9FF]/10 backdrop-blur-xl rounded-2xl p-8 border border-[#0066FF]/20 text-center">
                      <p className="text-[#B0BEC5]">
                        Connect your org's Telnyx account above to search and purchase numbers.
                      </p>
                    </div>
                  ) : (
                    <div className="bg-gradient-to-r from-[#0066FF]/10 to-[#00D9FF]/10 backdrop-blur-xl rounded-2xl p-8 border border-[#0066FF]/20">
                      <h3 className="text-xl font-bold text-white mb-4">Purchase Numbers</h3>
                      <p className="text-[#B0BEC5] mb-4">
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
                          className="flex-1 bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF]"
                        />
                        <button
                          onClick={handleSearchNumbers}
                          disabled={searchLoading}
                          className="px-6 py-3 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold disabled:opacity-50 flex items-center gap-2"
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
                        <div className="py-4 text-center text-[#B0BEC5]">
                          Searching Telnyx marketplace…
                        </div>
                      )}
                      {searchAttempted && !searchLoading && searchResults.length === 0 && (
                        <div className="py-4 text-center text-[#B0BEC5] text-sm">
                          No numbers found for this area. Try a different area code or leave blank
                          for US numbers.
                        </div>
                      )}
                      {searchResults.length > 0 && (
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {searchResults.map((n) => (
                            <div
                              key={n.phone_number}
                              className="flex items-center justify-between p-3 bg-[#1E2A3A]/60 rounded-lg"
                            >
                              <span className="text-white font-medium">{n.phone_number}</span>
                              <span className="text-[#B0BEC5] text-sm">
                                {n.monthly_cost ? `$${n.monthly_cost}/mo` : ''}
                              </span>
                              <button
                                onClick={() => handlePurchaseNumber(n.phone_number)}
                                disabled={purchaseLoading === n.phone_number}
                                className="px-4 py-2 bg-[#00E676]/20 hover:bg-[#00E676]/30 border border-[#00E676]/30 rounded-lg text-[#00E676] text-sm font-medium disabled:opacity-50 flex items-center gap-1"
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
                </motion.div>
              )}

              {activeTab === 'team' && !isAgent && <TeamTab />}

              {activeTab === 'integrations' && !isAgent && <IntegrationsTab />}

              {activeTab === 'dispositions' && !isAgent && <DispositionsTab />}

              {activeTab === 'dnc' && !isAgent && <DncTab />}

              {activeTab === 'security' ? (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-center py-20"
                >
                  <div className="text-6xl mb-4">🚧</div>
                  <h3 className="text-2xl font-bold text-white mb-2">Coming Soon</h3>
                  <p className="text-[#B0BEC5]">This feature is under development</p>
                </motion.div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
