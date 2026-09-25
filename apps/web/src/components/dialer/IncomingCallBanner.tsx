import { PhoneIncoming } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * TASK-I1 (INB-2): a `pendingInboundCall` from useTelnyxCall.ts is neither auto-answered nor
 * auto-rejected -- this is the human's Answer/Decline. Rendered unconditionally in Dialer.tsx
 * (not gated on `isParallelMode`/an active session), since the whole point of INB-2 is ringing
 * an intern who is online but NOT mid-batch -- the ordinary DialerStateBanner only ever renders
 * once a parallel session exists.
 *
 * Review fix (eng1 review-eng1.md finding #6): INB-2's own requirement is "the contact card up
 * (matched by the caller's E.164; show 'Unknown caller' + the number otherwise)" -- the
 * original version only ever showed the bare phone number, with "Unknown caller" reachable only
 * for a literally-null `fromE164`, never for "didn't match a contact." `contactName` is now
 * resolved by the caller (Dialer.tsx, via `lookupContactByPhone`) and passed in explicitly;
 * this component just renders whichever of the two is available, matching the requirement's own
 * exact fallback wording.
 */
interface IncomingCallBannerProps {
  fromE164: string | null;
  /** Resolved contact display name, or null if no match (or the lookup hasn't finished/failed
   *  -- either way, falls back to "Unknown caller" below, never left blank). */
  contactName: string | null;
  onAnswer: () => void;
  onDecline: () => void;
}

export function IncomingCallBanner({
  fromE164,
  contactName,
  onAnswer,
  onDecline,
}: IncomingCallBannerProps) {
  return (
    <div className="max-w-2xl mx-auto rounded-app-lg border border-accent-to/30 bg-accent-to/10 p-4 mb-6 flex items-center gap-3">
      <div className="text-accent-to">
        <PhoneIncoming className="w-5 h-5 animate-pulse" />
      </div>
      <div className="flex-1">
        <p className="font-medium text-text-primary">{contactName ?? 'Unknown caller'}</p>
        <p className="text-body text-text-secondary mt-0.5">{fromE164 ?? 'Unknown number'}</p>
      </div>
      <Button variant="danger-ghost" onClick={onDecline}>
        Decline
      </Button>
      <Button variant="primary" onClick={onAnswer}>
        Answer
      </Button>
    </div>
  );
}
