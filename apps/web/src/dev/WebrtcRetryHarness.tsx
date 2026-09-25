import {
  WEBRTC_RETRY_BASE_MS,
  nextWebrtcRetryDelayMs,
  isDefinitiveTelnyxNotConnectedError,
} from '@/lib/webrtcRetry';

/**
 * TASK-I1 review fix (eng1 finding #2): no JS test runner exists for the web client
 * (CLAUDE.md's own "no automated tests" note), so this harness exercises the pure backoff math
 * directly instead of a unit test -- it computes and renders the actual delay sequence
 * `Dialer.tsx`'s retry effect would produce on repeated failures, and the "stop retrying
 * entirely" classification for a definitive not-connected error, with no network/timers
 * involved. Reached via `?dev_webrtc_retry=1` -- see main.tsx.
 */
export function WebrtcRetryHarness() {
  const sequence: number[] = [];
  let delay = WEBRTC_RETRY_BASE_MS;
  for (let i = 0; i < 10; i++) {
    sequence.push(delay);
    delay = nextWebrtcRetryDelayMs(delay);
  }

  const classifications: Array<{ message: string; stopsRetrying: boolean }> = [
    {
      message: 'Telnyx is not connected for this org. Connect it in Settings first.',
      stopsRetrying: true,
    },
    { message: 'Failed to get a WebRTC token from Telnyx.', stopsRetrying: false },
    { message: 'Network request failed', stopsRetrying: false },
  ].map((c) => ({ ...c, stopsRetrying: isDefinitiveTelnyxNotConnectedError(c.message) }));

  return (
    <div className="min-h-screen bg-[#0A1628] p-8 text-white font-mono text-sm">
      <h1 className="text-lg font-bold mb-4">WebRTC retry backoff (pure function output)</h1>
      <p className="mb-2">
        Delay sequence in ms (5s base, 5min cap), one entry per consecutive failure:
      </p>
      <ol className="list-decimal list-inside mb-6">
        {sequence.map((ms, i) => (
          <li key={i}>
            attempt {i + 1}: {ms.toLocaleString()} ms ({(ms / 1000).toFixed(0)}s)
          </li>
        ))}
      </ol>
      <p className="mb-2">Error-message classification (does it stop the retry loop entirely?):</p>
      <ul className="list-disc list-inside">
        {classifications.map((c, i) => (
          <li key={i}>
            "{c.message}" → {c.stopsRetrying ? 'STOPS retrying' : 'backs off and retries'}
          </li>
        ))}
      </ul>
    </div>
  );
}
