import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Phone,
  Trash2,
  Upload,
  UserPlus,
  Users,
  Play,
  Loader2,
  Settings as SettingsIcon,
  Save,
  RotateCw,
  SkipForward,
  UserCog,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getCampaign,
  updateCampaignStatus,
  updateCampaignSettings,
  deleteCampaign,
  listCampaignAgentIds,
  setCampaignAgents,
  listOrgMembers,
  listCampaignLeads,
  addLeadsToCampaign,
  removeLeadFromCampaign,
  removeLeadsFromCampaign,
  assignCampaignLeads,
  setCampaignLeadPriority,
  skipCampaignLead,
  listContacts,
  listCampaignRetryRules,
  upsertCampaignRetryRules,
  type CampaignWithStats,
  type CampaignSettingsInput,
  type CampaignLead,
  type CampaignLeadPriority,
  type AssignLeadsFilter,
  type Contact,
  type OrgMember,
  type CampaignRetryRule,
  type RetryRuleAction,
} from '../../lib/api';
import { ImportContactsModal } from '../contacts/ImportContactsModal';
import { AddContactModal } from '../contacts/AddContactModal';
import { AssignLeadsModal } from './AssignLeadsModal';
import { usePhoneNumbers } from '../../contexts/PhoneNumbersContext';
import { useOrg } from '../../contexts/OrgContext';
import { setPendingStartCampaignId } from '../../lib/dialerLaunchIntent';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useFocusTrap } from '@/hooks/useFocusTrap';

const CATEGORIES = ['All', 'Cold', 'Warm', 'Follow Up', 'Voicemail', 'Booked'] as const;
const CONTACT_STATUSES = ['All', 'No Contact', 'Contacted'] as const;
const LEADS_PER_PAGE = 50;

function contactDisplayName(c: Contact): string {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return name || c.business_name || '—';
}

function formatDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

interface CampaignManageModalProps {
  open: boolean;
  campaignId: string | null;
  onClose: () => void;
  onRefreshList: () => void;
  onNavigateToDialer: () => void;
  onStartParallelDial: (ctx: { sessionId: string; campaignId: string }) => void;
  onOpenDialerWithSession?: (ctx: { sessionId: string; campaignId: string }) => void;
}

const RETRY_RULE_LABEL: Record<string, string> = {
  no_answer: 'No answer',
  voicemail: 'Voicemail',
  callback: 'Callback',
  interested: 'Interested',
  not_interested: 'Not interested',
  wrong_number: 'Wrong number',
  dnc: 'Do not call',
};

/** Campaign settings -> Retry Rules (TASK-F-T1, QUE-2/QUE-3/QUE-5), admin+ only. Small and
 *  functional per the task spec -- one row per seeded disposition_key, own fetch-on-mount/save
 *  lifecycle (independent of settingsForm's single Save button since this is a list of rows, not
 *  one flat form). delay_minutes is edited here as days (this build's two seeded retry rules are
 *  both "4 days"), converted at the save boundary. */
function RetryRulesCard({ campaignId }: { campaignId: string }) {
  const [rules, setRules] = useState<CampaignRetryRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    listCampaignRetryRules(campaignId)
      .then((r) =>
        setRules([...r].sort((a, b) => a.disposition_key.localeCompare(b.disposition_key)))
      )
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load retry rules'))
      .finally(() => setLoading(false));
  }, [campaignId]);

  const updateRule = (id: string, patch: Partial<CampaignRetryRule>) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await upsertCampaignRetryRules(
        campaignId,
        rules.map((r) => ({
          disposition_key: r.disposition_key,
          action: r.action,
          delay_minutes: r.action === 'retry' ? (r.delay_minutes ?? 1440) : null,
          rotate_block: r.action === 'retry' ? r.rotate_block : false,
        }))
      );
      toast.success('Retry rules saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save retry rules');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-2/60 rounded-app-lg border border-white/5 p-6 mb-6">
        <Loader2 className="w-5 h-5 text-accent-to animate-spin" />
      </div>
    );
  }
  if (rules.length === 0) return null;

  return (
    <div className="bg-surface-2/60 rounded-app-lg border border-white/5 p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <RotateCw className="w-5 h-5" />
          Retry Rules
        </h3>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-accent-from to-accent-to rounded-lg text-white text-sm font-semibold disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Rules
        </button>
      </div>
      <div className="space-y-3">
        {rules.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3">
            <div className="w-36 text-sm text-white flex-shrink-0">
              {RETRY_RULE_LABEL[r.disposition_key] ?? r.disposition_key}
            </div>
            <select
              value={r.action}
              onChange={(e) => updateRule(r.id, { action: e.target.value as RetryRuleAction })}
              className="bg-surface-1 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="retry">Retry</option>
              <option value="out">Out (exhaust)</option>
              <option value="exact_time">Exact time</option>
            </select>
            {r.action === 'retry' && (
              <>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    value={Math.max(1, Math.round((r.delay_minutes ?? 1440) / 1440))}
                    onChange={(e) =>
                      updateRule(r.id, {
                        delay_minutes: Math.max(1, Number(e.target.value)) * 1440,
                      })
                    }
                    className="w-20 bg-surface-1 border border-white/10 rounded-lg px-2 py-2 text-sm text-white"
                  />
                  <span className="text-xs text-text-secondary">days</span>
                </div>
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={r.rotate_block}
                    onChange={(e) => updateRule(r.id, { rotate_block: e.target.checked })}
                  />
                  Rotate time block
                </label>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CampaignManageModal({
  open,
  campaignId,
  onClose,
  onRefreshList,
  onNavigateToDialer,
}: CampaignManageModalProps) {
  const { numbers: userNumbers } = usePhoneNumbers();
  const { role } = useOrg();
  const canManage = role === 'owner' || role === 'admin';
  const [campaign, setCampaign] = useState<CampaignWithStats | null>(null);
  const [leads, setLeads] = useState<CampaignLead[]>([]);
  const [settingsForm, setSettingsForm] = useState<CampaignSettingsInput | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [assignedAgentIds, setAssignedAgentIds] = useState<Set<string>>(new Set());
  const [savingAgents, setSavingAgents] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>('All');
  const [contactStatusFilter, setContactStatusFilter] = useState<string>('All');
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set());
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [addExistingOpen, setAddExistingOpen] = useState(false);
  const [addNewOpen, setAddNewOpen] = useState(false);
  const [contactsForPicker, setContactsForPicker] = useState<Contact[]>([]);
  const [leadsPage, setLeadsPage] = useState(0);
  const [confirmRemoveContactId, setConfirmRemoveContactId] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, open);
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false);
  const [assignModalOpen, setAssignModalOpen] = useState(false);

  const fetchCampaign = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    try {
      const c = await getCampaign(campaignId);
      setCampaign(c);
      if (c) {
        setSettingsForm({
          lines: c.lines,
          amd_mode: c.amd_mode,
          voicemail_drop_mode: c.voicemail_drop_mode,
          caller_id_number_id: c.caller_id_number_id,
          max_attempts: c.max_attempts,
          retry_interval_minutes: c.retry_interval_minutes,
          calling_window_start: c.calling_window_start,
          calling_window_end: c.calling_window_end,
          abandon_message_enabled: c.abandon_message_enabled,
          script_text: c.script_text,
          objection_sheet_text: c.objection_sheet_text,
        });
      }
    } catch {
      setCampaign(null);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  const fetchAssignment = useCallback(async () => {
    if (!campaignId || !canManage) return;
    try {
      const [members, assignedIds] = await Promise.all([
        listOrgMembers(),
        listCampaignAgentIds(campaignId),
      ]);
      setOrgMembers(members.filter((m) => m.status === 'active'));
      setAssignedAgentIds(new Set(assignedIds));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load agent assignments');
    }
  }, [campaignId, canManage]);

  const fetchLeads = useCallback(async () => {
    if (!campaignId) return;
    setLeadsLoading(true);
    try {
      const list = await listCampaignLeads(campaignId);
      setLeads(list);
    } catch {
      setLeads([]);
    } finally {
      setLeadsLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    if (open && campaignId) {
      fetchCampaign();
      fetchLeads();
      fetchAssignment();
    }
  }, [open, campaignId, fetchCampaign, fetchLeads, fetchAssignment]);

  useEffect(() => {
    if (addExistingOpen) {
      listContacts()
        .then(setContactsForPicker)
        .catch(() => setContactsForPicker([]));
    }
  }, [addExistingOpen]);

  const filteredLeads = leads.filter((lead) => {
    const cat = lead.contact?.category ?? '';
    const status = lead.contact?.contact_status ?? '';
    const matchCat = categoryFilter === 'All' || cat === categoryFilter;
    const matchStatus = contactStatusFilter === 'All' || status === contactStatusFilter;
    return matchCat && matchStatus;
  });

  const paginatedLeads = filteredLeads.slice(
    leadsPage * LEADS_PER_PAGE,
    (leadsPage + 1) * LEADS_PER_PAGE
  );
  const totalPages = Math.ceil(filteredLeads.length / LEADS_PER_PAGE) || 1;

  const handleUpdateStatus = async (status: 'active' | 'paused' | 'completed') => {
    if (!campaignId) return;
    try {
      await updateCampaignStatus(campaignId, status);
      await fetchCampaign();
      onRefreshList();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update status');
    }
  };

  const handleSaveSettings = async () => {
    if (!campaignId || !settingsForm) return;
    setSavingSettings(true);
    try {
      await updateCampaignSettings(campaignId, settingsForm);
      await fetchCampaign();
      toast.success('Dialer settings saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  const toggleAssignedAgent = (userId: string) => {
    setAssignedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleSaveAgents = async () => {
    if (!campaignId) return;
    setSavingAgents(true);
    try {
      await setCampaignAgents(campaignId, Array.from(assignedAgentIds));
      toast.success('Agent assignments saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save agent assignments');
      await fetchAssignment();
    } finally {
      setSavingAgents(false);
    }
  };

  const handleDeleteCampaign = async () => {
    if (!campaignId) return;
    setDeleting(true);
    try {
      await deleteCampaign(campaignId);
      setConfirmDeleteOpen(false);
      onClose();
      onRefreshList();
      toast.success('Campaign deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete campaign');
    } finally {
      setDeleting(false);
    }
  };

  /**
   * TASK-L1 re-review (L1x L5 blocker) + TASK-L7: this used to run its own WebRTC pre-flight
   * client and call startDialerSession directly -- exactly the second, unsynchronized client
   * that raced the server's own (synchronous) agent-leg dial and caused every Start to land on
   * "Your line dropped". The Dialer is now the ONLY place that registers a client or starts a
   * session; this just hands off which campaign to start (a same-tab, in-memory intent -- see
   * dialerLaunchIntent.ts) and navigates there. The Dialer's own Start panel shows the SAME
   * campaign list (owners/admins see every campaign, same as this modal), including the mic-
   * permission check, the 409-existing-session "Open it" offer, and the actual start.
   */
  const handleStartParallelDialing = () => {
    if (!campaignId) return;
    if ((campaign?.total_contacts ?? 0) === 0) {
      toast.error('Add contacts before starting a session');
      return;
    }
    setPendingStartCampaignId(campaignId);
    onClose();
    onNavigateToDialer();
  };

  const handleImportSuccess = () => {
    setImportModalOpen(false);
    fetchLeads();
    fetchCampaign();
    onRefreshList();
  };

  const reportAddLeadsResult = (result: {
    added: number;
    skippedDnc: number;
    skippedActiveElsewhere: number;
  }) => {
    const skips: string[] = [];
    if (result.skippedDnc > 0) skips.push(`${result.skippedDnc} DNC`);
    if (result.skippedActiveElsewhere > 0)
      skips.push(`${result.skippedActiveElsewhere} already active elsewhere`);
    if (skips.length === 0) {
      toast.success(`Added ${result.added} contact${result.added === 1 ? '' : 's'}`);
    } else {
      toast.warning(
        `Added ${result.added} contact${result.added === 1 ? '' : 's'} -- skipped ${skips.join(', ')}`
      );
    }
  };

  const handleAddExisting = async (selectedIds: string[]) => {
    if (!campaignId || selectedIds.length === 0) return;
    try {
      const result = await addLeadsToCampaign(campaignId, selectedIds);
      setAddExistingOpen(false);
      reportAddLeadsResult(result);
      fetchLeads();
      fetchCampaign();
      onRefreshList();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add leads');
    }
  };

  const handleAddNewSuccess = (contact?: Contact) => {
    if (campaignId && contact) {
      addLeadsToCampaign(campaignId, [contact.id])
        .then((result) => {
          reportAddLeadsResult(result);
          fetchLeads();
          fetchCampaign();
          onRefreshList();
        })
        .catch((e) => {
          toast.error(e instanceof Error ? e.message : 'Failed to add lead');
        });
    }
    setAddNewOpen(false);
  };

  const doRemoveLead = async (contactId: string) => {
    if (!campaignId) return;
    try {
      await removeLeadFromCampaign(campaignId, contactId);
      fetchLeads();
      fetchCampaign();
      onRefreshList();
      setConfirmRemoveContactId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove lead');
    }
  };

  const doBulkRemove = async () => {
    if (!campaignId || selectedLeadIds.size === 0) return;
    try {
      await removeLeadsFromCampaign(campaignId, Array.from(selectedLeadIds));
      setSelectedLeadIds(new Set());
      fetchLeads();
      fetchCampaign();
      onRefreshList();
      setConfirmBulkRemove(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove leads');
    }
  };

  const handleRemoveLead = (contactId: string) => setConfirmRemoveContactId(contactId);
  const handleBulkRemove = () => selectedLeadIds.size > 0 && setConfirmBulkRemove(true);

  const handlePriorityChange = async (leadId: string, priority: CampaignLeadPriority) => {
    try {
      await setCampaignLeadPriority(leadId, priority);
      fetchLeads();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update priority');
    }
  };

  /** TASK-T6: "keeps its place/attempt" -- claim_next_leads passes over it for a while, without
   *  incrementing attempts or moving its queue position. */
  const handleSkipLead = async (leadId: string) => {
    try {
      await skipCampaignLead(leadId);
      toast.success('Lead skipped for now');
      fetchLeads();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to skip lead');
    }
  };

  const handleAssignLeads = async (agentId: string | null, filter: AssignLeadsFilter) => {
    if (!campaignId) return;
    const count = await assignCampaignLeads(campaignId, agentId, filter);
    toast.success(agentId ? `Assigned ${count} lead(s)` : `Unassigned ${count} lead(s)`);
    fetchLeads();
    fetchAssignment();
  };

  const handleCallLead = (phoneNumber: string | null) => {
    if (phoneNumber) {
      onNavigateToDialer();
      // Optional: could pass number via context/state for Dialer to pre-fill
    } else {
      toast.error('No phone number');
    }
  };

  const toggleSelectLead = (contactId: string) => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  };

  const selectAllOnPage = () => {
    const ids = paginatedLeads.map((l) => l.contact_id);
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  };

  if (!open) return null;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, isolation: 'isolate' }}>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="fixed inset-8 bg-surface-1 rounded-3xl border border-white/10 shadow-xl overflow-hidden flex flex-col outline-none"
        style={{ zIndex: 1 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/5 flex-shrink-0">
          <div>
            {loading ? (
              <div className="flex items-center gap-2 text-white">
                <Loader2 className="w-5 h-5 animate-spin" />
                Loading…
              </div>
            ) : (
              <>
                <h2 className="text-2xl font-bold text-white">{campaign?.name ?? 'Campaign'}</h2>
                <p className="text-sm text-text-secondary mt-1">
                  Created {campaign ? formatDate(campaign.created_at) : '—'}
                </p>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canManage && (
              <button
                type="button"
                onClick={() => setConfirmDeleteOpen(true)}
                className="p-2 rounded-lg bg-danger/10 hover:bg-danger/20 text-danger"
                title="Delete campaign"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg bg-surface-2 hover:bg-surface-3 text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 min-h-0">
          {campaign && (
            <>
              {/* Status + Start Parallel Dialing */}
              <div className="flex flex-wrap items-center gap-4 mb-6">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-secondary">Status</span>
                  <Select
                    value={campaign.status}
                    onValueChange={(v) =>
                      handleUpdateStatus(v as 'active' | 'paused' | 'completed')
                    }
                  >
                    <SelectTrigger className="w-[140px] bg-surface-2 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      className="bg-surface-2 border-white/10"
                      style={{ zIndex: 10001 }}
                    >
                      <SelectItem
                        value="active"
                        className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                      >
                        Active
                      </SelectItem>
                      <SelectItem
                        value="paused"
                        className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                      >
                        Paused
                      </SelectItem>
                      <SelectItem
                        value="completed"
                        className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                      >
                        Completed
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <button
                  type="button"
                  onClick={handleStartParallelDialing}
                  className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-accent-from to-accent-to rounded-xl text-white font-semibold"
                >
                  <Play className="w-4 h-4" />
                  Start Parallel Dialing Session
                </button>
              </div>

              {/* Dialer settings (admin+ only -- RLS is the real authority, this just hides
                  the UI for an agent) */}
              {canManage && settingsForm && (
                <div className="bg-surface-2/60 rounded-app-lg border border-white/5 p-6 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2">
                      <SettingsIcon className="w-5 h-5" />
                      Dialer Settings
                    </h3>
                    <button
                      type="button"
                      onClick={handleSaveSettings}
                      disabled={savingSettings}
                      className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-accent-from to-accent-to rounded-lg text-white text-sm font-semibold disabled:opacity-60"
                    >
                      {savingSettings ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save Settings
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div>
                      <label className="text-sm text-text-secondary block mb-1">Lines</label>
                      <Select
                        value={String(settingsForm.lines ?? 3)}
                        onValueChange={(v) =>
                          setSettingsForm((f) => (f ? { ...f, lines: Number(v) } : f))
                        }
                      >
                        <SelectTrigger className="w-full bg-surface-1 border-white/10 text-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          className="bg-surface-2 border-white/10"
                          style={{ zIndex: 10001 }}
                        >
                          {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                            <SelectItem
                              key={n}
                              value={String(n)}
                              className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                            >
                              {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm text-text-secondary block mb-1">
                        Answering Machine Detection
                      </label>
                      <Select
                        value={settingsForm.amd_mode ?? 'off'}
                        onValueChange={(v) =>
                          setSettingsForm((f) =>
                            f
                              ? {
                                  ...f,
                                  amd_mode: v as 'off' | 'detect' | 'detect_words' | 'premium',
                                }
                              : f
                          )
                        }
                      >
                        <SelectTrigger className="w-full bg-surface-1 border-white/10 text-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          className="bg-surface-2 border-white/10"
                          style={{ zIndex: 10001 }}
                        >
                          <SelectItem
                            value="off"
                            className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                          >
                            Off
                          </SelectItem>
                          <SelectItem
                            value="detect"
                            className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                          >
                            Detect (standard, ~$0.002/call)
                          </SelectItem>
                          <SelectItem
                            value="detect_words"
                            className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                          >
                            Detect + words (standard, ~$0.002/call -- required for voicemail drop)
                          </SelectItem>
                          <SelectItem
                            value="premium"
                            className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                          >
                            Premium (~$0.0065/call, ~3.25x -- also supports voicemail drop)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-text-secondary/70 mt-1">
                        AMD adds ~2–4s after answer; some humans hang up in that gap. Plain "Detect"
                        never signals when a machine's greeting ends, so voicemail drop (below)
                        silently never fires under it -- use "Detect + words" or "Premium" if you
                        want drops to actually play.
                      </p>
                    </div>
                    <div>
                      <label className="text-sm text-text-secondary block mb-1">
                        Voicemail Drop
                      </label>
                      <Select
                        value={settingsForm.voicemail_drop_mode ?? 'first_attempt'}
                        onValueChange={(v) =>
                          setSettingsForm((f) =>
                            f
                              ? {
                                  ...f,
                                  voicemail_drop_mode: v as
                                    'first_attempt' | 'every_attempt' | 'never',
                                }
                              : f
                          )
                        }
                      >
                        <SelectTrigger className="w-full bg-surface-1 border-white/10 text-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          className="bg-surface-2 border-white/10"
                          style={{ zIndex: 10001 }}
                        >
                          <SelectItem
                            value="first_attempt"
                            className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                          >
                            First attempt only
                          </SelectItem>
                          <SelectItem
                            value="every_attempt"
                            className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                          >
                            Every attempt
                          </SelectItem>
                          <SelectItem
                            value="never"
                            className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                          >
                            Never
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-text-secondary/70 mt-1">
                        Plays each agent's own drop file (Settings), or the org default, when a
                        machine is detected. Set up the file in Settings first.
                      </p>
                    </div>
                    <div>
                      <label className="text-sm text-text-secondary block mb-1">
                        Caller ID Number
                      </label>
                      <Select
                        value={settingsForm.caller_id_number_id ?? '__none__'}
                        onValueChange={(v) =>
                          setSettingsForm((f) =>
                            f ? { ...f, caller_id_number_id: v === '__none__' ? null : v } : f
                          )
                        }
                      >
                        <SelectTrigger className="w-full bg-surface-1 border-white/10 text-white">
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent
                          className="bg-surface-2 border-white/10"
                          style={{ zIndex: 10001 }}
                        >
                          <SelectItem
                            value="__none__"
                            className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                          >
                            None
                          </SelectItem>
                          {userNumbers.map((num) => (
                            <SelectItem
                              key={num.id}
                              value={num.id}
                              className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                            >
                              {num.phone_number}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm text-text-secondary block mb-1">Max Attempts</label>
                      <input
                        type="number"
                        min={1}
                        value={settingsForm.max_attempts ?? 3}
                        onChange={(e) =>
                          setSettingsForm((f) =>
                            f ? { ...f, max_attempts: Math.max(1, Number(e.target.value)) } : f
                          )
                        }
                        className="w-full bg-surface-1 border border-white/10 rounded-lg px-3 py-2 text-white"
                      />
                    </div>
                    <div>
                      <label className="text-sm text-text-secondary block mb-1">
                        Retry Interval (minutes)
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={settingsForm.retry_interval_minutes ?? 120}
                        onChange={(e) =>
                          setSettingsForm((f) =>
                            f
                              ? {
                                  ...f,
                                  retry_interval_minutes: Math.max(0, Number(e.target.value)),
                                }
                              : f
                          )
                        }
                        className="w-full bg-surface-1 border border-white/10 rounded-lg px-3 py-2 text-white"
                      />
                    </div>
                    <div className="flex items-end gap-2">
                      <label className="flex items-center gap-2 text-sm text-text-secondary">
                        <input
                          type="checkbox"
                          checked={settingsForm.abandon_message_enabled ?? true}
                          onChange={(e) =>
                            setSettingsForm((f) =>
                              f ? { ...f, abandon_message_enabled: e.target.checked } : f
                            )
                          }
                        />
                        Play abandon message
                      </label>
                    </div>
                    <div>
                      <label className="text-sm text-text-secondary block mb-1">
                        Calling Window Start (contact-local)
                      </label>
                      <input
                        type="time"
                        value={(settingsForm.calling_window_start ?? '08:00').slice(0, 5)}
                        onChange={(e) =>
                          setSettingsForm((f) =>
                            f ? { ...f, calling_window_start: e.target.value } : f
                          )
                        }
                        className="w-full bg-surface-1 border border-white/10 rounded-lg px-3 py-2 text-white"
                      />
                    </div>
                    <div>
                      <label className="text-sm text-text-secondary block mb-1">
                        Calling Window End (contact-local)
                      </label>
                      <input
                        type="time"
                        value={(settingsForm.calling_window_end ?? '21:00').slice(0, 5)}
                        onChange={(e) =>
                          setSettingsForm((f) =>
                            f ? { ...f, calling_window_end: e.target.value } : f
                          )
                        }
                        className="w-full bg-surface-1 border border-white/10 rounded-lg px-3 py-2 text-white"
                      />
                    </div>
                    <div className="sm:col-span-2 lg:col-span-3">
                      <label className="text-sm text-text-secondary block mb-1">Call Script</label>
                      <textarea
                        rows={4}
                        value={settingsForm.script_text ?? ''}
                        onChange={(e) =>
                          setSettingsForm((f) =>
                            f ? { ...f, script_text: e.target.value || null } : f
                          )
                        }
                        placeholder="Hi, this is {agent} calling from {company}..."
                        className="w-full bg-surface-1 border border-white/10 rounded-lg px-3 py-2 text-white placeholder:text-text-secondary/50 resize-y"
                      />
                      <p className="text-xs text-text-secondary/70 mt-1">
                        Shown collapsible on the intern's call card once a human answers. No AI --
                        plain reference text.
                      </p>
                    </div>
                    <div className="sm:col-span-2 lg:col-span-3">
                      <label className="text-sm text-text-secondary block mb-1">
                        Objection Sheet
                      </label>
                      <textarea
                        rows={4}
                        value={settingsForm.objection_sheet_text ?? ''}
                        onChange={(e) =>
                          setSettingsForm((f) =>
                            f ? { ...f, objection_sheet_text: e.target.value || null } : f
                          )
                        }
                        placeholder={'Objection: "Not interested"\nResponse: ...'}
                        className="w-full bg-surface-1 border border-white/10 rounded-lg px-3 py-2 text-white placeholder:text-text-secondary/50 resize-y"
                      />
                    </div>
                  </div>
                </div>
              )}

              {canManage && campaignId && <RetryRulesCard campaignId={campaignId} />}

              {/* Agent assignment (admin+ only). RLS on campaign_agents already scopes agents
                  to their assigned campaigns (TASK-P1-01); this is that assignment's UI. */}
              {canManage && (
                <div className="bg-surface-2/60 rounded-app-lg border border-white/5 p-6 mb-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2">
                      <Users className="w-5 h-5" />
                      Assigned Agents
                    </h3>
                    <button
                      type="button"
                      onClick={handleSaveAgents}
                      disabled={savingAgents}
                      className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-accent-from to-accent-to rounded-lg text-white text-sm font-semibold disabled:opacity-60"
                    >
                      {savingAgents ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save Assignment
                    </button>
                  </div>
                  {orgMembers.length === 0 ? (
                    <p className="text-sm text-text-secondary">No org members to assign.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {orgMembers.map((m) => {
                        const label =
                          [m.first_name, m.last_name].filter(Boolean).join(' ').trim() ||
                          m.email ||
                          m.user_id;
                        const checked = assignedAgentIds.has(m.user_id);
                        return (
                          <label
                            key={m.user_id}
                            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer ${
                              checked
                                ? 'bg-accent-to/10 border-accent-to/30 text-accent-to'
                                : 'bg-surface-1 border-white/10 text-text-secondary'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleAssignedAgent(m.user_id)}
                            />
                            {label} <span className="text-xs opacity-70">({m.role})</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Leads section */}
              <div className="bg-surface-2/60 rounded-app-lg border border-white/5 p-6">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                  <h3 className="text-lg font-bold text-white">Leads</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setImportModalOpen(true)}
                      className="flex items-center gap-2 px-3 py-2 bg-surface-1 hover:bg-surface-3 border border-white/10 rounded-lg text-white text-sm"
                    >
                      <Upload className="w-4 h-4" />
                      Import from CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddExistingOpen(true)}
                      className="flex items-center gap-2 px-3 py-2 bg-surface-1 hover:bg-surface-3 border border-white/10 rounded-lg text-white text-sm"
                    >
                      <Users className="w-4 h-4" />
                      Add existing contacts
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddNewOpen(true)}
                      className="flex items-center gap-2 px-3 py-2 bg-surface-1 hover:bg-surface-3 border border-white/10 rounded-lg text-white text-sm"
                    >
                      <UserPlus className="w-4 h-4" />
                      Add new contact
                    </button>
                    <button
                      type="button"
                      onClick={() => setAssignModalOpen(true)}
                      className="flex items-center gap-2 px-3 py-2 bg-surface-1 hover:bg-surface-3 border border-white/10 rounded-lg text-white text-sm"
                      title="Assign a range/percentage/tag of queued leads to a teammate"
                    >
                      <UserCog className="w-4 h-4" />
                      Assign leads
                    </button>
                    {selectedLeadIds.size > 0 && (
                      <button
                        type="button"
                        onClick={handleBulkRemove}
                        className="flex items-center gap-2 px-3 py-2 bg-danger/10 hover:bg-danger/20 border border-danger/20 rounded-lg text-danger text-sm"
                      >
                        <Trash2 className="w-4 h-4" />
                        Remove selected ({selectedLeadIds.size})
                      </button>
                    )}
                  </div>
                </div>

                {/* Sort/filter leads */}
                <div className="flex flex-wrap items-center gap-3 mb-4">
                  <span className="text-sm text-text-secondary">Filter:</span>
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="w-[160px] bg-surface-1 border-white/10 text-white">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent
                      className="bg-surface-2 border-white/10"
                      style={{ zIndex: 10001 }}
                    >
                      {CATEGORIES.map((c) => (
                        <SelectItem
                          key={c}
                          value={c}
                          className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                        >
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={contactStatusFilter} onValueChange={setContactStatusFilter}>
                    <SelectTrigger className="w-[160px] bg-surface-1 border-white/10 text-white">
                      <SelectValue placeholder="Contact status" />
                    </SelectTrigger>
                    <SelectContent
                      className="bg-surface-2 border-white/10"
                      style={{ zIndex: 10001 }}
                    >
                      {CONTACT_STATUSES.map((s) => (
                        <SelectItem
                          key={s}
                          value={s}
                          className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                        >
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {leadsLoading ? (
                  <div className="flex items-center justify-center py-12 text-text-secondary">
                    <Loader2 className="w-8 h-8 animate-spin" />
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-text-secondary border-b border-white/5">
                            <th className="pb-2 pr-2">
                              <input
                                type="checkbox"
                                checked={
                                  paginatedLeads.length > 0 &&
                                  paginatedLeads.every((l) => selectedLeadIds.has(l.contact_id))
                                }
                                onChange={(e) => {
                                  if (e.target.checked) selectAllOnPage();
                                  else setSelectedLeadIds(new Set());
                                }}
                              />
                            </th>
                            <th className="pb-2 pr-2">Name</th>
                            <th className="pb-2 pr-2">Business type</th>
                            <th className="pb-2 pr-2">Phone</th>
                            <th className="pb-2 pr-2">Category</th>
                            <th className="pb-2 pr-2">Contact status</th>
                            <th className="pb-2 pr-2">Lead status</th>
                            <th className="pb-2 pr-2">Priority</th>
                            <th className="pb-2 pr-2 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paginatedLeads.map((lead) => (
                            <tr key={lead.id} className="border-b border-white/5 hover:bg-white/5">
                              <td className="py-3 pr-2">
                                <input
                                  type="checkbox"
                                  checked={selectedLeadIds.has(lead.contact_id)}
                                  onChange={() => toggleSelectLead(lead.contact_id)}
                                />
                              </td>
                              <td className="py-3 pr-2 text-white">
                                {contactDisplayName(lead.contact)}
                              </td>
                              <td className="py-3 pr-2 text-text-secondary">
                                {lead.contact?.business_type ?? '—'}
                              </td>
                              <td className="py-3 pr-2 text-accent-to">
                                {lead.contact?.phone_number ?? '—'}
                              </td>
                              <td className="py-3 pr-2 text-text-secondary">
                                {lead.contact?.category ?? '—'}
                              </td>
                              <td className="py-3 pr-2 text-text-secondary">
                                {lead.contact?.contact_status ?? '—'}
                              </td>
                              <td className="py-3 pr-2">
                                <span
                                  className={`px-2 py-0.5 rounded text-xs ${
                                    lead.status === 'completed'
                                      ? 'bg-success/10 text-success'
                                      : lead.status === 'passthrough'
                                        ? 'bg-accent-to/10 text-accent-to'
                                        : lead.status === 'removed'
                                          ? 'bg-text-secondary/10 text-text-secondary'
                                          : 'bg-warning/10 text-warning'
                                  }`}
                                >
                                  {lead.status}
                                </span>
                              </td>
                              <td className="py-3 pr-2">
                                <select
                                  value={lead.priority}
                                  onChange={(e) =>
                                    void handlePriorityChange(
                                      lead.id,
                                      e.target.value as CampaignLeadPriority
                                    )
                                  }
                                  className="rounded-app-md bg-surface-1 border border-white/10 px-2 py-1 text-xs text-white focus:outline-none"
                                >
                                  <option value="low">Low</option>
                                  <option value="normal">Normal</option>
                                  <option value="high">High</option>
                                </select>
                              </td>
                              <td className="py-3 pr-2 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleCallLead(lead.contact?.phone_number ?? null)
                                    }
                                    className="p-2 rounded-lg hover:bg-accent-to/20 text-accent-to"
                                    title="Call"
                                  >
                                    <Phone className="w-4 h-4" />
                                  </button>
                                  {lead.status === 'queued' && (
                                    <button
                                      type="button"
                                      onClick={() => void handleSkipLead(lead.id)}
                                      className="p-2 rounded-lg hover:bg-white/10 text-text-secondary"
                                      title="Skip for now (keeps its place and attempt count)"
                                    >
                                      <SkipForward className="w-4 h-4" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveLead(lead.contact_id)}
                                    className="p-2 rounded-lg hover:bg-danger/20 text-danger"
                                    title="Remove from campaign"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {filteredLeads.length === 0 && (
                      <div className="py-12 text-center text-text-secondary">
                        No leads match the filters. Import or add contacts to this campaign.
                      </div>
                    )}
                    {totalPages > 1 && (
                      <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/5">
                        <span className="text-sm text-text-secondary">
                          Page {leadsPage + 1} of {totalPages}
                        </span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={leadsPage === 0}
                            onClick={() => setLeadsPage((p) => Math.max(0, p - 1))}
                            className="px-3 py-1 rounded bg-surface-2 disabled:opacity-50 text-white text-sm"
                          >
                            Previous
                          </button>
                          <button
                            type="button"
                            disabled={leadsPage >= totalPages - 1}
                            onClick={() => setLeadsPage((p) => Math.min(totalPages - 1, p + 1))}
                            className="px-3 py-1 rounded bg-surface-2 disabled:opacity-50 text-white text-sm"
                          >
                            Next
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </motion.div>

      {/* Import modal */}
      <ImportContactsModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={handleImportSuccess}
        campaignId={campaignId ?? undefined}
      />

      {/* Add existing contacts modal */}
      <AnimatePresence>
        {addExistingOpen && (
          <AddExistingContactsModal
            contacts={contactsForPicker}
            existingContactIds={new Set(leads.map((l) => l.contact_id))}
            onClose={() => setAddExistingOpen(false)}
            onConfirm={handleAddExisting}
          />
        )}
      </AnimatePresence>

      {/* Add new contact */}
      <AddContactModal
        open={addNewOpen}
        onClose={() => setAddNewOpen(false)}
        onSuccess={handleAddNewSuccess}
      />

      {/* Assign leads (TASK-T6 / ADM-4 slice assignment) */}
      {assignModalOpen && (
        <AssignLeadsModal
          members={orgMembers}
          onClose={() => setAssignModalOpen(false)}
          onAssign={handleAssignLeads}
        />
      )}

      {/* Remove-from-campaign confirmation */}
      <AnimatePresence>
        {(confirmRemoveContactId !== null || confirmBulkRemove) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 flex items-center justify-center p-4"
            style={{ zIndex: 10000 }}
          >
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => {
                setConfirmRemoveContactId(null);
                setConfirmBulkRemove(false);
              }}
              aria-hidden
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative z-[1] w-full max-w-sm rounded-app-lg border border-white/10 bg-surface-1 shadow-xl p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-white mb-6">
                {confirmBulkRemove
                  ? `Remove ${selectedLeadIds.size} contact${selectedLeadIds.size === 1 ? '' : 's'} from the campaign? They will remain in your Contacts.`
                  : 'Remove this contact from the campaign? They will remain in your Contacts.'}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmRemoveContactId(null);
                    setConfirmBulkRemove(false);
                  }}
                  className="px-4 py-2 rounded-lg bg-surface-2 text-white hover:bg-surface-3"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirmRemoveContactId !== null) doRemoveLead(confirmRemoveContactId);
                    else if (confirmBulkRemove) doBulkRemove();
                  }}
                  className="px-4 py-2 rounded-lg bg-danger/20 text-danger border border-danger/30 hover:bg-danger/30"
                >
                  Remove
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete campaign confirmation -- not window.confirm (design §7) */}
      <AnimatePresence>
        {confirmDeleteOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 flex items-center justify-center p-4"
            style={{ zIndex: 10000 }}
          >
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => !deleting && setConfirmDeleteOpen(false)}
              aria-hidden
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative z-[1] w-full max-w-sm rounded-app-lg border border-white/10 bg-surface-1 shadow-xl p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-white mb-2 font-semibold">
                Delete &ldquo;{campaign?.name ?? 'this campaign'}&rdquo;?
              </p>
              <p className="text-sm text-text-secondary mb-6">
                Its leads and call history are kept, but the campaign will no longer be usable or
                visible in your list. This cannot be undone from the UI.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setConfirmDeleteOpen(false)}
                  className="px-4 py-2 rounded-lg bg-surface-2 text-white hover:bg-surface-3 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={handleDeleteCampaign}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-danger/20 text-danger border border-danger/30 hover:bg-danger/30 disabled:opacity-60"
                >
                  {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body
  );
}

interface AddExistingContactsModalProps {
  contacts: Contact[];
  existingContactIds: Set<string>;
  onClose: () => void;
  onConfirm: (selectedIds: string[]) => void;
}

function AddExistingContactsModal({
  contacts,
  existingContactIds,
  onClose,
  onConfirm,
}: AddExistingContactsModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  const available = contacts.filter((c) => !existingContactIds.has(c.id));

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: 10000 }}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-lg max-h-[80vh] flex flex-col rounded-app-lg border border-white/10 bg-surface-1 shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 p-4">
          <h2 className="text-xl font-bold text-white">Add existing contacts</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-text-secondary hover:bg-white/10 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto flex-1">
          {available.length === 0 ? (
            <p className="text-text-secondary">
              No contacts available to add (all are already in this campaign).
            </p>
          ) : (
            <ul className="space-y-2">
              {available.map((c) => (
                <li key={c.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <span className="text-white">{contactDisplayName(c)}</span>
                  <span className="text-sm text-text-secondary">{c.phone_number ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-surface-2 text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={selectedIds.size === 0}
            onClick={() => onConfirm(Array.from(selectedIds))}
            className="px-4 py-2 rounded-lg bg-accent-from text-white disabled:opacity-50"
          >
            Add {selectedIds.size} contact(s)
          </button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
