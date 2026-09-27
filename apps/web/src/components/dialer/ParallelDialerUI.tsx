import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Play } from 'lucide-react';
import { ContactBatchCard } from './ContactBatchCard';
import { LiveCallPanel } from './LiveCallPanel';
import { TransferModal } from './TransferModal';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { supabase } from '@/lib/supabase';
import type { BatchContactPreview, ConnectedContactDetails } from '@/hooks/useDialerSession';
import { getRecordingUrl, getUserPreferences, saveUserPreferences } from '@/lib/api';
import type {
  ActiveTransfer,
  CallLegRecord,
  CampaignScriptInfo,
  ContactHistoryEntry,
  DialSessionState,
  InboundCallInfo,
} from '@/lib/api';

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
  /** TASK-T4 (AUD-6): the connected contact leg's own `held_at`, if any. */
  heldAt: string | null;
  /** MISSION-4 TASK-T8: the connected contact leg's own `recording_status`, if any. */
  recordingStatus: CallLegRecord['recording_status'];
  /** TASK-T4: the session's in-flight warm/cold transfer, if any. */
  activeTransfer: ActiveTransfer | null;
  /** TASK-T5 (CRD-1): the connected contact's own business details, if the leg has a contact
   *  join at all -- every field individually nullable ("graceful when missing"). */
  connectedContact: ConnectedContactDetails | null;
  /** TASK-T5 (CRD-3): the connected contact's own past-attempt history (up to 3, most recent
   *  first). Empty for a contact with no prior attempts. */
  connectedContactHistory: ContactHistoryEntry[];
  /** TASK-T5 (CRD-4, card-side): the connected call's own campaign script/objection sheet. */
  campaignScript: CampaignScriptInfo | null;
  /** TASK-T7: lifted out of LiveCallPanel's own local state so the Dialer's global "M" hotkey
   *  can read the same value the Mute button itself does. */
  muted: boolean;
  /** TASK-T7 review fix-forward (SHOULD, eng2's review-eng2.md): Dialer.tsx reads
   *  `auto_resume_seconds` once on mount, so without this callback a mid-session change via
   *  `AutoResumePrefControl`'s own inline selector below has no in-memory effect until reload --
   *  the countdown-arming effect keys off Dialer's own stale `autoResumePref` state, not a fresh
   *  fetch. Optional (undefined outside a real Dialer mount, e.g. DialerStatesHarness) so the
   *  control's own self-contained save still works standalone either way. */
  onAutoResumePrefChange?: (value: 0 | 5 | 10 | 15) => void;
  onPause: () => void;
  onResume: () => void;
  /** BUG-11: `force` is only ever passed `true` from the confirm dialog's "Hang up and stop"
   *  button -- see this component's own `StopConfirmDialog` and api.ts's `LiveCallInProgressError`. */
  onStop: (opts?: { force?: boolean }) => void;
  onMuteChange: (muted: boolean) => void;
  onEndLiveCall: () => void;
  onHoldCall: () => void;
  onResumeCall: () => void;
  /** MISSION-4 TASK-T8: the Pause/Resume-recording button -- one handler for both directions,
   *  same "the button already knows which state it's in" shape as `onResume`/`onHold` being two
   *  separate props instead. Kept as ONE prop (not two) since, unlike hold, there's no third
   *  "neither" affordance to render -- the button's own label flips on `recordingStatus`. */
  onToggleRecording: () => void;
  onStartTransfer: (args: {
    type: 'cold' | 'warm';
    targetKind: 'member' | 'external';
    targetUserId?: string;
    targetNumber?: string;
  }) => Promise<void>;
  onCompleteTransfer: () => void;
  onCancelTransfer: () => void;
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
  heldAt,
  recordingStatus,
  activeTransfer,
  connectedContact,
  connectedContactHistory,
  campaignScript,
  muted,
  onAutoResumePrefChange,
  onPause,
  onResume,
  onStop,
  onMuteChange,
  onEndLiveCall,
  onHoldCall,
  onResumeCall,
  onToggleRecording,
  onStartTransfer,
  onCompleteTransfer,
  onCancelTransfer,
}: ParallelDialerUIProps) {
  const [showTransferModal, setShowTransferModal] = useState(false);
  const activeTransferForPanel = activeTransfer
    ? {
        type: activeTransfer.type,
        status: activeTransfer.status,
        targetLabel:
          activeTransfer.target_kind === 'member'
            ? 'the teammate'
            : (activeTransfer.target_number ?? ''),
      }
    : null;
  // TASK-T5: connectedContact (CRD-1's own widened join) is the primary source for name/phone
  // too now -- batchContacts (name/phone only) is just the fallback for the split second before
  // it loads, same graceful-degradation spirit as every other nullable CRD-1 field.
  const connectedContactPreview = batchContacts.find((c) => c.id === connectedContactId) ?? null;
  const connectedCallCard = connectedContact ?? connectedContactPreview;
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
          <div className="flex items-center gap-3">
            <AutoResumePrefControl onChange={onAutoResumePrefChange} />
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

      {connectedCallCard && (
        <>
          <LiveCallPanel
            contactName={connectedCallCard.name}
            phone={connectedCallCard.phone}
            answeredAt={connectedAnsweredAt}
            coachingMode={coachingMode}
            heldAt={heldAt}
            onHold={onHoldCall}
            onResume={onResumeCall}
            recordingStatus={recordingStatus}
            onToggleRecording={onToggleRecording}
            activeTransfer={activeTransferForPanel}
            onOpenTransfer={() => setShowTransferModal(true)}
            onCompleteTransfer={onCompleteTransfer}
            onCancelTransfer={onCancelTransfer}
            muted={muted}
            onToggleMute={onMuteChange}
            onEndCall={onEndLiveCall}
          />
          {connectedContact && <ContactDetailsPanel contact={connectedContact} />}
          {connectedContactHistory.length > 0 && (
            <ContactHistoryPanel history={connectedContactHistory} />
          )}
          {campaignScript && (campaignScript.scriptText || campaignScript.objectionSheetText) && (
            <CampaignScriptPanel script={campaignScript} />
          )}
        </>
      )}

      {showTransferModal && (
        <TransferModal
          onClose={() => setShowTransferModal(false)}
          onStart={async (args) => {
            await onStartTransfer(args);
          }}
        />
      )}

      {inboundCall && (
        <LiveCallPanel
          contactName={inboundContactName ?? 'Unknown caller'}
          phone={inboundCall.contact?.phone_number ?? inboundCall.from_e164}
          answeredAt={inboundCall.answered_at}
          flagLabel="Inbound call"
          coachingMode={coachingMode}
          muted={muted}
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

const AUTO_RESUME_SELECT_OPTIONS: Array<{ value: 0 | 5 | 10 | 15; label: string }> = [
  { value: 0, label: 'Manual' },
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
  { value: 15, label: '15s' },
];

/** MISSION-4 TASK-T7 (auto-resume): a compact, agent-reachable version of the same preference
 *  Settings.tsx's own AutoResumeSettingsCard edits. The Settings page itself is manager-only
 *  (TopNavigation.tsx: "the Settings tab is manager-only... fail CLOSED"), so a plain agent --
 *  this feature's actual audience, per the task's own "intern speed" framing -- could never
 *  reach that card at all. Self-contained (own fetch/save via api.ts), no new required prop on
 *  ParallelDialerUI itself. Renders nothing until the initial fetch resolves, and shows no option
 *  selected for an unconfigured (null) preference -- same "don't misrepresent the true default"
 *  reasoning as the Settings card's own comment.
 *
 *  Reads the current user directly via `supabase.auth.getUser()` rather than `useAuth()`'s React
 *  context -- `DialerStatesHarness.tsx` (`?dev_dialer_states=1`) mounts this component with NO
 *  `<AuthProvider>` in the tree at all (`main.tsx`'s dev-harness branch renders it standalone),
 *  and `useAuth()` throws hard ("must be used within AuthProvider") the instant a component calls
 *  it outside one -- this would have crashed that harness the moment this control was added. This
 *  read has no such requirement and degrades gracefully to a no-op save if there's no session.
 *
 *  TASK-T7 review fix-forward: `onChange` (ParallelDialerUIProps' own `onAutoResumePrefChange`)
 *  lets the real Dialer mount keep its own `autoResumePref` state in sync the moment this saves,
 *  instead of only taking effect on the NEXT full reload -- fired only on a SUCCESSFUL save, same
 *  as this control's own optimistic-then-rollback-on-failure shape already implies. */
function AutoResumePrefControl({ onChange }: { onChange?: (value: 0 | 5 | 10 | 15) => void }) {
  const [value, setValue] = useState<0 | 5 | 10 | 15 | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getUserPreferences()
      .then((prefs) => setValue(prefs?.auto_resume_seconds ?? null))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = Number(e.target.value) as 0 | 5 | 10 | 15;
    const prev = value;
    setValue(next);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      await saveUserPreferences(user.id, { auto_resume_seconds: next });
      onChange?.(next);
    } catch {
      setValue(prev);
    }
  };

  if (!loaded) return null;

  return (
    <label className="flex items-center gap-1.5 text-meta text-text-muted">
      Auto-resume
      <select
        value={value ?? ''}
        onChange={(e) => void handleChange(e)}
        className="rounded-app-sm border border-border-subtle bg-surface-2 px-1.5 py-1 text-meta text-text-primary"
      >
        <option value="" disabled>
          Default
        </option>
        {AUTO_RESUME_SELECT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** TASK-T5 (CRD-1): business details for the currently-connected contact. Every row is omitted
 *  individually when its own field is null -- "graceful when missing" per the task's own spec,
 *  never a placeholder "N/A" row. Renders nothing (not even the card) if every field is null. */
function ContactDetailsPanel({ contact }: { contact: ConnectedContactDetails }) {
  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  if (contact.rating !== null) {
    rows.push({
      label: 'Rating',
      value: `${contact.rating.toFixed(1)}${contact.reviewCount !== null ? ` (${contact.reviewCount} reviews)` : ''}`,
    });
  }
  if (contact.ownerContact) rows.push({ label: 'Owner/contact', value: contact.ownerContact });
  if (contact.licenseNumber) rows.push({ label: 'License #', value: contact.licenseNumber });
  if (contact.serviceZips) rows.push({ label: 'Service ZIPs', value: contact.serviceZips });
  if (contact.tier) rows.push({ label: 'Tier', value: contact.tier });
  if (contact.website) {
    rows.push({
      label: 'Website',
      value: (
        <a
          href={contact.website}
          target="_blank"
          rel="noreferrer"
          className="text-accent-to hover:underline"
        >
          {contact.website}
        </a>
      ),
    });
  }
  if (rows.length === 0) return null;

  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
      <h4 className="text-meta text-text-secondary mb-2">Business details</h4>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-body">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-2 sm:block">
            <dt className="text-text-muted">{row.label}</dt>
            <dd className="text-text-primary sm:mt-0.5">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatHistoryDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** TASK-T5 (CRD-3): up to 3 past attempts at the connected contact, most recent first --
 *  recording playback is on-click (a past leg's recording either already exists or it doesn't,
 *  no "still processing" window to wait out), same pattern as WrapUpModal's own
 *  DispositionHistory/RecordingButton. */
function ContactHistoryPanel({ history }: { history: ContactHistoryEntry[] }) {
  const [playingLegId, setPlayingLegId] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<{ legId: string; url: string } | null>(null);

  const handlePlay = async (legId: string) => {
    setPlayError(null);
    setPlayingLegId(legId);
    try {
      const result = await getRecordingUrl(legId);
      setRecordingUrl({ legId, url: result.url });
    } catch (e) {
      setPlayError(e instanceof Error ? e.message : 'Recording not available');
    } finally {
      setPlayingLegId(null);
    }
  };

  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
      <h4 className="text-meta text-text-secondary mb-2">Previous attempts</h4>
      <div className="space-y-2">
        {history.map((entry) => {
          const duration = formatHistoryDuration(entry.durationSeconds);
          return (
            <div
              key={entry.legId}
              className="rounded-app-md border border-border-subtle bg-surface-2 px-3 py-2 text-body"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-text-primary">
                <span className="font-medium">
                  {entry.dispositionLabel ?? entry.outcome ?? 'No outcome'}
                  {entry.isVoicemail && (
                    <span className="ml-1.5 text-meta text-warning">Voicemail left</span>
                  )}
                  {entry.callbackAt && (
                    <span className="ml-1.5 text-meta text-accent-to">Callback set</span>
                  )}
                </span>
                <span className="text-meta text-text-muted whitespace-nowrap">
                  {new Date(entry.createdAt).toLocaleDateString()}
                  {duration ? ` · ${duration}` : ''}
                </span>
              </div>
              {entry.notes && <p className="text-meta text-text-secondary mt-1">{entry.notes}</p>}
              {entry.hasRecording && (
                <div className="mt-1.5">
                  {recordingUrl?.legId === entry.legId ? (
                    <audio controls src={recordingUrl.url} className="w-full h-8">
                      <track kind="captions" />
                    </audio>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handlePlay(entry.legId)}
                      disabled={playingLegId === entry.legId}
                      className="flex items-center gap-1 text-meta text-accent-to hover:underline disabled:opacity-50"
                    >
                      <Play className="w-3 h-3" />
                      {playingLegId === entry.legId ? 'Loading…' : 'Play recording'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {playError && <p className="text-xs text-danger mt-1">{playError}</p>}
    </div>
  );
}

/** TASK-T5 (CRD-4, card-side): collapsible so it doesn't compete for space with the live call
 *  controls above -- closed by default, same "not mandatory to look at" spirit as the admin-side
 *  editor (CampaignManageModal) it mirrors. Live refetch on change comes for free from the same
 *  3s poll that already refreshes everything else on this screen. */
function CampaignScriptPanel({ script }: { script: CampaignScriptInfo }) {
  return (
    <details className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
      <summary className="text-meta text-text-secondary cursor-pointer select-none">
        Call script &amp; objections
      </summary>
      <div className="mt-3 space-y-3 text-body">
        {script.scriptText && (
          <div>
            <h4 className="text-meta text-text-muted mb-1">Script</h4>
            <p className="text-text-primary whitespace-pre-wrap">{script.scriptText}</p>
          </div>
        )}
        {script.objectionSheetText && (
          <div>
            <h4 className="text-meta text-text-muted mb-1">Objection sheet</h4>
            <p className="text-text-primary whitespace-pre-wrap">{script.objectionSheetText}</p>
          </div>
        )}
      </div>
    </details>
  );
}
