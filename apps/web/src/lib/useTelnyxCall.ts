import { useState, useCallback, useEffect, useRef } from 'react';
import { isViewOnly } from './viewAsFlag';
import { TelnyxRTC } from '@telnyx/webrtc';
import { getWebrtcCredentials } from './api';
import { telnyxErrorToError } from './webrtcRetry';

export type CallState = 'idle' | 'dialing' | 'ringing' | 'connected' | 'ended';

interface UseTelnyxCallOptions {
  remoteElementId?: string;
  /**
   * TASK-L1: when set, this hook ALSO auto-answers an inbound call whose client_state
   * decodes to `{kind:'agent', session: sessionId}` -- the parallel dialer's own agent leg,
   * dialed server-side (dialer-engine.ts's dialAgentLeg/reconnectAgentLeg) from the org's Call
   * Control app into this member's WebRTC credential SIP URI. Every OTHER inbound call
   * (anything that doesn't decode to this exact session) is REJECTED (hung up before
   * answering) -- this hook must never auto-answer a call it wasn't told to expect. Omitted
   * (the legacy single-line manual dialer's usage): every inbound call is rejected the same
   * way, since this usage never expects one at all -- it is not left alone/ignored.
   */
  sessionId?: string;
}

const ACTIVE_AGENT_CALL_CONTROL_ID_KEY = 'hyperdial_active_agent_call_control_id';
/** TASK-L1r4 round 5 (review-notes-r4.md, minor): without this, a TelnyxRTC client that never
 *  fires telnyx.ready OR telnyx.error (a genuinely hung WebSocket, not just a slow one) pins
 *  `connectPromiseRef` forever -- every later `connect()` call (including a fresh Start attempt)
 *  just awaits the same permanently-unsettled promise. */
const CONNECT_TIMEOUT_MS = 15000;

/**
 * Browser-safe port of `supabase/functions/_shared/client-state.ts`'s decode logic -- kept as
 * a small, self-contained copy rather than importing a Deno edge-function module into the web
 * app (that module also assumes `Deno`-side base64/JSON helpers are the only ones in scope;
 * `atob`/`JSON.parse` are the same built-ins in a browser). Never throws -- the input is
 * untrusted (an SDK-reported field off an inbound call notification, not something this app
 * produced), so any malformed value just fails to match and gets rejected below.
 */
function decodeAgentClientState(
  value: unknown
): { org: string; session: string; leg: string; kind: 'agent' | 'contact' } | null {
  if (typeof value !== 'string' || !value) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(atob(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { org, session, leg, kind } = decoded;
  if (
    typeof org !== 'string' ||
    !org ||
    typeof session !== 'string' ||
    !session ||
    typeof leg !== 'string' ||
    !leg
  ) {
    return null;
  }
  return { org, session, leg, kind: kind === 'agent' ? 'agent' : 'contact' };
}

/** TASK-I1: browser-safe port of client-state.ts's InboundClientState decode -- same rationale
 *  as decodeAgentClientState above (distinct shape: `{org, inbound, step}`, no `session`/`leg`
 *  at all). Only `step === 'intern'` ever reaches a browser as a WebRTC invite (the cell/shared
 *  fallback steps transfer to a plain phone number, never this member's SIP credential). */
function decodeInboundRoutingClientState(
  value: unknown
): { org: string; inbound: string; step: string } | null {
  if (typeof value !== 'string' || !value) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(atob(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { org, inbound, step } = decoded;
  if (typeof org !== 'string' || !org || typeof inbound !== 'string' || !inbound) return null;
  if (typeof step !== 'string' || !step) return null;
  return { org, inbound, step };
}

/**
 * TASK-T3: browser-safe port of client-state.ts's CoachingClientState decode -- same rationale
 * as decodeAgentClientState/decodeInboundRoutingClientState above (a distinct shape: `{org,
 * coaching, kind:'coaching'}`, no `session`/`leg`/`inbound`/`step` at all, so it never matches
 * either of those decoders' required fields and can be tried unconditionally after them).
 */
export type CoachingMode = 'listen' | 'whisper' | 'barge';
const COACHING_MODES: CoachingMode[] = ['listen', 'whisper', 'barge'];

function decodeCoachingClientState(
  value: unknown
): { org: string; coaching: string; mode: CoachingMode; targetSession: string } | null {
  if (typeof value !== 'string' || !value) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(atob(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { org, coaching, kind, mode, targetSession } = decoded;
  if (kind !== 'coaching' || typeof org !== 'string' || !org) return null;
  if (typeof coaching !== 'string' || !coaching) return null;
  return {
    org,
    coaching,
    mode: COACHING_MODES.includes(mode as CoachingMode) ? (mode as CoachingMode) : 'listen',
    // TASK-T3 review fix-forward (review-eng1.md #1): only ever used by CoachingBanner's own
    // banner-polling safety layer -- '' (rather than rejecting the whole decode) just means that
    // one UI feature can't run for this leg, same reasoning as client-state.ts's own decoder.
    targetSession: typeof targetSession === 'string' ? targetSession : '',
  };
}

/** The invite's `custom_headers` (TASK-L1: `X-Hyperdial-Session`), as a defense-in-depth
 *  secondary signal alongside client_state -- see telnyx-client.ts's DialArgs header comment.
 *  Not relied on alone: header name/case over the real SIP INVITE wasn't live-verified this
 *  task (NEEDS-LIVE-VERIFY), client_state is the primary, already-structured signal. */
function customHeaderSessionId(customHeaders: unknown): string | null {
  if (!Array.isArray(customHeaders)) return null;
  const header = customHeaders.find(
    (h) => h && typeof h === 'object' && (h as { name?: string }).name === 'X-Hyperdial-Session'
  ) as { value?: string } | undefined;
  return typeof header?.value === 'string' ? header.value : null;
}

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && !phone.startsWith('+')) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return digits;
}

export function useTelnyxCall(options: UseTelnyxCallOptions = {}) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const clientRef = useRef<TelnyxRTC | null>(null);
  const activeCallRef = useRef<{ hangup: () => void } | null>(null);
  /** TASK-I1 (INB-2): an inbound-routing invite (`step:'intern'`) is neither auto-answered nor
   *  auto-rejected -- it's surfaced here for the incoming-call banner (Dialer.tsx) to let the
   *  human Answer/Decline. Cleared on answer/decline or if the OTHER side hangs up first (the
   *  server's own INBOUND_RING_TIMEOUT_SECS elapsed, or the caller themselves hung up). */
  const [pendingInboundCall, setPendingInboundCall] = useState<{
    callId: string;
    fromE164: string | null;
  } | null>(null);
  const pendingInboundCallRef = useRef<{
    id?: string;
    hangup: () => void;
    answer: (params?: { remoteElement?: string }) => void | Promise<void>;
  } | null>(null);
  /** TASK-T3: set for the lifetime of a live-coaching leg this hook auto-answered (see
   *  decodeCoachingClientState's own header above) -- CoachingBanner reads this to know a
   *  coaching call is live and which `coaching_sessions.id` to pass to switchCoachingMode.
   *  Cleared in the same 'hangup'/'destroy'/'purge' branch that clears activeCallRef below, so it
   *  never outlives the real Telnyx leg it describes. */
  const [activeCoaching, setActiveCoaching] = useState<{
    coachingId: string;
    mode: CoachingMode;
    targetSessionId: string;
  } | null>(null);
  /** TASK-L1: the SDK re-fires telnyx.notification repeatedly as an inbound call's state
   *  changes (new -> ringing -> ...) -- decide answer-vs-reject exactly once per call id, not
   *  once per notification, and remember the decision so a REJECTED call's later
   *  notifications (e.g. its own eventual hangup/destroy) never fall through to the normal
   *  state-tracking below and get mistaken for this hook's own active call. `pending` (TASK-I1)
   *  is a third outcome: not yet decided by the human, but already shown on the banner --
   *  later notifications for the SAME call id must still be able to clear it on a hangup. */
  const inboundCallDecisionsRef = useRef<Map<string, 'answered' | 'rejected' | 'pending'>>(
    new Map()
  );
  /** Review fix (M5): `connect()` only ever runs its OWN `telnyx.notification` handler setup
   *  once per underlying TelnyxRTC client (it early-returns if `clientRef.current` already
   *  exists) -- that handler used to read `options.sessionId` directly, closing over
   *  whatever session was passed to THE `connect()` CALL that happened to establish the
   *  connection. A second session in the same mount (or a client first connected with no
   *  sessionId at all, e.g. the manual dialer) never re-ran `connect()` once already
   *  `isReady`, so every later agent-leg INVITE was rejected against a stale/absent session
   *  id. This ref is updated on every render (no dependency array), and the handler reads
   *  `optionsRef.current` instead of closing over `options` -- decoupling "which session to
   *  auto-answer for" from "when the WebSocket connection was first established". */
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /** TASK-L1 re-review (L1×L5 blocker): closes the race where the server dials the agent leg
   *  (synchronously, inside `dialer-session-start`, before the HTTP response returns) before
   *  this hook's caller has learned the real `sessionId` to pass in. Set true for the narrow
   *  window between "about to call startDialerSession" and "got the session id back"; while
   *  true, ANY inbound `kind:'agent'` call is answered regardless of session match (nothing
   *  else can plausibly be inviting this member's WebRTC credential to an agent-kind call in
   *  that window except the start this hook's own caller just issued). Cleared as soon as the
   *  real sessionId is known -- from then on the normal exact-match path above covers it. */
  const expectingAgentLegRef = useRef(false);

  const persistAgentCallControlId = useCallback((maybeCall: unknown) => {
    if (typeof window === 'undefined') return;
    const call = (maybeCall ?? {}) as Record<string, unknown>;
    const candidate =
      (typeof call.call_control_id === 'string' && call.call_control_id) ||
      (typeof call.callControlId === 'string' && call.callControlId) ||
      (typeof call.id === 'string' && call.id) ||
      '';
    if (!candidate) return;
    window.localStorage.setItem(ACTIVE_AGENT_CALL_CONTROL_ID_KEY, candidate);
  }, []);

  /** Review fix (minor, L1r4/review-notes-r3.md): `connect()` used to key its early-return
   *  purely off `clientRef.current` being set -- but that ref is populated synchronously right
   *  after `client.connect()`, well before `telnyx.ready` fires, so a SECOND call made while a
   *  connection was still in flight resolved immediately (as if already connected) instead of
   *  waiting for the real result. Worse, a failed connection (bad token, `telnyx.error`) left
   *  that same now-dead client sitting in `clientRef` forever, so every later `connect()` call
   *  kept resolving immediately against it too -- there was no way to actually retry. This ref
   *  tracks the in-flight promise itself so a second caller awaits the SAME attempt, and the
   *  catch handler below clears `clientRef` on failure so the next call genuinely starts over. */
  const connectPromiseRef = useRef<Promise<void> | null>(null);
  /** Manual-dial failure reporting: whether the current outbound call was ever answered, and
   *  whether the user hung up themselves (neither should show a "could not be placed" error). */
  const outboundAnsweredRef = useRef(false);
  const hangupRequestedRef = useRef(false);

  const connect = useCallback((): Promise<void> => {
    // TASK-H21: a view-as tab must never register a WebRTC client or create Telnyx credentials as the intern.
    if (isViewOnly) return Promise.reject(new Error('View-only'));
    if (connectPromiseRef.current) return connectPromiseRef.current;
    if (clientRef.current) return Promise.resolve();
    setIsConnecting(true);
    setError(null);

    // Review fix (L1r4 round 5, minor): captured outside the IIFE so the outer .catch below can
    // disconnect THIS specific client's own socket on failure, not just drop the reference.
    let pendingClient: TelnyxRTC | null = null;

    const promise = (async () => {
      const { token } = await getWebrtcCredentials();
      if (!token) throw new Error('No token received');

      const client = new TelnyxRTC({ login_token: token });
      pendingClient = client;
      if (optionsRef.current.remoteElementId) {
        client.remoteElement = optionsRef.current.remoteElementId;
      }

      return new Promise<void>((resolve, reject) => {
        // Guards against a stale telnyx.ready/telnyx.error firing AFTER the timeout below has
        // already rejected (or vice versa) -- only the first outcome should ever take effect.
        let settled = false;
        const timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('Timed out connecting to your phone line. Please try again.'));
        }, CONNECT_TIMEOUT_MS);

        client
          .on('telnyx.ready', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            setIsReady(true);
            setIsConnecting(false);
            resolve();
          })
          .on('telnyx.error', (err: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            console.error('Telnyx connection error:', err);
            reject(telnyxErrorToError(err));
          })
          .on(
            'telnyx.notification',
            (notification: {
              type?: string;
              call?: {
                id?: string;
                state?: string;
                direction?: string;
                options?: {
                  clientState?: string;
                  customHeaders?: unknown;
                  remoteCallerNumber?: string;
                };
                cause?: string;
                causeCode?: number;
                sipReason?: string;
                sipCode?: number;
                hangup: () => void;
                answer: (params?: { remoteElement?: string }) => void | Promise<void>;
              };
            }) => {
              if (notification.type !== 'callUpdate' || !notification.call) return;
              const call = notification.call;

              if (call.direction === 'inbound' && call.id) {
                const priorDecision = inboundCallDecisionsRef.current.get(call.id);
                if (priorDecision === 'rejected') return;

                if (priorDecision === 'pending') {
                  // TASK-I1: the human hasn't answered/declined yet -- only a hangup/destroy is
                  // interesting (the server's own ring timeout elapsed, or the caller hung up),
                  // and even then this call was never `activeCallRef`'s concern, so return
                  // either way instead of falling into the general state-tracking below.
                  const pendingState = (call.state || '').toLowerCase();
                  if (
                    pendingState === 'hangup' ||
                    pendingState === 'destroy' ||
                    pendingState === 'purge'
                  ) {
                    inboundCallDecisionsRef.current.delete(call.id);
                    if (pendingInboundCallRef.current?.id === call.id) {
                      pendingInboundCallRef.current = null;
                      setPendingInboundCall(null);
                    }
                  }
                  return;
                }

                if (!priorDecision) {
                  // TASK-T3: checked FIRST, before the agent-leg session-match logic below --
                  // a coaching invite carries neither `session` nor `leg` (a different shape
                  // entirely, see decodeCoachingClientState's own header), so it always fails
                  // decodeAgentClientState's required-fields check and would otherwise fall
                  // through to the inbound-routing/reject branch. It is ALWAYS self-directed
                  // (only THIS manager's own SIP credential could ever receive it -- the server
                  // dialed it specifically to reach this browser), so it's auto-answered
                  // unconditionally, unlike the agent leg's sessionId match.
                  const coaching = decodeCoachingClientState(call.options?.clientState);
                  if (coaching) {
                    inboundCallDecisionsRef.current.set(call.id, 'answered');
                    setActiveCoaching({
                      coachingId: coaching.coaching,
                      mode: coaching.mode,
                      targetSessionId: coaching.targetSession,
                    });
                    const currentOptions = optionsRef.current;
                    Promise.resolve(
                      call.answer(
                        currentOptions.remoteElementId
                          ? { remoteElement: currentOptions.remoteElementId }
                          : undefined
                      )
                    ).catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : String(err));
                      setActiveCoaching(null);
                      call.hangup();
                    });
                    activeCallRef.current = call;
                    return;
                  }
                }

                if (!priorDecision) {
                  const currentOptions = optionsRef.current;
                  const decoded = decodeAgentClientState(call.options?.clientState);
                  const headerSessionId = customHeaderSessionId(call.options?.customHeaders);
                  const matchesThisSession =
                    (Boolean(currentOptions.sessionId) &&
                      ((decoded?.kind === 'agent' &&
                        decoded.session === currentOptions.sessionId) ||
                        headerSessionId === currentOptions.sessionId)) ||
                    (decoded?.kind === 'agent' && expectingAgentLegRef.current);
                  if (matchesThisSession) {
                    inboundCallDecisionsRef.current.set(call.id, 'answered');
                    // Review fix (mic-permission/answer gap): the SDK's answer() returns a
                    // promise that rejects on a denied/unavailable mic -- previously neither
                    // awaited nor caught, so a mic denial surfaced as nothing but a silent
                    // 25s ring followed by agent-lost. Reject the call so the caller sees a
                    // clean hangup instead of a hung invite.
                    Promise.resolve(
                      call.answer(
                        currentOptions.remoteElementId
                          ? { remoteElement: currentOptions.remoteElementId }
                          : undefined
                      )
                    ).catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : String(err));
                      call.hangup();
                    });
                  } else {
                    // TASK-I1 (INB-2): a fallback-step invite for THIS member's own SIP
                    // credential -- neither auto-answer (unlike the agent leg) nor auto-reject.
                    // Surface it for the incoming-call banner; answerPendingInboundCall/
                    // declinePendingInboundCall below are what the human's click actually calls.
                    const inboundRouting = decodeInboundRoutingClientState(
                      call.options?.clientState
                    );
                    if (inboundRouting?.step === 'intern') {
                      inboundCallDecisionsRef.current.set(call.id, 'pending');
                      pendingInboundCallRef.current = call;
                      setPendingInboundCall({
                        callId: call.id,
                        fromE164: call.options?.remoteCallerNumber ?? null,
                      });
                      return;
                    }
                    // Not this session, and not a recognized inbound-routing invite -- reject.
                    // Never auto-answer a call this hook was not explicitly told to expect.
                    inboundCallDecisionsRef.current.set(call.id, 'rejected');
                    call.hangup();
                    return;
                  }
                }
              }

              activeCallRef.current = call;
              persistAgentCallControlId(call);
              const state = (call.state || '').toLowerCase();
              if (state === 'trying' || state === 'requesting') {
                setCallState('ringing');
              } else if (state === 'ringing') {
                setCallState('ringing');
              } else if (state === 'active' || state === 'answering' || state === 'early') {
                setCallState('connected');
                if (state === 'active') outboundAnsweredRef.current = true;
              } else if (state === 'hangup' || state === 'destroy' || state === 'purge') {
                // A manual outbound call that Telnyx tore down before it was ever answered used
                // to just reset the dial pad with no explanation (e.g. no outbound voice profile
                // attached to the connection). Surface the SDK's reason instead.
                if (
                  call.direction !== 'inbound' &&
                  !outboundAnsweredRef.current &&
                  !hangupRequestedRef.current
                ) {
                  const reason = [call.sipReason || call.cause, call.sipCode ?? call.causeCode]
                    .filter(Boolean)
                    .join(' ');
                  setError(
                    `The call could not be placed${reason ? ` (${reason})` : ''}. ` +
                      'Check that your Telnyx connection has an outbound voice profile attached.'
                  );
                }
                outboundAnsweredRef.current = false;
                hangupRequestedRef.current = false;
                setCallState('ended');
                activeCallRef.current = null;
                setActiveCoaching(null);
                if (typeof window !== 'undefined') {
                  window.localStorage.removeItem(ACTIVE_AGENT_CALL_CONTROL_ID_KEY);
                }
                // Review fix (n2): prune the decision this call was recorded under -- an
                // unbounded Map growing for the lifetime of the WebSocket connection is a
                // real (if slow) leak over a long shift with many inbound attempts.
                if (call.id) inboundCallDecisionsRef.current.delete(call.id);
                setTimeout(() => setCallState('idle'), 500);
              }
            }
          );

        client.connect();
        clientRef.current = client;
      });
    })()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setIsConnecting(false);
        // Review fix (L1r4 round 5, minor): disconnect the failed client's own socket BEFORE
        // dropping the reference -- nulling clientRef alone left its underlying connection
        // running if it somehow survived past the point of failure (e.g. the connect timeout
        // fired while the WebSocket was still trying), so a retried connect() would end up with
        // TWO registered clients sharing this hook's one notification handler.
        pendingClient?.disconnect();
        clientRef.current = null;
        throw err;
      })
      .finally(() => {
        connectPromiseRef.current = null;
      });
    connectPromiseRef.current = promise;
    return promise;
    // Review fix (M5) follow-on: this body now reads `optionsRef.current` exclusively (never
    // closes over `options` directly), so `options.remoteElementId`/`options.sessionId` are no
    // longer real dependencies -- keeping them just churned `connect`'s own identity (and the
    // effect that calls it) on every options change for no functional reason.
  }, [persistAgentCallControlId]);

  const disconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
      setIsReady(false);
    }
  }, []);

  const dial = useCallback(
    async (toNumber: string, callerId: string) => {
      setError(null);
      if (!clientRef.current || !isReady) {
        await connect();
      }
      const client = clientRef.current;
      if (!client) {
        const msg = 'WebRTC client not ready. Please try again.';
        setError(msg);
        throw new Error(msg);
      }

      setCallState('dialing');
      outboundAnsweredRef.current = false;
      hangupRequestedRef.current = false;

      const destinationNumber = toE164(toNumber);
      const callerNumber = toE164(callerId);

      try {
        const call = client.newCall({
          destinationNumber,
          callerNumber,
        });
        // Store immediately so hangup() works during dialing/ringing (before callUpdate)
        if (call && typeof (call as { hangup?: () => void }).hangup === 'function') {
          activeCallRef.current = call as { hangup: () => void };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setCallState('idle');
        throw err;
      }
    },
    [isReady, connect]
  );

  const hangup = useCallback(() => {
    hangupRequestedRef.current = true;
    if (activeCallRef.current) {
      activeCallRef.current.hangup();
      activeCallRef.current = null;
    }
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ACTIVE_AGENT_CALL_CONTROL_ID_KEY);
    }
    setCallState('idle');
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    const call = activeCallRef.current as {
      muteAudio?: () => void;
      unmuteAudio?: () => void;
    } | null;
    if (!call) return;
    if (muted) call.muteAudio?.();
    else call.unmuteAudio?.();
  }, []);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  /** See `expectingAgentLegRef`'s own comment above. Call right before `startDialerSession`;
   *  call `endAgentLegExpectation` once the real sessionId is known (success or failure) --
   *  the normal exact-session-match path takes over from there. */
  const beginAgentLegExpectation = useCallback(() => {
    expectingAgentLegRef.current = true;
  }, []);
  const endAgentLegExpectation = useCallback(() => {
    expectingAgentLegRef.current = false;
  }, []);

  /** TASK-I1 (INB-2): the incoming-call banner's own "Answer" button. Marks the decision
   *  'answered' (so this call id's later notifications fall through to the normal active-call
   *  tracking, same as the agent-leg path) and clears the pending state. */
  const answerPendingInboundCall = useCallback(() => {
    const call = pendingInboundCallRef.current;
    if (!call || !call.id) return;
    inboundCallDecisionsRef.current.set(call.id, 'answered');
    pendingInboundCallRef.current = null;
    setPendingInboundCall(null);
    Promise.resolve(
      call.answer(
        optionsRef.current.remoteElementId
          ? { remoteElement: optionsRef.current.remoteElementId }
          : undefined
      )
    ).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      call.hangup();
    });
  }, []);

  /** TASK-I1 (INB-2): the incoming-call banner's own "Decline" button -- a real hangup, which
   *  sends Telnyx a genuine `call.hangup` for this leg, letting the server (inbound-engine.ts's
   *  handleClientStateEvent) advance to the next fallback step exactly as if the ring had timed
   *  out unanswered. */
  const declinePendingInboundCall = useCallback(() => {
    const call = pendingInboundCallRef.current;
    if (!call || !call.id) return;
    inboundCallDecisionsRef.current.set(call.id, 'rejected');
    pendingInboundCallRef.current = null;
    setPendingInboundCall(null);
    call.hangup();
  }, []);

  return {
    callState,
    error,
    isConnecting,
    isReady,
    connect,
    disconnect,
    dial,
    hangup,
    setMuted,
    beginAgentLegExpectation,
    endAgentLegExpectation,
    pendingInboundCall,
    answerPendingInboundCall,
    declinePendingInboundCall,
    activeCoaching,
    /** CoachingBanner calls this right after a successful switchCoachingMode API response -- the
     *  hook itself never re-decodes client_state mid-call (Telnyx's own update action doesn't
     *  re-fire an invite), so the new mode has to be told to it explicitly. */
    setActiveCoachingMode: (mode: CoachingMode) =>
      setActiveCoaching((current) => (current ? { ...current, mode } : current)),
  };
}
