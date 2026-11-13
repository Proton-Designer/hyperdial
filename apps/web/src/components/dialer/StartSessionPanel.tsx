import { useState } from 'react';
import { Phone, Play, Users } from 'lucide-react';
import { isViewOnly, VIEW_ONLY_MESSAGE } from '@/lib/viewAs';
import type { CampaignWithStats } from '@/lib/api';
import type { UserPhoneNumber } from '@/contexts/PhoneNumbersContext';
import { useAuth } from '@/contexts/AuthContext';
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
  onStart: (campaign: CampaignWithStats) => void;
}

function callerIdLabel(campaign: CampaignWithStats, userNumbers: UserPhoneNumber[]): string {
  if (!campaign.caller_id_number_id) return 'No caller ID set';
  const match = userNumbers.find((n) => n.id === campaign.caller_id_number_id);
  return match?.phone_number ?? 'Unknown number';
}

const PHONE_TIP_KEY = 'hd_phone_tip_seen';

/** TASK-MOB1-B: shown once per device on a phone before the first Start. */
function PhoneTip() {
  const [show, setShow] = useState(() => {
    try {
      return window.matchMedia('(pointer: coarse)').matches && !localStorage.getItem(PHONE_TIP_KEY);
    } catch {
      return false;
    }
  });
  if (!show) return null;
  return (
    <div role="note" className="mb-6 rounded-app-lg border border-accent-to/30 bg-accent-to/10 p-4">
      <p className="text-body font-medium text-text-primary mb-1">Dialing from your phone?</p>
      <ul className="text-body text-text-secondary list-disc pl-5 space-y-1">
        <li>Keep the screen on and HyperDial open while you dial.</li>
        <li>Use headphones with a microphone.</li>
        <li>If the line drops, tap Reconnect and the customer stays on the call.</li>
      </ul>
      <Button
        variant="fe-secondary"
        size="sm"
        className="mt-3"
        onClick={() => {
          try {
            localStorage.setItem(PHONE_TIP_KEY, '1');
          } catch {
            // private mode: the tip simply shows again next time
          }
          setShow(false);
        }}
      >
        Got it
      </Button>
    </div>
  );
}

export function StartSessionPanel({
  campaigns,
  campaignsError,
  userNumbers,
  startingCampaignId,
  micRegistering,
  startError,
  onStart,
}: StartSessionPanelProps) {
  const { user } = useAuth();
  // TASK-N1: numbers this intern could actually dial from -- assigned to them, or unassigned
  // (the team pool). RLS lets every org member SEE the whole org's numbers (needed to pick a
  // caller ID while dialing), so a number assigned to a DIFFERENT intern must be excluded here
  // or this count would misleadingly include numbers this agent can never actually be picked
  // for.
  const myNumbers = userNumbers.filter(
    (n) => n.assigned_user_id === null || n.assigned_user_id === user?.id
  );
  return (
    <div className="max-w-3xl mx-auto mb-8">
      <h2 className="text-page-title text-text-primary mb-1">Start a session</h2>
      <p className="text-body text-text-secondary mb-6">
        Pick a campaign below. We'll register your phone line first, then start dialing.
      </p>

      <PhoneTip />

      {myNumbers.length > 0 && (
        <p className="text-meta text-text-muted mb-6">
          Your numbers: {myNumbers.filter((n) => n.status === 'active').length} active,{' '}
          {myNumbers.filter((n) => n.status === 'resting').length} resting
        </p>
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
                  disabled={isStartingOther || isStartingThis || isViewOnly}
                  title={isViewOnly ? VIEW_ONLY_MESSAGE : undefined}
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
