import { useEffect, useState } from 'react';
import { listInboxItems } from '@/lib/api';

const POLL_MS = 30000;

/** MISSION-5 TASK-M5-G6: the Sidebar's Inbox nav badge -- same lightweight poll shape as
 *  BroadcastBanner (60s), just faster since a fresh missed call is more time-sensitive than a
 *  broadcast. Silent on error: a badge that fails to update isn't worth surfacing to every page
 *  that isn't the Inbox itself. */
export function useInboxOpenCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      listInboxItems()
        .then((items) => {
          if (!cancelled) setCount(items.filter((i) => i.status === 'open').length);
        })
        .catch(() => {});
    };
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return count;
}
