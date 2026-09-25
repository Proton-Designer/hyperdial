import { useState, useCallback, useEffect, useRef } from 'react';
import { TelnyxRTC } from '@telnyx/webrtc';
import { getWebrtcCredentials } from './api';

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
  /** TASK-L1: the SDK re-fires telnyx.notification repeatedly as an inbound call's state
   *  changes (new -> ringing -> ...) -- decide answer-vs-reject exactly once per call id, not
   *  once per notification, and remember the decision so a REJECTED call's later
   *  notifications (e.g. its own eventual hangup/destroy) never fall through to the normal
   *  state-tracking below and get mistaken for this hook's own active call. */
  const inboundCallDecisionsRef = useRef<Map<string, 'answered' | 'rejected'>>(new Map());
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

  const connect = useCallback((): Promise<void> => {
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
            reject(err);
          })
          .on(
            'telnyx.notification',
            (notification: {
              type?: string;
              call?: {
                id?: string;
                state?: string;
                direction?: string;
                options?: { clientState?: string; customHeaders?: unknown };
                hangup: () => void;
                answer: (params?: { remoteElement?: string }) => void | Promise<void>;
              };
            }) => {
              if (notification.type !== 'callUpdate' || !notification.call) return;
              const call = notification.call;

              if (call.direction === 'inbound' && call.id) {
                const priorDecision = inboundCallDecisionsRef.current.get(call.id);
                if (priorDecision === 'rejected') return;
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
                    // Not this session (or this hook wasn't told to expect one at all, e.g.
                    // the legacy manual dialer) -- reject. Never auto-answer a call this hook
                    // was not explicitly told to expect.
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
              } else if (state === 'hangup' || state === 'destroy' || state === 'purge') {
                setCallState('ended');
                activeCallRef.current = null;
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
  };
}
