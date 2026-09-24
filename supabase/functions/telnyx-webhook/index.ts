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
    // The outer handler already rejected a missing/mismatched client_state for call.*
    // events with a 401 before this ever runs -- these are defensive, should-never-happen
    // guards, not the primary enforcement point.
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
    // must decode to this task's {org, session, leg} shape and name this same org. TASK-P2-E2
    // removes the legacy engine entirely, so there is no longer an org-less client_state
    // shape to tolerate on a call.* event -- a missing/undecodable one is now a hard reject,
    // not a skipped check (that leniency was only ever correct while the legacy engine's
    // org-less client_state was still in play, per TASK-P1-05's original comment here).
    // Scoped to call.* specifically: Telnyx also sends conference.* events to this same
    // webhook URL (created via the org's own Call Control App), and those never carry this
    // client_state shape at all -- rejecting them outright would just make Telnyx retry (or
    // eventually disable) the endpoint for events this function never acts on anyway.
    const eventType = body?.data?.event_type ?? '';
    const rawClientState = asString(
      (body?.data?.payload as Record<string, unknown> | undefined)?.client_state ??
        (body?.data as Record<string, unknown>)?.client_state
    );
    const dialClientState = decodeDialClientState(rawClientState);
    if (eventType.startsWith('call.') && (!dialClientState || dialClientState.org !== orgId)) {
      webhookLog('rejected_client_state_missing_or_org_mismatch', {
        orgId,
        eventType,
        clientStateOrg: dialClientState?.org ?? null,
      });
      return new Response(JSON.stringify({ error: 'missing or mismatched client_state' }), {
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
      processWebhook(body, orgId, dialClientState).catch((err) =>
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
