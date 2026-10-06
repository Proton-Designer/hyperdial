import { useEffect, useState } from 'react';

/** A clock that re-renders every `ms` while mounted (30 s is plenty for minute-level text). */
export function useNow(ms = 30_000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return now;
}
