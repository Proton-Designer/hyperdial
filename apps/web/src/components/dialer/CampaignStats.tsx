import { Phone } from 'lucide-react';
import type { UserPhoneNumber } from '../Dialer';
import { cn } from '@/components/ui/utils';

interface CampaignStatsProps {
  userNumbers: UserPhoneNumber[];
}

/** FE-B: slimmed down to just "Your Numbers" -- the old "Single Call Dialer" instructional card
 *  was redundant filler now that the manual dialer is its own clearly-labeled collapsible panel. */
export function CampaignStats({ userNumbers }: CampaignStatsProps) {
  return (
    <div className="hidden lg:block w-[280px] border-l border-border-subtle overflow-y-auto p-5">
      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
        <h3 className="text-meta font-semibold text-text-secondary uppercase tracking-wide mb-3 flex items-center gap-1.5">
          <Phone className="w-3.5 h-3.5" />
          Your numbers
        </h3>
        {userNumbers.length === 0 ? (
          <p className="text-meta text-text-muted">
            No phone numbers yet. Purchase one in Settings.
          </p>
        ) : (
          <div className="space-y-1.5">
            {userNumbers.map((num) => (
              <div
                key={num.id}
                className="flex items-center justify-between px-2.5 py-2 bg-surface-2 rounded-app-sm"
              >
                <span className="text-meta text-text-primary truncate">{num.phone_number}</span>
                <span
                  className={cn(
                    'px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0',
                    num.status === 'active'
                      ? 'bg-success-soft text-success'
                      : 'bg-surface-3 text-text-muted'
                  )}
                >
                  {num.status === 'active'
                    ? 'Active'
                    : num.status === 'resting'
                      ? 'Resting'
                      : 'Retired'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
