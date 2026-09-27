import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { ContactBatchCard } from './ContactBatchCard';
import { LiveCallPanel } from './LiveCallPanel';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import type { BatchContactPreview } from '@/hooks/useDialerSession';
import type { DialSessionState, InboundCallInfo } from '@/lib/api';

interface ParallelDialerUIProps {
  sessionState: DialSessionState;
  lines: number;
  amdMode: 'off' | 'detect' | 'detect_words' | 'premium';
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
  /** TASK-I1: the session's current bridged inbound call, if any -- see LiveCallPanel's own
   *  `flagLabel` comment. Mutually exclusive with `connectedContactId` in practice (an inbound
   *  bridge pauses the batch, `pause_reason: 'inbound_call'`, so no contact leg is live at the
   *  same time), but rendered independently rather than assumed. */
  inboundCall: InboundCallInfo | null;
  /** TASK-T3: see LiveCallPanel's own `coachingMode` comment. */
  coachingMode: 'whisper' | 'barge' | null;
  onPause: () => void;
  onResume: () => void;
  /** BUG-11: `force` is only ever passed `true` from the confirm dialog's "Hang up and stop"
   *  button -- see this component's own `StopConfirmDialog` and api.ts's `LiveCallInProgressError`. */
  onStop: (opts?: { force?: boolean }) => void;
  onMuteChange: (muted: boolean) => void;
  onEndLiveCall: () => void;
}

/** BUG-11: "A prospect is on the line" confirm dialog, same portal/focus-trap/motion shape as
 *  AddContactModal.tsx. Only ever rendered while `sessionState === 'on_call'` (StopButton below
 *  owns that gate), so there's always a live human to name in the copy. */
function StopConfirmDialog({
  onKeepCalling,
  onHangUpAndStop,
}: {
  onKeepCalling: () => void;
  onHangUpAndStop: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="stop-confirm-title"
    >
      <div className="absolute inset-0 bg-black/60" onClick={onKeepCalling} aria-hidden="true" />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-sm rounded-app-lg border border-border-subtle bg-surface-1 p-5 shadow-app-md outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="stop-confirm-title" className="text-page-title text-text-primary mb-2">
          A prospect is on the line
        </h2>
        <p className="text-body text-text-secondary mb-5">Stop the session and hang up on them?</p>
        {/* "Keep calling" comes first in DOM order on purpose -- useFocusTrap auto-focuses the
            first focusable element on open, and the safe/default action (not the destructive
            one) is what a stray Enter/Space should activate. */}
        <div className="flex flex-col sm:flex-row sm:justify-end gap-2">
          <Button variant="primary" onClick={onKeepCalling}>
            Keep calling
          </Button>
          <Button variant="danger" onClick={onHangUpAndStop}>
            Hang up and stop
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
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
  inboundCall,
  coachingMode,
  onPause,
  onResume,
  onStop,
  onMuteChange,
  onEndLiveCall,
}: ParallelDialerUIProps) {
  const connectedContact = batchContacts.find((c) => c.id === connectedContactId) ?? null;
  const inboundContactName = inboundCall
    ? inboundCall.contact
      ? inboundCall.contact.business_name ||
        `${inboundCall.contact.first_name ?? ''} ${inboundCall.contact.last_name ?? ''}`.trim() ||
        'Unknown caller'
      : 'Unknown caller'
    : null;
  const elapsed = useElapsed(sessionState === 'on_call' ? connectedAnsweredAt : null);
  const chip = STATUS_CHIP[sessionState];

  // BUG-11: gate Stop behind a confirm dialog whenever a live human is bridged right now.
  // `sessionState === 'on_call'` is the same signal STATUS_CHIP/the elapsed timer above already
  // use for "connected" -- it's only reached once a contact leg is actually claimed/bridged.
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const handleStopClick = () => {
    if (sessionState === 'on_call') {
      setShowStopConfirm(true);
      return;
    }
    onStop();
  };

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
              {lines} line{lines === 1 ? '' : 's'} · AMD {amdMode}
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
            {/* Stop always works, in every state, per this task's own spec -- but BUG-11 gates
                it behind a confirm dialog while a human is actually on the line. */}
            <Button variant="danger-ghost" size="sm" onClick={handleStopClick}>
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
          coachingMode={coachingMode}
          onToggleMute={onMuteChange}
          onEndCall={onEndLiveCall}
        />
      )}

      {inboundCall && (
        <LiveCallPanel
          contactName={inboundContactName ?? 'Unknown caller'}
          phone={inboundCall.contact?.phone_number ?? inboundCall.from_e164}
          answeredAt={inboundCall.answered_at}
          flagLabel="Inbound call"
          coachingMode={coachingMode}
          onToggleMute={onMuteChange}
          onEndCall={onEndLiveCall}
        />
      )}

      {showStopConfirm && (
        <StopConfirmDialog
          onKeepCalling={() => setShowStopConfirm(false)}
          onHangUpAndStop={() => {
            setShowStopConfirm(false);
            onStop({ force: true });
          }}
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
