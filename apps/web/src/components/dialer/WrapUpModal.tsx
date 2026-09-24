import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listDispositions,
  submitDisposition,
  type Disposition,
  type SubmitDispositionResult,
} from '@/lib/api';

const NOTES_MAX_LENGTH = 500;
/** Only digits 1-9 get a shortcut; a catalog with more active dispositions than that is an
 * org-configuration problem (Settings' editor), not something this component should special-case
 * beyond rendering the extras as plain (unshortcut-able) buttons. */
const MAX_SHORTCUT_DISPOSITIONS = 9;

export interface WrapUpModalProps {
  sessionId: string;
  legId: string;
  contact: { name: string; phone: string };
  callDurationSeconds?: number;
  onSubmitted: (result: SubmitDispositionResult) => void;
  /** Test/dev-only overrides (default to the real api.ts calls) -- lets the dev fixture harness
   * (apps/web/src/dev/WrapUpModalHarness.tsx) render this against fixture data with no live
   * session, DB, or edge function, instead of monkeypatching the network layer. L2b's real
   * integration never passes these. */
  loadDispositions?: typeof listDispositions;
  submitWrapUp?: typeof submitDisposition;
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

export function WrapUpModal({
  sessionId,
  legId,
  contact,
  callDurationSeconds,
  onSubmitted,
  loadDispositions = listDispositions,
  submitWrapUp = submitDisposition,
}: WrapUpModalProps) {
  const [dispositions, setDispositions] = useState<Disposition[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [callbackLocal, setCallbackLocal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const notesRef = useRef<HTMLTextAreaElement>(null);
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

  const selected = dispositions?.find((d) => d.key === selectedKey) ?? null;
  const needsCallback = selected?.lead_effect === 'callback';
  const callbackIso = needsCallback ? localDateTimeToIso(callbackLocal) : null;
  const callbackValid =
    !needsCallback || (callbackIso !== null && new Date(callbackIso) > new Date());
  const canSubmit = selected !== null && callbackValid && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || !selected) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitWrapUp({
        legId,
        dispositionKey: selected.key,
        notes: notes.trim() || undefined,
        callbackAt: needsCallback ? (callbackIso ?? undefined) : undefined,
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

  // Keyboard: 1-9 pick a disposition, Enter submits -- except while the notes textarea has
  // focus, where digits must type normally and only Cmd/Ctrl+Enter submits (a plain Enter in a
  // textarea should insert a newline, matching every other multi-line input in this app).
  // Escape and any other key are deliberately no-ops: this modal has no close/cancel path.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inNotes = document.activeElement === notesRef.current;

      if (e.key === 'Enter') {
        if (inNotes && !(e.metaKey || e.ctrlKey)) return; // let it insert a newline
        e.preventDefault();
        void handleSubmit();
        return;
      }

      if (inNotes) return; // every other key types into notes normally

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
  }, [dispositions, selected, notes, callbackLocal, submitting, needsCallback, callbackIso]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-label="Call wrap-up"
    >
      {/* No onClick here on purpose: a backdrop click must do nothing (unskippable). */}
      <div className="absolute inset-0 bg-black/70" aria-hidden="true" />
      <div className="relative z-[1] w-full max-w-lg rounded-2xl border border-white/10 bg-[#1A2332] shadow-xl">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-xl font-bold text-white">Wrap up the call</h2>
          <p className="text-sm text-[#B0BEC5] mt-1">
            {contact.name || 'Unknown contact'} · {contact.phone}
            {typeof callDurationSeconds === 'number' && (
              <> · {formatDuration(callDurationSeconds)}</>
            )}
          </p>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {submitError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm p-3">
              {submitError}
            </div>
          )}
          {loadError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm p-3">
              Could not load dispositions: {loadError}
            </div>
          )}

          {!dispositions && !loadError && (
            <div className="text-sm text-[#B0BEC5]">Loading dispositions…</div>
          )}

          {dispositions && (
            <div>
              <label className="block text-sm text-[#B0BEC5] mb-2">Disposition</label>
              <div className="grid grid-cols-1 gap-2">
                {dispositions.map((d, i) => {
                  const shortcut = i < MAX_SHORTCUT_DISPOSITIONS ? i + 1 : null;
                  const isSelected = d.key === selectedKey;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setSelectedKey(d.key)}
                      className={`w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                        isSelected
                          ? 'border-[#00D9FF] bg-[#00D9FF]/10 text-white'
                          : 'border-white/10 bg-[#1E2A3A] text-[#B0BEC5] hover:border-white/30 hover:text-white'
                      }`}
                    >
                      {shortcut !== null && (
                        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-white/10 text-xs font-semibold text-white">
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
              <label className="block text-sm text-[#B0BEC5] mb-1">Callback time (required)</label>
              <input
                type="datetime-local"
                value={callbackLocal}
                min={minCallback}
                onChange={(e) => setCallbackLocal(e.target.value)}
                className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#00D9FF]"
              />
              {callbackLocal && !callbackValid && (
                <p className="text-xs text-red-400 mt-1">Callback time must be in the future.</p>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm text-[#B0BEC5]">Notes</label>
              <span className="text-xs text-[#B0BEC5]/70">
                {notes.length}/{NOTES_MAX_LENGTH}
              </span>
            </div>
            <textarea
              ref={notesRef}
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, NOTES_MAX_LENGTH))}
              maxLength={NOTES_MAX_LENGTH}
              rows={4}
              placeholder="Quick notes for this call..."
              className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF] resize-none"
            />
          </div>
        </div>

        <div className="border-t border-white/10 p-4">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="w-full rounded-xl bg-[#0066FF] px-4 py-3 font-semibold text-white transition-colors hover:bg-[#0066FF]/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Submitting…' : 'Submit (Enter)'}
          </button>
          <p className="text-xs text-[#B0BEC5]/70 mt-2 text-center">
            Press 1-9 to pick a disposition, Enter to submit. This call must be dispositioned before
            the next batch dials.
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}
