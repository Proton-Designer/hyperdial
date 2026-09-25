import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getDialerSession,
  hangupLiveCall,
  pauseDialerSession,
  reconnectDialerSession,
  startDialerSession,
  stopDialerSession,
  type CallLegRecord,
  type DialSessionRecord,
} from '@/lib/api';

/**
 * TASK-P2-E2: rewritten from the legacy Redis/BATCH_FIRING-realtime-event model to the
 * org-scoped dial_sessions/call_legs schema. There is no realtime push anymore -- the new
 * engine (_shared/dialer-engine.ts) never calls the legacy publishDialerEvent, so the old
 * `supabase.channel('dialer:user:...')` subscription this hook used to hold would just sit
 * silently dead. Replaced with a plain poll of dialer-session-get while the session is in an
 * active state; a future task can add a real realtime channel if push updates matter enough
 * to build (out of scope here -- see LANE-eng2.md). The public shape this hook returns is
 * unchanged on purpose, so Dialer.tsx/ParallelDialerUI.tsx (E4's UI, not touched by this
 * task) keep working without their own changes.
 */

export interface BatchContactPreview {
  id: string;
  name: string;
  phone: string;
}

interface DialerHookState {
  session: DialSessionRecord | null;
  sessionId: string | null;
  legs: CallLegRecord[];
  loading: boolean;
  error: string | null;
}

const POLL_INTERVAL_MS = 3000;
// TASK-L1: 'ready_pending' (waiting for the agent leg to answer, right after Go Ready) and
// 'paused_agent_lost' (waiting for Reconnect) both need to keep polling -- the whole point is
// to notice the state change (to 'ready'/cascaded further, or after Reconnect succeeds)
// without the intern refreshing the page.
const ACTIVE_SESSION_STATES = new Set([
  'ready_pending',
  'ready',
  'dialing',
  'connecting',
  'on_call',
  'wrap_up',
  'paused_agent_lost',
]);
const TERMINAL_LEG_STATES = new Set(['ended', 'dropped', 'abandoned', 'machine']);

function contactName(leg: CallLegRecord): string {
  const c = leg.contact;
  if (!c) return 'Unknown contact';
  return (
    c.business_name || `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Unknown contact'
  );
}

export function useDialerSession(initialSessionId: string | null = null) {
  const [state, setState] = useState<DialerHookState>({
    session: null,
    sessionId: initialSessionId,
    legs: [],
    loading: false,
    error: null,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSession = useCallback(async (sessionId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const { session, legs } = await getDialerSession(sessionId);
      setState((prev) => ({ ...prev, session, sessionId, legs }));
    } catch (e) {
      setState((prev) => ({
        ...prev,
        error: e instanceof Error ? e.message : 'Failed to load dialer session',
      }));
    } finally {
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  const start = useCallback(
    async (args: {
      campaignId: string;
      lines?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
      amdMode?: 'off' | 'on';
    }) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const result = await startDialerSession(args);
        setState((prev) => ({ ...prev, sessionId: result.sessionId }));
        await loadSession(result.sessionId);
        return result;
      } finally {
        setState((prev) => ({ ...prev, loading: false }));
      }
    },
    [loadSession]
  );

  const stop = useCallback(async () => {
    if (!state.sessionId) return null;
    const res = await stopDialerSession(state.sessionId);
    await loadSession(state.sessionId);
    return res;
  }, [loadSession, state.sessionId]);

  const pause = useCallback(async () => {
    if (!state.sessionId) return null;
    const res = await pauseDialerSession(state.sessionId);
    await loadSession(state.sessionId);
    return res;
  }, [loadSession, state.sessionId]);

  /** TASK-L1: the Reconnect button, shown when session.state === 'paused_agent_lost'. Only
   *  dials the agent leg again server-side -- the caller (the pre-flight/Reconnect UI) is
   *  responsible for making sure useTelnyxCall's client is registered and will auto-answer
   *  the resulting inbound call. */
  const reconnect = useCallback(async () => {
    if (!state.sessionId) return null;
    const res = await reconnectDialerSession(state.sessionId);
    await loadSession(state.sessionId);
    return res;
  }, [loadSession, state.sessionId]);

  const endLiveCall = useCallback(async () => {
    if (!state.sessionId) return;
    await hangupLiveCall(state.sessionId);
    await loadSession(state.sessionId);
  }, [loadSession, state.sessionId]);

  useEffect(() => {
    if (initialSessionId) loadSession(initialSessionId);
  }, [initialSessionId, loadSession]);

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    const sessionId = state.sessionId;
    if (!sessionId || !state.session || !ACTIVE_SESSION_STATES.has(state.session.state)) {
      return;
    }
    pollRef.current = setInterval(() => {
      loadSession(sessionId);
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [state.sessionId, state.session, loadSession]);

  const derived = useMemo(() => {
    const connected = state.legs.filter((l) => l.outcome === 'connected').length;
    const voicemail = state.legs.filter((l) => l.outcome === 'machine').length;
    const noAnswer = state.legs.filter((l) => l.outcome === 'no_answer').length;
    const callsMade = state.legs.length;
    // No campaign-total-contacts equivalent exists in the new schema (the legacy engine
    // snapshotted it at session start into dialer_sessions.total_contacts; dial_sessions has
    // no such column). Approximated as "every leg attempted so far" -- progress reads as "%
    // of attempted calls resolved," not "% of the whole campaign," until a future task adds
    // a real rollup query.
    const totalContacts = Math.max(callsMade, 1);
    const activeLeg = state.legs.find((l) => state.session && l.id === state.session.active_leg_id);
    const connectedContactId = activeLeg?.contact_id ?? null;
    const answeringLeg = state.legs.find(
      (l) => l.state === 'answered' || l.state === 'amd_pending'
    );
    const answeredContactId = answeringLeg?.contact_id ?? null;
    const currentBatchContacts: BatchContactPreview[] = state.legs
      .filter((l) => !TERMINAL_LEG_STATES.has(l.state))
      .map((l) => ({
        id: l.contact_id ?? l.id,
        name: contactName(l),
        phone: l.contact?.phone_number ?? '',
      }));
    const progress =
      callsMade === 0
        ? 0
        : Math.min(100, Math.round(((connected + voicemail + noAnswer) / totalContacts) * 100));
    return {
      connected,
      voicemail,
      noAnswer,
      callsMade,
      totalContacts,
      connectedContactId,
      answeredContactId,
      currentBatchContacts,
      progress,
    };
  }, [state.legs, state.session]);

  return {
    ...state,
    ...derived,
    start,
    stop,
    pause,
    reconnect,
    endLiveCall,
    loadSession,
  };
}
