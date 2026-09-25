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
   * (anything that doesn't decode to this exact session) is rejected (hung up before
   * answering) -- this hook must never auto-answer a call it wasn't told to expect. Omitted
   * (the legacy single-line manual dialer's usage): inbound calls are left entirely alone,
   * same as before this task.
   */
  sessionId?: string;
}

const ACTIVE_AGENT_CALL_CONTROL_ID_KEY = 'hyperdial_active_agent_call_control_id';

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

  const connect = useCallback((): Promise<void> => {
    if (clientRef.current) return Promise.resolve();
    setIsConnecting(true);
    setError(null);

    return (async () => {
      const { token } = await getWebrtcCredentials();
      if (!token) throw new Error('No token received');

      const client = new TelnyxRTC({ login_token: token });
      if (options.remoteElementId) {
        client.remoteElement = options.remoteElementId;
      }

      return new Promise<void>((resolve, reject) => {
        client
          .on('telnyx.ready', () => {
            setIsReady(true);
            setIsConnecting(false);
            resolve();
          })
          .on('telnyx.error', reject)
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
                answer: (params?: { remoteElement?: string }) => void;
              };
            }) => {
              if (notification.type !== 'callUpdate' || !notification.call) return;
              const call = notification.call;

              if (call.direction === 'inbound' && call.id) {
                const priorDecision = inboundCallDecisionsRef.current.get(call.id);
                if (priorDecision === 'rejected') return;
                if (!priorDecision) {
                  const decoded = decodeAgentClientState(call.options?.clientState);
                  const headerSessionId = customHeaderSessionId(call.options?.customHeaders);
                  const matchesThisSession =
                    Boolean(options.sessionId) &&
                    ((decoded?.kind === 'agent' && decoded.session === options.sessionId) ||
                      headerSessionId === options.sessionId);
                  if (matchesThisSession) {
                    inboundCallDecisionsRef.current.set(call.id, 'answered');
                    call.answer(
                      options.remoteElementId
                        ? { remoteElement: options.remoteElementId }
                        : undefined
                    );
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
                setTimeout(() => setCallState('idle'), 500);
              }
            }
          );

        client.connect();
        clientRef.current = client;
      });
    })().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setIsConnecting(false);
      throw err;
    });
  }, [options.remoteElementId, options.sessionId, persistAgentCallControlId]);

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
  };
}
