import { Loader2, Phone, Play, Users } from 'lucide-react';
import type { CampaignWithStats } from '@/lib/api';
import type { UserPhoneNumber } from '@/contexts/PhoneNumbersContext';

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
      <h2 className="text-xl font-bold text-white mb-1">Start a parallel dialing session</h2>
      <p className="text-sm text-[#B0BEC5] mb-6">
        Pick a campaign below. We'll register your phone line first, then start dialing.
      </p>

      {conflict && (
        <div className="rounded-2xl border border-[#FFB300]/30 bg-[#FFB300]/10 p-4 mb-6 flex items-center justify-between gap-4">
          <p className="text-sm text-[#FFB300]">
            A session is already active for{' '}
            <span className="font-semibold">{conflict.campaignName}</span>.
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={onOpenConflict}
              className="px-3 py-1.5 rounded-lg bg-[#FFB300]/20 border border-[#FFB300]/40 text-[#FFB300] text-sm font-medium"
            >
              Open it
            </button>
            <button
              type="button"
              onClick={onDismissConflict}
              className="px-3 py-1.5 rounded-lg bg-white/5 text-[#B0BEC5] text-sm"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {startError && (
        <div className="rounded-2xl border border-[#FF3D00]/30 bg-[#FF3D00]/10 p-4 mb-6">
          <p className="text-sm text-[#FF3D00]">{startError}</p>
        </div>
      )}

      {campaignsError && (
        <div className="rounded-2xl border border-[#FF3D00]/30 bg-[#FF3D00]/10 p-4 mb-6">
          <p className="text-sm text-[#FF3D00]">{campaignsError}</p>
        </div>
      )}

      {campaigns === null && !campaignsError && (
        <div className="flex items-center gap-2 text-[#B0BEC5] py-8 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" />
          Loading campaigns…
        </div>
      )}

      {campaigns !== null && campaigns.length === 0 && (
        <div className="rounded-2xl border border-white/5 bg-[#1A2332]/60 p-8 text-center">
          <Users className="w-8 h-8 text-[#B0BEC5]/50 mx-auto mb-3" />
          <p className="text-[#B0BEC5]">No campaigns assigned yet — ask your manager.</p>
        </div>
      )}

      {campaigns !== null && campaigns.length > 0 && (
        <div className="space-y-3">
          {campaigns.map((campaign) => {
            const isStartingThis = startingCampaignId === campaign.id;
            const isStartingOther = startingCampaignId !== null && !isStartingThis;
            return (
              <div
                key={campaign.id}
                className="rounded-2xl border border-white/5 bg-[#1A2332]/60 p-5 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <p className="text-white font-semibold truncate">{campaign.name}</p>
                  <div className="flex flex-wrap items-center gap-3 mt-1 text-sm text-[#B0BEC5]">
                    <span>{campaign.lines} lines</span>
                    <span className="flex items-center gap-1">
                      <Phone className="w-3.5 h-3.5" />
                      {callerIdLabel(campaign, userNumbers)}
                    </span>
                    <span>{campaign.queued} queued</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onStart(campaign)}
                  disabled={isStartingOther || isStartingThis}
                  className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-[#00D9FF] to-[#0066FF] text-white font-semibold disabled:opacity-60"
                >
                  {isStartingThis ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {micRegistering ? 'Registering your line…' : 'Starting…'}
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      Start
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
