import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Plus, Target, Play, RefreshCw, ServerCrash } from 'lucide-react';
import {
  listCampaigns,
  createCampaign,
  syncGhlNow,
  getGhlIntegrationStatus,
  listGhlCampaignMappings,
  createGhlTagCampaignMapping,
  type CampaignWithStats,
  type GhlCampaignMapping,
} from '../lib/api';
import { useOrg } from '@/contexts/OrgContext';
import { suggestCampaignTag } from '@/lib/campaignTag';
import { toast } from 'sonner';
import { CampaignManageModal } from './campaigns/CampaignManageModal';
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
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { cn } from '@/components/ui/utils';

function formatDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_CHIP: Record<CampaignWithStats['status'], string> = {
  active: 'bg-success-soft text-success',
  paused: 'bg-warning-soft text-warning',
  completed: 'bg-surface-3 text-text-secondary',
};

/** TASK-H18: the campaign's GHL tag(s) at a glance, or "No GHL tag". */
function CampaignTagChips({ tags }: { tags: GhlCampaignMapping[] }) {
  if (tags.length === 0) {
    return <div className="text-meta text-text-muted mt-1">No GHL tag</div>;
  }
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {tags.map((m) => (
        <span
          key={m.id}
          title="GHL contacts with this tag are added to this campaign"
          className="inline-flex max-w-full items-center px-2 py-0.5 rounded-full bg-surface-3 text-xs text-text-secondary font-mono truncate"
        >
          {m.tag}
        </span>
      ))}
    </div>
  );
}

interface CampaignsProps {
  onNavigateToDialer?: () => void;
  onStartParallelDial?: (ctx: { sessionId: string; campaignId: string }) => void;
  onOpenDialerWithSession?: (ctx: { sessionId: string; campaignId: string }) => void;
}

export function Campaigns({
  onNavigateToDialer,
  onStartParallelDial,
  onOpenDialerWithSession,
}: CampaignsProps) {
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const [campaigns, setCampaigns] = useState<CampaignWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'paused' | 'completed'>(
    'all'
  );
  const [manageCampaignId, setManageCampaignId] = useState<string | null>(null);
  const [newCampaignOpen, setNewCampaignOpen] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const newCampaignModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(newCampaignModalRef, newCampaignOpen);
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';
  const [syncing, setSyncing] = useState(false);
  // TASK-H18: GHL connected? + every tag rule (campaign -> tags), for the New campaign field and the list chips.
  const [ghlConnected, setGhlConnected] = useState(false);
  const [ghlPullOn, setGhlPullOn] = useState(true);
  const [rules, setRules] = useState<GhlCampaignMapping[]>([]);
  const [newCampaignTag, setNewCampaignTag] = useState('');
  const [tagEdited, setTagEdited] = useState(false);

  const loadRules = useCallback(() => {
    listGhlCampaignMappings()
      .then(setRules)
      .catch(() => setRules([]));
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    getGhlIntegrationStatus()
      .then((st) => {
        const connected = st?.status === 'connected';
        setGhlConnected(connected);
        setGhlPullOn(st?.ghl_pull_enabled === true);
        if (connected) loadRules();
      })
      .catch(() => setGhlConnected(false));
  }, [isAdmin, loadRules]);

  const tagsFor = (campaignId: string) =>
    rules.filter((m) => m.campaign_id === campaignId && m.match_type === 'tag' && m.tag);
  const showTagChips = isAdmin && ghlConnected;
  const showTagField = isAdmin && ghlConnected;

  const fetchCampaigns = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    listCampaigns()
      .then(setCampaigns)
      .catch((e) => {
        console.error('Failed to load campaigns', e);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  const filteredCampaigns = campaigns.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filterStatus === 'all' || c.status === filterStatus;
    return matchesSearch && matchesFilter;
  });

  const handleCreateCampaign = async () => {
    const name = newCampaignName.trim();
    if (!name) {
      setCreateError('Campaign name is required');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const campaign = await createCampaign(name);
      const tag = showTagField ? newCampaignTag.trim() : '';
      if (tag) {
        try {
          await createGhlTagCampaignMapping(tag, campaign.id);
          if (ghlPullOn) {
            toast.success(`GHL contacts tagged "${tag}" will be added to ${name}.`);
          } else {
            toast.warning(
              `Tag rule saved, but nothing is added yet: switch on "Also check GHL every 5 minutes" in Settings → Integrations → GoHighLevel first (instant leads need it).`
            );
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          if (/duplicate key|unique constraint/i.test(msg)) {
            const clash = rules.find(
              (m) =>
                m.match_type === 'tag' && (m.tag ?? '').trim().toLowerCase() === tag.toLowerCase()
            );
            const owner = campaigns.find((c) => c.id === clash?.campaign_id)?.name;
            toast.warning(
              `Campaign created, but the tag "${tag}" already adds leads to ${owner ?? 'another campaign'}. Pick a different tag in this campaign's Auto-add from GHL section.`
            );
          } else {
            toast.warning(
              `Campaign created, but the GHL tag rule was not saved (${msg || 'unknown error'}). Add it in this campaign's Auto-add from GHL section.`
            );
          }
        }
        loadRules();
      }
      setNewCampaignOpen(false);
      setNewCampaignName('');
      setNewCampaignTag('');
      setTagEdited(false);
      fetchCampaigns();
      setManageCampaignId(campaign.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create campaign');
    } finally {
      setCreating(false);
    }
  };

  /** MISSION-4 TASK-T1 (GHL-5): runs every configured tag/stage -> campaign mapping right now
   *  (Settings -> Integrations -> GHL), regardless of whether the 5-minute auto-pull is enabled. */
  const handleSyncGhlNow = async () => {
    setSyncing(true);
    try {
      const result = await syncGhlNow();
      const failed = result.mappings.filter((m) => m.error);
      if (failed.length > 0) {
        toast.warning(
          `Synced -- ${result.created} created, ${result.updated} updated, but ${failed.length} mapping(s) failed.`
        );
      } else {
        toast.success(`Synced with GHL -- ${result.created} created, ${result.updated} updated.`);
      }
      fetchCampaigns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to sync with GHL');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="h-full bg-surface-0">
      <div className="hd-touch p-4 sm:p-8 max-w-[1600px] mx-auto">
        <PageHeader
          title="Campaigns"
          description="Manage your outreach campaigns"
          actions={
            <div className="flex gap-2">
              {isAdmin && (
                <Button variant="fe-ghost" onClick={handleSyncGhlNow} disabled={syncing}>
                  <RefreshCw className={cn('w-4 h-4', syncing && 'animate-spin')} />
                  {syncing ? 'Syncing...' : 'Sync now'}
                </Button>
              )}
              <Button variant="primary" onClick={() => setNewCampaignOpen(true)}>
                <Plus className="w-4 h-4" />
                New campaign
              </Button>
            </div>
          }
        />

        <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 mb-6">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex-1 min-w-[240px] relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search campaigns..."
                className="w-full bg-surface-2 border border-border-subtle rounded-app-md pl-9 pr-3 py-2 text-body text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to transition-colors"
              />
            </div>
            <div className="flex gap-1.5">
              {(['all', 'active', 'paused', 'completed'] as const).map((status) => (
                <button
                  key={status}
                  onClick={() => setFilterStatus(status)}
                  className={cn(
                    'px-2.5 py-1.5 rounded-app-sm text-meta font-medium transition-colors',
                    filterStatus === status
                      ? 'bg-accent-from/20 text-accent-to'
                      : 'bg-surface-2 text-text-secondary hover:bg-surface-3'
                  )}
                >
                  {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loadError && campaigns.length > 0 && (
          <div
            role="alert"
            className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-app-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            <span>Couldn't refresh campaigns. Showing the last loaded list.</span>
            <Button variant="fe-secondary" size="sm" onClick={fetchCampaigns}>
              Try again
            </Button>
          </div>
        )}
        {loading ? (
          isDesktop ? (
            <div className="rounded-app-lg border border-border-subtle bg-surface-1 overflow-hidden">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="skeleton-shimmer h-12 border-b border-border-subtle last:border-0"
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton-shimmer h-[160px] rounded-app-lg" />
              ))}
            </div>
          )
        ) : loadError && campaigns.length === 0 ? (
          <EmptyState
            icon={ServerCrash}
            title="Couldn't load campaigns"
            body="Check your connection and try again."
            action={
              <Button variant="fe-secondary" onClick={fetchCampaigns}>
                <RefreshCw className="w-4 h-4" />
                Try again
              </Button>
            }
          />
        ) : filteredCampaigns.length === 0 ? (
          <EmptyState
            icon={Target}
            title="No campaigns found"
            body="Create a campaign or try adjusting your search or filters."
            action={
              <Button variant="primary" onClick={() => setNewCampaignOpen(true)}>
                <Plus className="w-4 h-4" />
                New campaign
              </Button>
            }
          />
        ) : isDesktop ? (
          <div className="rounded-app-lg border border-border-subtle bg-surface-1 overflow-hidden">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-surface-1">
                <TableRow className="border-border-subtle hover:bg-transparent">
                  <TableHead className="text-text-secondary">Campaign</TableHead>
                  <TableHead className="text-text-secondary">Status</TableHead>
                  <TableHead className="text-text-secondary">Lines</TableHead>
                  <TableHead className="text-text-secondary">Progress</TableHead>
                  <TableHead className="text-text-secondary">Connect rate</TableHead>
                  <TableHead className="text-text-secondary">Last called</TableHead>
                  <TableHead className="text-right text-text-secondary">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCampaigns.map((campaign) => {
                  const total = campaign.total_contacts ?? 0;
                  const done = campaign.completed ?? 0;
                  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                  return (
                    <TableRow
                      key={campaign.id}
                      onClick={() => setManageCampaignId(campaign.id)}
                      className="border-border-subtle hover:bg-surface-2 cursor-pointer group"
                    >
                      <TableCell className="max-w-[240px]">
                        <div className="font-medium text-text-primary truncate">
                          {campaign.name}
                        </div>
                        <div className="text-meta text-text-secondary">
                          Created {formatDate(campaign.created_at)}
                        </div>
                        {showTagChips && <CampaignTagChips tags={tagsFor(campaign.id)} />}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                            STATUS_CHIP[campaign.status]
                          )}
                        >
                          {campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1)}
                        </span>
                      </TableCell>
                      <TableCell className="text-body text-text-secondary">
                        {campaign.lines}
                      </TableCell>
                      <TableCell className="min-w-[140px]">
                        <div className="flex items-center gap-2">
                          <div className="w-24 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-accent-from to-accent-to"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-meta text-text-secondary whitespace-nowrap">
                            {done}/{total}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-body text-text-primary">
                        {Number(campaign.connect_rate ?? 0).toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-meta text-text-secondary whitespace-nowrap">
                        {formatDate(campaign.last_called_at)}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                          {total > 0 && (
                            <Button
                              variant="fe-secondary"
                              size="sm"
                              onClick={() => setManageCampaignId(campaign.id)}
                            >
                              <Play className="w-3.5 h-3.5" />
                              Start
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {filteredCampaigns.map((campaign, index) => {
              const total = campaign.total_contacts ?? 0;
              const done = campaign.completed ?? 0;
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              return (
                <motion.div
                  key={campaign.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(index, 5) * 0.04, duration: 0.12 }}
                  onClick={() => setManageCampaignId(campaign.id)}
                  className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <h3 className="font-semibold text-text-primary truncate">{campaign.name}</h3>
                    <span
                      className={cn(
                        'inline-flex flex-shrink-0 items-center px-2 py-0.5 rounded-full text-xs font-medium',
                        STATUS_CHIP[campaign.status]
                      )}
                    >
                      {campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1)}
                    </span>
                  </div>
                  {showTagChips && (
                    <div className="mb-2">
                      <CampaignTagChips tags={tagsFor(campaign.id)} />
                    </div>
                  )}
                  <div className="text-meta text-text-secondary mb-1">
                    {campaign.lines} lines · {Number(campaign.connect_rate ?? 0).toFixed(1)}%
                    connect
                  </div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="flex-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-accent-from to-accent-to"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-meta text-text-secondary whitespace-nowrap">
                      {done}/{total}
                    </span>
                  </div>
                  {total > 0 && (
                    <Button
                      variant="fe-secondary"
                      size="sm"
                      className="w-full"
                      onClick={(e) => {
                        e.stopPropagation();
                        setManageCampaignId(campaign.id);
                      }}
                    >
                      <Play className="w-3.5 h-3.5" />
                      Start
                    </Button>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* New campaign name modal - rendered inline so motion/context work */}
      <AnimatePresence>
        {newCampaignOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !creating && setNewCampaignOpen(false)}
            className="hd-touch hd-vv fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 bg-black/60 backdrop-blur-sm"
          >
            {/* B1: `aria-hidden` used to sit on THIS wrapper, which is an ANCESTOR of the
                `role="dialog"` panel below, not a sibling backdrop like every other modal in
                this app -- that hid the whole dialog (despite its own aria-modal="true") from
                every assistive technology while it was visually open and interactive. Every
                other modal's backdrop is a sibling div, not a wrapper, which is why none of
                them had this bug; removed here instead of restructuring, since this wrapper
                carries no meaningful content of its own beyond positioning the dialog. */}
            <motion.div
              ref={newCampaignModalRef}
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}
              className="w-[88vw] max-w-[320px] sm:w-[80vw] sm:max-w-[360px] rounded-app-lg border border-border-subtle bg-surface-1 p-4 sm:p-5 shadow-app-md outline-none"
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-campaign-title"
            >
              <h3 id="new-campaign-title" className="text-page-title text-text-primary mb-4">
                New campaign
              </h3>
              <input
                type="text"
                value={newCampaignName}
                onChange={(e) => {
                  setNewCampaignName(e.target.value);
                  if (!tagEdited) setNewCampaignTag(suggestCampaignTag(e.target.value));
                  setCreateError(null);
                }}
                placeholder="Campaign name"
                className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-3 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to mb-4"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateCampaign()}
              />
              {showTagField && (
                <div className="mb-4">
                  <label
                    htmlFor="new-campaign-tag"
                    className="block text-meta text-text-secondary mb-1"
                  >
                    Auto-add GHL leads tagged (optional)
                  </label>
                  <input
                    id="new-campaign-tag"
                    type="text"
                    value={newCampaignTag}
                    onChange={(e) => {
                      setNewCampaignTag(e.target.value);
                      setTagEdited(true);
                    }}
                    placeholder="hd-your-campaign"
                    autoCapitalize="none"
                    className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
                  />
                  <p className="text-meta text-text-muted mt-1">
                    n8n puts this tag on each lead for this campaign. Clear it to skip.
                  </p>
                  {!ghlPullOn && (
                    <p className="text-meta text-warning mt-1" role="status">
                      Leads are only added while &ldquo;Also check GHL every 5 minutes&rdquo; is
                      switched on in Settings → Integrations → GoHighLevel (it is off now).
                    </p>
                  )}
                </div>
              )}
              {createError && <p className="text-body text-danger mb-4">{createError}</p>}
              <div className="flex justify-end gap-2">
                <Button
                  variant="fe-ghost"
                  disabled={creating}
                  onClick={() => setNewCampaignOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={creating || !newCampaignName.trim()}
                  onClick={handleCreateCampaign}
                  loading={creating}
                >
                  Create
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <CampaignManageModal
        open={manageCampaignId !== null}
        campaignId={manageCampaignId}
        onClose={() => setManageCampaignId(null)}
        onRefreshList={fetchCampaigns}
        onNavigateToDialer={onNavigateToDialer ?? (() => {})}
        onStartParallelDial={onStartParallelDial ?? (() => {})}
        onOpenDialerWithSession={onOpenDialerWithSession ?? (() => {})}
      />
    </div>
  );
}
