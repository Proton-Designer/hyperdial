import { Grid3x3 } from 'lucide-react';
import type { DtmfQueue } from '@/lib/useDtmfQueue';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/** TASK-H11: keypad for the live call, so an agent can answer "press 1 to be connected" menus.
 *  Collapsed by default (the call controls stay compact); each tap sends that one tone.
 *  The queue lives in `useDtmfQueue` (one instance per dialer, shared with the phone Keypad sheet). */
export function DtmfKeypad({
  dtmf,
  defaultOpen = false,
}: {
  dtmf: DtmfQueue;
  defaultOpen?: boolean;
}) {
  const { sessionId, sent, error, press } = dtmf;
  if (!sessionId) return null;

  return (
    <details
      open={defaultOpen || undefined}
      className="rounded-xl border border-white/10 bg-surface-1 p-3"
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-white">
        <Grid3x3 className="w-4 h-4" />
        Keypad
      </summary>
      <div className="mt-3 mx-auto w-full max-w-[240px]">
        <div
          className="mb-2 min-h-[1.5rem] text-center font-mono text-lg tracking-widest text-text-primary"
          aria-live="polite"
        >
          {sent || (
            <span className="text-text-muted text-sm tracking-normal">Tap a key to send it</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              aria-label={`Send ${key}`}
              className="h-12 rounded-app-md bg-surface-2 border border-border-subtle text-lg font-semibold text-text-primary hover:bg-surface-3 active:scale-95"
            >
              {key}
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="mt-2 text-center text-sm text-red-400">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
