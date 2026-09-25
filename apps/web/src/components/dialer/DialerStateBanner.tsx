import { useEffect, useState } from 'react';
import { AlertTriangle, Mic, Pause, Phone, PhoneOff, Wifi } from 'lucide-react';
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
 */

interface DialerStateBannerProps {
  sessionState: DialSessionState | null;
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
}

function useElapsedSeconds(answeredAt: string | null): number {
  const [seconds, setSeconds] = useState(0);
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
  return seconds;
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function DialerStateBanner({
  sessionState,
  ringingCount,
  connectedContact,
  connectedAnsweredAt,
  webrtcReady,
  webrtcConnecting,
  webrtcError,
  onReconnect,
  reconnecting,
  onResume,
  resuming,
}: DialerStateBannerProps) {
  const connectedSeconds = useElapsedSeconds(connectedAnsweredAt);

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
          <button
            type="button"
            onClick={onReconnect}
            disabled={reconnecting}
            className="px-4 py-2 rounded-lg bg-[#00D9FF]/20 border border-[#00D9FF]/40 text-[#00D9FF] font-medium disabled:opacity-50"
          >
            {reconnecting ? 'Reconnecting…' : 'Reconnect'}
          </button>
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

  if (sessionState === 'on_call' && connectedContact) {
    return (
      <StatusBanner
        tone="success"
        icon={<Phone className="w-5 h-5" />}
        title={`Connected — ${connectedContact.name} ${formatElapsed(connectedSeconds)}`}
        detail={connectedContact.phone}
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

  if (sessionState === 'paused') {
    return (
      <StatusBanner
        tone="info"
        icon={<Pause className="w-5 h-5" />}
        title="Paused"
        detail="No new lines will dial until you resume."
        action={
          <button
            type="button"
            onClick={onResume}
            disabled={resuming}
            className="px-4 py-2 rounded-lg bg-[#00D9FF]/20 border border-[#00D9FF]/40 text-[#00D9FF] font-medium disabled:opacity-50"
          >
            {resuming ? 'Resuming…' : 'Resume'}
          </button>
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
      ? 'border-[#FF3D00]/30 bg-[#FF3D00]/10 text-[#FF3D00]'
      : tone === 'success'
        ? 'border-[#00E676]/30 bg-[#00E676]/10 text-[#00E676]'
        : 'border-[#00D9FF]/30 bg-[#00D9FF]/10 text-[#00D9FF]';
  return (
    <div className={`rounded-2xl border p-4 mb-4 flex items-start gap-3 ${toneClasses}`}>
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1">
        <p className="font-medium text-white">{title}</p>
        <p className="text-sm text-[#B0BEC5] mt-0.5">{detail}</p>
      </div>
      {action}
    </div>
  );
}
