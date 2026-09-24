/**
 * dialer-sweeper (TASK-P2-E5, design §4.7): reconciles state a lost webhook otherwise strands
 * forever, and closes TASK-P2-E2's own carried item 5 (record_webhook_event commits before
 * processing, so a webhook whose processing throws after that commit is lost -- Telnyx already
 * got its 200 and never redelivers).
 *
 * Triggered every 30s by pg_cron/pg_net (`private.trigger_dialer_sweeper`,
 * `20260924001700_dialer_sweeper_cron.sql`) with a shared secret header, not a user JWT -- the
 * exact same shape as `ghl-sync-worker` (TASK-P3-P3): the caller is Postgres itself, not a
 * signed-in user, so this is not `requireTelnyxOrgRole` either -- it acts across every org in
 * one sweep, and `run_dialer_sweep` (SQL) org-scopes its own row-level work internally.
 *
 * All the actual STATE mutation happens inside `run_dialer_sweep` (SQL), reusing transition_leg/
 * transition_session/apply_leg_outcome's existing idempotent expected-state guards -- this
 * function's only job is the one thing SQL can't do: best-effort Telnyx hangup for every leg the
 * RPC just reaped, exactly like `dialer-engine.ts`'s own `hangupLeg` (a failed hangup is logged,
 * never fatal -- the leg is already 'ended' in our own bookkeeping regardless).
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getConnectedOrgTelnyxContext } from '../_shared/telnyx-org-context.ts';

const STUCK_AFTER_SECONDS = 60;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** Same constant-time comparison as ghl-sync-worker's secretsMatch -- a plain `===` on the raw
 *  secret leaks its length/prefix through response-time differences. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

interface ReapedLeg {
  org_id: string;
  call_control_id: string;
}

interface DialerSweepResult {
  reaped_legs: ReapedLeg[];
  paused_agent_sessions: number;
  applied_orphaned_outcomes: number;
  requeued_leads: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('DIALER_SWEEPER_SECRET');
  const providedSecret = req.headers.get('X-Cron-Secret');
  // Fail closed: an unset expectedSecret never means "allow everything" (known-issues #0's
  // telnyx-webhook lesson, applied here the same way ghl-sync-worker already applied it).
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc('run_dialer_sweep', {
    p_stuck_after_seconds: STUCK_AFTER_SECONDS,
  });
  if (error) {
    console.error('[dialer-sweeper] run_dialer_sweep failed', error.message);
    return jsonResponse({ error: error.message }, 500);
  }
  const result = data as DialerSweepResult;

  // Best-effort Telnyx hangup for every leg the RPC just reaped -- our own state already reads
  // 'ended' regardless of whether Telnyx's side ever confirms it, same non-fatal shape as
  // dialer-engine.ts's hangupLeg. One client resolution per org, not per leg.
  const orgClients = new Map<string, Awaited<ReturnType<typeof getConnectedOrgTelnyxContext>>>();
  let hungUp = 0;
  for (const leg of result.reaped_legs ?? []) {
    if (!orgClients.has(leg.org_id)) {
      orgClients.set(leg.org_id, await getConnectedOrgTelnyxContext(supabase, leg.org_id));
    }
    const ctx = orgClients.get(leg.org_id);
    if (!ctx?.client) continue;
    try {
      await ctx.client.hangup(leg.call_control_id);
      hungUp++;
    } catch (err) {
      console.log('[dialer-sweeper] hangup_failed', leg.call_control_id, String(err));
    }
  }

  console.log('[dialer-sweeper] sweep_done', {
    reaped: result.reaped_legs?.length ?? 0,
    hungUp,
    pausedAgentSessions: result.paused_agent_sessions,
    appliedOrphanedOutcomes: result.applied_orphaned_outcomes,
    requeuedLeads: result.requeued_leads,
  });

  return jsonResponse({
    reaped: result.reaped_legs?.length ?? 0,
    hungUp,
    pausedAgentSessions: result.paused_agent_sessions,
    appliedOrphanedOutcomes: result.applied_orphaned_outcomes,
    requeuedLeads: result.requeued_leads,
  });
});
