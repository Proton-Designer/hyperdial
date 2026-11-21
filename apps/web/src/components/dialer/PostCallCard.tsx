import { useEffect, useState } from 'react';
import { PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  listDispositions,
  lookupContactByPhone,
  setManualCallOutcome,
  type Disposition,
} from '@/lib/api';
import { contactHeadline } from '@/lib/contactName';
import { isViewOnly } from '@/lib/viewAs';
import { LogCloseModal } from './LogCloseModal';
import { Chip } from './closeFormParts';

export interface PostCall {
  id: string;
  number: string;
  direction: 'outbound' | 'inbound';
  /** TASK-H27: resolves to the server log id of this call (recording retries quietly; rejects after the last attempt). */
  recorded: Promise<string>;
  /** One more attempt to record the same call (same client key, so it can never be written twice). */
  retryRecord: () => Promise<string>;
}

interface Match {
  contactId: string | null;
  name: string;
}

/**
 * TASK-H24: after a connected call outside a dial session (manual dial, or an inbound call answered from the banner)
 * there is no wrap-up window, so this card is the only place to "Log close". It stays until dismissed, lives in the
 * permanently mounted Dialer (so a tab switch does not lose it) and never blocks the next dial. The close is saved by
 * phone number: the server finds the org contact or creates it from the form.
 */
export function PostCallCard({ call, onDismiss }: { call: PostCall; onDismiss: () => void }) {
  const [match, setMatch] = useState<Match | null | 'loading'>('loading');
  const [logging, setLogging] = useState(false);
  const [saved, setSaved] = useState(false);

  // TASK-H27: outcome + notes for this call.
  const [dispositions, setDispositions] = useState<Disposition[] | null | 'error'>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOutcome, setSavedOutcome] = useState<{ label: string | null; dnc: boolean } | null>(
    null
  );
  const [recordedPromise, setRecordedPromise] = useState(call.recorded);

  useEffect(() => {
    let cancelled = false;
    listDispositions()
      .then((d) => !cancelled && setDispositions(d.filter((x) => x.active)))
      .catch(() => !cancelled && setDispositions('error'));
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = picked !== null || notes.trim() !== '';
  const saveOutcome = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      let id: string;
      try {
        id = await recordedPromise;
      } catch {
        // The quiet retries failed; one more try now that the agent asked for something.
        const next = call.retryRecord();
        setRecordedPromise(next);
        id = await next;
      }
      const res = await setManualCallOutcome(id, picked, notes.trim() || null);
      const label =
        dispositions && dispositions !== 'error'
          ? (dispositions.find((d) => d.key === res.dispositionKey)?.label ?? null)
          : null;
      setSavedOutcome({ label, dnc: res.effect === 'dnc' });
      setPicked(null);
      setNotes('');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save the outcome');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    lookupContactByPhone(call.number)
      .then((c) => {
        if (cancelled) return;
        setMatch(
          c
            ? {
                contactId: c.id,
                name: contactHeadline({
                  business_name: c.business_name,
                  first_name: c.first_name,
                  last_name: c.last_name,
                }),
              }
            : null
        );
      })
      .catch(() => !cancelled && setMatch(null));
    return () => {
      cancelled = true;
    };
  }, [call.number]);

  const known = match !== 'loading' && match !== null ? match : null;
  const Icon = call.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;

  return (
    <div
      className="max-w-2xl mx-auto mb-4 rounded-app-lg border border-accent-to/30 bg-surface-1 p-4 flex flex-wrap items-center gap-3"
      role="status"
    >
      <Icon className="w-5 h-5 text-accent-to shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-body text-text-primary font-medium truncate">
          {call.direction === 'inbound' ? 'Call from' : 'Call to'} {call.number} ended
        </p>
        <p className="text-meta text-text-muted truncate">
          {match === 'loading'
            ? 'Looking up contact…'
            : known
              ? known.name === '—'
                ? 'Contact with no name'
                : known.name
              : 'Not in your contacts'}
        </p>
      </div>
      {saved ? (
        <span className="text-meta text-success">Close logged</span>
      ) : (
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={isViewOnly || match === 'loading'}
          title={isViewOnly ? 'View-only' : undefined}
          onClick={() => setLogging(true)}
        >
          Log close
        </Button>
      )}
      <Button type="button" variant="fe-secondary" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
      {/* TASK-H27: how did the call go. Dispositions that need more than a click (license, zips: "Yes - Build Profile")
          are not recorded here; they open Log close, which collects the details. */}
      <div className="basis-full space-y-2">
        <div className="text-meta text-text-secondary">How did it go?</div>
        {dispositions === null && (
          <p className="text-meta text-text-muted" role="status">
            Loading outcomes…
          </p>
        )}
        {dispositions === 'error' && (
          <p className="text-meta text-text-muted">
            Outcomes are not available right now. You can still add a note.
          </p>
        )}
        {Array.isArray(dispositions) && (
          <div className="flex flex-wrap gap-2">
            {dispositions.map((d) => {
              const needsDetails = (d.required_fields?.length ?? 0) > 0;
              return needsDetails ? (
                <button
                  key={d.id}
                  type="button"
                  disabled={isViewOnly || match === 'loading'}
                  title="Opens Log close to collect the details"
                  onClick={() => setLogging(true)}
                  className="px-3 py-1.5 rounded-full text-body border border-dashed border-accent-to/60 text-text-primary hover:bg-accent-to/10 disabled:opacity-50"
                >
                  {d.label}
                </button>
              ) : (
                <Chip
                  key={d.id}
                  selected={picked === d.key}
                  onClick={() => setPicked(picked === d.key ? null : d.key)}
                >
                  {d.label}
                </Chip>
              );
            })}
          </div>
        )}
        <textarea
          aria-label="Call notes"
          className="w-full rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-body text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to resize-none"
          rows={2}
          maxLength={2000}
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {saveError && (
          <p role="alert" className="text-meta text-danger">
            {saveError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="fe-secondary"
            size="sm"
            onClick={() => void saveOutcome()}
            disabled={!dirty || saving}
          >
            {saving ? 'Saving…' : savedOutcome ? 'Save change' : 'Save'}
          </Button>
          {savedOutcome && (
            <span className="text-meta text-success" role="status">
              Saved{savedOutcome.label ? `: ${savedOutcome.label}` : ''}
              {savedOutcome.dnc ? ' · number marked Do Not Call' : ''}
            </span>
          )}
        </div>
      </div>
      {logging && (
        <LogCloseModal
          draftKey={`postcall:${call.id}`}
          byPhone
          contactId={known?.contactId ?? undefined}
          name={known ? (known.name === '—' ? call.number : known.name) : ''}
          phone={call.number}
          onSaved={() => setSaved(true)}
          onClose={() => setLogging(false)}
        />
      )}
    </div>
  );
}
