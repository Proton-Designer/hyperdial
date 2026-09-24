import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { processTelnyxDialerEvent } from '../_shared/dialer-engine.ts';
import { verifyTelnyxSignature } from '../_shared/webhook-verify.ts';
import { decodeDialClientState, type DialClientState } from '../_shared/client-state.ts';

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

/**
 * Dispatches a verified, accepted webhook body into the new org-scoped engine
 * (_shared/dialer-engine.ts, TASK-P2-E2). The outer Deno.serve handler below has already:
 * verified the ed25519 signature, resolved `orgId` from the `?org=` query param, and (for
 * any call.* event) confirmed `dialClientState` decodes and names this same org -- so by
 * the time this runs, a call.* event always has a valid `{org, session, leg}` client_state.
 * Non-call.* events (e.g. conference.*) are filtered out before ever reaching the engine.
 */
async function processWebhook(
  body: WebhookBody,
  orgId: string,
  dialClientState: DialClientState | null
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
    hasClientState: Boolean(dialClientState),
  });

  if (!eventType.startsWith('call.')) {
    webhookLog('event_ignored_not_a_call_event', { eventType });
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

    // Cross-tenant defense in depth (design §3 step 5): every call.* event's client_state
    // must decode to this task's {org, session, leg} shape and name this same org. Scoped to
    // call.* specifically: Telnyx also sends conference.* events to this same webhook URL
    // (created via the org's own Call Control App), and those never carry this client_state
    // shape at all.
    //
    // TASK-P2-E2 fix-forward item 4 (lead's diff-read, medium): a missing/undecodable or
    // org-mismatched client_state on a call.* event used to be a 401 -- but the signature
    // ALREADY authenticates this request as belonging to `orgId` (checked above), so a
    // mismatch here just means this specific event isn't one our engine tracks (an inbound
    // call to one of the org's numbers, or -- once E3 lands -- the agent's own WebRTC leg,
    // which never carries this {org,session,leg} shape at all). Telnyx retries a non-2xx
    // response repeatedly and eventually disables the endpoint; there is nothing to retry
    // into, so accept with 200 and just ignore it (logged).
    const eventType = body?.data?.event_type ?? '';
    const rawClientState = asString(
      (body?.data?.payload as Record<string, unknown> | undefined)?.client_state ??
        (body?.data as Record<string, unknown>)?.client_state
    );
    const dialClientState = decodeDialClientState(rawClientState);
    if (eventType.startsWith('call.') && (!dialClientState || dialClientState.org !== orgId)) {
      webhookLog('ignored_client_state_missing_or_org_mismatch', {
        orgId,
        eventType,
        clientStateOrg: dialClientState?.org ?? null,
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
    const processingPromise = processWebhook(body, orgId, dialClientState).catch((err) =>
      console.error('telnyx-webhook async processing error:', err)
    );
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
