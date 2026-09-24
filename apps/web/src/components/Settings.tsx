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
  getTelnyxConnectionStatus,
  connectTelnyx,
  disconnectTelnyx,
  type OrgMember,
  type GhlIntegrationStatus,
  type TelnyxConnectionStatus,
} from '@/lib/api';

type SettingsTab = 'profile' | 'phone' | 'team' | 'integrations' | 'security';

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
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 text-[#00D9FF] animate-spin" />
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
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 text-[#00D9FF] animate-spin" />
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
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 text-[#00D9FF] animate-spin" />
        </div>
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
    { id: 'security' as SettingsTab, label: 'Security', icon: Shield },
  ];

  useEffect(() => {
    if (
      isAgent &&
      (activeTab === 'phone' || activeTab === 'team' || activeTab === 'integrations')
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
    <div className="flex h-[calc(100vh-72px)]">
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
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 text-[#00D9FF] animate-spin" />
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
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-8 h-8 text-[#00D9FF] animate-spin" />
                    </div>
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
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-8 h-8 text-[#00D9FF] animate-spin" />
                      </div>
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
