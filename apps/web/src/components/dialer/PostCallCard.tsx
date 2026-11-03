import { useEffect, useState } from 'react';
import { PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { lookupContactByPhone } from '@/lib/api';
import { contactHeadline } from '@/lib/contactName';
import { isViewOnly } from '@/lib/viewAs';
import { LogCloseModal } from './LogCloseModal';

export interface PostCall {
  id: string;
  number: string;
  direction: 'outbound' | 'inbound';
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
      {logging && (
        <LogCloseModal
          draftKey={`postcall:${call.id}`}
          byPhone
          contactId={known?.contactId ?? undefined}
          name={known && known.name !== '—' ? known.name : ''}
          phone={call.number}
          onSaved={() => setSaved(true)}
          onClose={() => setLogging(false)}
        />
      )}
    </div>
  );
}
