import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Plus, Target, Play } from 'lucide-react';
import { listCampaigns, createCampaign, type CampaignWithStats } from '../lib/api';
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

  const fetchCampaigns = useCallback(() => {
    setLoading(true);
    listCampaigns()
      .then(setCampaigns)
      .catch(() => setCampaigns([]))
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
      setNewCampaignOpen(false);
      setNewCampaignName('');
      fetchCampaigns();
      setManageCampaignId(campaign.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create campaign');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full bg-surface-0">
      <div className="p-4 sm:p-8 max-w-[1600px] mx-auto">
        <PageHeader
          title="Campaigns"
          description="Manage your outreach campaigns"
          actions={
            <Button variant="primary" onClick={() => setNewCampaignOpen(true)}>
              <Plus className="w-4 h-4" />
              New campaign
            </Button>
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
            className="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 bg-black/60 backdrop-blur-sm"
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
              className="w-[88vw] max-w-[280px] sm:w-[80vw] sm:max-w-[300px] rounded-app-lg border border-border-subtle bg-surface-1 p-4 sm:p-5 shadow-app-md outline-none"
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
                  setCreateError(null);
                }}
                placeholder="Campaign name"
                className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-3 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to mb-4"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateCampaign()}
              />
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
