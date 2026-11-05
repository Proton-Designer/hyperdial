import { useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { PostCallCard, type PostCall } from '@/components/dialer/PostCallCard';

/**
 * TASK-H27: PostCallCard in isolation (outcome chips, notes, Save, saved state, Log close routing). Needs a signed-in
 * QA session in this browser (the card reads the org's dispositions). `?dev_post_call=1&record=ok|fail`.
 */
export function PostCallHarness() {
  const fail = new URLSearchParams(window.location.search).get('record') === 'fail';
  const [call] = useState<PostCall>(() => {
    const recorded = fail
      ? Promise.reject(new Error('offline'))
      : Promise.resolve('00000000-0000-0000-0000-000000000001');
    recorded.catch(() => undefined); // like the Dialer: the rejection is handled, the card shows its own retry
    return {
      id: 'dev-1',
      number: '+15125550142',
      direction: 'outbound',
      recorded,
      retryRecord: () => Promise.resolve('00000000-0000-0000-0000-000000000001'),
    };
  });
  const [shown, setShown] = useState(true);
  return (
    <div className="min-h-screen bg-background p-6">
      {shown && <PostCallCard call={call} onDismiss={() => setShown(false)} />}
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}
