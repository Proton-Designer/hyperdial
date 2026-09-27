import { useState } from 'react';
import { Ear, Mic, PhoneOff, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { switchCoachingMode, type CoachingMode } from '@/lib/api';

interface CoachingBannerProps {
  coachingId: string;
  mode: CoachingMode;
  onModeChanged: (mode: CoachingMode) => void;
  onLeave: () => void;
}

const MODE_META: Record<CoachingMode, { label: string; icon: typeof Ear }> = {
  listen: { label: 'Listen', icon: Ear },
  whisper: { label: 'Whisper', icon: Mic },
  barge: { label: 'Barge', icon: Radio },
};

/**
 * TASK-T3: a small, always-visible-while-coaching banner -- rendered via a portal from
 * Dialer.tsx (see its own comment for why) so it survives every tab switch, since the coaching
 * leg lives on the SAME always-mounted WebRTC client Dialer.tsx owns, not on whichever tab
 * happens to be active. "Leave" is a PLAIN client-side hangup (`onLeave`, wired to
 * useTelnyxCall's own `hangup()`) -- there is no server "end" endpoint at all, see
 * coaching-core.ts's own header for why.
 */
export function CoachingBanner({ coachingId, mode, onModeChanged, onLeave }: CoachingBannerProps) {
  const [switching, setSwitching] = useState<CoachingMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSwitch = async (next: CoachingMode) => {
    if (next === mode || switching) return;
    setSwitching(next);
    setError(null);
    try {
      const result = await switchCoachingMode(coachingId, next);
      onModeChanged(result.mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch coaching mode');
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[320px] rounded-app-lg border border-warning/30 bg-surface-1 p-4 shadow-app-lg">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-warning flex-shrink-0" />
        <p className="font-medium text-text-primary flex-1">Live coaching</p>
        <Button type="button" variant="fe-ghost" size="sm" onClick={onLeave}>
          <PhoneOff className="w-3.5 h-3.5" />
          Leave
        </Button>
      </div>
      {error && <p className="text-meta text-danger mb-2">{error}</p>}
      <div className="flex items-center gap-1.5">
        {(Object.keys(MODE_META) as CoachingMode[]).map((m) => {
          const meta = MODE_META[m];
          const Icon = meta.icon;
          const active = m === mode;
          return (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={active ? 'fe-secondary' : 'fe-ghost'}
              disabled={switching !== null}
              onClick={() => void handleSwitch(m)}
            >
              <Icon className="w-3.5 h-3.5" />
              {switching === m ? 'Switching…' : meta.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
