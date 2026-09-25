import { useEffect, useRef, useState } from 'react';

const LOCK_KEY = 'hyperdial_agent_line_lock';
const CHANNEL_NAME = 'hyperdial-agent-line-lock';
const HEARTBEAT_MS = 1500;
const STALE_AFTER_MS = 4000;

interface LockRecord {
  tabId: string;
  heartbeatAt: number;
}

function readLock(): LockRecord | null {
  try {
    const raw = window.localStorage.getItem(LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.tabId !== 'string' || typeof parsed.heartbeatAt !== 'number') return null;
    return { tabId: parsed.tabId, heartbeatAt: parsed.heartbeatAt };
  } catch {
    return null;
  }
}

function writeLock(record: LockRecord): void {
  try {
    window.localStorage.setItem(LOCK_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode, quota) -- fails open to "owner" rather than blocking
    // the whole feature; single-tab enforcement is a safety net, not a hard guarantee.
  }
}

function clearLockIfOwnedBy(tabId: string): void {
  try {
    const current = readLock();
    if (current?.tabId === tabId) window.localStorage.removeItem(LOCK_KEY);
  } catch {
    // ignore
  }
}

function isStale(record: LockRecord | null): boolean {
  return !record || Date.now() - record.heartbeatAt > STALE_AFTER_MS;
}

/**
 * TASK-L1r4 round 5 (review-notes-r4.md): the Dialer is permanently mounted (TASK-L1r4 M3) and
 * proactively registers the agent's WebRTC line whenever a parallel session is active, so
 * opening a second browser tab now means TWO registered clients that can each answer the SAME
 * agent-kind inbound call -- a real race for which one actually gets it. Elects exactly one
 * "owner" tab across every open tab of this app: BroadcastChannel gives near-instant handoff,
 * a localStorage heartbeat is the durable source of truth a late-joining tab can read
 * immediately and the fallback that lets a NEW tab reclaim the lock if the owner tab crashed
 * without running its own cleanup (closed the process, not just navigated away).
 *
 * Callers must gate BOTH registering a WebRTC client and any UI that could trigger one behind
 * `isOwner` -- this hook only tracks ownership, it does not touch `useTelnyxCall` itself.
 */
export function useSingleTabLock(): { isOwner: boolean; otherTabOpen: boolean } {
  const tabIdRef = useRef<string>('');
  if (!tabIdRef.current) {
    tabIdRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  const [isOwner, setIsOwner] = useState(false);
  const [otherTabOpen, setOtherTabOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const tabId = tabIdRef.current;
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let ownerNow = false;

    const stepDown = () => {
      ownerNow = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      setIsOwner(false);
      setOtherTabOpen(true);
    };

    const becomeOwner = () => {
      ownerNow = true;
      writeLock({ tabId, heartbeatAt: Date.now() });
      setIsOwner(true);
      setOtherTabOpen(false);
      channel?.postMessage({ type: 'claim', tabId });
      heartbeatTimer = setInterval(() => {
        writeLock({ tabId, heartbeatAt: Date.now() });
      }, HEARTBEAT_MS);
    };

    const tryClaim = () => {
      if (ownerNow) return;
      const current = readLock();
      if (!current || current.tabId === tabId || isStale(current)) {
        becomeOwner();
      } else {
        setIsOwner(false);
        setOtherTabOpen(true);
      }
    };

    tryClaim();

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; tabId?: string } | undefined;
      if (!data || data.tabId === tabId) return;
      if (data.type === 'claim' || data.type === 'heartbeat') {
        if (ownerNow) {
          // Two tabs raced to claim in the same tick, both briefly believed they were the
          // owner -- defer to whichever's write actually landed in localStorage last.
          const current = readLock();
          if (current && current.tabId !== tabId) stepDown();
        } else {
          setOtherTabOpen(true);
        }
      } else if (data.type === 'released' && !ownerNow) {
        tryClaim();
      }
    };
    channel?.addEventListener('message', onMessage);

    // Fallback poll: catches a crashed owner tab (heartbeat goes stale, no `released` message
    // was ever sent) and covers any context without BroadcastChannel entirely.
    const pollTimer = setInterval(() => {
      if (!ownerNow) tryClaim();
    }, HEARTBEAT_MS);

    const release = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (ownerNow) {
        clearLockIfOwnedBy(tabId);
        channel?.postMessage({ type: 'released', tabId });
        ownerNow = false;
      }
    };
    window.addEventListener('beforeunload', release);

    return () => {
      window.removeEventListener('beforeunload', release);
      clearInterval(pollTimer);
      release();
      channel?.removeEventListener('message', onMessage);
      channel?.close();
    };
  }, []);

  return { isOwner, otherTabOpen };
}
