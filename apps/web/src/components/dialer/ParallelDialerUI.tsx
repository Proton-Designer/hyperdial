import { useEffect, useState } from 'react';
import { ContactBatchCard } from './ContactBatchCard';
import { LiveCallPanel } from './LiveCallPanel';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import type { BatchContactPreview } from '@/hooks/useDialerSession';
import type { DialSessionState } from '@/lib/api';

interface ParallelDialerUIProps {
  sessionState: DialSessionState;
  lines: number;
  amdMode: 'off' | 'on';
  callsMade: number;
  connected: number;
  voicemail: number;
  noAnswer: number;
  resolvedCount: number;
  totalContacts: number;
  progress: number;
  batchContacts: BatchContactPreview[];
  answeredContactId: string | null;
  connectedContactId: string | null;
  connectedAnsweredAt: string | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onMuteChange: (muted: boolean) => void;
  onEndLiveCall: () => void;
}

/** Session states where clicking Pause could do anything (pauseSession's own gate) -- disabled
 *  everywhere else so it's never a confusing no-op click. */
const PAUSABLE_STATES = new Set<DialSessionState>(['dialing', 'ready']);

const STATUS_CHIP: Record<DialSessionState, { label: string; className: string }> = {
  ready_pending: { label: 'Ready', className: 'bg-surface-3 text-text-secondary' },
  ready: { label: 'Ready', className: 'bg-surface-3 text-text-secondary' },
  dialing: { label: 'Dialing', className: 'bg-accent-to/15 text-accent-to' },
  connecting: { label: 'Connecting', className: 'bg-warning-soft text-warning' },
  on_call: { label: 'Connected', className: 'bg-success-soft text-success' },
  wrap_up: { label: 'Wrap-up', className: 'bg-warning-soft text-warning' },
  paused: { label: 'Paused', className: 'bg-surface-3 text-text-secondary' },
  paused_agent_lost: { label: 'Line lost', className: 'bg-danger-soft text-danger' },
  completed: { label: 'Completed', className: 'bg-success-soft text-success' },
  stopped: { label: 'Stopped', className: 'bg-surface-3 text-text-secondary' },
};

function useElapsed(answeredAt: string | null): string {
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
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export function ParallelDialerUI({
  sessionState,
  lines,
  amdMode,
  callsMade,
  connected,
  voicemail,
  noAnswer,
  resolvedCount,
  totalContacts,
  progress,
  batchContacts,
  answeredContactId,
  connectedContactId,
  connectedAnsweredAt,
  onPause,
  onResume,
  onStop,
  onMuteChange,
  onEndLiveCall,
}: ParallelDialerUIProps) {
  const connectedContact = batchContacts.find((c) => c.id === connectedContactId) ?? null;
  const elapsed = useElapsed(sessionState === 'on_call' ? connectedAnsweredAt : null);
  const chip = STATUS_CHIP[sessionState];

  const getContactState = (contactId: string): 'dialing' | 'connecting' | 'connected' => {
    if (connectedContactId === contactId) return 'connected';
    if (answeredContactId === contactId) return 'connecting';
    return 'dialing';
  };

  return (
    <div className="space-y-4">
      {/* Header strip: status chip + timer (on_call only) + the stat row + Pause/Stop. */}
      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-meta font-medium',
                chip.className
              )}
            >
              {chip.label}
            </span>
            {sessionState === 'on_call' && (
              <span className="text-body text-text-primary tabular-nums font-medium">
                {elapsed}
              </span>
            )}
            <span className="text-meta text-text-muted">
              {lines} line{lines === 1 ? '' : 's'} · AMD {amdMode === 'on' ? 'on' : 'off'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {sessionState === 'paused' ? (
              <Button variant="primary" size="sm" onClick={onResume}>
                Resume
              </Button>
            ) : (
              <Button
                variant="warning-soft"
                size="sm"
                onClick={onPause}
                disabled={!PAUSABLE_STATES.has(sessionState)}
              >
                Pause
              </Button>
            )}
            {/* Stop always works, in every state, per this task's own spec. */}
            <Button variant="danger-ghost" size="sm" onClick={onStop}>
              Stop session
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-meta text-text-secondary">
          <Stat label="Dialed" value={callsMade} />
          <Stat label="Connected" value={connected} />
          <Stat label="VM" value={voicemail} />
          <Stat label="No answer" value={noAnswer} />
          <Stat label="Progress" value={`${resolvedCount}/${totalContacts}`} />
        </div>
        <div className="mt-3 h-1.5 rounded-full bg-surface-3 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent-from to-accent-to transition-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {batchContacts.length > 0 && (
        <div>
          <h3 className="text-section-title text-text-primary mb-3">Current batch</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {batchContacts.map((contact) => (
              <ContactBatchCard
                key={contact.id}
                name={contact.name}
                phone={contact.phone}
                state={getContactState(contact.id)}
                answeredAt={contact.id === connectedContactId ? connectedAnsweredAt : null}
              />
            ))}
          </div>
        </div>
      )}

      {connectedContact && (
        <LiveCallPanel
          contactName={connectedContact.name}
          phone={connectedContact.phone}
          answeredAt={connectedAnsweredAt}
          onToggleMute={onMuteChange}
          onEndCall={onEndLiveCall}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span>
      {label}: <b className="text-text-primary font-semibold">{value}</b>
    </span>
  );
}
