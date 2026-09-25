import { AlertTriangle, Mic, PhoneOff, Wifi } from 'lucide-react';
import type { DialSessionState } from '@/lib/api';

/**
 * TASK-L1 (AUD-7 pre-flight, AUD-5 Reconnect) -- deliberately minimal. The full dialer
 * state-machine screen is TASK-L2b; this is just enough surface for the intern to know
 * whether their line is actually in the conference, and a way to get it back if it drops.
 *
 * Scope note: this can only show status and offer Reconnect -- it cannot BLOCK the "Start
 * Session" click itself (that button lives in CampaignManageModal.tsx, owned by the other
 * lane per LAUNCH-PLAN). The real hard backstop against starting a session with no WebRTC
 * client registered is server-side: dialer-session-start's AGENT_NOT_REGISTERED error
 * (dialer-engine.ts's agentSipUri). This component's job is to make the common case obvious
 * and self-service, not to be the only thing enforcing it.
 */

interface AgentConnectionStatusProps {
  /** The dial_sessions row's own state, once a session exists. */
  sessionState: DialSessionState | null;
  /** useTelnyxCall's isReady/isConnecting/error for the WebRTC client itself. */
  webrtcReady: boolean;
  webrtcConnecting: boolean;
  webrtcError: string | null;
  onReconnect: () => void;
  reconnecting: boolean;
}

export function AgentConnectionStatus({
  sessionState,
  webrtcReady,
  webrtcConnecting,
  webrtcError,
  onReconnect,
  reconnecting,
}: AgentConnectionStatusProps) {
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
        title="Your line dropped"
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

  if (sessionState === 'ready_pending' && webrtcConnecting) {
    return (
      <StatusBanner
        tone="info"
        icon={<Wifi className="w-5 h-5 animate-pulse" />}
        title="Waiting for your line to join the call…"
        detail="This usually takes about a second."
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
  tone: 'info' | 'error';
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  const toneClasses =
    tone === 'error'
      ? 'border-[#FF3D00]/30 bg-[#FF3D00]/10 text-[#FF3D00]'
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
