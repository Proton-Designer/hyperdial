import { useState, useEffect, useCallback, useRef } from 'react';
import { contactHeadline, contactSecondaryName } from '@/lib/contactName';
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
  MapPin,
  Shuffle,
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
  listCampaigns,
  listCampaignRetryRules,
  upsertCampaignRetryRules,
  setCampaignDistributionMode,
  rebalanceCampaignDistribution,
  type CampaignWithStats,
  type BulkAddLeadsResult,
  type CampaignSettingsInput,
  type CampaignLead,
  type CampaignLeadPriority,
  type AssignLeadsFilter,
  type Contact,
  type OrgMember,
  type CampaignRetryRule,
  type RetryRuleAction,
  listGhlCampaignMappings,
  createGhlTagCampaignMapping,
  createGhlStageCampaignMapping,
  deleteGhlCampaignMapping,
  listGhlPipelineStages,
  getGhlIntegrationStatus,
  type GhlIntegrationStatus,
  type GhlCampaignMapping,
  type GhlPipelineStageOption,
} from '../../lib/api';
import { ScriptHistoryPanel } from './ScriptHistoryPanel';
import { ImportContactsModal } from '../contacts/ImportContactsModal';
import { AddContactModal } from '../contacts/AddContactModal';
import { AssignLeadsModal } from './AssignLeadsModal';
import { AddExistingContactsModal } from './AddExistingContactsModal';
import { describeBulkAddResult } from './bulkAddMessage';
import { TerritoryRulesModal } from './TerritoryRulesModal';
import { usePhoneNumbers } from '../../contexts/PhoneNumbersContext';
import { useOrg } from '../../contexts/OrgContext';
import { setPendingStartCampaignId } from '../../lib/dialerLaunchIntent';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useFocusTrap } from '@/hooks/useFocusTrap';

const CATEGORIES = ['All', 'Cold', 'Warm', 'Follow Up', 'Voicemail', 'Booked'] as const;
const CONTACT_STATUSES = ['All', 'No Contact', 'Contacted'] as const;
const LEADS_PER_PAGE = 50;

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

/** TASK-H17 (#5): "Auto-add from GHL" -- THIS campaign's tag/stage rules (owner/admin only). Same table and api.ts wrappers as
 *  Settings -> GoHighLevel -> "Tag/stage -> campaign mappings", which keeps the org-wide view. A GHL contact that arrives with
 *  one of these tags (instantly via the workflow, or by the 5-minute check) is queued onto this campaign. Own fetch lifecycle. */
function GhlAutoAddCard({ campaignId }: { campaignId: string }) {
  const [rules, setRules] = useState<GhlCampaignMapping[] | null>(null);
  const [allRules, setAllRules] = useState<GhlCampaignMapping[]>([]);
  const [ghl, setGhl] = useState<GhlIntegrationStatus | null | undefined>(undefined);
  const [stages, setStages] = useState<GhlPipelineStageOption[] | null>(null);
  const [matchType, setMatchType] = useState<'tag' | 'stage'>('tag');
  const [tag, setTag] = useState('');
  const [stageKey, setStageKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listGhlCampaignMappings()
      .then((all) => {
        setAllRules(all);
        setRules(all.filter((m) => m.campaign_id === campaignId));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load the rules'));
  }, [campaignId]);

  // Whether GHL is connected and the 5-minute check is on: instant intake needs both, so the card says so.
  useEffect(() => {
    let cancelled = false;
    getGhlIntegrationStatus()
      .then((s) => !cancelled && setGhl(s))
      .catch(() => !cancelled && setGhl(null));
    return () => {
      cancelled = true;
    };
  }, []);

  // A stage rule shows its name, not the raw id: load the pipelines once when this campaign has a stage rule.
  const hasStageRule = rules?.some((m) => m.match_type === 'stage') ?? false;
  useEffect(() => {
    if (!hasStageRule || stages) return;
    let cancelled = false;
    listGhlPipelineStages()
      .then((s) => !cancelled && setStages(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hasStageRule, stages]);

  useEffect(() => {
    setRules(null);
    setError(null);
    load();
  }, [load]);

  const add = async () => {
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
      const msg = e instanceof Error ? e.message : 'Failed to add the rule';
      if (/duplicate key|unique constraint/i.test(msg)) {
        // one rule per tag/stage per org: say which campaign already uses it
        const wanted = tag.trim().toLowerCase();
        const clash = allRules.find((m) =>
          matchType === 'tag'
            ? (m.tag ?? '').trim().toLowerCase() === wanted
            : m.pipeline_stage_id === stageKey.split('|')[1]
        );
        let owner = 'another campaign';
        if (clash?.campaign_id === campaignId) owner = 'this campaign';
        else if (clash) {
          owner =
            (await listCampaigns().catch(() => []))?.find((c) => c.id === clash.campaign_id)
              ?.name ?? owner;
        }
        setError(
          `That ${matchType === 'tag' ? 'tag' : 'stage'} already has a rule: it adds leads to ${owner}. Remove that rule first to move it.`
        );
      } else {
        setError(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await deleteGhlCampaignMapping(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove the rule');
    }
  };

  const loadStages = async () => {
    try {
      setStages(await listGhlPipelineStages());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load GHL pipelines');
    }
  };

  return (
    <div className="bg-surface-2/60 rounded-app-lg border border-white/5 p-6 mb-6">
      <h3 className="text-lg font-bold text-white mb-1">Auto-add from GHL</h3>
      <p className="text-sm text-text-secondary mb-4">
        A GoHighLevel contact with one of these tags (or in one of these pipeline stages) is added
        to this campaign automatically (while the 5-minute check is on). n8n tags each lead, for
        example <code className="text-white">hd-mckinney</code> for a McKinney, TX campaign. The
        webhook and backup check are set up in Settings &rarr; Integrations &rarr; GoHighLevel.
      </p>
      {ghl === null && (
        <p className="text-sm text-yellow-400 mb-3" role="status">
          GoHighLevel is not connected, so nothing is added automatically yet. Connect it in
          Settings &rarr; Integrations &rarr; GoHighLevel.
        </p>
      )}
      {ghl && !ghl.ghl_pull_enabled && (
        <p className="text-sm text-yellow-400 mb-3" role="status">
          Rules only work while &ldquo;Also check GHL every 5 minutes&rdquo; is switched on in
          Settings &rarr; Integrations &rarr; GoHighLevel (it is off now). Instant new leads need it
          too.
        </p>
      )}

      {error && (
        <p className="text-sm text-danger mb-3" role="alert">
          {error}
        </p>
      )}

      {rules === null && !error ? (
        <p className="text-sm text-text-secondary" role="status">
          Loading rules...
        </p>
      ) : (
        <>
          {rules && rules.length === 0 ? (
            <p className="text-sm text-text-secondary mb-3">
              No rules yet. Add the tag n8n puts on this market&rsquo;s leads.
            </p>
          ) : (
            <ul className="mb-3 divide-y divide-white/5 rounded-app-md border border-white/10">
              {rules?.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 break-words text-white">
                    {m.match_type === 'tag'
                      ? `Tag "${m.tag}"`
                      : `Stage "${stages?.find((s) => s.stageId === m.pipeline_stage_id)?.stageName ?? m.pipeline_stage_id}"`}
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove(m.id)}
                    className="shrink-0 text-xs text-danger hover:underline"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={matchType}
              onChange={(e) => setMatchType(e.target.value as 'tag' | 'stage')}
              aria-label="Rule type"
              className="rounded-app-md bg-surface-1 border border-white/10 px-2 py-1.5 text-sm text-white"
            >
              <option value="tag">Tag</option>
              <option value="stage">Pipeline stage</option>
            </select>
            {matchType === 'tag' ? (
              <input
                type="text"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="GHL tag, e.g. hd-mckinney"
                aria-label="GHL tag"
                className="min-w-0 basis-full flex-1 rounded-app-md bg-surface-1 border border-white/10 px-3 py-1.5 text-sm text-white sm:basis-0 placeholder-text-muted"
              />
            ) : stages ? (
              <select
                value={stageKey}
                onChange={(e) => setStageKey(e.target.value)}
                aria-label="Pipeline stage"
                className="min-w-0 basis-full flex-1 rounded-app-md bg-surface-1 border border-white/10 px-3 py-1.5 text-sm text-white sm:basis-0"
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
                onClick={() => void loadStages()}
                className="flex-1 text-left text-sm text-accent-to hover:underline"
              >
                Load pipeline stages from GHL...
              </button>
            )}
            <button
              type="button"
              onClick={() => void add()}
              disabled={saving}
              className="px-3 py-1.5 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white text-sm font-medium disabled:opacity-50"
            >
              Add rule
            </button>
          </div>
        </>
      )}
    </div>
  );
}

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
  const [otherCampaigns, setOtherCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [leadsPage, setLeadsPage] = useState(0);
  const [confirmRemoveContactId, setConfirmRemoveContactId] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, open);
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false);
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [territoryModalOpen, setTerritoryModalOpen] = useState(false);
  const [savingDistributionMode, setSavingDistributionMode] = useState(false);
  const [rebalancing, setRebalancing] = useState(false);

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
          high_lines_guard_enabled: c.high_lines_guard_enabled,
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
      listCampaigns()
        .then((all) =>
          setOtherCampaigns(
            all.filter((c) => c.id !== campaignId).map((c) => ({ id: c.id, name: c.name }))
          )
        )
        .catch(() => setOtherCampaigns([]));
    }
  }, [addExistingOpen, campaignId]);

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

  /** TASK-H02: the bulk modal already wrote through add_leads_to_campaign_bulk; report and refresh. */
  const handleBulkAdded = (result: BulkAddLeadsResult) => {
    setAddExistingOpen(false);
    const message = describeBulkAddResult(result);
    if (result.added === 0) toast.warning(message);
    else if (message.includes('skipped') || result.capped) toast.warning(message);
    else toast.success(message);
    fetchLeads();
    fetchCampaign();
    onRefreshList();
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

  /** TASK-M5-N4: server re-checks role+scope on every call (owner/admin, or a manager whose
   *  whole campaign roster is in their own pods) -- this control is shown to every manager, same
   *  as Territory rules above, and an out-of-scope call simply surfaces the server's rejection. */
  const handleDistributionModeChange = async (mode: 'manual' | 'round_robin') => {
    if (!campaignId) return;
    setSavingDistributionMode(true);
    try {
      await setCampaignDistributionMode(campaignId, mode);
      await fetchCampaign();
      toast.success(
        mode === 'round_robin'
          ? 'Round-robin distribution enabled'
          : 'Switched to manual distribution'
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update distribution mode');
    } finally {
      setSavingDistributionMode(false);
    }
  };

  const handleRebalance = async () => {
    if (!campaignId) return;
    setRebalancing(true);
    try {
      const count = await rebalanceCampaignDistribution(campaignId);
      toast.success(
        count > 0
          ? `Rebalanced ${count} lead(s)`
          : 'Nothing to rebalance -- no unassigned queued leads'
      );
      fetchLeads();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to rebalance');
    } finally {
      setRebalancing(false);
    }
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
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                            <SelectItem
                              key={n}
                              value={String(n)}
                              disabled={n > 7 && !settingsForm.high_lines_guard_enabled}
                              className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                            >
                              {n}
                              {n > 7 ? ' (needs the drop-rate guard below)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <label className="flex items-center gap-2 text-xs text-text-secondary mt-2">
                        <input
                          type="checkbox"
                          checked={settingsForm.high_lines_guard_enabled ?? false}
                          onChange={(e) =>
                            setSettingsForm((f) =>
                              f
                                ? {
                                    ...f,
                                    high_lines_guard_enabled: e.target.checked,
                                    // Turning the guard off while lines is still 8-10 would be
                                    // rejected by the DB (campaigns_lines_check) -- snap lines
                                    // back to a safe value in the same edit so Save doesn't
                                    // surprise-fail.
                                    lines: !e.target.checked && (f.lines ?? 0) > 7 ? 7 : f.lines,
                                  }
                                : f
                            )
                          }
                        />
                        Allow 8-10 lines (auto-reduces back to 7 if drop rate exceeds 3%)
                      </label>
                      {campaign?.high_lines_guard_last_triggered_at && (
                        <p className="text-xs text-amber-400/90 mt-1">
                          Guard last auto-reduced lines to 7 on{' '}
                          {new Date(campaign.high_lines_guard_last_triggered_at).toLocaleString()}
                          {campaign.high_lines_guard_last_drop_rate_pct != null
                            ? ` (drop rate was ${campaign.high_lines_guard_last_drop_rate_pct}%)`
                            : ''}
                          .
                        </p>
                      )}
                    </div>
                    <div>
                      <label className="text-sm text-text-secondary block mb-1">
                        Answering Machine Detection
                      </label>
                      <Select
                        value={settingsForm.amd_mode ?? 'premium'}
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
                      {campaignId && (
                        <ScriptHistoryPanel
                          campaignId={campaignId}
                          field="script_text"
                          canRestore={canManage}
                          onRestored={fetchCampaign}
                        />
                      )}
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
                      {campaignId && (
                        <ScriptHistoryPanel
                          campaignId={campaignId}
                          field="objection_sheet_text"
                          canRestore={canManage}
                          onRestored={fetchCampaign}
                        />
                      )}
                    </div>
                  </div>
                </div>
              )}

              {canManage && campaignId && <RetryRulesCard campaignId={campaignId} />}
              {canManage && campaignId && <GhlAutoAddCard campaignId={campaignId} />}

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
                    {(role === 'owner' || role === 'admin' || role === 'manager') && (
                      <button
                        type="button"
                        onClick={() => setTerritoryModalOpen(true)}
                        className="flex items-center gap-2 px-3 py-2 bg-surface-1 hover:bg-surface-3 border border-white/10 rounded-lg text-white text-sm"
                        title="Route queued leads by contact state/area code to an agent or pod"
                      >
                        <MapPin className="w-4 h-4" />
                        Territory rules
                      </button>
                    )}
                    {(role === 'owner' || role === 'admin' || role === 'manager') && (
                      <div
                        className="flex items-center gap-2 px-2 py-1 bg-surface-1 border border-white/10 rounded-lg"
                        title="Distribution mode: manual (today's behaviour) or round-robin (every new unassigned lead auto-rotates across the campaign's agents; territory rules still get first shot)"
                      >
                        <Shuffle className="w-4 h-4 text-text-secondary ml-1" />
                        <select
                          value={campaign.distribution_mode}
                          disabled={savingDistributionMode}
                          onChange={(e) =>
                            void handleDistributionModeChange(
                              e.target.value as 'manual' | 'round_robin'
                            )
                          }
                          className="bg-surface-1 text-white text-sm focus:outline-none disabled:opacity-60"
                        >
                          <option value="manual">Manual distribution</option>
                          <option value="round_robin">Round-robin distribution</option>
                        </select>
                        {campaign.distribution_mode === 'round_robin' && (
                          <button
                            type="button"
                            onClick={() => void handleRebalance()}
                            disabled={rebalancing}
                            className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-white/10 text-white text-xs disabled:opacity-60"
                            title="Round-robin every currently unassigned queued lead (never touches an already-assigned one)"
                          >
                            {rebalancing ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RotateCw className="w-3.5 h-3.5" />
                            )}
                            Rebalance now
                          </button>
                        )}
                      </div>
                    )}
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
                            <th className="pb-2 pr-2">Source</th>
                            <th className="pb-2 pr-2">Added</th>
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
                                {contactHeadline(lead.contact)}
                                {contactSecondaryName(lead.contact) && (
                                  <div className="text-xs text-text-secondary">
                                    {contactSecondaryName(lead.contact)}
                                  </div>
                                )}
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
                              <td className="py-3 pr-2 text-text-secondary">
                                {lead.list_name ?? lead.contact?.import_list ?? '—'}
                              </td>
                              <td className="py-3 pr-2 text-text-secondary whitespace-nowrap">
                                {formatDate(lead.added_at)}
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
        {addExistingOpen && campaignId && (
          <AddExistingContactsModal
            campaignId={campaignId}
            contacts={contactsForPicker}
            existingContactIds={new Set(leads.map((l) => l.contact_id))}
            otherCampaigns={otherCampaigns}
            onClose={() => setAddExistingOpen(false)}
            onDone={handleBulkAdded}
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
      {assignModalOpen && campaignId && (
        <AssignLeadsModal
          campaignId={campaignId}
          members={orgMembers}
          onClose={() => setAssignModalOpen(false)}
          onAssign={handleAssignLeads}
        />
      )}

      {/* Territory rules (TASK-M5-C4) */}
      {territoryModalOpen && campaignId && (
        <TerritoryRulesModal
          campaignId={campaignId}
          members={orgMembers}
          distributionMode={campaign?.distribution_mode ?? 'manual'}
          onClose={() => setTerritoryModalOpen(false)}
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
