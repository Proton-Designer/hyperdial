import type { RecordManualCallInput } from '@/lib/api';

/**
 * TASK-H27: records a finished manual call, retrying quietly. The same `clientKey` is sent every time, so a retry after
 * a lost response can never write the call twice (the server de-duplicates on it). Resolves to the log id; after the
 * last failed attempt it logs to the console and rejects -- the caller must never let that block the agent.
 */
export async function recordWithRetry(
  record: (input: RecordManualCallInput) => Promise<{ id: string }>,
  input: RecordManualCallInput,
  delaysMs: number[] = [1500, 5000]
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return (await record(input)).id;
    } catch (e) {
      lastError = e;
      if (attempt < delaysMs.length) await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
  console.error('Could not record the manual call:', lastError);
  throw lastError instanceof Error ? lastError : new Error('Could not record the call');
}

/** Seconds of talk time, clamped to what the server accepts (0..86400). */
export function talkSeconds(connectedAtMs: number | null, endedAtMs: number): number | null {
  if (connectedAtMs === null) return null;
  return Math.min(86400, Math.max(0, Math.round((endedAtMs - connectedAtMs) / 1000)));
}
