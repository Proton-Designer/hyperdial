import { PhoneIncoming } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * TASK-I1 (INB-2): a `pendingInboundCall` from useTelnyxCall.ts is neither auto-answered nor
 * auto-rejected -- this is the human's Answer/Decline. Rendered unconditionally in Dialer.tsx
 * (not gated on `isParallelMode`/an active session), since the whole point of INB-2 is ringing
 * an intern who is online but NOT mid-batch -- the ordinary DialerStateBanner only ever renders
 * once a parallel session exists.
 */
interface IncomingCallBannerProps {
  fromE164: string | null;
  onAnswer: () => void;
  onDecline: () => void;
}

export function IncomingCallBanner({ fromE164, onAnswer, onDecline }: IncomingCallBannerProps) {
  return (
    <div className="max-w-2xl mx-auto rounded-app-lg border border-accent-to/30 bg-accent-to/10 p-4 mb-6 flex items-center gap-3">
      <div className="text-accent-to">
        <PhoneIncoming className="w-5 h-5 animate-pulse" />
      </div>
      <div className="flex-1">
        <p className="font-medium text-text-primary">Incoming call</p>
        <p className="text-body text-text-secondary mt-0.5">{fromE164 ?? 'Unknown caller'}</p>
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
