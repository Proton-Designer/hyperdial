/**
 * TASK-G08 (spec section 4): the 5-minute GHL -> HyperDial reconcile sweep. Triggered by pg_cron/
 * pg_net (`private.trigger_ghl_reconcile_worker`, 20261019201027_ghl_reconcile.sql) with its OWN
 * shared secret header (GHL_RECONCILE_WORKER_SECRET), no user JWT -- same shape as ghl-pull-worker.
 * Fails closed when the secret is unset. Loops every connected org with ghl_reconcile_enabled and
 * reconciles a bounded batch (GHL_RECONCILE_BATCH, default 100, max 300) per org per tick, within a
 * total time budget so one slow org cannot starve the rest or time the function out.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { createGhlClient } from '../_shared/ghl-client.ts';
import {
  createGhlRateLimiter,
  withGhlRateLimit,
  GHL_PULL_RATE_LIMIT_MAX_PER_WINDOW,
} from '../_shared/ghl-rate-limit.ts';
import { reconcileOrg } from '../_shared/ghl-reconcile.ts';
import { lookupUnlinkedContacts } from '../_shared/ghl-lookup.ts';

const TIME_BUDGET_MS = 100_000;
/** TASK-G32: the phone lookup of unlinked contacts may use at most this long per org before the main reads start. */
const LOOKUP_BUDGET_MS = 15_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

function batchSize(): number {
  const n = Number(Deno.env.get('GHL_RECONCILE_BATCH'));
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 300) : 100;
}

/** GHL_LOOKUP_BATCH: unlinked contacts looked up in GHL per org per tick (default 25, max 100, 0 turns the lookup off). */
function lookupBatchSize(): number {
  const raw = Deno.env.get('GHL_LOOKUP_BATCH');
  if (raw === undefined || raw === '') return 25;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 100) : 25;
}

interface ReconcileOrgRow {
  org_id: string;
  location_id: string;
  ghl_dnc_tags: string[] | null;
  ghl_paused_tags: string[] | null;
  ghl_exclude_tags: string[] | null;
  ghl_exclude_stage_ids: string[] | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('GHL_RECONCILE_WORKER_SECRET');
  const providedSecret = req.headers.get('X-Cron-Secret');
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const started = Date.now();
  const supabase = getSupabaseAdmin();
  const { data: orgs, error: orgsError } = await supabase
    .from('org_integrations')
    .select(
      'org_id, location_id, ghl_dnc_tags, ghl_paused_tags, ghl_exclude_tags, ghl_exclude_stage_ids'
    )
    .eq('provider', 'ghl')
    .eq('status', 'connected')
    .eq('ghl_reconcile_enabled', true);
  if (orgsError) {
    console.error('[ghl-reconcile-worker] org_integrations lookup failed', orgsError.message);
    return jsonResponse({ error: orgsError.message }, 500);
  }

  const results: Record<string, unknown>[] = [];
  for (const org of (orgs ?? []) as ReconcileOrgRow[]) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      results.push({ orgId: org.org_id, skipped: 'time budget' });
      continue;
    }
    try {
      const { data: token } = await supabase.rpc('get_org_ghl_token', { p_org: org.org_id });
      if (!token || !org.location_id) {
        results.push({ orgId: org.org_id, error: 'no GHL token/location' });
        continue;
      }
      const client = withGhlRateLimit(
        createGhlClient(token as string, { apiBase: Deno.env.get('GHL_API_BASE') || undefined }),
        createGhlRateLimiter({ maxPerWindow: GHL_PULL_RATE_LIMIT_MAX_PER_WINDOW })
      );
      // TASK-G32: link CSV-imported contacts to GHL by phone first; a failure here never stops the main reconcile
      let lookup: Awaited<ReturnType<typeof lookupUnlinkedContacts>> | null = null;
      let lookupError: string | null = null;
      try {
        lookup = await lookupUnlinkedContacts(supabase, client, {
          orgId: org.org_id,
          locationId: org.location_id,
          batchSize: lookupBatchSize(),
          deadlineMs: Math.min(started + TIME_BUDGET_MS, Date.now() + LOOKUP_BUDGET_MS),
        });
      } catch (err) {
        lookupError = err instanceof Error ? err.message : String(err);
        console.error(`[ghl-reconcile-worker] org ${org.org_id} lookup failed`, lookupError);
      }
      const r0 = await reconcileOrg(supabase, client, {
        orgId: org.org_id,
        locationId: org.location_id,
        dncTags: org.ghl_dnc_tags,
        pausedTags: org.ghl_paused_tags,
        excludeTags: org.ghl_exclude_tags,
        excludeStageIds: org.ghl_exclude_stage_ids,
        batchSize: batchSize(),
        deadlineMs: started + TIME_BUDGET_MS,
        extraRows: lookup?.linked ?? [],
      });
      const r = { ...r0, lookup: lookup?.result ?? { error: lookupError } };
      await supabase.rpc('record_ghl_reconcile_result', { p_org: org.org_id, p_counts: r });
      results.push({ orgId: org.org_id, ...r });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ghl-reconcile-worker] org ${org.org_id} failed`, message);
      await supabase.rpc('record_ghl_reconcile_result', {
        p_org: org.org_id,
        p_counts: { error: message },
      });
      results.push({ orgId: org.org_id, error: message });
    }
  }
  return jsonResponse({ orgsProcessed: results.length, results });
});
