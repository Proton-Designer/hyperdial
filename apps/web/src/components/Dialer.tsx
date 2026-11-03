import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { isViewOnly, VIEW_ONLY_MESSAGE } from '@/lib/viewAs';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { useTelnyxCall } from '../lib/useTelnyxCall';
import { CoachingBanner } from './dialer/CoachingBanner';
import { usePhoneNumbers } from '@/contexts/PhoneNumbersContext';
import { CampaignStats } from './dialer/CampaignStats';
import { useDialerSession } from '@/hooks/useDialerSession';
import { ParallelDialerUI } from './dialer/ParallelDialerUI';
import { DialerStateBanner } from './dialer/DialerStateBanner';
import { IncomingCallBanner } from './dialer/IncomingCallBanner';
import { CallForwardingCard } from './dialer/CallForwardingCard';
import { WrapUpModal } from './dialer/WrapUpModal';
import { StartSessionPanel } from './dialer/StartSessionPanel';
import { ShiftDialerBanner } from './shifts/ShiftDialerBanner';
import { ManualDialPanel } from './dialer/ManualDialPanel';
import { HotkeyHelpOverlay } from './dialer/HotkeyHelpOverlay';
import { MyGoalHeader } from '@/components/goals/MyGoalHeader';
import { BroadcastBanner } from '@/components/goals/BroadcastBanner';
import { PowerHourLiveBanner } from '@/components/power-hour/PowerHourLiveBanner';
import { isTypingTarget } from '@/lib/keyboard';
import {
  getActiveDialerSession,
  getDialerSession,
  getTelnyxConnectionStatus,
  lookupContactByPhone,
  listCampaigns,
  startDialerSession,
  stopDialerSession,
  updateMyPresenceHeartbeat,
  getUserPreferences,
  getOrgPauseReasons,
  DEFAULT_PAUSE_REASONS,
  ActiveSessionExistsError,
  ReconnectAlreadyInFlightError,
  LiveCallInProgressError,
  type CampaignWithStats,
} from '@/lib/api';
import { playConnectChime } from '@/lib/dialerSoundCue';
import {
  consumePendingStartCampaignId,
  consumePendingManualDialNumber,
  subscribePendingManualDial,
  hasPendingManualDialNumber,
} from '@/lib/dialerLaunchIntent';
import { dialableNumbers, pickCallerId, decidePendingDial } from '@/lib/dialNumbers';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import { useSingleTabLock } from '@/lib/useSingleTabLock';
import {
  WEBRTC_RETRY_BASE_MS,
  nextWebrtcRetryDelayMs,
  isDefinitiveTelnyxNotConnectedError,
} from '@/lib/webrtcRetry';

const REMOTE_AUDIO_ID = 'telnyx-remote-audio';

/** A session whose line dropped longer ago than this is a leftover (a closed tab, a laptop that
 *  slept overnight), not a refresh to reconnect -- the Dialer closes it instead of restoring it. */
const LEFTOVER_LINE_LOST_MS = 10 * 60 * 1000;

/** An agent can have only one open session (dial_sessions_one_active_per_agent). When one the
 *  intern can't see is in the way, end it for them instead of asking them to. Never hangs up a
 *  live caller: without `force` the stop endpoint refuses (LIVE_CALL_IN_PROGRESS) while a
 *  prospect is on the line, and this returns false so the caller opens that session instead. */
async function endLeftoverSession(sessionId: string): Promise<boolean> {
  try {
    const { status } = await stopDialerSession(sessionId);
    return status === 'stopped';
  } catch {
    return false;
  }
}

export type DialerStatus = 'idle' | 'dialing' | 'ringing' | 'connected';

export type UserPhoneNumber = import('@/contexts/PhoneNumbersContext').UserPhoneNumber;

interface DialerProps {
  parallelSessionId?: string | null;
  parallelCampaignId?: string | null;
  onClearParallelContext?: () => void;
  onNavigateToSettings?: () => void;
}

/**
 * Review fix (L1r4 round 6, review-notes-r5.md, MAJOR): a plain `return <blocked-banner/>`
 * placed at the end of the OLD single component body did not stop a non-owner tab's hooks from
 * running -- React executes every hook top-to-bottom on every render regardless of a LATER
 * return statement, so `useDialerSession`'s 3s poll and the UI-8 connect-chime effect kept
 * firing (and the chime kept playing OUT LOUD) in a follower tab that was simultaneously
 * showing "HyperDial is open in another tab." The only way to actually stop those hooks from
 * running at all is to not call them in the first place: this outer `Dialer` owns ONLY the
 * single-tab-lock check, and renders `DialerBody` -- which owns every other hook in this file,
 * including `useDialerSession`'s poll -- ONLY for the owner tab. A non-owner tab never mounts
 * `DialerBody` at all, so none of its hooks/effects/polling ever run there.
 */
export function Dialer({
  parallelSessionId = null,
  parallelCampaignId = null,
  onClearParallelContext,
  onNavigateToSettings,
}: DialerProps) {
  const { isOwner: isAgentLineOwner, otherTabOpen } = useSingleTabLock();

  // `otherTabOpen` only becomes true once useSingleTabLock's own effect has actually run and
  // found a live owner elsewhere -- on the very first render of the one-and-only real tab, both
  // this and `isOwner` start false, so this deliberately does NOT block on `!isAgentLineOwner`
  // alone (that would also block the normal single-tab case for one render).
  if (otherTabOpen && !isAgentLineOwner) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center rounded-app-lg border border-warning/25 bg-warning-soft p-8">
          <p className="text-text-primary font-semibold text-lg mb-2">
            HyperDial is open in another tab
          </p>
          <p className="text-text-secondary text-body">
            Your phone line can only be registered in one browser tab at a time. Close this tab, or
            close the other one and refresh this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <DialerBody
      parallelSessionId={parallelSessionId}
      parallelCampaignId={parallelCampaignId}
      onClearParallelContext={onClearParallelContext}
      onNavigateToSettings={onNavigateToSettings}
      isAgentLineOwner={isAgentLineOwner}
    />
  );
}

interface DialerBodyProps extends DialerProps {
  isAgentLineOwner: boolean;
}

function DialerBody({
  parallelSessionId = null,
  parallelCampaignId = null,
  onClearParallelContext,
  onNavigateToSettings,
  isAgentLineOwner,
}: DialerBodyProps) {
  const { numbers: allNumbers, loading: numbersLoading } = usePhoneNumbers();
  const { user } = useAuth();
  const { role: orgRole } = useOrg();
  // TASK-H23 (C): RLS shows the whole org's numbers; this agent may only dial from their own
  // assigned one or an unassigned pool one (owner/admin keep every non-retired number).
  const userNumbers = useMemo(
    () => dialableNumbers(allNumbers, user?.id, orgRole === 'owner' || orgRole === 'admin'),
    [allNumbers, user?.id, orgRole]
  );
  const [selectedFromNumber, setSelectedFromNumber] = useState<string | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [outboundNumber, setOutboundNumber] = useState('');
  // TASK-T7: lifted out of LiveCallPanel's own local state so the global "M" hotkey can read the
  // same value the Mute button toggles -- see LiveCallPanel.tsx's own header comment.
  const [isMuted, setIsMuted] = useState(false);
  const [showHotkeyHelp, setShowHotkeyHelp] = useState(false);
  // MISSION-4 TASK-T7 (auto-resume): the agent's own pacing preference (null = never fetched
  // yet, or no row -- see api.ts's own UserPreferences comment for why that's distinct from the
  // literal 0). Fetched once; Settings.tsx is a separate tab, so a same-session change while the
  // Dialer is mounted only takes effect on the NEXT wrap-up, not the one already in flight --
  // acceptable, this is a pacing preference, not a security control.
  const [autoResumePref, setAutoResumePref] = useState<0 | 5 | 10 | 15 | null>(null);
  const [autoResumeSecondsLeft, setAutoResumeSecondsLeft] = useState<number | null>(null);
  const autoResumeArmedForRef = useRef<string | null>(null);

  useEffect(() => {
    getUserPreferences()
      .then((prefs) => setAutoResumePref(prefs?.auto_resume_seconds ?? null))
      .catch(() => {});
  }, []);

  /** When opening Dialer without launch context, restore active session so parallel UI can show. */
  const [restoredParallelContext, setRestoredParallelContext] = useState<{
    sessionId: string;
    campaignId: string;
  } | null>(null);

  // TASK-L7: the campaigns list backing the new "start a session" panel -- null while loading,
  // [] for a genuinely empty (unassigned) agent. listCampaigns() already agent-filters vs.
  // returns everything for owner/admin (api.ts's own comment); no new endpoint needed.
  const [assignedCampaigns, setAssignedCampaigns] = useState<CampaignWithStats[] | null>(null);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [startingCampaignId, setStartingCampaignId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const pendingIntentConsumedRef = useRef(false);
  // TASK-H23 (B): bumped by every setPendingManualDialNumber so the effect below re-runs for each
  // new number, not just the first one after page load.
  const [pendingDialTick, setPendingDialTick] = useState(0);
  useEffect(() => subscribePendingManualDial(() => setPendingDialTick((t) => t + 1)), []);

  const effectiveSessionId = parallelSessionId ?? restoredParallelContext?.sessionId ?? null;
  const effectiveCampaignId = parallelCampaignId ?? restoredParallelContext?.campaignId ?? null;
  const parallelSession = useDialerSession(effectiveSessionId);

  // `isAgentLineOwner` comes from the outer `Dialer` (see its own header comment) -- every place
  // below that registers a WebRTC client or could trigger a real call still checks it, as
  // defense-in-depth for the narrow initial-render window before ownership resolves; the outer
  // component is what guarantees THIS component's hooks (the poll above, the chime effect
  // below) don't run at all once a non-owner state is confirmed.
  // TASK-L1: sessionId (when a parallel session exists) makes this SAME hook instance also
  // auto-answer the agent leg's inbound call for that session -- see useTelnyxCall.ts's own
  // header comment. Outside parallel mode (manual single-line dialer), sessionId is undefined
  // and behavior is unchanged from before this task.
  const {
    callState,
    error,
    dial,
    hangup,
    setMuted,
    connect: connectAgentLine,
    isReady: agentLineReady,
    isConnecting: agentLineConnecting,
    beginAgentLegExpectation,
    endAgentLegExpectation,
    pendingInboundCall,
    answerPendingInboundCall,
    declinePendingInboundCall,
    activeCoaching,
    setActiveCoachingMode,
  } = useTelnyxCall({
    remoteElementId: REMOTE_AUDIO_ID,
    sessionId: effectiveSessionId ?? undefined,
  });

  // TASK-T7: single wrapper so both the Mute button (via ParallelDialerUI/LiveCallPanel's
  // `onMuteChange`) and the future global "M" hotkey update the same `isMuted` value that
  // LiveCallPanel now reads as a required prop, while still driving the real WebRTC mute through
  // useTelnyxCall's own `setMuted`.
  const handleToggleMute = useCallback(
    (next: boolean) => {
      setIsMuted(next);
      setMuted(next);
    },
    [setMuted]
  );

  // TASK-I1 review fix (eng1 review-eng1.md finding #6): resolve the caller's contact name for
  // the incoming-call banner, matched by E.164 within the org -- see lookupContactByPhone's own
  // comment for why this can't just be a plain client-side `.from('contacts')` query. Keyed on
  // the pending call's own id so a stale lookup from a PRIOR call can't ever apply to a new one.
  const [pendingCallContactName, setPendingCallContactName] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingInboundCall?.fromE164) {
      setPendingCallContactName(null);
      return;
    }
    let cancelled = false;
    lookupContactByPhone(pendingInboundCall.fromE164)
      .then((contact) => {
        if (cancelled) return;
        const name = contact
          ? contact.business_name ||
            `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim() ||
            null
          : null;
        setPendingCallContactName(name);
      })
      .catch(() => {
        if (!cancelled) setPendingCallContactName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pendingInboundCall?.callId, pendingInboundCall?.fromE164]);

  // Proactively register the WebRTC client whenever this tab owns the agent line -- not just
  // when there's a parallel session to serve. Originally gated on `effectiveSessionId` (the
  // agent leg's inbound call has nowhere to be auto-answered until this has run, covering
  // restoring an already-active session on mount/refresh; a fresh Start already registers
  // (mic check -> connect -> Go Ready) inside handleStartSessionForCampaign below before this
  // effect would ever need to).
  // TASK-I1 (INB-2): widened to drop the session gate entirely. An intern who is online but not
  // mid-batch still needs a live, registered SIP client for an inbound call's `ringing_intern`
  // transfer to reach -- `isAgentOnline` (the presence heartbeat below) being true is otherwise a
  // lie: it would say the browser is reachable while the WebRTC client itself is unregistered,
  // and the transfer would just ring out against a SIP URI nothing is listening on.
  // dialer-engine.ts's agentSipUri no longer has a registration backstop to fall back on --
  // it's self-healing (get-or-create) regardless of whether the browser has connected yet, so
  // this effect running promptly (session or not) is what makes an intern actually reachable.
  //
  // Review fix (eng1 review-eng1.md finding #2, live-confirmed 108+ req/15s): dropping the
  // session gate meant this effect now runs continuously for every org, including the DEFAULT
  // "Telnyx not connected" state -- and `agentLineConnecting` flipping back to false on a failed
  // `connect()` was itself one of this effect's own dependencies, so a failure re-satisfied its
  // re-entry condition and fired again immediately, forever, with no backoff. Two independent
  // fixes: (1) never even attempt a connect until `getTelnyxConnectionStatus()` confirms the org
  // IS connected (checked once per isAgentLineOwner transition, below) -- the common "no Telnyx
  // yet" case now issues zero credential requests, not an infinite retry of failing ones; (2)
  // any OTHER failure retries on an exponential backoff (5s -> 5min cap, `webrtcRetry.ts`) driven
  // by its own setTimeout chain, not by React re-running this effect -- `agentLineReady`/
  // `agentLineConnecting` are read via refs inside the retry closure instead of being dependency-
  // array entries, so a connect attempt's own state transitions can no longer re-trigger this
  // effect and bypass the backoff the way the original bug did.
  // MISSION-5 TASK-M5-B1: fetched once, not per-render -- the org's own reason list rarely
  // changes and a stale copy for the rest of this mount is harmless (the picker is just a
  // convenience list, dialer-session-pause never validates against it server-side).
  const [pauseReasons, setPauseReasons] = useState<string[]>(DEFAULT_PAUSE_REASONS);
  useEffect(() => {
    let cancelled = false;
    getOrgPauseReasons()
      .then((reasons) => {
        if (!cancelled && reasons.length > 0) setPauseReasons(reasons);
      })
      .catch(() => {
        /* keep the default list -- this is a convenience picker, not a required load */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [orgTelnyxConnected, setOrgTelnyxConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isAgentLineOwner) {
      setOrgTelnyxConnected(null);
      return;
    }
    let cancelled = false;
    getTelnyxConnectionStatus()
      .then((status) => {
        if (!cancelled) setOrgTelnyxConnected(status?.status === 'connected');
      })
      .catch(() => {
        if (!cancelled) setOrgTelnyxConnected(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isAgentLineOwner]);

  const agentLineReadyRef = useRef(agentLineReady);
  const agentLineConnectingRef = useRef(agentLineConnecting);
  useEffect(() => {
    agentLineReadyRef.current = agentLineReady;
    agentLineConnectingRef.current = agentLineConnecting;
  }, [agentLineReady, agentLineConnecting]);

  useEffect(() => {
    if (!isAgentLineOwner || orgTelnyxConnected !== true) return;

    let cancelled = false;
    let retryDelayMs = WEBRTC_RETRY_BASE_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const attempt = () => {
      if (cancelled) return;
      if (agentLineReadyRef.current || agentLineConnectingRef.current) return;
      connectAgentLine()
        .then(() => {
          retryDelayMs = WEBRTC_RETRY_BASE_MS;
        })
        .catch((e) => {
          if (cancelled) return;
          // Surfaced via useTelnyxCall's own `error` state; DialerStateBanner renders it.
          const message = e instanceof Error ? e.message : String(e);
          if (isDefinitiveTelnyxNotConnectedError(message)) {
            setOrgTelnyxConnected(false);
            return;
          }
          retryTimer = setTimeout(attempt, retryDelayMs);
          retryDelayMs = nextWebrtcRetryDelayMs(retryDelayMs);
        });
    };
    attempt();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isAgentLineOwner, orgTelnyxConnected, connectAgentLine]);

  // TASK-I1 (INB-3): presence heartbeat, the only server-visible "seen recently" signal
  // (`isAgentOnline`, inbound-core.ts) -- there's no server-visible WebRTC-registration status
  // anywhere in this schema. 60s is comfortably under `INBOUND_PRESENCE_WINDOW_MS` (2 min), so a
  // single missed tick (a slow network, a background tab throttled by the browser) doesn't flip
  // an online intern to "offline" for a routing decision. Fire-and-forget by design (see the
  // function's own header comment) -- never surfaced as an error here.
  useEffect(() => {
    if (!isAgentLineOwner || isViewOnly) return;
    void updateMyPresenceHeartbeat();
    const interval = setInterval(() => {
      void updateMyPresenceHeartbeat();
    }, 60_000);
    return () => clearInterval(interval);
  }, [isAgentLineOwner]);

  const handleReconnectAgentLine = useCallback(async () => {
    try {
      await parallelSession.reconnect();
      toast.success('Reconnecting your line…');
    } catch (e) {
      // Review fix (L1r4 round 5, review-notes-r4.md): a reconnect the auto-reconnect effect
      // below already fired for this same drop is expected to race the poll and occasionally
      // get a 409 here -- not a real failure, so don't alarm the intern with an error toast for
      // it specifically. Any OTHER failure still surfaces normally.
      if (e instanceof ReconnectAlreadyInFlightError) return;
      toast.error(e instanceof Error ? e.message : 'Failed to reconnect');
    }
  }, [parallelSession.reconnect]);

  // UI-8: a short chime the instant a human connects -- only on the actual transition into
  // connected (a ref, not state, so this never re-fires on every 3s poll tick while the same
  // contact stays connected, and never fires on mount if the page loads directly into an
  // already-on_call session).
  const previousConnectedContactIdRef = useRef<string | null>(null);
  useEffect(() => {
    const current = parallelSession.connectedContactId;
    if (current && current !== previousConnectedContactIdRef.current) {
      playConnectChime();
    }
    previousConnectedContactIdRef.current = current;
  }, [parallelSession.connectedContactId]);

  const handleParallelResume = useCallback(async () => {
    try {
      await parallelSession.resume();
      toast.success('Dialing resumed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to resume');
    }
  }, [parallelSession.resume]);

  // MISSION-4 TASK-T7 (auto-resume): arms a countdown the moment the session enters
  // paused/post_wrapup (submit_disposition's own new pause, see the migration's header), exactly
  // once per pause "spell" -- keyed on `session.updated_at`, which `transition_session` always
  // bumps on every transition (dialer_rpcs.sql), so re-polling the SAME still-paused session never
  // re-arms a countdown the agent already cancelled or that already ran out. A null/0 preference
  // arms nothing (stays a bare manual-resume banner, per DialerStateBanner's own branch).
  useEffect(() => {
    const session = parallelSession.session;
    if (!session || session.state !== 'paused' || session.pause_reason !== 'post_wrapup') {
      setAutoResumeSecondsLeft(null);
      autoResumeArmedForRef.current = null;
      return;
    }
    const spellKey = `${session.id}:${session.updated_at}`;
    if (autoResumeArmedForRef.current === spellKey) return;
    autoResumeArmedForRef.current = spellKey;
    setAutoResumeSecondsLeft(autoResumePref && autoResumePref > 0 ? autoResumePref : null);
  }, [parallelSession.session, autoResumePref]);

  useEffect(() => {
    if (autoResumeSecondsLeft == null) return;
    if (autoResumeSecondsLeft <= 0) {
      setAutoResumeSecondsLeft(null);
      void handleParallelResume();
      return;
    }
    const timer = setTimeout(() => {
      setAutoResumeSecondsLeft((s) => (s == null ? null : s - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [autoResumeSecondsLeft, handleParallelResume]);

  const handleCancelAutoResume = useCallback(() => {
    setAutoResumeSecondsLeft(null);
  }, []);

  useEffect(() => {
    if (parallelSessionId != null) return;
    let cancelled = false;
    getActiveDialerSession()
      .then(async (session) => {
        if (cancelled || !session) return;
        if (
          session.state === 'paused_agent_lost' &&
          Date.now() - new Date(session.stateSince).getTime() > LEFTOVER_LINE_LOST_MS &&
          (await endLeftoverSession(session.sessionId))
        ) {
          return;
        }
        if (!cancelled) {
          setRestoredParallelContext({
            sessionId: session.sessionId,
            campaignId: session.campaignId,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [parallelSessionId]);

  // UI-6: on a refresh that restores a session already sitting in paused_agent_lost, re-join
  // automatically instead of waiting for the intern to notice and click the manual Reconnect
  // button (still rendered by DialerStateBanner as the fallback/retry path).
  //
  // Review fix (L1 round-3, review-notes-r3.md, MAJOR 2): this used to fire as soon as the
  // polled session read paused_agent_lost, with no check that the WebRTC client was actually
  // registered yet. Now gated on `agentLineReady`.
  //
  // Review fix (L1r4 round 5, review-notes-r4.md, MAJOR): the round-3 fix's once-guard was
  // keyed on `session.agent_leg_id` alone -- but `reconnectAgentLeg` (dialer-engine.ts) relinks
  // `agent_leg_id` to the NEW leg at INSERT time, not once it answers (the round-3 fix's own
  // comment had this backwards). So the very next poll after calling reconnect still reads
  // `state === 'paused_agent_lost'` (that only changes once the new leg answers) but a DIFFERENT
  // `agent_leg_id` (the new leg) -- the old guard saw a "new" id and fired a SECOND reconnect
  // immediately, hitting the server's own re-entrancy check (409 RECONNECT_ALREADY_IN_FLIGHT,
  // an error toast on every single drop), or worse, actually dialing a real third leg if the
  // second one failed fast enough (a ring loop bounded only by how fast legs fail).
  //
  // Fixed with two independent changes:
  // 1. Only auto-fire when the CURRENTLY-referenced agent leg's own state is 'ended' -- true for
  //    the just-lost leg (that's what "lost" means), but false for a leg this same effect just
  //    redialed (which starts 'initiated'/dialing, not 'ended') even though its DIFFERENT id
  //    would have fooled the old id-keyed guard.
  // 2. A per-drop attempt budget, not a per-leg-id one: `autoReconnectAttemptedRef` is set once
  //    an attempt fires and only clears when the session actually LEAVES paused_agent_lost
  //    (rearming for the next genuinely new drop) -- so even a leg that ends quickly after a
  //    failed reconnect attempt does not trigger a second automatic retry; the manual Reconnect
  //    button (still rendered by DialerStateBanner) is the only way to try again after that.
  const autoReconnectAttemptedRef = useRef(false);
  useEffect(() => {
    const session = parallelSession.session;
    if (!session || session.state !== 'paused_agent_lost') {
      autoReconnectAttemptedRef.current = false;
      return;
    }
    if (!isAgentLineOwner) return;
    if (!agentLineReady) return;
    if (autoReconnectAttemptedRef.current) return;
    const currentAgentLeg = parallelSession.legs.find(
      (l) => l.kind === 'agent' && l.id === session.agent_leg_id
    );
    if (currentAgentLeg?.state !== 'ended') return;
    autoReconnectAttemptedRef.current = true;
    void handleReconnectAgentLine();
  }, [
    parallelSession.session,
    parallelSession.legs,
    isAgentLineOwner,
    agentLineReady,
    handleReconnectAgentLine,
  ]);

  // Runs after `effectiveSessionId` (and therefore this hook's own `sessionId` option) has
  // actually committed in a render -- the point at which the exact-match path in
  // useTelnyxCall.ts is guaranteed wired up, so the broader "any agent-kind call" expectation
  // from handleStartSessionForCampaign below is safe to drop. See that function's own comment.
  useEffect(() => {
    if (effectiveSessionId) endAgentLegExpectation();
  }, [effectiveSessionId, endAgentLegExpectation]);

  // TASK-L7: the campaign list backing the "start a session" panel, shown whenever there's no
  // active session. Re-fires once a session ends (effectiveSessionId back to null) for a fresh
  // queued-count.
  useEffect(() => {
    if (effectiveSessionId) return;
    let cancelled = false;
    setAssignedCampaigns(null);
    setCampaignsError(null);
    listCampaigns()
      .then((campaigns) => {
        if (!cancelled) setAssignedCampaigns(campaigns);
      })
      .catch((e) => {
        if (!cancelled) {
          setCampaignsError(e instanceof Error ? e.message : 'Failed to load campaigns');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveSessionId]);

  /**
   * TASK-L1 x L5 redesign, delivered here: this hook's WebRTC client is now the ONLY one
   * registered anywhere in the app (CampaignManageModal no longer runs its own pre-flight
   * client -- see this task's own commit). Registering fully BEFORE calling startDialerSession
   * closes most of the L1x L5 race (the server dials the agent leg synchronously, before the
   * HTTP response returns); `beginAgentLegExpectation` closes the remainder (the brief window
   * between "server may have already dialed" and "this hook's own sessionId option is set to
   * the real id it's about to learn") -- see that function's own comment in useTelnyxCall.ts.
   */
  const handleStartSessionForCampaign = useCallback(
    async (campaign: CampaignWithStats) => {
      if (campaign.total_contacts === 0) {
        toast.error('Add contacts before starting a session');
        return;
      }
      // Defense-in-depth (the Start button itself is not rendered for a non-owner tab, see the
      // early return in this component's JSX below) -- never register a client or dial from a
      // tab that isn't the single-tab-lock owner, even if this were somehow reached anyway.
      if (!isAgentLineOwner) {
        setStartError(
          isViewOnly
            ? VIEW_ONLY_MESSAGE
            : 'HyperDial is open in another tab. Close it there first, then try again.'
        );
        return;
      }
      setStartError(null);
      setStartingCampaignId(campaign.id);
      try {
        // Mic-permission pre-check (L1 re-review MAJOR): fail fast and clearly instead of a
        // silent ~25s ring inside the SDK's own call.answer() on a denied/unavailable mic.
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          setStartError(
            'Microphone access is required to take calls. Allow microphone access and try again.'
          );
          return;
        }
        if (!agentLineReady) {
          try {
            await connectAgentLine();
          } catch (err) {
            setStartError(err instanceof Error ? err.message : "Couldn't register your phone line");
            return;
          }
        }
        beginAgentLegExpectation();
        let started = false;
        try {
          let result: Awaited<ReturnType<typeof startDialerSession>>;
          try {
            result = await startDialerSession({ campaignId: campaign.id });
          } catch (err) {
            // An older session is still open on the server (another tab or device, or one the
            // page didn't restore) -- end it and start this one, which is what the intern asked
            // for. If it can't be ended (a prospect is still on the line from it), the outer
            // catch opens it instead.
            if (!(err instanceof ActiveSessionExistsError)) throw err;
            if (!(await endLeftoverSession(err.existingSessionId))) throw err;
            result = await startDialerSession({ campaignId: campaign.id });
          }
          const { sessionId, warning } = result;
          started = true;
          // Deliberately NOT clearing the expectation flag here: setting this state only
          // QUEUES a re-render, and the hook's `optionsRef` (which the exact-match path
          // reads) only picks up the real sessionId once that render actually commits. See
          // the effect below, keyed on `effectiveSessionId`, which clears it once that render
          // has genuinely happened -- clearing here would reopen the exact race this exists
          // to close, for the window between this line and that commit.
          setRestoredParallelContext({ sessionId, campaignId: campaign.id });
          toast.success('Parallel dialing session started');
          // TASK-SP2: a low balance never blocks Go Ready anymore -- it only warns, non-blocking,
          // alongside the success toast above.
          if (warning) toast.warning(warning.message);
        } finally {
          if (!started) endAgentLegExpectation();
        }
      } catch (e) {
        if (e instanceof ActiveSessionExistsError) {
          // Only reached when the older session couldn't be ended -- someone is still on the
          // line from it. Sessions are per agent, not per campaign (SEC-8), so it can belong to a
          // different campaign than the one clicked: look up the real one and open it.
          const existingSessionId = e.existingSessionId;
          let campaignId = campaign.id;
          try {
            campaignId = (await getDialerSession(existingSessionId)).session.campaign_id;
          } catch {
            // Fall back to the clicked campaign; the session view loads by session id anyway.
          }
          setRestoredParallelContext({ sessionId: existingSessionId, campaignId });
          toast.warning(
            'Your earlier session still has a call open -- opened it so you can finish.'
          );
          return;
        }
        setStartError(e instanceof Error ? e.message : 'Failed to start session');
      } finally {
        setStartingCampaignId(null);
      }
    },
    [
      isAgentLineOwner,
      agentLineReady,
      connectAgentLine,
      beginAgentLegExpectation,
      endAgentLegExpectation,
    ]
  );

  // TASK-L7: CampaignManageModal's Start button no longer starts a session itself (that was
  // the L1x L5 blocker's root cause -- a second WebRTC client). It just navigates here and
  // leaves a same-tab intent for which campaign to start; consumed exactly once per mount, and
  // only once the real campaign list has loaded (consuming it any earlier would drop it, since
  // the intent store clears itself on read).
  useEffect(() => {
    if (effectiveSessionId) return;
    if (!assignedCampaigns) return;
    if (pendingIntentConsumedRef.current) return;
    pendingIntentConsumedRef.current = true;
    const pendingCampaignId = consumePendingStartCampaignId();
    if (!pendingCampaignId) return;
    const campaign = assignedCampaigns.find((c) => c.id === pendingCampaignId);
    if (campaign) void handleStartSessionForCampaign(campaign);
  }, [effectiveSessionId, assignedCampaigns, handleStartSessionForCampaign]);

  // When cached numbers load, select first if none selected
  useEffect(() => {
    const stillValid = userNumbers.some((n) => n.phone_number === selectedFromNumber);
    if (selectedFromNumber && stillValid) return;
    // TASK-H23 (C): own number, then the pool -- never "the newest number in the org".
    const pick = pickCallerId(userNumbers, user?.id);
    setSelectedFromNumber(pick ? pick.phone_number : null);
  }, [userNumbers, selectedFromNumber, user?.id]);

  // Create remote audio element outside React so Telnyx SDK never sees React fiber (avoids "Converting circular structure to JSON")
  const remoteAudioCreated = useRef(false);
  useEffect(() => {
    if (remoteAudioCreated.current) return;
    if (typeof document === 'undefined') return;
    let el = document.getElementById(REMOTE_AUDIO_ID) as HTMLAudioElement | null;
    if (!el) {
      el = document.createElement('audio');
      el.id = REMOTE_AUDIO_ID;
      el.setAttribute('autoplay', '');
      el.setAttribute('playsinline', '');
      el.className = 'hidden';
      document.body.appendChild(el);
    }
    remoteAudioCreated.current = true;
    return () => {
      el?.remove();
      remoteAudioCreated.current = false;
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    if (callState === 'connected') {
      timer = setInterval(() => setCallDuration((prev) => prev + 1), 1000);
    } else {
      setCallDuration(0);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [callState]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleDial = async (phoneNumber: string) => {
    if (!selectedFromNumber) return;
    // Defense-in-depth, see handleStartSessionForCampaign's own comment -- the manual dialer UI
    // is not rendered at all for a non-owner tab.
    if (!isAgentLineOwner) {
      toast.error(
        isViewOnly
          ? VIEW_ONLY_MESSAGE
          : 'HyperDial is open in another tab. Close it there first, then try again.'
      );
      return;
    }
    setOutboundNumber(phoneNumber);
    try {
      await dial(phoneNumber, selectedFromNumber);
    } catch (err) {
      console.error('Dial error:', err);
    }
  };

  const handleEndCall = () => {
    hangup();
    setOutboundNumber('');
  };

  /** In parallel mode, end the live contact call via backend; otherwise end the browser call.
   *  TASK-I1: also covers hanging up a caller bridged in via inbound routing (no contact leg,
   *  `parallelSession.inboundCall` instead of `connectedContactId`) -- dialer-session-hangup-
   *  live's own new branch handles that server-side. */
  const handleEndLiveCallParallel = useCallback(async () => {
    if (!effectiveSessionId) return;
    if (!parallelSession.connectedContactId && !parallelSession.inboundCall) return;
    try {
      await parallelSession.endLiveCall();
      toast.success('Call ended');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to end call');
    }
  }, [
    effectiveSessionId,
    parallelSession.connectedContactId,
    parallelSession.inboundCall,
    parallelSession.endLiveCall,
  ]);

  const dialerStatus: DialerStatus =
    callState === 'idle' || callState === 'ended'
      ? 'idle'
      : callState === 'dialing' || callState === 'ringing'
        ? 'dialing'
        : 'connected';

  const isParallelMode = Boolean(
    effectiveCampaignId && (parallelSession.sessionId ?? effectiveSessionId)
  );
  const resolvedCount =
    parallelSession.connected + parallelSession.voicemail + parallelSession.noAnswer;
  // Full-screen spinner only before the first snapshot: once a session is on screen, a refetch
  // (after Hold, Resume, a wrap-up submit, ...) must not unmount the dialer UI and the forms in it.
  const isParallelLoading = isParallelMode && parallelSession.loading && !parallelSession.session;
  const connectedContactPreview =
    parallelSession.currentBatchContacts.find((c) => c.id === parallelSession.connectedContactId) ??
    null;

  const handleParallelPause = useCallback(
    async (reason: string) => {
      if (!parallelSession.sessionId) {
        toast.error('Session not loaded yet');
        return;
      }
      try {
        await parallelSession.pause(reason);
        toast.success('Dialing paused');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to pause');
      }
    },
    [parallelSession.sessionId, parallelSession.pause]
  );

  // MISSION-5 TASK-M5-B2: "raise hand" -- hotkey R, or the button (ParallelDialerUI). Toggles
  // off the current raised_hand_at value read straight off the session (not local component
  // state) so a poll-driven auto-clear (call ended, or a manager started coaching) is reflected
  // immediately -- the very next press always means "raise", never a stale "clear" from before
  // the auto-clear happened.
  const handleToggleRaiseHand = useCallback(async () => {
    if (!parallelSession.sessionId) return;
    const currentlyRaised = Boolean(parallelSession.session?.raised_hand_at);
    try {
      await parallelSession.setRaisedHand(!currentlyRaised);
      toast.success(currentlyRaised ? 'Hand lowered' : 'Hand raised -- your manager was notified');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update raised-hand status');
    }
  }, [parallelSession.sessionId, parallelSession.session, parallelSession.setRaisedHand]);

  // MISSION-5 TASK-M5-B2: a manager's remote "End session" that had to defer (a live call was in
  // progress) finally took effect -- the poll picks up `state === 'stopped'` with the exact
  // sentinel pause_reason `stopSession`/`submit_disposition` both write ONLY for this path (see
  // dialer-engine.ts's own comment on it), never for a self-service Stop. useDialerSession's own
  // ACTIVE_SESSION_STATES excludes 'stopped', so polling has already stopped by the time this
  // fires -- reset the same local state handleParallelStop's own self-service path already does,
  // so the view doesn't sit frozen on a dead session with no explanation.
  useEffect(() => {
    if (
      parallelSession.session?.state === 'stopped' &&
      parallelSession.session.pause_reason === 'remote_end_by_manager'
    ) {
      setRestoredParallelContext(null);
      onClearParallelContext?.();
      toast('Your session was ended by a manager');
    }
  }, [parallelSession.session, onClearParallelContext]);

  const handleParallelStop = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!parallelSession.sessionId) {
        toast.error('Session not loaded yet');
        return;
      }
      try {
        await parallelSession.stop(opts);
        setRestoredParallelContext(null);
        onClearParallelContext?.();
        toast.success('Session stopped');
      } catch (e) {
        // BUG-11: the confirm dialog (ParallelDialerUI) is what normally prevents this --
        // seeing it here means a human connected in the moment between the UI's last poll and
        // this click. Surface it plainly rather than the generic failure message so the intern
        // understands why Stop didn't work, and just re-clicking Stop shows the real dialog.
        if (e instanceof LiveCallInProgressError) {
          toast.error('A prospect just connected -- click Stop again to confirm.');
          await parallelSession.loadSession(parallelSession.sessionId);
          return;
        }
        toast.error(e instanceof Error ? e.message : 'Failed to stop session');
      }
    },
    [
      parallelSession.sessionId,
      parallelSession.stop,
      parallelSession.loadSession,
      onClearParallelContext,
    ]
  );

  // TASK-T7: global hotkeys for the parallel dialer -- M (mute), H (hold), Space (resume from
  // paused), ? (toggle help). Never fires while typing (isTypingTarget guard, see lib/keyboard.ts)
  // or outside parallel mode -- WrapUpModal's own separate digit-shortcut keydown listener is
  // untouched; gating M/H on `on_call` means the two never compete for the same keystroke (wrap_up
  // is a different session state entirely).
  useEffect(() => {
    if (!isParallelMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;
      if (e.key === '?') {
        e.preventDefault();
        setShowHotkeyHelp((v) => !v);
        return;
      }
      const session = parallelSession.session;
      if (!session) return;
      if (e.key === 'm' || e.key === 'M') {
        if (session.state !== 'on_call') return;
        e.preventDefault();
        handleToggleMute(!isMuted);
        return;
      }
      if (e.key === 'h' || e.key === 'H') {
        if (session.state !== 'on_call') return;
        // TASK-T4: hold doesn't apply while parked in a warm-connected transfer's side
        // conference -- mirrors LiveCallPanel's own UI gate for the exact same state.
        const transfer = parallelSession.activeTransfer;
        if (transfer?.type === 'warm' && transfer.status === 'connected') return;
        e.preventDefault();
        if (parallelSession.heldAt) {
          void parallelSession.unhold();
        } else {
          void parallelSession.hold();
        }
        return;
      }
      if (e.key === ' ') {
        // "Resume/Next": plain manual pause -> Resume; paused/post_wrapup mid-countdown ->
        // skip the wait. Clear the countdown FIRST so its own pending setTimeout doesn't also
        // fire and attempt a second (harmless but confusing, 409-then-toast) resume call.
        if (session.state !== 'paused') return;
        e.preventDefault();
        setAutoResumeSecondsLeft(null);
        void handleParallelResume();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        // MISSION-5 TASK-M5-B2: "during a call or session" -- any non-terminal state, not just
        // on_call, unlike M/H which only ever make sense mid-call.
        e.preventDefault();
        void handleToggleRaiseHand();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isParallelMode,
    parallelSession.session,
    parallelSession.activeTransfer,
    parallelSession.heldAt,
    parallelSession.hold,
    parallelSession.unhold,
    isMuted,
    handleToggleMute,
    handleParallelResume,
    handleToggleRaiseHand,
  ]);

  // TASK-M5-G6: the Inbox's "Call back" action leaves a same-tab pending number here (same
  // module-level handoff shape as the campaign-start intent above) instead of threading a prop
  // through MainApp.tsx. Consumed once selectedFromNumber is ready and only when the existing
  // manual-dial path is actually the one in use (not mid parallel-dial session) -- reuses
  // ManualDialPanel's own onDial handler rather than a second dial-triggering path.
  useEffect(() => {
    if (!hasPendingManualDialNumber()) return;
    // Not ready (numbers still loading): leave it pending and re-run when they load. Every other
    // outcome consumes the number, so it can never dial later by surprise.
    const action = decidePendingDial({
      numbersLoading,
      isViewOnly,
      isAgentLineOwner,
      inParallelSession: isParallelMode && !parallelSession.error,
      callActive: dialerStatus !== 'idle',
      hasFromNumber: Boolean(selectedFromNumber),
      viewOnlyMessage: VIEW_ONLY_MESSAGE,
    });
    if (action.kind === 'wait') return;
    if (action.kind === 'refuse') {
      consumePendingManualDialNumber();
      toast.error(action.message);
      return;
    }
    const pendingNumber = consumePendingManualDialNumber();
    if (!pendingNumber) return;
    void handleDial(pendingNumber);
  }, [
    pendingDialTick,
    numbersLoading,
    isAgentLineOwner,
    selectedFromNumber,
    isParallelMode,
    parallelSession.error,
    dialerStatus,
    handleDial,
  ]);

  return (
    <div className="flex h-full">
      {/* Remote audio is created in useEffect (outside React tree) to avoid circular ref in Telnyx SDK */}

      {/* TASK-T3: a portal, not a normal child -- this component's own wrapper div is
          CSS-`display:none` while another tab is active (MainApp.tsx), but the coaching leg
          lives on this SAME always-mounted WebRTC client regardless of which tab is showing, so
          the banner needs to render into `document.body` directly to stay visible across every
          tab switch, not just while the Dialer tab happens to be active. */}
      {activeCoaching &&
        createPortal(
          <CoachingBanner
            coachingId={activeCoaching.coachingId}
            mode={activeCoaching.mode}
            targetSessionId={activeCoaching.targetSessionId}
            onModeChanged={setActiveCoachingMode}
            onLeave={hangup}
          />,
          document.body
        )}

      {/* Center Panel - Dialing Interface */}
      <div className="flex-1 bg-surface-0 p-4 sm:p-8 overflow-y-auto">
        {/* MISSION-5 TASK-M5-A6: today's goal progress + any active broadcast for this agent.
            Both are self-contained (own fetch/poll) and render nothing when there's nothing to
            show, so they're safe to always mount here regardless of dialer state. */}
        <div className="max-w-2xl mx-auto mb-6">
          <MyGoalHeader />
        </div>
        <BroadcastBanner />
        <ShiftDialerBanner
          sessionActive={
            isParallelMode &&
            !isParallelLoading &&
            !parallelSession.error &&
            !!parallelSession.session
          }
        />
        {/* MISSION-5 TASK-M5-E2: compact live power-hour board, same self-contained/renders-
            nothing-when-idle shape as the two above. */}
        <PowerHourLiveBanner />
        {pendingInboundCall && (
          <IncomingCallBanner
            fromE164={pendingInboundCall.fromE164}
            contactName={pendingCallContactName}
            onAnswer={answerPendingInboundCall}
            onDecline={declinePendingInboundCall}
          />
        )}
        {isParallelMode && parallelSession.error && (
          <div className="max-w-2xl mx-auto rounded-app-lg border border-danger/30 bg-surface-1 p-6 mb-6">
            <p className="text-danger font-medium mb-2">Could not load parallel session</p>
            <p className="text-text-secondary text-body mb-4">{parallelSession.error}</p>
            <p className="text-text-secondary text-body">
              Use manual dial below to place single calls.
            </p>
          </div>
        )}
        {isParallelLoading && (
          <div className="max-w-3xl mx-auto flex flex-col items-center justify-center py-20 text-text-secondary">
            <div className="w-10 h-10 border-2 border-accent-to border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-text-primary font-medium">Loading parallel dialing session…</p>
          </div>
        )}
        {isParallelMode &&
          !isParallelLoading &&
          !parallelSession.error &&
          parallelSession.session && (
            <>
              {parallelSession.refreshError && (
                <div className="max-w-3xl mx-auto mb-3 p-3 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-meta">
                  Lost contact with the server ({parallelSession.refreshError}). Retrying -- what
                  you see may be a few seconds old.
                </div>
              )}
              <DialerStateBanner
                sessionState={parallelSession.session.state}
                pauseReason={parallelSession.session.pause_reason}
                hasDialNumber={dialableNumbers(allNumbers, user?.id, false).length > 0}
                takenOverByManagerName={parallelSession.takenOverByManagerName}
                ringingCount={parallelSession.currentBatchContacts.length}
                connectedContact={connectedContactPreview}
                connectedAnsweredAt={parallelSession.connectedAnsweredAt}
                webrtcReady={agentLineReady}
                webrtcConnecting={agentLineConnecting}
                webrtcError={error}
                onReconnect={() => void handleReconnectAgentLine()}
                reconnecting={parallelSession.loading}
                onResume={() => void handleParallelResume()}
                resuming={parallelSession.loading}
                autoResumeSecondsLeft={autoResumeSecondsLeft}
                onCancelAutoResume={handleCancelAutoResume}
              />
              <ParallelDialerUI
                sessionState={parallelSession.session.state}
                lines={parallelSession.session.lines}
                amdMode={parallelSession.session.amd_mode}
                callsMade={parallelSession.callsMade}
                connected={parallelSession.connected}
                voicemail={parallelSession.voicemail}
                noAnswer={parallelSession.noAnswer}
                resolvedCount={resolvedCount}
                totalContacts={parallelSession.totalContacts}
                progress={parallelSession.progress}
                batchContacts={parallelSession.currentBatchContacts}
                answeredContactId={parallelSession.answeredContactId}
                connectedContactId={parallelSession.connectedContactId}
                connectedLegId={parallelSession.connectedLegId}
                connectedAnsweredAt={parallelSession.connectedAnsweredAt}
                inboundCall={parallelSession.inboundCall}
                coachingMode={parallelSession.coachingMode}
                heldAt={parallelSession.heldAt}
                recordingStatus={parallelSession.recordingStatus}
                onToggleRecording={() => void parallelSession.toggleRecording()}
                activeTransfer={parallelSession.activeTransfer}
                connectedContact={parallelSession.connectedContact}
                connectedContactHistory={parallelSession.connectedContactHistory}
                campaignScript={parallelSession.campaignScript}
                pendingCampaignScript={parallelSession.pendingCampaignScript}
                onApplyPendingCampaignScript={parallelSession.applyPendingCampaignScript}
                onPause={handleParallelPause}
                pauseReasons={pauseReasons}
                onResume={() => void handleParallelResume()}
                onStop={(opts) => void handleParallelStop(opts)}
                muted={isMuted}
                onAutoResumePrefChange={setAutoResumePref}
                onMuteChange={handleToggleMute}
                onEndLiveCall={handleEndLiveCallParallel}
                sessionId={parallelSession.sessionId}
                onHoldCall={() => void parallelSession.hold()}
                onResumeCall={() => void parallelSession.unhold()}
                onStartTransfer={async (args) => {
                  await parallelSession.beginTransfer(args);
                }}
                onCompleteTransfer={() => void parallelSession.completeActiveTransfer()}
                onCancelTransfer={() => void parallelSession.cancelActiveTransfer()}
                raisedHandAt={parallelSession.session.raised_hand_at}
                onToggleRaiseHand={() => void handleToggleRaiseHand()}
              />
              {/* wrap_up (TASK-L2b): the modal is the ONLY way out (no "Continue" bypass) --
                submit_disposition (SQL) moves the session wrap_up -> dialing itself; onSubmitted
                just re-polls so this component naturally stops rendering once the session has
                moved on. Deriving `wrapUpLeg` purely from the current legs snapshot (not from
                having "seen" the call go live) is what makes a page refresh mid-wrap_up correctly
                re-open this same modal, per this task's own spec line. */}
              {parallelSession.session.state === 'wrap_up' && parallelSession.wrapUpLeg && (
                <WrapUpModal
                  key={parallelSession.wrapUpLeg.legId}
                  sessionId={parallelSession.session.id}
                  legId={parallelSession.wrapUpLeg.legId}
                  contact={parallelSession.wrapUpLeg.contact}
                  callDurationSeconds={parallelSession.wrapUpLeg.callDurationSeconds}
                  onSubmitted={() => {
                    void parallelSession.loadSession(parallelSession.session!.id);
                  }}
                />
              )}
            </>
          )}

        {!isViewOnly && (!isParallelMode || parallelSession.error) && (
          <StartSessionPanel
            campaigns={assignedCampaigns}
            campaignsError={campaignsError}
            userNumbers={userNumbers}
            startingCampaignId={startingCampaignId}
            micRegistering={agentLineConnecting}
            startError={startError}
            onStart={(campaign) => void handleStartSessionForCampaign(campaign)}
          />
        )}

        {(!isParallelMode || parallelSession.error) && <CallForwardingCard />}

        {!isViewOnly && (!isParallelMode || parallelSession.error) && (
          <ManualDialPanel
            userNumbers={userNumbers}
            selectedFromNumber={selectedFromNumber}
            onSelectNumber={setSelectedFromNumber}
            onDial={handleDial}
            dialerStatus={dialerStatus}
            error={error}
            outboundNumber={outboundNumber}
            callDurationFormatted={formatDuration(callDuration)}
            onEndCall={handleEndCall}
            onMuteChange={setMuted}
            onNavigateToSettings={onNavigateToSettings}
          />
        )}
      </div>

      {isParallelMode && showHotkeyHelp && (
        <HotkeyHelpOverlay onClose={() => setShowHotkeyHelp(false)} />
      )}

      {/* Right Panel - Campaign Stats */}
      <CampaignStats userNumbers={userNumbers} />
    </div>
  );
}
