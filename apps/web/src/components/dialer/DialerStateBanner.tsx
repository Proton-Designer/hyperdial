import { AlertTriangle, Mic, Pause, Phone, PhoneOff, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DialSessionState } from '@/lib/api';

/**
 * TASK-L2b (UI-7, "big visible state"): the single, authoritative one-line status for the
 * parallel dialer -- extended from TASK-L1's `AgentConnectionStatus` (same file, renamed and
 * broadened) rather than adding a second banner that could ever disagree with it. Deliberately
 * minimal presentation-wise; the fuller "current batch" grid and `LiveCallPanel` (name/phone/
 * timer/mute/end-call) do the detailed work below this. Priority order, top to bottom: a
 * WebRTC client error outranks everything (nothing else can be trusted until it's fixed);
 * `paused_agent_lost` outranks the ordinary session-state strings (it's the one state where
 * something is actively wrong, not just "the next normal step"); then the ordinary UI-7
 * strings keyed on `dial_sessions.state`.
 *
 * FE-B: `on_call` now renders nothing here -- ParallelDialerUI's header strip already carries a
 * status chip, and LiveCallPanel is the "prominent contact card" for that state, so a third
 * "Connected — <name> <timer>" line would just repeat both. Every other state still gets its
 * explanatory sentence here (the chip alone is a glance, not an explanation).
 */

interface DialerStateBannerProps {
  sessionState: DialSessionState | null;
  /** TASK-N1: only meaningful while `sessionState === 'paused'` -- see DialSessionRecord's own
   *  field comment (api.ts) for why a stale value must never be read once the session has moved
   *  on to a different state. */
  pauseReason: string | null;
  /** Contacts currently in a non-terminal state ("Ringing N lines"). */
  ringingCount: number;
  connectedContact: { name: string; phone: string } | null;
  connectedAnsweredAt: string | null;
  webrtcReady: boolean;
  webrtcConnecting: boolean;
  webrtcError: string | null;
  onReconnect: () => void;
  reconnecting: boolean;
  onResume: () => void;
  resuming: boolean;
  /** MISSION-4 TASK-T7 (auto-resume): only meaningful while `sessionState === 'paused'` and
   *  `pauseReason === 'post_wrapup'`. `null`/`undefined` means no countdown is running (either
   *  the agent's own setting is "Manual", or they already clicked Cancel) -- render the bare
   *  manual-resume banner in that case, same as any other plain `paused` state. */
  autoResumeSecondsLeft?: number | null;
  onCancelAutoResume?: () => void;
}

export function DialerStateBanner({
  sessionState,
  pauseReason,
  ringingCount,
  webrtcReady,
  webrtcConnecting,
  webrtcError,
  onReconnect,
  reconnecting,
  onResume,
  resuming,
  autoResumeSecondsLeft,
  onCancelAutoResume,
}: DialerStateBannerProps) {
  if (webrtcError) {
    return (
      <StatusBanner
        tone="error"
        icon={<AlertTriangle className="w-5 h-5" />}
        title="Your line could not connect"
        detail={webrtcError}
      />
    );
  }

  if (sessionState === 'paused_agent_lost') {
    return (
      <StatusBanner
        tone="error"
        icon={<PhoneOff className="w-5 h-5" />}
        title="Agent audio lost — Reconnect"
        detail="The customer is still on the call. Reconnect to rejoin -- they have not been hung up on."
        action={
          <Button variant="primary" onClick={onReconnect} disabled={reconnecting}>
            {reconnecting ? 'Reconnecting…' : 'Reconnect'}
          </Button>
        }
      />
    );
  }

  if (sessionState === 'ready_pending' && !webrtcReady) {
    return (
      <StatusBanner
        tone="info"
        icon={<Mic className="w-5 h-5 animate-pulse" />}
        title="Connecting your line…"
        detail="Allow microphone access if your browser asks. This finishes automatically."
      />
    );
  }

  if (sessionState === 'ready_pending' || sessionState === 'ready') {
    return (
      <StatusBanner
        tone="info"
        icon={<Wifi className={`w-5 h-5 ${webrtcConnecting ? 'animate-pulse' : ''}`} />}
        title="Ready — waiting to dial"
        detail="Your line is in the call. Dialing starts automatically."
      />
    );
  }

  if (sessionState === 'connecting') {
    return (
      <StatusBanner
        tone="info"
        icon={<Phone className="w-5 h-5 animate-pulse" />}
        title="Connecting…"
        detail="A contact just answered — bridging the call now."
      />
    );
  }

  if (sessionState === 'dialing') {
    return (
      <StatusBanner
        tone="info"
        icon={<Phone className="w-5 h-5 animate-pulse" />}
        title={`Ringing ${ringingCount} line${ringingCount === 1 ? '' : 's'}`}
        detail="The first contact to answer gets bridged to you."
      />
    );
  }

  if (sessionState === 'wrap_up') {
    return (
      <StatusBanner
        tone="info"
        icon={<Pause className="w-5 h-5" />}
        title="Wrapping up"
        detail="Submit a disposition for the last call to continue dialing."
      />
    );
  }

  if (sessionState === 'paused' && pauseReason === 'no_numbers_available') {
    return (
      <StatusBanner
        tone="error"
        icon={<AlertTriangle className="w-5 h-5" />}
        title="All your numbers have hit today's dial limit"
        detail="Ask your manager to assign you another number or wait for one to finish resting, then resume."
        action={
          <Button variant="primary" onClick={onResume} disabled={resuming}>
            {resuming ? 'Resuming…' : 'Resume'}
          </Button>
        }
      />
    );
  }

  if (sessionState === 'paused' && pauseReason === 'post_wrapup') {
    const counting = typeof autoResumeSecondsLeft === 'number' && autoResumeSecondsLeft > 0;
    return (
      <StatusBanner
        tone="info"
        icon={<Pause className="w-5 h-5" />}
        title={counting ? `Next batch in ${autoResumeSecondsLeft}s` : 'Disposition saved'}
        detail={
          counting
            ? 'Press Space or click Resume now to skip the wait.'
            : 'Click Resume (or press Space) when you’re ready for the next batch.'
        }
        action={
          <div className="flex items-center gap-2">
            {counting && onCancelAutoResume && (
              <Button variant="fe-secondary" onClick={onCancelAutoResume}>
                Cancel
              </Button>
            )}
            <Button variant="primary" onClick={onResume} disabled={resuming}>
              {resuming ? 'Resuming…' : 'Resume'}
            </Button>
          </div>
        }
      />
    );
  }

  if (sessionState === 'paused') {
    return (
      <StatusBanner
        tone="info"
        icon={<Pause className="w-5 h-5" />}
        title="Paused"
        detail="No new lines will dial until you resume."
        action={
          <Button variant="primary" onClick={onResume} disabled={resuming}>
            {resuming ? 'Resuming…' : 'Resume'}
          </Button>
        }
      />
    );
  }

  return null;
}

function StatusBanner({
  tone,
  icon,
  title,
  detail,
  action,
}: {
  tone: 'info' | 'error' | 'success';
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  const toneClasses =
    tone === 'error'
      ? 'border-danger/30 bg-danger-soft text-danger'
      : tone === 'success'
        ? 'border-success/30 bg-success-soft text-success'
        : 'border-accent-to/30 bg-accent-to/10 text-accent-to';
  return (
    <div className={`rounded-app-lg border p-4 mb-4 flex items-start gap-3 ${toneClasses}`}>
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1">
        <p className="font-medium text-text-primary">{title}</p>
        <p className="text-body text-text-secondary mt-0.5">{detail}</p>
      </div>
      {action}
    </div>
  );
}
