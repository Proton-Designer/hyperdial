import { useState } from 'react';
import { IncomingCallBanner } from '@/components/dialer/IncomingCallBanner';

/**
 * TASK-I1 (INB-2): IncomingCallBanner in isolation, fixture caller, no live WebRTC/DB. Same
 * spirit as DialerStatesHarness/WrapUpModalHarness. Reached via `?dev_incoming_call=1` -- see
 * main.tsx, which only imports this behind `import.meta.env.DEV`.
 */
export function IncomingCallHarness() {
  const [answered, setAnswered] = useState<'idle' | 'answered' | 'declined'>('idle');

  return (
    <div className="min-h-screen bg-[#0A1628] p-8">
      <div className="max-w-2xl mx-auto">
        {answered === 'idle' ? (
          <IncomingCallBanner
            fromE164="+15125550100"
            onAnswer={() => setAnswered('answered')}
            onDecline={() => setAnswered('declined')}
          />
        ) : (
          <p className="text-white">Fixture result: {answered} (no-op, no live call)</p>
        )}
      </div>
    </div>
  );
}
