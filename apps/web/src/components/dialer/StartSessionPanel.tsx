import { Phone, Play, Users } from 'lucide-react';
import type { CampaignWithStats } from '@/lib/api';
import type { UserPhoneNumber } from '@/contexts/PhoneNumbersContext';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/app/EmptyState';
import { ListSkeleton } from '@/components/app/skeletons';

/**
 * TASK-L7: the only place a parallel dial session gets started now, for every role. Reuses
 * `listCampaigns()` as-is (it already agent-filters vs. returns everything for owner/admin,
 * see api.ts's own comment) instead of a new endpoint. Owns none of the WebRTC client/mic
 * logic itself -- that lives in Dialer.tsx, which is also the ONLY place that ever registers a
 * TelnyxRTC client now (the L1x L5 redesign this task delivers: CampaignManageModal used to run
 * its own separate pre-flight client, which is exactly what raced the server-side agent dial).
 */

interface StartSessionPanelProps {
  campaigns: CampaignWithStats[] | null;
  campaignsError: string | null;
  userNumbers: UserPhoneNumber[];
  startingCampaignId: string | null;
  micRegistering: boolean;
  startError: string | null;
  conflict: { campaignId: string; campaignName: string; existingSessionId: string } | null;
  onStart: (campaign: CampaignWithStats) => void;
  onOpenConflict: () => void;
  onDismissConflict: () => void;
}

function callerIdLabel(campaign: CampaignWithStats, userNumbers: UserPhoneNumber[]): string {
  if (!campaign.caller_id_number_id) return 'No caller ID set';
  const match = userNumbers.find((n) => n.id === campaign.caller_id_number_id);
  return match?.phone_number ?? 'Unknown number';
}

export function StartSessionPanel({
  campaigns,
  campaignsError,
  userNumbers,
  startingCampaignId,
  micRegistering,
  startError,
  conflict,
  onStart,
  onOpenConflict,
  onDismissConflict,
}: StartSessionPanelProps) {
  return (
    <div className="max-w-3xl mx-auto mb-8">
      <h2 className="text-page-title text-text-primary mb-1">Start a session</h2>
      <p className="text-body text-text-secondary mb-6">
        Pick a campaign below. We'll register your phone line first, then start dialing.
      </p>

      {conflict && (
        <div className="rounded-app-lg border border-warning/30 bg-warning-soft p-4 mb-6 flex items-center justify-between gap-4">
          <p className="text-body text-warning">
            A session is already active for{' '}
            <span className="font-semibold">{conflict.campaignName}</span>.
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="warning-soft" size="sm" onClick={onOpenConflict}>
              Open it
            </Button>
            <Button variant="fe-ghost" size="sm" onClick={onDismissConflict}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {startError && (
        <div className="rounded-app-lg border border-danger/30 bg-danger-soft p-4 mb-6">
          <p className="text-body text-danger">{startError}</p>
        </div>
      )}

      {campaignsError && (
        <div className="rounded-app-lg border border-danger/30 bg-danger-soft p-4 mb-6">
          <p className="text-body text-danger">{campaignsError}</p>
        </div>
      )}

      {campaigns === null && !campaignsError && <ListSkeleton rows={3} />}

      {campaigns !== null && campaigns.length === 0 && (
        <EmptyState
          icon={Users}
          title="No campaigns assigned yet"
          body="Ask your manager to assign you to a campaign."
        />
      )}

      {campaigns !== null && campaigns.length > 0 && (
        <div className="space-y-3">
          {campaigns.map((campaign) => {
            const isStartingThis = startingCampaignId === campaign.id;
            const isStartingOther = startingCampaignId !== null && !isStartingThis;
            return (
              <div
                key={campaign.id}
                className="rounded-app-lg border border-border-subtle bg-surface-1 p-5 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <p className="text-body font-semibold text-text-primary truncate">
                    {campaign.name}
                  </p>
                  <div className="flex flex-wrap items-center gap-3 mt-1 text-meta text-text-secondary">
                    <span>{campaign.lines} lines</span>
                    <span className="flex items-center gap-1">
                      <Phone className="w-3.5 h-3.5" />
                      {callerIdLabel(campaign, userNumbers)}
                    </span>
                    <span>{campaign.queued} leads remaining</span>
                  </div>
                </div>
                <Button
                  variant="primary"
                  onClick={() => onStart(campaign)}
                  disabled={isStartingOther || isStartingThis}
                  loading={isStartingThis}
                  className="flex-shrink-0"
                >
                  {isStartingThis ? (
                    micRegistering ? (
                      'Registering your line…'
                    ) : (
                      'Starting…'
                    )
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      Start
                    </>
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
