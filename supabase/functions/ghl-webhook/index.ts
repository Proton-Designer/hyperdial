/**
 * TASK-G30: GHL -> HyperDial webhook (instant DND / DNC tag / stage / owner changes). PUBLIC endpoint
 * (verify_jwt = false in config.toml): GHL sends no Supabase JWT, so the request is authenticated here, fail
 * CLOSED, either by `X-GHL-Signature` (Marketplace app, Ed25519) or by the per-org `X-HyperDial-Webhook-Secret`
 * (workflow Custom Webhook). The payload is never trusted: it only names a contact, which is re-read from GHL
 * and run through the same decision + apply path as the 5-minute sweep (ghl-reconcile-worker stays as the safety
 * net). All logic and the response codes live in _shared/ghl-webhook-run.ts (unit-tested).
 *
 * Optional secrets: GHL_WEBHOOK_PUBLIC_KEY (SPKI base64, overrides the pinned GHL key), GHL_WEBHOOK_SIGNED_PAYLOAD
 * ('json' = the signature covers the re-serialised body; default 'raw'), GHL_API_BASE.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createGhlClient } from '../_shared/ghl-client.ts';
import {
  createGhlRateLimiter,
  withGhlRateLimit,
  GHL_PULL_RATE_LIMIT_MAX_PER_WINDOW,
} from '../_shared/ghl-rate-limit.ts';
import { handleGhlWebhook } from '../_shared/ghl-webhook-run.ts';
import { MAX_WEBHOOK_BODY_BYTES } from '../_shared/ghl-webhook.ts';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    return json({ error: 'Payload too large' }, 413);
  }
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return json({ error: 'Invalid body' }, 400);
  }
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  try {
    const out = await handleGhlWebhook(
      {
        supabase,
        makeClient: (token) =>
          withGhlRateLimit(
            createGhlClient(token, { apiBase: Deno.env.get('GHL_API_BASE') || undefined }),
            createGhlRateLimiter({ maxPerWindow: GHL_PULL_RATE_LIMIT_MAX_PER_WINDOW })
          ),
        publicKeySpkiB64: Deno.env.get('GHL_WEBHOOK_PUBLIC_KEY') || null,
        signedPayload: Deno.env.get('GHL_WEBHOOK_SIGNED_PAYLOAD') === 'json' ? 'json' : 'raw',
      },
      { method: req.method, headers: req.headers, rawBody, contentLength: declared || null }
    );
    return json(out.body, out.status);
  } catch (err) {
    console.error('[ghl-webhook] unhandled', err);
    return json({ error: 'Temporary failure' }, 503);
  }
});
