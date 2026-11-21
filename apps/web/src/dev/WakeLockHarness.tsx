import { useState } from 'react';
import { useScreenWakeLock } from '@/lib/useWakeLock';

/** `?dev_wakelock=1` -- shows whether useScreenWakeLock holds a lock. On iOS Safari it starts false and turns true after the first tap. */
export function WakeLockHarness() {
  const [active, setActive] = useState(true);
  const held = useScreenWakeLock(active);
  return (
    <div
      className="p-4 text-base text-white"
      style={{ background: '#0a1628', minHeight: '100dvh' }}
    >
      <p>
        session active: <b>{String(active)}</b>
      </p>
      <p>
        wake lock held: <b data-testid="held">{String(held)}</b>
      </p>
      <p>supported: {String('wakeLock' in navigator)}</p>
      <button
        type="button"
        className="mt-4 rounded border px-4 py-3"
        onClick={() => setActive((a) => !a)}
      >
        toggle session
      </button>
    </div>
  );
}
