import { useEffect, useState } from 'react';
import { Mic, MicOff, PhoneOff, User } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LiveCallPanelProps {
  contactName: string;
  phone: string;
  /** TASK-L2b: the leg's real `answered_at` (ISO). Elapsed time is derived from it every tick
   *  instead of a local counter that reset to 0 on every remount (a real bug once this task
   *  put a second, correct timer -- the DialerStateBanner's "Connected — <name> <timer>" -- on
   *  screen at the same time: the two would visibly disagree). `null` shows "0:00" rather than
   *  guessing. */
  answeredAt: string | null;
  /** TASK-I1: set to "Inbound call" while this panel is showing a caller bridged in via
   *  inbound routing (`pause_reason: 'inbound_call'`), not a contact leg the batch dialed --
   *  the task's own explicit ask ("The Dialer shows the contact card flagged 'Inbound call'"). */
  flagLabel?: string;
  onToggleMute: (muted: boolean) => void;
  onEndCall: () => void;
}

export function LiveCallPanel({
  contactName,
  phone,
  answeredAt,
  flagLabel,
  onToggleMute,
  onEndCall,
}: LiveCallPanelProps) {
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!answeredAt) {
      setSeconds(0);
      return;
    }
    const answeredAtMs = new Date(answeredAt).getTime();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - answeredAtMs) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [answeredAt]);

  const mins = Math.floor(seconds / 60);
  const secs = `${seconds % 60}`.padStart(2, '0');

  return (
    <div className="rounded-app-lg border border-success/25 bg-surface-1 p-6 shadow-app-md">
      <div className="flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-full bg-success-soft flex items-center justify-center mb-4">
          <User className="w-7 h-7 text-success" />
        </div>
        {flagLabel && (
          <span className="mb-2 px-2 py-0.5 rounded-full text-xs border border-accent-to/30 bg-accent-to/10 text-accent-to">
            {flagLabel}
          </span>
        )}
        <h3 className="text-page-title text-text-primary">{contactName}</h3>
        <p className="text-body text-text-secondary mt-0.5">{phone}</p>
        <p className="text-metric text-4xl font-semibold text-text-primary mt-4 tabular-nums">
          {mins}:{secs}
        </p>
      </div>
      <div className="mt-6 flex items-center justify-center gap-3">
        <Button
          type="button"
          variant="fe-secondary"
          onClick={() => {
            const next = !muted;
            setMuted(next);
            onToggleMute(next);
          }}
        >
          {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          {muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button type="button" variant="danger" onClick={onEndCall}>
          <PhoneOff className="w-4 h-4" />
          Hang up
        </Button>
      </div>
      <textarea
        placeholder="Quick notes for this contact..."
        className="mt-6 w-full min-h-[90px] rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
      />
    </div>
  );
}
