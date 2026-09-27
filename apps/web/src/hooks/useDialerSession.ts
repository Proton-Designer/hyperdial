import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getDialerSession,
  hangupLiveCall,
  pauseDialerSession,
  reconnectDialerSession,
  resumeDialerSession,
  startDialerSession,
  stopDialerSession,
  holdCall,
  resumeCall,
  pauseSessionRecording,
  resumeSessionRecording,
  startTransfer,
  completeTransfer,
  cancelTransfer,
  type ActiveTransfer,
  type CallLegRecord,
  type CampaignScriptInfo,
  type ContactHistoryEntry,
  type DialSessionRecord,
  type InboundCallInfo,
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

/** TASK-T5 (CRD-1): the connected-call card's business-details panel -- built from the active
 *  leg's own widened `contact` join (dialer-session-get). Every field is nullable/optional by
 *  design ("graceful when missing" is the task's own explicit ask) -- license_number/
 *  service_zips/tier come out of `ghlCustomFields`, keyed by our own target-key names. */
export interface ConnectedContactDetails {
  id: string;
  name: string;
  phone: string;
  rating: number | null;
  reviewCount: number | null;
  website: string | null;
  ownerContact: string | null;
  licenseNumber: string | null;
  serviceZips: string | null;
  tier: string | null;
}

/** TASK-L2b: the leg still waiting on a wrap-up disposition, plus everything WrapUpModal
 *  needs to render (it takes contact/duration as plain values, not a whole leg row). */
export interface WrapUpLegInfo {
  legId: string;
  contact: { id: string | null; name: string; phone: string };
  callDurationSeconds?: number;
}

interface DialerHookState {
  session: DialSessionRecord | null;
  sessionId: string | null;
  legs: CallLegRecord[];
  /** TASK-I1: the session's current bridged inbound call, if any -- see InboundCallInfo's own
   *  comment (api.ts) for the exact "current" scoping. */
  inboundCall: InboundCallInfo | null;
  /** TASK-T3: 'whisper'/'barge' only -- see getDialerSession's own comment (api.ts). Drives
   *  DialerStateBanner's "Manager listening" indicator. */
  coachingMode: 'whisper' | 'barge' | null;
  /** TASK-T4: the session's in-flight warm/cold transfer, if any -- see getDialerSession's own
   *  comment (api.ts). */
  activeTransfer: ActiveTransfer | null;
  /** TASK-T5 (CRD-3 + CRD-5): the whole current batch's contact history, pre-loaded in one
   *  batched query -- see getDialerSession's own comment (api.ts). */
  history: Record<string, ContactHistoryEntry[]>;
  /** TASK-T5 (CRD-4): the connected call's own campaign script/objection sheet, if any. */
  campaignScript: CampaignScriptInfo | null;
  loading: boolean;
  error: string | null;
}

const POLL_INTERVAL_MS = 3000;
// TASK-L1: 'ready_pending' (waiting for the agent leg to answer, right after Go Ready) and
// 'paused_agent_lost' (waiting for Reconnect) both need to keep polling -- the whole point is
// to notice the state change (to 'ready'/cascaded further, or after Reconnect succeeds)
// without the intern refreshing the page.
// TASK-L2b review fix: 'paused' ALSO needs to keep polling, for the same reason -- the server
// can transition a manually-paused session to 'paused_agent_lost' out from under it if the
// agent leg drops while paused (handleAgentLegLost runs from any AGENT_ACTIVE_SESSION_STATES
// state, which includes 'paused', dialer-engine.ts). Without this, the client stops polling
// the instant Pause is clicked and never notices the state changed underneath it -- the UI
// sticks on "Paused" forever, never shows the Reconnect banner, and Dialer.tsx's own UI-6
// auto-reconnect effect (keyed on session.state === 'paused_agent_lost') never fires either,
// since state.session itself is stale.
const ACTIVE_SESSION_STATES = new Set([
  'ready_pending',
  'ready',
  'dialing',
  'connecting',
  'on_call',
  'wrap_up',
  'paused',
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
    inboundCall: null,
    coachingMode: null,
    activeTransfer: null,
    history: {},
    campaignScript: null,
    loading: false,
    error: null,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSession = useCallback(async (sessionId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const { session, legs, inboundCall, coachingMode, activeTransfer, history, campaignScript } =
        await getDialerSession(sessionId);
      setState((prev) => ({
        ...prev,
        session,
        sessionId,
        legs,
        inboundCall,
        coachingMode,
        activeTransfer,
        history,
        campaignScript,
      }));
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
      amdMode?: 'off' | 'detect' | 'detect_words' | 'premium';
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

  const stop = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!state.sessionId) return null;
      const res = await stopDialerSession(state.sessionId, opts);
      await loadSession(state.sessionId);
      return res;
    },
    [loadSession, state.sessionId]
  );

  const pause = useCallback(
    async (reason?: string) => {
      if (!state.sessionId) return null;
      const res = await pauseDialerSession(state.sessionId, reason);
      await loadSession(state.sessionId);
      return res;
    },
    [loadSession, state.sessionId]
  );

  /** TASK-L2b: resumes a manually `paused` session (the counterpart `pause()` never had). */
  const resume = useCallback(async () => {
    if (!state.sessionId) return null;
    const res = await resumeDialerSession(state.sessionId);
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

  // TASK-T4 (AUD-6 + warm/cold transfer). Each action re-loads the session afterward, same
  // "call the API, then refresh from the server's own resulting state" shape as pause/resume
  // above -- the poll loop would eventually catch up anyway, but an immediate refresh is what
  // makes the button's own effect feel instant rather than laggy.
  const hold = useCallback(async () => {
    if (!state.sessionId) return null;
    const res = await holdCall(state.sessionId);
    await loadSession(state.sessionId);
    return res;
  }, [loadSession, state.sessionId]);

  const unhold = useCallback(async () => {
    if (!state.sessionId) return null;
    const res = await resumeCall(state.sessionId);
    await loadSession(state.sessionId);
    return res;
  }, [loadSession, state.sessionId]);

  // MISSION-4 TASK-T8: same "call the API, then refresh from the server's own resulting state"
  // shape as hold/unhold above. One toggle, not two separate actions -- reads the CURRENT
  // recording_status fresh off `state.legs` each call (not a stale closed-over value), so it
  // stays correct even if the leg's status changed since the last render for some other reason.
  const toggleRecording = useCallback(async () => {
    if (!state.sessionId) return;
    const activeLeg = state.legs.find((l) => l.id === state.session?.active_leg_id);
    if (activeLeg?.recording_status === 'paused') {
      await resumeSessionRecording(state.sessionId);
    } else if (activeLeg?.recording_status === 'recording') {
      await pauseSessionRecording(state.sessionId);
    } else {
      return;
    }
    await loadSession(state.sessionId);
  }, [loadSession, state.sessionId, state.legs, state.session]);

  const beginTransfer = useCallback(
    async (args: {
      type: 'cold' | 'warm';
      targetKind: 'member' | 'external';
      targetUserId?: string;
      targetNumber?: string;
    }) => {
      if (!state.sessionId) return null;
      const res = await startTransfer({ sessionId: state.sessionId, ...args });
      await loadSession(state.sessionId);
      return res;
    },
    [loadSession, state.sessionId]
  );

  const completeActiveTransfer = useCallback(async () => {
    if (!state.activeTransfer) return null;
    const res = await completeTransfer(state.activeTransfer.id);
    if (state.sessionId) await loadSession(state.sessionId);
    return res;
  }, [loadSession, state.sessionId, state.activeTransfer]);

  const cancelActiveTransfer = useCallback(async () => {
    if (!state.activeTransfer) return null;
    const res = await cancelTransfer(state.activeTransfer.id);
    if (state.sessionId) await loadSession(state.sessionId);
    return res;
  }, [loadSession, state.sessionId, state.activeTransfer]);

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
    // TASK-L1 put a real `kind='agent'` leg into this same `legs` array -- every stat below is
    // a CONTACT-facing count/list, so it needs the same `kind==='contact'` filter handleWin
    // needed on the backend (LANE-eng2.md's TASK-L1 section). Without it: "Calls Made" counts
    // the agent's own leg (and every Reconnect adds another), and the current-batch grid shows
    // an "Unknown contact" card (no `contact` join, no phone) for the agent leg whenever it's
    // 'answered'/'ringing'.
    const contactLegs = state.legs.filter((l) => l.kind === 'contact');
    const connected = contactLegs.filter((l) => l.outcome === 'connected').length;
    const voicemail = contactLegs.filter((l) => l.outcome === 'machine').length;
    const noAnswer = contactLegs.filter((l) => l.outcome === 'no_answer').length;
    const callsMade = contactLegs.length;
    // No campaign-total-contacts equivalent exists in the new schema (the legacy engine
    // snapshotted it at session start into dialer_sessions.total_contacts; dial_sessions has
    // no such column). Approximated as "every leg attempted so far" -- progress reads as "%
    // of attempted calls resolved," not "% of the whole campaign," until a future task adds
    // a real rollup query.
    const totalContacts = Math.max(callsMade, 1);
    const activeLeg = contactLegs.find(
      (l) => state.session && l.id === state.session.active_leg_id
    );
    const connectedContactId = activeLeg?.contact_id ?? null;
    const connectedAnsweredAt = activeLeg?.answered_at ?? null;
    // TASK-T4: 'On hold mm:ss' timer anchor -- null whenever the active leg isn't held.
    const heldAt = activeLeg?.held_at ?? null;
    // MISSION-4 TASK-T8: drives the live Pause/Resume recording button -- only 'recording'/
    // 'paused' are ever actionable (LiveCallPanel's own gate), everything else (null, 'saved',
    // etc.) hides the button.
    const recordingStatus = activeLeg?.recording_status ?? null;
    // TASK-T5 (CRD-1): built straight from the active leg's own widened contact join -- every
    // field individually nullable ("graceful when missing"). ghl_custom_fields is keyed by our
    // own target-key names, not a GHL field id (confirmed against ghl-import.ts's own
    // enrichment code).
    const connectedContact: ConnectedContactDetails | null = activeLeg?.contact
      ? {
          id: activeLeg.contact.id,
          name: contactName(activeLeg),
          phone: activeLeg.contact.phone_number ?? '',
          rating: activeLeg.contact.rating,
          reviewCount: activeLeg.contact.review_count,
          website: activeLeg.contact.website,
          ownerContact: activeLeg.contact.owner_contact,
          licenseNumber: activeLeg.contact.ghl_custom_fields?.license_number ?? null,
          serviceZips: activeLeg.contact.ghl_custom_fields?.service_zips ?? null,
          tier: activeLeg.contact.ghl_custom_fields?.tier ?? null,
        }
      : null;
    // TASK-T5 (CRD-3): the connected contact's own slice of the batch-wide history map.
    const connectedContactHistory: ContactHistoryEntry[] =
      (connectedContactId && state.history[connectedContactId]) || [];
    const answeringLeg = contactLegs.find(
      (l) => l.state === 'answered' || l.state === 'amd_pending'
    );
    const answeredContactId = answeringLeg?.contact_id ?? null;
    const currentBatchContacts: BatchContactPreview[] = contactLegs
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
    // TASK-L2b (wrap_up): dial_sessions.active_leg_id is already cleared by apply_leg_outcome
    // by the time the session reaches `wrap_up`, so "the leg to disposition" has to be found a
    // different way -- the CONTACT leg with outcome='connected' that hasn't been dispositioned
    // yet. At most one such leg should ever exist at a time (a new dialing cycle can't reach
    // 'connected' again until this one is dispositioned and the session leaves wrap_up), so
    // this is also correct across a page refresh with no client-side memory of "which leg was
    // live" -- it's derived purely from this one snapshot, which is what makes "a refresh
    // while in wrap_up re-opens the modal" (this task's own spec line) actually hold.
    const wrapUpLegRow = contactLegs.find((l) => l.outcome === 'connected' && !l.dispositioned_at);
    const wrapUpLeg: WrapUpLegInfo | null = wrapUpLegRow
      ? {
          legId: wrapUpLegRow.id,
          contact: {
            id: wrapUpLegRow.contact_id,
            name: contactName(wrapUpLegRow),
            phone: wrapUpLegRow.contact?.phone_number ?? '',
          },
          callDurationSeconds:
            wrapUpLegRow.answered_at && wrapUpLegRow.ended_at
              ? Math.max(
                  0,
                  Math.round(
                    (new Date(wrapUpLegRow.ended_at).getTime() -
                      new Date(wrapUpLegRow.answered_at).getTime()) /
                      1000
                  )
                )
              : undefined,
        }
      : null;
    return {
      connected,
      voicemail,
      noAnswer,
      callsMade,
      totalContacts,
      connectedContactId,
      connectedAnsweredAt,
      answeredContactId,
      currentBatchContacts,
      wrapUpLeg,
      progress,
      heldAt,
      recordingStatus,
      connectedContact,
      connectedContactHistory,
    };
  }, [state.legs, state.session, state.history]);

  return {
    ...state,
    ...derived,
    start,
    stop,
    pause,
    resume,
    reconnect,
    endLiveCall,
    hold,
    unhold,
    toggleRecording,
    beginTransfer,
    completeActiveTransfer,
    cancelActiveTransfer,
    loadSession,
  };
}
