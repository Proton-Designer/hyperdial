import { useEffect, useState } from 'react';
import { getMyVoicemailDrop, getOrgDefaultVoicemailDrop } from '@/lib/api';

/**
 * TASK-H34: does this agent have a voicemail drop to play (their own, or the org default)?
 * `null` while loading or if the check fails (callers show nothing rather than a false "none yet").
 */
export function useHasVoicemailDrop(enabled = true): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    Promise.all([getMyVoicemailDrop(), getOrgDefaultVoicemailDrop()])
      .then(([mine, org]) => {
        if (!cancelled) setHas(mine.hasFile || org.hasFile);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return has;
}
