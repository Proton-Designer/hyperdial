/**
 * TASK-H03: 5-minute retry sweep for "Log Close" webhook deliveries. Triggered by pg_cron/pg_net
 * (`private.trigger_close_delivery_worker`) with its OWN shared secret header (CLOSE_DELIVERY_WORKER_SECRET), no
 * user JWT; fails closed when the secret is unset. The first attempt for a close happens in log-contact-close.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { runCloseDeliveries } from '../_shared/close-delivery-run.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expected = Deno.env.get('CLOSE_DELIVERY_WORKER_SECRET');
  const provided = req.headers.get('X-Cron-Secret');
  if (!expected || !provided || !secretsMatch(provided, expected)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  try {
    return jsonResponse(await runCloseDeliveries(supabase, { limit: 20 }));
  } catch (err) {
    console.error('[close-delivery-worker] failed', err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
