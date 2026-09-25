import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { useTelnyxCall } from '../lib/useTelnyxCall';
import { usePhoneNumbers } from '@/contexts/PhoneNumbersContext';
import { CampaignStats } from './dialer/CampaignStats';
import { useDialerSession } from '@/hooks/useDialerSession';
import { ParallelDialerUI } from './dialer/ParallelDialerUI';
import { DialerStateBanner } from './dialer/DialerStateBanner';
import { WrapUpModal } from './dialer/WrapUpModal';
import { StartSessionPanel } from './dialer/StartSessionPanel';
import { ManualDialPanel } from './dialer/ManualDialPanel';
import {
  getActiveDialerSession,
  getDialerSession,
  listCampaigns,
  startDialerSession,
  ActiveSessionExistsError,
  ReconnectAlreadyInFlightError,
  type CampaignWithStats,
} from '@/lib/api';
import { playConnectChime } from '@/lib/dialerSoundCue';
import { consumePendingStartCampaignId } from '@/lib/dialerLaunchIntent';
import { useSingleTabLock } from '@/lib/useSingleTabLock';

const REMOTE_AUDIO_ID = 'telnyx-remote-audio';

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
  const { numbers: userNumbers } = usePhoneNumbers();
  const [selectedFromNumber, setSelectedFromNumber] = useState<string | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [outboundNumber, setOutboundNumber] = useState('');

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
  const [startConflict, setStartConflict] = useState<{
    campaignId: string;
    campaignName: string;
    existingSessionId: string;
  } | null>(null);
  const pendingIntentConsumedRef = useRef(false);

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
  } = useTelnyxCall({
    remoteElementId: REMOTE_AUDIO_ID,
    sessionId: effectiveSessionId ?? undefined,
  });

  // Proactively register the WebRTC client the moment there's a parallel session to serve --
  // the agent leg's inbound call has nowhere to be auto-answered until this has run. Covers
  // restoring an already-active session on mount/refresh; a fresh Start already registers
  // (mic check -> connect -> Go Ready) inside handleStartSessionForCampaign below before this
  // effect would ever need to. dialer-engine.ts's agentSipUri no longer has a registration
  // backstop to fall back on -- it's self-healing (get-or-create) regardless of whether the
  // browser has connected yet, so this effect running promptly is what makes the agent leg's
  // inbound call actually answerable, not just a nice-to-have.
  useEffect(() => {
    if (!effectiveSessionId) return;
    if (!isAgentLineOwner) return;
    if (agentLineReady || agentLineConnecting) return;
    connectAgentLine().catch(() => {
      // Surfaced via useTelnyxCall's own `error` state; DialerStateBanner renders it.
    });
  }, [effectiveSessionId, isAgentLineOwner, agentLineReady, agentLineConnecting, connectAgentLine]);

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

  useEffect(() => {
    if (parallelSessionId != null) return;
    let cancelled = false;
    getActiveDialerSession()
      .then((session) => {
        if (!cancelled && session) setRestoredParallelContext(session);
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
        setStartError('HyperDial is open in another tab. Close it there first, then try again.');
        return;
      }
      setStartError(null);
      setStartConflict(null);
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
          const { sessionId } = await startDialerSession({ campaignId: campaign.id });
          started = true;
          // Deliberately NOT clearing the expectation flag here: setting this state only
          // QUEUES a re-render, and the hook's `optionsRef` (which the exact-match path
          // reads) only picks up the real sessionId once that render actually commits. See
          // the effect below, keyed on `effectiveSessionId`, which clears it once that render
          // has genuinely happened -- clearing here would reopen the exact race this exists
          // to close, for the window between this line and that commit.
          setRestoredParallelContext({ sessionId, campaignId: campaign.id });
          toast.success('Parallel dialing session started');
        } finally {
          if (!started) endAgentLegExpectation();
        }
      } catch (e) {
        if (e instanceof ActiveSessionExistsError) {
          // Review fix (minor, L1r4/review-notes-r3.md): sessions are per-agent, not
          // per-campaign (SEC-8) -- the existing session this 409 refers to can belong to a
          // completely different campaign than the one just clicked. Look up the real session
          // so both the conflict banner's text and "Open it" reflect what's ACTUALLY running,
          // not the campaign the agent happened to click Start on.
          const existingSessionId = e.existingSessionId;
          try {
            const { session: existingSession } = await getDialerSession(existingSessionId);
            const existingCampaign = assignedCampaigns?.find(
              (c) => c.id === existingSession.campaign_id
            );
            setStartConflict({
              campaignId: existingSession.campaign_id,
              campaignName: existingCampaign?.name ?? 'another campaign',
              existingSessionId,
            });
          } catch {
            // Couldn't resolve the real session -- fall back to the attempted campaign's own
            // name/id so the banner still renders; "Open it" may point at the wrong campaign
            // in this fallback case only (unchanged from before this fix).
            setStartConflict({
              campaignId: campaign.id,
              campaignName: campaign.name,
              existingSessionId,
            });
          }
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
      assignedCampaigns,
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

  const handleOpenStartConflict = useCallback(() => {
    if (!startConflict) return;
    setRestoredParallelContext({
      sessionId: startConflict.existingSessionId,
      campaignId: startConflict.campaignId,
    });
    setStartConflict(null);
  }, [startConflict]);

  // When cached numbers load, select first if none selected
  useEffect(() => {
    if (userNumbers.length > 0 && !selectedFromNumber) {
      setSelectedFromNumber(userNumbers[0].phone_number);
    }
  }, [userNumbers, selectedFromNumber]);

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
      toast.error('HyperDial is open in another tab. Close it there first, then try again.');
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

  /** In parallel mode, end the live contact call via backend; otherwise end the browser call. */
  const handleEndLiveCallParallel = useCallback(async () => {
    if (!effectiveSessionId || !parallelSession.connectedContactId) return;
    try {
      await parallelSession.endLiveCall();
      toast.success('Call ended');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to end call');
    }
  }, [effectiveSessionId, parallelSession.connectedContactId, parallelSession.endLiveCall]);

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
  const isParallelLoading = isParallelMode && parallelSession.loading;
  const connectedContactPreview =
    parallelSession.currentBatchContacts.find((c) => c.id === parallelSession.connectedContactId) ??
    null;

  const handleParallelPause = useCallback(async () => {
    if (!parallelSession.sessionId) {
      toast.error('Session not loaded yet');
      return;
    }
    try {
      await parallelSession.pause();
      toast.success('Dialing paused');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to pause');
    }
  }, [parallelSession.sessionId, parallelSession.pause]);

  const handleParallelStop = useCallback(async () => {
    if (!parallelSession.sessionId) {
      toast.error('Session not loaded yet');
      return;
    }
    try {
      await parallelSession.stop();
      setRestoredParallelContext(null);
      onClearParallelContext?.();
      toast.success('Session stopped');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to stop session');
    }
  }, [parallelSession.sessionId, parallelSession.stop, onClearParallelContext]);

  return (
    <div className="flex h-full">
      {/* Remote audio is created in useEffect (outside React tree) to avoid circular ref in Telnyx SDK */}

      {/* Center Panel - Dialing Interface */}
      <div className="flex-1 bg-surface-0 p-4 sm:p-8 overflow-y-auto">
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
              <DialerStateBanner
                sessionState={parallelSession.session.state}
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
                connectedAnsweredAt={parallelSession.connectedAnsweredAt}
                onPause={handleParallelPause}
                onResume={() => void handleParallelResume()}
                onStop={() => void handleParallelStop()}
                onMuteChange={setMuted}
                onEndLiveCall={handleEndLiveCallParallel}
              />
              {/* wrap_up (TASK-L2b): the modal is the ONLY way out (no "Continue" bypass) --
                submit_disposition (SQL) moves the session wrap_up -> dialing itself; onSubmitted
                just re-polls so this component naturally stops rendering once the session has
                moved on. Deriving `wrapUpLeg` purely from the current legs snapshot (not from
                having "seen" the call go live) is what makes a page refresh mid-wrap_up correctly
                re-open this same modal, per this task's own spec line. */}
              {parallelSession.session.state === 'wrap_up' && parallelSession.wrapUpLeg && (
                <WrapUpModal
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

        {(!isParallelMode || parallelSession.error) && (
          <StartSessionPanel
            campaigns={assignedCampaigns}
            campaignsError={campaignsError}
            userNumbers={userNumbers}
            startingCampaignId={startingCampaignId}
            micRegistering={agentLineConnecting}
            startError={startError}
            conflict={startConflict}
            onStart={(campaign) => void handleStartSessionForCampaign(campaign)}
            onOpenConflict={handleOpenStartConflict}
            onDismissConflict={() => setStartConflict(null)}
          />
        )}

        {(!isParallelMode || parallelSession.error) && (
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

      {/* Right Panel - Campaign Stats */}
      <CampaignStats userNumbers={userNumbers} />
    </div>
  );
}
