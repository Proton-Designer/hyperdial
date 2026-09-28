import { useCallback, useEffect, useRef, useState } from 'react';
import { listInboxItems } from '@/lib/api';
import { useVisibilityPacedPolling } from './useVisibilityPacedPolling';

const POLL_MS = 30000;

/** MISSION-5 TASK-M5-G6: the Sidebar's Inbox nav badge -- same lightweight poll shape as
 *  BroadcastBanner (60s), just faster since a fresh missed call is more time-sensitive than a
 *  broadcast. Silent on error: a badge that fails to update isn't worth surfacing to every page
 *  that isn't the Inbox itself.
 *  TASK-M5-L1 (EC-9): paused while the tab is hidden, refreshed immediately on becoming visible,
 *  backs off 30s->180s->360s on an error streak (invisible -- feeds only the backoff, the badge
 *  itself stays silent-on-failure as before). */
export function useInboxOpenCount(): number {
  const [count, setCount] = useState(0);
  const [pollFailed, setPollFailed] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    listInboxItems()
      .then((items) => {
        if (mountedRef.current) {
          setCount(items.filter((i) => i.status === 'open').length);
          setPollFailed(false);
        }
      })
      .catch(() => {
        if (mountedRef.current) setPollFailed(true);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useVisibilityPacedPolling(refresh, POLL_MS, pollFailed);

  return count;
}
