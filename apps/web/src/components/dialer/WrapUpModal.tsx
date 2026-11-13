import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play } from 'lucide-react';
import {
  listDispositions,
  submitDisposition,
  getRecordingUrl,
  listContactDispositionHistory,
  type Disposition,
  type SubmitDispositionResult,
  type ContactDispositionHistoryEntry,
  type TopObjection,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { LogCloseModal } from './LogCloseModal';
import { OBJECTION_LABEL, OBJECTION_ORDER } from '@/components/shifts/clockModel';

/** TASK-F-T2 (REC-5): the recording may still be processing when this modal opens (the
 *  call.recording.saved webhook lands seconds after hangup, independently of this modal's own
 *  lifecycle) -- polls lightly rather than blocking wrap-up on it. Stops polling once found, on
 *  unmount, or after a few minutes (a leg with recording disabled/failed would otherwise poll
 *  forever for nothing). */
const RECORDING_POLL_MS = 5000;
const RECORDING_POLL_MAX_ATTEMPTS = 36; // ~3 minutes

function RecordingButton({ legId }: { legId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const check = () => {
      getRecordingUrl(legId)
        .then((result) => {
          if (cancelled) return;
          setUrl(result.url);
          setChecking(false);
        })
        .catch(() => {
          if (cancelled) return;
          attempts++;
          if (attempts >= RECORDING_POLL_MAX_ATTEMPTS) {
            setChecking(false);
            return;
          }
          timer = setTimeout(check, RECORDING_POLL_MS);
        });
    };
    let timer = setTimeout(check, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [legId]);

  if (url) {
    return (
      <audio controls src={url} className="w-full h-8">
        <track kind="captions" />
      </audio>
    );
  }
  if (checking) {
    return <p className="text-xs text-text-muted">Recording processing…</p>;
  }
  return null;
}

const NOTES_MAX_LENGTH = 500;
/** Only digits 1-9 get a shortcut; a catalog with more active dispositions than that is an
 * org-configuration problem (Settings' editor), not something this component should special-case
 * beyond rendering the extras as plain (unshortcut-able) buttons. */
const MAX_SHORTCUT_DISPOSITIONS = 9;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface WrapUpModalProps {
  sessionId: string;
  legId: string;
  contact: { id: string | null; name: string; phone: string };
  callDurationSeconds?: number;
  onSubmitted: (result: SubmitDispositionResult) => void;
  /** Test/dev-only overrides (default to the real api.ts calls) -- lets the dev fixture harness
   * (apps/web/src/dev/WrapUpModalHarness.tsx) render this against fixture data with no live
   * session, DB, or edge function, instead of monkeypatching the network layer. L2b's real
   * integration never passes these. */
  loadDispositions?: typeof listDispositions;
  submitWrapUp?: typeof submitDisposition;
  loadHistory?: typeof listContactDispositionHistory;
}

/** DSP-9: the last 3 dispositions for this contact, across every agent. Recording playback is
 * on-click, not auto-polled like the CURRENT call's RecordingButton -- a historical leg's
 * recording either already exists or it doesn't (no "still processing" window to wait out). */
function DispositionHistory({
  contactId,
  loadHistory = listContactDispositionHistory,
}: {
  contactId: string;
  loadHistory?: typeof listContactDispositionHistory;
}) {
  const [entries, setEntries] = useState<ContactDispositionHistoryEntry[] | null>(null);
  const [playingLegId, setPlayingLegId] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<{ legId: string; url: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadHistory(contactId)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId, loadHistory]);

  if (!entries || entries.length === 0) return null;

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
    <div>
      <div className="block text-meta text-text-secondary mb-2">Previous calls</div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div
            key={entry.leg_id}
            className="rounded-app-md border border-border-subtle bg-surface-2 px-3 py-2 text-body"
          >
            <div className="flex items-center justify-between gap-2 text-text-primary">
              <span className="font-medium">{entry.disposition_label ?? 'No disposition'}</span>
              <span className="text-meta text-text-muted whitespace-nowrap">
                {new Date(entry.dispositioned_at).toLocaleDateString()} ·{' '}
                {entry.agent_name || 'Agent'}
              </span>
            </div>
            {entry.notes && <p className="text-meta text-text-secondary mt-1">{entry.notes}</p>}
            {entry.has_recording && (
              <div className="mt-1.5">
                {recordingUrl?.legId === entry.leg_id ? (
                  <audio controls src={recordingUrl.url} className="w-full h-8">
                    <track kind="captions" />
                  </audio>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handlePlay(entry.leg_id)}
                    disabled={playingLegId === entry.leg_id}
                    className="flex items-center gap-1 text-meta text-accent-to hover:underline disabled:opacity-50"
                  >
                    <Play className="w-3 h-3" />
                    {playingLegId === entry.leg_id ? 'Loading…' : 'Play recording'}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {playError && <p className="text-xs text-danger mt-1">{playError}</p>}
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** `datetime-local`'s value has no timezone -- the browser interprets it in the viewer's own
 * local zone, which is exactly "the intern's local time shown" the spec asks for. Converting via
 * `new Date(value)` therefore already produces the right instant; `.toISOString()` turns that
 * into the UTC ISO string the API wants. */
function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Minimum value for the `datetime-local` input's `min` attribute -- "future time only". Rounded
 * down to the minute since that's the input's own granularity; a callback for "right now" would
 * round to a past minute and get rejected by the future-only check below, which is the correct,
 * stricter behavior (the spec says future, not "now or later"). */
function nowAsDateTimeLocalMin(): string {
  const d = new Date(Date.now() + 60_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Any element that consumes typed characters itself (so digit/Enter shortcuts must not hijack
 * it) -- not just the notes textarea. Review finding (TASK-L2a fix pass): pressing "1" while the
 * callback datetime-local input was focused re-picked disposition #1 out from under the user. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement
  ) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null
  );
}

export function WrapUpModal({
  sessionId,
  legId,
  contact,
  callDurationSeconds,
  onSubmitted,
  loadDispositions = listDispositions,
  submitWrapUp = submitDisposition,
  loadHistory = listContactDispositionHistory,
}: WrapUpModalProps) {
  const [dispositions, setDispositions] = useState<Disposition[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [callbackLocal, setCallbackLocal] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [zipsRaw, setZipsRaw] = useState('');
  const [topObjection, setTopObjection] = useState<TopObjection | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  // TASK-H03: the Log Close form opens over this modal; while it is open this modal's own keyboard shortcuts
  // (Tab trap, Enter-submit, digit picks) must stand down, or typing in the form would drive the disposition.
  const [showLogClose, setShowLogClose] = useState(false);
  const logCloseOpenRef = useRef(false);
  logCloseOpenRef.current = showLogClose;
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const firstDispositionRef = useRef<HTMLButtonElement>(null);
  const minCallback = useMemo(() => nowAsDateTimeLocalMin(), []);

  useEffect(() => {
    let cancelled = false;
    loadDispositions()
      .then((all) => {
        if (cancelled) return;
        setDispositions(all.filter((d) => d.active));
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Failed to load dispositions');
      });
    return () => {
      cancelled = true;
    };
    // loadDispositions is intentionally not a dep: it's either the stable module-level default
    // or a fixture the harness passes once. Re-fetching on sessionId/legId change (a new call to
    // wrap up) is the actual intent here.
  }, [sessionId, legId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autofocus (review finding, MAJOR): move focus into the modal as soon as there's something
  // focusable in it, so a keyboard user never has to Tab in from wherever focus happened to be
  // (which, once L2b wires this in, could be a control behind the modal).
  useEffect(() => {
    if (dispositions && dispositions.length > 0) {
      firstDispositionRef.current?.focus();
    } else {
      modalRef.current?.focus();
    }
  }, [dispositions]);

  const selected = dispositions?.find((d) => d.key === selectedKey) ?? null;
  const needsCallback = selected?.lead_effect === 'callback';
  const callbackIso = needsCallback ? localDateTimeToIso(callbackLocal) : null;
  // TASK-H09: the time is optional. Left empty, the backend reschedules the lead by the campaign's retry rule; a time that
  // is entered must still be in the future. A disposition that lists 'callback_at' in required_fields still needs one.
  const callbackRequired = selected?.required_fields?.includes('callback_at') ?? false;
  const callbackValid =
    !needsCallback ||
    (callbackLocal.trim() === ''
      ? !callbackRequired
      : callbackIso !== null && new Date(callbackIso) > new Date());

  // DSP-4: a generic per-disposition required_fields check, client-side (the RPC re-checks this
  // server-side regardless -- see the migration's own comment on why). Only two field names are
  // actually wired up to a real input below: 'license_number' and 'zips'.
  const requiredFields = selected?.required_fields ?? null;
  const needsLicenseNumber = requiredFields?.includes('license_number') ?? false;
  const needsZips = requiredFields?.includes('zips') ?? false;
  const zipsList = zipsRaw
    .split(',')
    .map((z) => z.trim())
    .filter(Boolean);
  const requiredFieldsValid =
    (!needsLicenseNumber || licenseNumber.trim().length > 0) && (!needsZips || zipsList.length > 0);

  const canSubmit = selected !== null && callbackValid && requiredFieldsValid && !submitting;

  const handleSubmit = async () => {
    if (!selected || submitting) return;
    // Re-check at submit time, not just at whatever render last computed `callbackValid` (review
    // finding, MINOR): a callback time that was valid when picked can become past while the form
    // just sits there with no other state change to trigger a re-render.
    let freshCallbackIso: string | undefined;
    if (needsCallback && (callbackLocal.trim() !== '' || callbackRequired)) {
      const iso = localDateTimeToIso(callbackLocal);
      if (!iso || new Date(iso) <= new Date()) {
        setSubmitError('Callback time must be in the future.');
        return;
      }
      freshCallbackIso = iso;
    }
    if (needsLicenseNumber && !licenseNumber.trim()) {
      setSubmitError('License number is required for this disposition.');
      return;
    }
    if (needsZips && zipsList.length === 0) {
      setSubmitError('At least one ZIP code is required for this disposition.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitWrapUp({
        legId,
        dispositionKey: selected.key,
        notes: notes.trim() || undefined,
        callbackAt: freshCallbackIso,
        licenseNumber: needsLicenseNumber ? licenseNumber.trim() : undefined,
        zips: needsZips ? zipsList : undefined,
        topObjection: topObjection || undefined,
      });
      onSubmitted(result);
      // Deliberately do not reset local state here: the parent unmounts this component once
      // onSubmitted fires (per L2b's session-state machine), so there is no "next open" of this
      // same instance to reset for.
    } catch (e) {
      // Keep every field as-is so the intern doesn't retype anything (spec: "keep the form
      // contents for retry").
      setSubmitError(e instanceof Error ? e.message : 'Failed to submit disposition');
      setSubmitting(false);
    }
  };

  // Keyboard: 1-9 pick a disposition, Enter submits -- except while ANY typing target (notes
  // textarea, the callback datetime input, or any other future form control) has focus, where
  // keys must behave normally and only Cmd/Ctrl+Enter submits. Fixes a review-found blocker:
  // digit shortcuts were previously only suppressed inside the notes textarea, so typing "1" into
  // the callback date/time input re-picked disposition #1 out from under the user instead of
  // typing a "1". Tab/Shift+Tab are trapped inside the modal (focus never leaves it) since this
  // component has no close/cancel path and must not let a keyboard user tab to whatever is behind
  // it once L2b mounts this inside the real dialer screen. Escape and any other key are
  // deliberately no-ops: this modal has no close/cancel path.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (logCloseOpenRef.current) return;
      const active = document.activeElement;
      const typing = isTypingTarget(active);

      if (e.key === 'Tab') {
        const root = modalRef.current;
        if (!root) return;
        const focusable = getFocusable(root);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!active || !root.contains(active)) {
          e.preventDefault();
          first.focus();
          return;
        }
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }

      if (e.key === 'Enter') {
        if (typing && !(e.metaKey || e.ctrlKey)) return; // let it type/insert normally
        e.preventDefault();
        void handleSubmit();
        return;
      }

      if (typing) return; // every other key behaves normally in whatever field has focus

      if (/^[1-9]$/.test(e.key) && dispositions) {
        const index = Number(e.key) - 1;
        if (index < Math.min(dispositions.length, MAX_SHORTCUT_DISPOSITIONS)) {
          e.preventDefault();
          setSelectedKey(dispositions[index].key);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // handleSubmit itself is intentionally not a dep: it's redefined every render from the same
    // state already listed below, so listing it too would just be redundant, not more correct.
  }, [
    dispositions,
    selected,
    notes,
    callbackLocal,
    submitting,
    needsCallback,
    callbackIso,
    licenseNumber,
    zipsRaw,
    topObjection,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div
      ref={modalRef}
      className="hd-touch hd-vv fixed inset-0 flex items-center justify-center p-4 outline-none"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wrapup-title"
      tabIndex={-1}
    >
      {/* No onClick here on purpose: a backdrop click must do nothing (unskippable). */}
      <div className="absolute inset-0 bg-black/70" aria-hidden="true" />
      <div className="relative z-[1] flex max-h-[min(calc(100dvh-1rem),100%)] w-full max-w-lg flex-col rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md">
        <div className="border-b border-border-subtle p-4">
          <h2 id="wrapup-title" className="text-page-title text-text-primary">
            Wrap up the call
          </h2>
          <p className="text-body text-text-secondary mt-1">
            {contact.name || 'Unknown contact'} · {contact.phone}
            {typeof callDurationSeconds === 'number' && (
              <> · {formatDuration(callDurationSeconds)}</>
            )}
          </p>
          {contact.id && (
            <Button
              type="button"
              variant="fe-secondary"
              size="sm"
              className="mt-3"
              onClick={() => setShowLogClose(true)}
            >
              Log close
            </Button>
          )}
        </div>

        <div className="p-4 space-y-4 min-h-0 flex-1 overflow-y-auto md:max-h-[70vh]">
          {submitError && (
            <div className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3">
              {submitError}
            </div>
          )}
          {loadError && (
            <div className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3">
              Could not load dispositions: {loadError}
            </div>
          )}

          {!dispositions && !loadError && (
            <div className="text-body text-text-secondary">Loading dispositions…</div>
          )}

          <RecordingButton legId={legId} />

          {contact.id && <DispositionHistory contactId={contact.id} loadHistory={loadHistory} />}

          {dispositions && (
            <div>
              <div
                id="disposition-group-label"
                className="block text-meta text-text-secondary mb-2"
              >
                Disposition
              </div>
              <div
                role="group"
                aria-labelledby="disposition-group-label"
                className="grid grid-cols-1 gap-2"
              >
                {dispositions.map((d, i) => {
                  const shortcut = i < MAX_SHORTCUT_DISPOSITIONS ? i + 1 : null;
                  const isSelected = d.key === selectedKey;
                  return (
                    <button
                      key={d.id}
                      ref={i === 0 ? firstDispositionRef : undefined}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedKey(d.key)}
                      className={`w-full flex items-center gap-3 rounded-app-md border px-4 py-3 text-left transition-colors ${
                        isSelected
                          ? 'border-accent-to bg-accent-to/10 text-text-primary'
                          : 'border-border-subtle bg-surface-2 text-text-secondary hover:border-border-strong hover:text-text-primary'
                      }`}
                    >
                      {shortcut !== null && (
                        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-app-sm bg-white/10 text-xs font-semibold text-text-primary">
                          {shortcut}
                        </span>
                      )}
                      <span>{d.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {needsCallback && (
            <div>
              <label htmlFor="wrapup-callback" className="block text-meta text-text-secondary mb-1">
                Callback time ({callbackRequired ? 'required' : 'optional'})
              </label>
              <input
                id="wrapup-callback"
                type="datetime-local"
                value={callbackLocal}
                min={minCallback}
                onChange={(e) => setCallbackLocal(e.target.value)}
                className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-3 text-text-primary focus:outline-none focus:border-accent-to"
              />
              {callbackLocal && !callbackValid && (
                <p className="text-xs text-danger mt-1">Callback time must be in the future.</p>
              )}
              {!callbackLocal && !callbackRequired && (
                <p className="text-xs text-text-secondary mt-1">
                  No time? The lead comes back on the campaign&apos;s retry schedule.
                </p>
              )}
            </div>
          )}

          {needsLicenseNumber && (
            <div>
              <label htmlFor="wrapup-license" className="block text-meta text-text-secondary mb-1">
                License number (required)
              </label>
              <input
                id="wrapup-license"
                type="text"
                value={licenseNumber}
                onChange={(e) => setLicenseNumber(e.target.value)}
                className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-3 text-text-primary focus:outline-none focus:border-accent-to"
                placeholder="e.g. TX-LIC-12345"
              />
            </div>
          )}

          {needsZips && (
            <div>
              <label htmlFor="wrapup-zips" className="block text-meta text-text-secondary mb-1">
                ZIP codes served (required)
              </label>
              <input
                id="wrapup-zips"
                type="text"
                value={zipsRaw}
                onChange={(e) => setZipsRaw(e.target.value)}
                className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-3 text-text-primary focus:outline-none focus:border-accent-to"
                placeholder="e.g. 78701, 78702"
              />
              <p className="text-xs text-text-muted mt-1">Comma-separated.</p>
            </div>
          )}

          <div>
            <label htmlFor="wrapup-objection" className="block text-meta text-text-secondary mb-1">
              Top objection (optional)
            </label>
            <select
              id="wrapup-objection"
              value={topObjection}
              onChange={(e) => setTopObjection(e.target.value as TopObjection | '')}
              className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-3 text-text-primary focus:outline-none focus:border-accent-to"
            >
              <option value="">None / not raised</option>
              {OBJECTION_ORDER.map((k) => (
                <option key={k} value={k}>
                  {OBJECTION_LABEL[k]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="wrapup-notes" className="block text-meta text-text-secondary">
                Notes
              </label>
              <span className="text-xs text-text-muted">
                {notes.length}/{NOTES_MAX_LENGTH}
              </span>
            </div>
            <textarea
              id="wrapup-notes"
              ref={notesRef}
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, NOTES_MAX_LENGTH))}
              maxLength={NOTES_MAX_LENGTH}
              rows={4}
              placeholder="Quick notes for this call..."
              className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-3 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to resize-none"
            />
          </div>
        </div>

        <div className="border-t border-border-subtle p-4">
          <Button
            type="button"
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="w-full"
          >
            {submitting ? 'Submitting…' : 'Submit (Enter)'}
          </Button>
          <p className="text-xs text-text-muted mt-2 text-center">
            Press 1-9 to pick a disposition, Enter to submit. This call must be dispositioned before
            the next batch dials.
          </p>
        </div>
      </div>
      {showLogClose && contact.id && (
        <LogCloseModal
          draftKey={legId}
          contactId={contact.id}
          name={contact.name}
          phone={contact.phone}
          onClose={() => setShowLogClose(false)}
        />
      )}
    </div>,
    document.body
  );
}
