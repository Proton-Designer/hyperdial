import { useCallback, useRef, useState } from 'react';
import { sendDialerDtmf } from '@/lib/api';

export interface DtmfQueue {
  sessionId: string | null;
  sent: string;
  error: string | null;
  press: (key: string) => void;
  reset: () => void;
}

/**
 * TASK-H15 queue, lifted out of DtmfKeypad (TASK-MOB6b) so the inline keypad and the phone's Keypad sheet share ONE
 * instance: keys tapped while a request is in flight are queued and sent in order (up to 16 per request, the server's
 * cap), one request at a time, so quick multi-digit presses are never dropped, interleaved or double-sent.
 */
export function useDtmfQueue(sessionId: string | null): DtmfQueue {
  const [sent, setSent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pending = useRef('');
  const flushing = useRef(false);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      while (pending.current) {
        const id = sessionRef.current;
        if (!id) {
          pending.current = '';
          break;
        }
        const batch = pending.current.slice(0, 16);
        pending.current = pending.current.slice(batch.length);
        try {
          await sendDialerDtmf(id, batch);
          setSent((prev) => (prev + batch).slice(-16));
        } catch (err) {
          // Later queued keys would be out of sequence after a failed one: drop them and tell the agent.
          pending.current = '';
          setError(err instanceof Error ? err.message : 'Failed to send keypad tones');
        }
      }
    } finally {
      flushing.current = false;
    }
  }, []);

  const press = useCallback(
    (key: string) => {
      setError(null);
      pending.current += key;
      void flush();
    },
    [flush]
  );

  const reset = useCallback(() => {
    pending.current = '';
    setSent('');
    setError(null);
  }, []);

  return { sessionId, sent, error, press, reset };
}
