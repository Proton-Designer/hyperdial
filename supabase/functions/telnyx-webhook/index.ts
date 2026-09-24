import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  completeBatchAndAdvanceIfNeeded,
  decodeAgentCallbackState,
  decodeClientState,
  handleAmdResult,
  handleCallHangup,
  markNoAnswerAndCleanup,
  resolveStaleBatchIfTimedOut,
} from '../_shared/dialer-engine.ts';
import { getAgentSessionState, getCallState, setCallState } from '../_shared/redis.ts';
import { hangupCall, joinCallToConference } from '../_shared/telnyx.ts';
import { publishDialerEvent } from '../_shared/dialer-events.ts';
import { verifyTelnyxSignature } from '../_shared/webhook-verify.ts';
import { decodeDialClientState } from '../_shared/client-state.ts';

type WebhookBody = {
  data?: {
    event_type?: string;
    occurred_at?: string;
    payload?: Record<string, unknown>;
  };
};

function webhookLog(step: string, meta: Record<string, unknown> = {}): void {
  console.log('[telnyx-webhook]', step, meta);
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

// Known-issues #0 fix: this replaces both fail-open branches (no-secret-configured,
// and unchecked-ed25519-header) with real ed25519 verification that fails closed on
// every branch (see _shared/webhook-verify.ts). There is no code path here, or in
// verifyTelnyxSignature, that accepts a request without checking its signature.
async function loadOrgWebhookPublicKey(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('org_telephony')
    .select('webhook_public_key')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) {
    console.error('[telnyx-webhook] org_telephony lookup failed', { orgId, error: error.message });
    return null;
  }
  return data?.webhook_public_key ?? null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function processWebhook(body: WebhookBody): Promise<void> {
  const eventType = body?.data?.event_type ?? '';
  const occurredAt = body?.data?.occurred_at ?? null;
  const payload = (body?.data?.payload ?? {}) as Record<string, unknown>;
  const callControlId = asString(payload.call_control_id || payload.call_session_id);
  const clientStateRaw = asString(
    payload.client_state ?? (body?.data as Record<string, unknown>)?.client_state
  );
  const clientState = decodeClientState(clientStateRaw);
  const agentCallback = decodeAgentCallbackState(clientStateRaw);
  const amdResult = asString(payload.result);

  webhookLog('event_received', {
    eventType,
    occurredAt,
    callControlId,
    hasClientStateRaw: Boolean(clientStateRaw),
    decodedClientState: clientState
      ? {
          sessionId: clientState.sessionId,
          contactId: clientState.contactId,
          batchIndex: clientState.batchIndex,
        }
      : null,
    decodedAgentCallback: agentCallback
      ? {
          sessionId: agentCallback.sessionId,
          userId: agentCallback.userId,
        }
      : null,
    amdResult: amdResult || null,
  });

  if (!eventType || !callControlId) {
    webhookLog('event_ignored_missing_event_or_call_id', { eventType, callControlId });
    return;
  }

  const supabase = getSupabaseAdmin();
  const cachedCall = await getCallState(callControlId);
  const callContext =
    cachedCall ??
    (clientState
      ? {
          userId: clientState.userId,
          sessionId: clientState.sessionId,
          campaignId: clientState.campaignId,
          contactId: clientState.contactId,
          callControlId,
          status: 'initiated' as const,
          batchIndex: clientState.batchIndex,
          startedAt: Date.now(),
        }
      : null);
  webhookLog('call_context_resolved', {
    eventType,
    callControlId,
    source: cachedCall ? 'redis' : clientState ? 'client_state' : 'none',
    sessionId: callContext?.sessionId ?? null,
    contactId: callContext?.contactId ?? null,
  });

  // Agent callback leg (we dialed the agent when contact answered); handle join to conference on answer.
  if (agentCallback && eventType === 'call.answered') {
    webhookLog('agent_callback_answered_start', {
      callControlId,
      sessionId: agentCallback.sessionId,
    });
    try {
      const { data: session, error: sessionError } = await supabase
        .from('dialer_sessions')
        .select('conference_name')
        .eq('id', agentCallback.sessionId)
        .maybeSingle();
      if (sessionError) {
        webhookLog('agent_callback_session_fetch_failed', {
          sessionId: agentCallback.sessionId,
          callControlId,
          error: sessionError.message,
        });
        await hangupCall(callControlId);
        return;
      }
      if (!session?.conference_name) {
        webhookLog('agent_callback_missing_conference_name', {
          sessionId: agentCallback.sessionId,
          callControlId,
          hasSession: !!session,
        });
        await hangupCall(callControlId);
        return;
      }
      await joinCallToConference(callControlId, session.conference_name);
      webhookLog('agent_callback_joined_conference', {
        sessionId: agentCallback.sessionId,
        callControlId,
        conferenceName: session.conference_name,
      });
    } catch (err) {
      webhookLog('agent_callback_join_failed', {
        sessionId: agentCallback.sessionId,
        callControlId,
        error: String(err),
      });
      await hangupCall(callControlId);
    }
    return;
  }

  if (!callContext) {
    webhookLog('event_ignored_missing_call_context', {
      eventType,
      callControlId,
      hasAgentCallback: Boolean(agentCallback),
      hasClientStateRaw: Boolean(clientStateRaw),
    });
    return;
  }

  const agentState = await getAgentSessionState(callContext.userId);
  if (
    !agentState ||
    agentState.sessionId !== callContext.sessionId ||
    agentState.status !== 'active'
  ) {
    webhookLog('hanging_up_due_to_invalid_agent_state', {
      eventType,
      callControlId,
      callSessionId: callContext.sessionId,
      agentStateSessionId: agentState?.sessionId ?? null,
      agentStateStatus: agentState?.status ?? null,
    });
    await hangupCall(callControlId);
    return;
  }

  await resolveStaleBatchIfTimedOut(supabase, {
    sessionId: callContext.sessionId,
    userId: callContext.userId,
    fromNumber: agentState.fromNumber ?? '',
    webhookUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-webhook`,
    triggerEventType: eventType,
    triggerCallControlId: callControlId,
  });

  switch (eventType) {
    case 'call.initiated': {
      webhookLog('case_call_initiated', {
        sessionId: callContext.sessionId,
        callControlId,
        contactId: callContext.contactId,
      });
      await setCallState({ ...callContext, status: 'initiated' });
      await supabase.from('call_logs').upsert(
        {
          session_id: callContext.sessionId,
          user_id: callContext.userId,
          campaign_id: callContext.campaignId,
          contact_id: callContext.contactId,
          call_control_id: callControlId,
          status: 'initiated',
          direction: 'outbound',
        },
        { onConflict: 'call_control_id' }
      );
      await supabase
        .from('contacts')
        .update({
          call_status: 'dialing',
          last_called_at: new Date().toISOString(),
        })
        .eq('id', callContext.contactId);
      break;
    }
    case 'call.answered': {
      webhookLog('case_call_answered', {
        sessionId: callContext.sessionId,
        callControlId,
        contactId: callContext.contactId,
      });
      await setCallState({
        ...callContext,
        status: 'answered_pending_amd',
        answeredAt: Date.now(),
      });
      await supabase
        .from('call_logs')
        .update({
          status: 'answered',
          answered_at: new Date().toISOString(),
        })
        .eq('call_control_id', callControlId);
      await publishDialerEvent(callContext.userId, 'CALL_ANSWERED', {
        contactId: callContext.contactId,
      });
      break;
    }
    case 'call.machine.detection.ended':
    case 'call.machine.premium.detection.ended': {
      webhookLog('case_call_amd_ended', {
        sessionId: callContext.sessionId,
        callControlId,
        contactId: callContext.contactId,
        amdResult: amdResult || null,
      });
      await handleAmdResult(supabase, {
        callControlId,
        amdRawResult: amdResult,
      });
      break;
    }
    case 'call.machine.greeting.ended': {
      webhookLog('case_call_machine_greeting_ended_hangup', {
        sessionId: callContext.sessionId,
        callControlId,
        contactId: callContext.contactId,
      });
      // With standard AMD ('detect'), this event is not required for our flow and
      // can cause false-positive disconnects if received unexpectedly.
      // Keep it as an observability checkpoint only.
      break;
    }
    case 'call.hangup': {
      webhookLog('case_call_hangup', {
        sessionId: callContext.sessionId,
        callControlId,
        contactId: callContext.contactId,
      });
      const result = await handleCallHangup(supabase, callControlId);
      webhookLog('case_call_hangup_decision', {
        callControlId,
        shouldAdvance: result.shouldAdvance,
        sessionId: result.sessionId,
        userId: result.userId,
      });
      if (result.shouldAdvance && result.sessionId && result.userId) {
        await completeBatchAndAdvanceIfNeeded(supabase, {
          sessionId: result.sessionId,
          userId: result.userId,
          webhookUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-webhook`,
          fromNumber: agentState.fromNumber ?? '',
        });
      } else {
        await markNoAnswerAndCleanup(supabase, callControlId);
      }
      break;
    }
    case 'call.bridged': {
      webhookLog('case_call_bridged', {
        sessionId: callContext.sessionId,
        callControlId,
      });
      await supabase
        .from('call_logs')
        .update({
          status: 'connected',
        })
        .eq('call_control_id', callControlId);
      break;
    }
    default:
      webhookLog('case_unhandled_event', {
        eventType,
        callControlId,
        sessionId: callContext.sessionId,
      });
      break;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const orgId = new URL(req.url).searchParams.get('org');
    if (!orgId) {
      // Fail closed: with no org, there is no public key to check the signature
      // against. Every org's Call Control Application webhook URL is provisioned
      // with ?org=<org_id> by telnyx-connect, so a legitimate Telnyx request always
      // carries it.
      webhookLog('rejected_missing_org_param');
      return new Response(JSON.stringify({ error: 'Missing org' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rawBody = await req.text();
    const supabase = getSupabaseAdmin();
    const publicKey = await loadOrgWebhookPublicKey(supabase, orgId);
    const verified = await verifyTelnyxSignature({
      rawBody,
      signatureB64: req.headers.get('telnyx-signature-ed25519'),
      timestamp: req.headers.get('telnyx-timestamp'),
      publicKeyB64: publicKey,
    });
    if (!verified.ok) {
      webhookLog('signature_verification_failed', { orgId, reason: verified.reason });
      return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = JSON.parse(rawBody) as WebhookBody;

    // Cross-tenant defense in depth (design §3 step 5): if client_state carries the
    // new {org, session, leg} shape (TASK-P1-04/P2 dial engine), it must name this
    // same org. The legacy dialer-engine client_state (userId/sessionId/contactId/
    // campaignId/batchIndex, still dispatched below per this task's invariant) has no
    // org field at all -- today's dial engine is pre-org-rewrite -- so there is
    // nothing to check for it yet; that gap closes when Phase 2 rewrites the engine
    // to carry {org, session, leg} on every leg.
    const rawClientState = asString(
      (body?.data?.payload as Record<string, unknown> | undefined)?.client_state ??
        (body?.data as Record<string, unknown>)?.client_state
    );
    const dialClientState = decodeDialClientState(rawClientState);
    if (dialClientState && dialClientState.org !== orgId) {
      webhookLog('rejected_client_state_org_mismatch', {
        orgId,
        clientStateOrg: dialClientState.org,
      });
      return new Response(JSON.stringify({ error: 'client_state org mismatch' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    webhookLog('request_accepted_for_async_processing', {
      orgId,
      eventType: body?.data?.event_type ?? null,
      callControlId: asString(
        (body?.data?.payload as Record<string, unknown> | undefined)?.call_control_id
      ),
    });
    queueMicrotask(() => {
      processWebhook(body).catch((err) =>
        console.error('telnyx-webhook async processing error:', err)
      );
    });

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('telnyx-webhook error:', errorMessage, err);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
