import { useEffect, useRef, useState } from 'react';
import { Ear, Mic, PhoneOff, Radio, UserCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  switchCoachingMode,
  getDialerSession,
  takeoverCall,
  getCallTakeoverSettings,
  type CoachingMode,
} from '@/lib/api';

interface CoachingBannerProps {
  coachingId: string;
  mode: CoachingMode;
  /** TASK-T3 review fix-forward (review-eng1.md #1): the coached session's own id, so this
   *  banner can poll it and auto-hang-up once it's no longer `on_call` -- '' (a pre-fix client
   *  build, or a malformed/missing client_state field) just disables this ONE safety layer, the
   *  server-side sweeper (`reap_stale_coaching_sessions`) still covers it either way. */
  targetSessionId: string;
  onModeChanged: (mode: CoachingMode) => void;
  onLeave: () => void;
}

/** How often to poll the target session while coaching -- fast enough that "the call ended, why
 *  is my line still open" never lingers more than a few seconds, cheap enough (one GET) to run
 *  for the lifetime of a coaching session. */
const TARGET_SESSION_POLL_MS = 4000;

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
export function CoachingBanner({
  coachingId,
  mode,
  targetSessionId,
  onModeChanged,
  onLeave,
}: CoachingBannerProps) {
  const [switching, setSwitching] = useState<CoachingMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetEnded, setTargetEnded] = useState(false);
  // MISSION-5 TASK-M5-N1: org setting, OFF by default -- fetched once so the button is hidden
  // rather than shown-then-403'd for an org that hasn't turned this on. Fails closed (hidden) on
  // a fetch error, same "never assume enabled" posture as every other settings-gated control.
  const [takeoverEnabled, setTakeoverEnabled] = useState(false);
  const [confirmingTakeover, setConfirmingTakeover] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  // Once true, the agent's own leg is gone for good (server-side) -- this manager's leg is now
  // the only one talking to the prospect. Distinct from `targetEnded`: a takeover also moves
  // `targetSessionId`'s state away from `on_call` (by design, see the migration's own header), so
  // the poll below must stop treating that as "the call ended, hang up my own leg too."
  const [tookOver, setTookOver] = useState<{ roleUpdateFailed: boolean } | null>(null);
  const tookOverRef = useRef(false);
  // `onLeave` (hangup) is a fresh closure every render (Dialer.tsx) -- a ref keeps the poll
  // effect below from needing it in its dependency array, so it never tears down/restarts the
  // interval on every parent re-render, only when targetSessionId itself actually changes.
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    getCallTakeoverSettings()
      .then((s) => setTakeoverEnabled(s.enabled))
      .catch(() => setTakeoverEnabled(false));
  }, []);

  useEffect(() => {
    if (!targetSessionId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const { session } = await getDialerSession(targetSessionId);
        if (stopped) return;
        if (session.state !== 'on_call' && !tookOverRef.current) {
          setTargetEnded(true);
          onLeaveRef.current();
        }
      } catch {
        // A transient fetch failure (network blip) should never auto-hang-up the manager's own
        // leg on a false positive -- just try again on the next tick.
      }
    };
    const interval = setInterval(() => void poll(), TARGET_SESSION_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [targetSessionId]);

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

  const handleTakeover = async () => {
    setTakingOver(true);
    setTakeoverError(null);
    try {
      const result = await takeoverCall(coachingId);
      tookOverRef.current = true;
      setTookOver({ roleUpdateFailed: result.roleUpdateFailed });
      setConfirmingTakeover(false);
    } catch (e) {
      setTakeoverError(e instanceof Error ? e.message : 'Failed to take over the call');
    } finally {
      setTakingOver(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[320px] rounded-app-lg border border-warning/30 bg-surface-1 p-4 shadow-app-lg">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-warning flex-shrink-0" />
        <p className="font-medium text-text-primary flex-1">
          {tookOver ? "You're on this call" : 'Live coaching'}
        </p>
        <Button type="button" variant="fe-ghost" size="sm" onClick={onLeave}>
          <PhoneOff className="w-3.5 h-3.5" />
          {tookOver ? 'Hang up' : 'Leave'}
        </Button>
      </div>
      {error && <p className="text-meta text-danger mb-2">{error}</p>}
      {takeoverError && <p className="text-meta text-danger mb-2">{takeoverError}</p>}
      {targetEnded && !tookOver && (
        <p className="text-meta text-text-secondary mb-2">Call ended, coaching stopped.</p>
      )}
      {tookOver && (
        <p className="text-meta text-text-secondary mb-2">
          You took over -- the agent has been disconnected.
          {tookOver.roleUpdateFailed && (
            <>
              {' '}
              Your audio role may not have updated to Barge.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => void handleSwitch('barge')}
              >
                Retry
              </button>
            </>
          )}
        </p>
      )}
      {!tookOver && (
        <div className="flex items-center gap-1.5 flex-wrap">
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
                disabled={switching !== null || targetEnded}
                onClick={() => void handleSwitch(m)}
              >
                <Icon className="w-3.5 h-3.5" />
                {switching === m ? 'Switching…' : meta.label}
              </Button>
            );
          })}
          {takeoverEnabled && !targetEnded && !confirmingTakeover && (
            <Button
              type="button"
              size="sm"
              variant="fe-ghost"
              disabled={takingOver}
              onClick={() => setConfirmingTakeover(true)}
            >
              <UserCog className="w-3.5 h-3.5" />
              Take over
            </Button>
          )}
        </div>
      )}
      {confirmingTakeover && !tookOver && (
        <div className="mt-2 rounded-app-md border border-warning/40 bg-warning-soft p-2">
          <p className="text-meta text-text-primary mb-2">
            This ends the agent's leg -- you'll be the only one on the call. Confirm?
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={takingOver}
              onClick={() => void handleTakeover()}
            >
              {takingOver ? 'Taking over…' : 'Take over'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="fe-ghost"
              disabled={takingOver}
              onClick={() => setConfirmingTakeover(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
