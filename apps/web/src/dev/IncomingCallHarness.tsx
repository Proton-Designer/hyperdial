import { useState } from 'react';
import { IncomingCallBanner } from '@/components/dialer/IncomingCallBanner';

/**
 * TASK-I1 (INB-2): IncomingCallBanner in isolation, fixture caller, no live WebRTC/DB. Same
 * spirit as DialerStatesHarness/WrapUpModalHarness. Reached via `?dev_incoming_call=1` -- see
 * main.tsx, which only imports this behind `import.meta.env.DEV`.
 *
 * Review fix (eng1 review-eng1.md finding #6): two fixture rows now, matching INB-2's own exact
 * requirement -- a resolved contact name, and the "Unknown caller" + number fallback when
 * nothing matched.
 */
export function IncomingCallHarness() {
  const [answered, setAnswered] = useState<'idle' | 'answered' | 'declined'>('idle');

  return (
    <div className="min-h-screen bg-[#0A1628] p-8">
      <div className="max-w-2xl mx-auto space-y-4">
        {answered === 'idle' ? (
          <>
            <IncomingCallBanner
              fromE164="+15125550100"
              contactName="Jordan Ramirez"
              onAnswer={() => setAnswered('answered')}
              onDecline={() => setAnswered('declined')}
            />
            <IncomingCallBanner
              fromE164="+15125550199"
              contactName={null}
              onAnswer={() => setAnswered('answered')}
              onDecline={() => setAnswered('declined')}
            />
          </>
        ) : (
          <p className="text-white">Fixture result: {answered} (no-op, no live call)</p>
        )}
      </div>
    </div>
  );
}
