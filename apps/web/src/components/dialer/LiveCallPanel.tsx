import { useEffect, useState } from 'react';
import { Mic, MicOff, PauseCircle, PhoneForwarded, PhoneOff, User } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** TASK-T4: a plain "mm:ss since this timestamp" ticker -- shared by the call-duration timer
 *  above and the new on-hold timer below (LiveCallPanel's own original inline version, factored
 *  out rather than duplicated a second time). */
function useElapsedSince(since: string | null): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!since) {
      setSeconds(0);
      return;
    }
    const sinceMs = new Date(since).getTime();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - sinceMs) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  const mins = Math.floor(seconds / 60);
  const secs = `${seconds % 60}`.padStart(2, '0');
  return `${mins}:${secs}`;
}

export interface LiveCallActiveTransfer {
  type: 'cold' | 'warm';
  status: 'dialing' | 'connected';
  targetLabel: string;
}

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
  /** TASK-T3: 'whisper'/'barge' only -- never 'listen' (industry default: a plain listen is
   *  silent, the task's own explicit ask; enforced server-side too, see getDialerSession's own
   *  comment in api.ts, not just by this component omitting it). A separate badge from
   *  `flagLabel` (not a shared slot) so an "Inbound call" flag and a coaching indicator can show
   *  at the same time without one clobbering the other. */
  coachingMode?: 'whisper' | 'barge' | null;
  /** TASK-T4 (AUD-6): the leg's own `held_at` -- null when not held. Omit entirely (along with
   *  onHold/onResume) for a panel that shouldn't offer hold at all (the inbound-call panel,
   *  out of this task's scope). */
  heldAt?: string | null;
  onHold?: () => void;
  onResume?: () => void;
  /** TASK-T4: the session's in-flight transfer for THIS leg, if any -- omit `onOpenTransfer`
   *  entirely for a panel that shouldn't offer transfer at all. */
  activeTransfer?: LiveCallActiveTransfer | null;
  onOpenTransfer?: () => void;
  onCompleteTransfer?: () => void;
  onCancelTransfer?: () => void;
  onToggleMute: (muted: boolean) => void;
  onEndCall: () => void;
}

export function LiveCallPanel({
  contactName,
  phone,
  answeredAt,
  flagLabel,
  coachingMode,
  heldAt,
  onHold,
  onResume,
  activeTransfer,
  onOpenTransfer,
  onCompleteTransfer,
  onCancelTransfer,
  onToggleMute,
  onEndCall,
}: LiveCallPanelProps) {
  const [muted, setMuted] = useState(false);
  const callTimer = useElapsedSince(answeredAt);
  const holdTimer = useElapsedSince(heldAt ?? null);

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
        {coachingMode && (
          <span className="mb-2 px-2 py-0.5 rounded-full text-xs border border-warning/30 bg-warning/10 text-warning">
            {coachingMode === 'barge' ? 'Manager on the call' : 'Manager listening'}
          </span>
        )}
        {heldAt && (
          <span className="mb-2 px-2 py-0.5 rounded-full text-xs border border-warning/30 bg-warning/10 text-warning">
            On hold
          </span>
        )}
        {activeTransfer && (
          <span className="mb-2 px-2 py-0.5 rounded-full text-xs border border-accent-to/30 bg-accent-to/10 text-accent-to">
            {activeTransfer.status === 'dialing'
              ? `${activeTransfer.type === 'warm' ? 'Warm' : 'Cold'} transfer -- dialing ${activeTransfer.targetLabel}…`
              : `Talking to ${activeTransfer.targetLabel}`}
          </span>
        )}
        <h3 className="text-page-title text-text-primary">{contactName}</h3>
        <p className="text-body text-text-secondary mt-0.5">{phone}</p>
        <p className="text-metric text-4xl font-semibold text-text-primary mt-4 tabular-nums">
          {heldAt ? holdTimer : callTimer}
        </p>
        {heldAt && <p className="text-meta text-text-secondary mt-1">On hold</p>}
      </div>

      {activeTransfer?.type === 'warm' && activeTransfer.status === 'connected' ? (
        // TASK-T4: the intern is talking to the transfer target -- the ONLY two ways this
        // resolves. Cold transfer never reaches this branch (dialing -> completed in one step,
        // see transfer-core.ts's own header); mute/hangup don't apply while parked here either.
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button type="button" variant="fe-secondary" onClick={onCancelTransfer}>
            Cancel transfer
          </Button>
          <Button type="button" variant="primary" onClick={onCompleteTransfer}>
            <PhoneForwarded className="w-4 h-4" />
            Complete transfer
          </Button>
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {heldAt ? (
            <Button type="button" variant="primary" onClick={onResume}>
              Resume
            </Button>
          ) : (
            <>
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
              {onHold && (
                <Button type="button" variant="fe-secondary" onClick={onHold}>
                  <PauseCircle className="w-4 h-4" />
                  Hold
                </Button>
              )}
              {onOpenTransfer && !activeTransfer && (
                <Button type="button" variant="fe-secondary" onClick={onOpenTransfer}>
                  <PhoneForwarded className="w-4 h-4" />
                  Transfer
                </Button>
              )}
              <Button type="button" variant="danger" onClick={onEndCall}>
                <PhoneOff className="w-4 h-4" />
                Hang up
              </Button>
            </>
          )}
        </div>
      )}
      <textarea
        placeholder="Quick notes for this contact..."
        className="mt-6 w-full min-h-[90px] rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
      />
    </div>
  );
}
