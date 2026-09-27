import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { processTelnyxDialerEvent } from '../_shared/dialer-engine.ts';
import { processTelnyxInboundEvent } from '../_shared/inbound-engine.ts';
import { processTelnyxCoachingEvent } from '../_shared/coaching-core.ts';
import { processTelnyxTransferEvent } from '../_shared/transfer-core.ts';
import { getConnectedOrgTelnyxContext } from '../_shared/telnyx-org-context.ts';
import { verifyTelnyxSignature } from '../_shared/webhook-verify.ts';
import {
  decodeDialClientState,
  decodeInboundClientState,
  decodeCoachingClientState,
  decodeTransferTargetClientState,
  type DialClientState,
  type InboundClientState,
  type CoachingClientState,
  type TransferTargetClientState,
} from '../_shared/client-state.ts';

type WebhookBody = {
  data?: {
    /** The event's own UUID (verified against spec3.json -- every Call Control event schema
     *  has this at data.id, a sibling of event_type/occurred_at/payload), used for
     *  record_webhook_event's dedupe. */
    id?: string;
    event_type?: string;
    occurred_at?: string;
    payload?: Record<string, unknown>;
  };
};

function webhookLog(step: string, meta: Record<string, unknown> = {}): void {
  console.log('[telnyx-webhook]', step, meta);
}

// Supabase's Edge Runtime, not stock Deno -- undeclared in Deno's own lib types, hence the
// ambient ad-hoc declaration. `typeof EdgeRuntime` is a safe existence check even when the
// binding doesn't exist in the global scope at all (e.g. under `deno test`, or a `functions
// serve` build that predates it).
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** TASK-P2-E2 fix-forward item 3 (lead's diff-read, high): `queueMicrotask` alone does not
 *  guarantee the webhook's async processing survives past the response. Supabase's Edge
 *  Runtime can freeze/recycle the isolate immediately after a response ships, killing an
 *  in-flight microtask -- silently dropping the event in production. `EdgeRuntime.waitUntil`
 *  is the runtime's own supported way to keep a promise alive past the response (see
 *  https://supabase.com/docs/guides/functions/background-tasks). Outside that runtime (unit
 *  tests, or a `functions serve` build without it) there is nothing left to keep the process
 *  alive after the response ships, so the caller must await the promise itself before
 *  responding instead -- see the two branches at the bottom of the request handler below. */

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

/** call.initiated + direction incoming is the only shape a genuinely fresh, never-before-seen
 *  inbound call can have (see receiving-webhooks.md's own example payload) -- everything else
 *  that reaches this call has already had EITHER a dial or an inbound client_state decoded for
 *  it by the outer handler. */
function isFreshInboundCall(eventType: string, payload: Record<string, unknown>): boolean {
  return eventType === 'call.initiated' && payload.direction === 'incoming';
}

/**
 * Dispatches a verified, accepted webhook body into the org-scoped engine that owns it --
 * the dial engine (_shared/dialer-engine.ts, TASK-P2-E2) for an event carrying a DialClientState,
 * the inbound-routing engine (_shared/inbound-engine.ts, TASK-I1) for an event carrying an
 * InboundClientState OR a genuinely fresh inbound call.initiated, or the coaching engine
 * (_shared/coaching-core.ts, TASK-T3) for an event carrying a CoachingClientState. The outer
 * Deno.serve handler below has already: verified the ed25519 signature, resolved `orgId` from
 * the `?org=` query param, and confirmed a call.* event matches ONE of these four shapes (or
 * is accepted-and-ignored before ever reaching here). Non-call.* events (e.g. conference.*) are
 * filtered out before ever reaching the engine.
 */
async function processWebhook(
  body: WebhookBody,
  orgId: string,
  dialClientState: DialClientState | null,
  inboundClientState: InboundClientState | null,
  coachingClientState: CoachingClientState | null,
  transferTargetClientState: TransferTargetClientState | null
): Promise<void> {
  const eventType = body?.data?.event_type ?? '';
  const eventId = body?.data?.id ?? '';
  const occurredAt = body?.data?.occurred_at ?? null;
  const payload = (body?.data?.payload ?? {}) as Record<string, unknown>;
  const callControlId = asString(payload.call_control_id || payload.call_session_id);

  webhookLog('event_received', {
    eventType,
    eventId,
    occurredAt,
    callControlId,
    hasClientState: Boolean(
      dialClientState || inboundClientState || coachingClientState || transferTargetClientState
    ),
  });

  if (!eventType.startsWith('call.')) {
    webhookLog('event_ignored_not_a_call_event', { eventType });
    return;
  }

  if (transferTargetClientState) {
    // TASK-T4: a transfer target leg is neither a dial-engine leg nor an inbound-routing leg --
    // see transfer-core.ts's own header for why it deliberately has no call_legs row at all.
    // Only `call.answered`/`call.hangup` are interesting; processTelnyxTransferEvent no-ops on
    // anything else and on an already-resolved row (idempotent against Telnyx's own retries).
    if (!callControlId) {
      webhookLog('transfer_event_ignored_missing_call_control_id', { eventType });
      return;
    }
    const supabase = getSupabaseAdmin();
    const { client, error } = await getConnectedOrgTelnyxContext(supabase, orgId);
    if (!client) {
      webhookLog('transfer_event_no_telnyx_client', { orgId, errorStatus: error?.status });
      return;
    }
    await processTelnyxTransferEvent(supabase, client, {
      orgId,
      eventType,
      callControlId,
      transferId: transferTargetClientState.transfer,
    });
    return;
  }

  if (coachingClientState) {
    // TASK-T3: a coaching leg is neither a dial-engine leg nor an inbound-routing leg -- see
    // coaching-core.ts's own header for why it deliberately has no call_legs row at all. Only
    // `call.answered`/`call.hangup` are interesting; processTelnyxCoachingEvent no-ops on
    // anything else and on an already-`ended` row (idempotent against Telnyx's own retries).
    if (!callControlId) {
      webhookLog('coaching_event_ignored_missing_call_control_id', { eventType });
      return;
    }
    const supabase = getSupabaseAdmin();
    const { client, error } = await getConnectedOrgTelnyxContext(supabase, orgId);
    if (!client) {
      webhookLog('coaching_event_no_telnyx_client', { orgId, errorStatus: error?.status });
      return;
    }
    await processTelnyxCoachingEvent(supabase, client, {
      orgId,
      eventType,
      callControlId,
      coachingId: coachingClientState.coaching,
    });
    return;
  }

  const isFresh = isFreshInboundCall(eventType, payload);
  if (inboundClientState || isFresh) {
    if (!eventId) {
      webhookLog('inbound_event_ignored_missing_event_id', { eventType });
      return;
    }
    const supabase = getSupabaseAdmin();
    const { client, error } = await getConnectedOrgTelnyxContext(supabase, orgId);
    if (!client) {
      webhookLog('inbound_event_no_telnyx_client', { orgId, errorStatus: error?.status });
      return;
    }
    await processTelnyxInboundEvent(supabase, client, {
      orgId,
      eventId,
      eventType,
      callControlId,
      payload,
      inboundClientState,
    });
    return;
  }

  if (!callControlId || !eventId || !dialClientState) {
    // The outer handler already accepted-and-ignored (200) a missing/mismatched client_state
    // for call.* events before this ever runs (fix-forward item 4) -- these are defensive,
    // should-never-happen guards, not the primary enforcement point.
    webhookLog('event_ignored_missing_required_field', {
      eventType,
      hasCallControlId: Boolean(callControlId),
      hasEventId: Boolean(eventId),
      hasClientState: Boolean(dialClientState),
    });
    return;
  }

  const supabase = getSupabaseAdmin();
  await processTelnyxDialerEvent(supabase, {
    orgId,
    eventId,
    eventType,
    callControlId,
    payload,
    clientState: dialClientState,
  });
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

    // Cross-tenant defense in depth (design §3 step 5): every call.* event must be ONE of three
    // recognized shapes for this org -- a DialClientState (the outbound dial engine, TASK-P2-E2),
    // an InboundClientState (TASK-I1's own fallback-step legs and recording webhooks), or a
    // genuinely fresh inbound call.initiated (never had ANY client_state set on it yet -- see
    // isFreshInboundCall's own header). Scoped to call.* specifically: Telnyx also sends
    // conference.* events to this same webhook URL (created via the org's own Call Control
    // App), and those never carry either client_state shape at all.
    //
    // TASK-P2-E2 fix-forward item 4 (lead's diff-read, medium): a missing/undecodable or
    // org-mismatched client_state on a call.* event used to be a 401 -- but the signature
    // ALREADY authenticates this request as belonging to `orgId` (checked above), so a
    // mismatch here just means this specific event isn't one our engine tracks (once E3
    // landed, the agent's own WebRTC leg, which never carries either client_state shape at
    // all). Telnyx retries a non-2xx response repeatedly and eventually disables the endpoint;
    // there is nothing to retry into, so accept with 200 and just ignore it (logged).
    const eventType = body?.data?.event_type ?? '';
    const payloadForGate = (body?.data?.payload ?? {}) as Record<string, unknown>;
    const rawClientState = asString(
      (body?.data?.payload as Record<string, unknown> | undefined)?.client_state ??
        (body?.data as Record<string, unknown>)?.client_state
    );
    const dialClientState = decodeDialClientState(rawClientState);
    const inboundClientState = decodeInboundClientState(rawClientState);
    const coachingClientState = decodeCoachingClientState(rawClientState);
    const transferTargetClientState = decodeTransferTargetClientState(rawClientState);
    const recognized =
      (dialClientState && dialClientState.org === orgId) ||
      (inboundClientState && inboundClientState.org === orgId) ||
      (coachingClientState && coachingClientState.org === orgId) ||
      (transferTargetClientState && transferTargetClientState.org === orgId) ||
      isFreshInboundCall(eventType, payloadForGate);
    if (eventType.startsWith('call.') && !recognized) {
      webhookLog('ignored_client_state_missing_or_org_mismatch', {
        orgId,
        eventType,
        clientStateOrg:
          dialClientState?.org ??
          inboundClientState?.org ??
          coachingClientState?.org ??
          transferTargetClientState?.org ??
          null,
      });
      return new Response(JSON.stringify({ received: true, ignored: true }), {
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
    const processingPromise = processWebhook(
      body,
      orgId,
      dialClientState,
      inboundClientState,
      coachingClientState,
      transferTargetClientState
    ).catch((err) => {
      console.error('telnyx-webhook async processing error:', err);
      // TASK-T10 (SEC-7 rest): the one integration point for the webhook-error-spike alert --
      // record_webhook_processing_error is itself best-effort (never let alert bookkeeping turn
      // a real processing error into an unhandled rejection).
      supabase
        .rpc('record_webhook_processing_error', {
          p_org: orgId,
          p_event_type: body?.data?.event_type ?? null,
          p_error_message: err instanceof Error ? err.message : String(err),
        })
        .then(({ error }) => {
          if (error)
            console.error('[telnyx-webhook] record_webhook_processing_error failed', error.message);
        });
    });
    if (typeof EdgeRuntime !== 'undefined') {
      // Ack 200 immediately; EdgeRuntime keeps processingPromise alive past the response.
      EdgeRuntime.waitUntil(processingPromise);
    } else {
      // No EdgeRuntime outside the real Supabase runtime -- nothing would keep the process
      // alive after the response ships, so finish processing before responding instead of
      // risking it getting killed mid-flight.
      await processingPromise;
    }

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
