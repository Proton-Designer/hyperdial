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
 * Most of the actual STATE mutation happens inside `run_dialer_sweep` (SQL), reusing
 * transition_leg/transition_session/apply_leg_outcome's existing idempotent expected-state
 * guards. This function's own job is the two things SQL can't do: (1) best-effort Telnyx
 * hangup for every leg the RPC just reaped, exactly like `dialer-engine.ts`'s own `hangupLeg`
 * (a failed hangup is logged, never fatal -- the leg is already 'ended' in our own bookkeeping
 * regardless); (2) TASK-L6's own claimed-leg reconciliation
 * (`_shared/dialer-sweeper-core.ts`'s `reconcileStaleClaimedLeg`) -- the RPC only ever SELECTs
 * candidate `claimed` legs silent past a threshold, since deciding whether one is actually dead
 * needs a live Telnyx call (`GET /calls/{id}`, `is_alive`) this function makes per candidate.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getConnectedOrgTelnyxContext } from '../_shared/telnyx-org-context.ts';
import {
  reconcileStaleClaimedLeg,
  hangUpReapedCoachingSessions,
  unwindReapedCallTransfers,
  type StaleClaimedLegCandidate,
  type ReapedCoachingSession,
  type ReapedCallTransfer,
} from '../_shared/dialer-sweeper-core.ts';
import type { TelnyxClient } from '../_shared/telnyx-client.ts';
import { VOICEMAIL_DROP_SWEEP_TIMEOUT_SECONDS } from '../_shared/voicemail-core.ts';

const STUCK_AFTER_SECONDS = 60;
// TASK-L6: how long a claimed (bridged) contact leg must be silent before this even asks
// Telnyx whether it's still alive -- see dialer-sweeper-core.ts's own header for why this
// can't just be a longer version of STUCK_AFTER_SECONDS's own webhook-silence heuristic.
const CLAIMED_CHECK_AFTER_SECONDS = 300;
// TASK-T3 review fix-forward (msg-fix-T3.txt): the target session hasn't been on_call for this
// long -> the coaching leg is almost certainly stale (the coached call ended/dropped).
const COACHING_STUCK_AFTER_SECONDS = 60;
// Absolute ceiling on a coaching session regardless of the target's own state -- a runaway
// manager leg is real per-minute Telnyx billing, so this never waits forever even if the
// target session's state somehow never leaves on_call.
const COACHING_HARD_CAP_SECONDS = 2 * 60 * 60;
// TASK-T4: a 'dialing' transfer this old (well past TRANSFER_DIAL_TIMEOUT_SECS' own 30s ring +
// generous grace) almost certainly lost its own call.hangup webhook.
const TRANSFER_DIALING_STUCK_AFTER_SECONDS = 5 * 60;
// A 'connected' (warm) transfer this old leaves the AGENT stuck in a side conference,
// unable to take their next contact -- an absolute ceiling, not a webhook-loss heuristic (a
// real warm-transfer conversation could otherwise run indefinitely).
const TRANSFER_CONNECTED_HARD_CAP_SECONDS = 2 * 60 * 60;

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
  stale_claimed_legs: StaleClaimedLegCandidate[];
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
    p_claimed_check_after_seconds: CLAIMED_CHECK_AFTER_SECONDS,
    // TASK-F-T3 (VMD-2 safety timeout): reaps a leg stuck in 'voicemail_dropping' -- see
    // run_dialer_sweep's own SQL comment (block 1c) and voicemail-core.ts's header.
    p_voicemail_drop_after_seconds: VOICEMAIL_DROP_SWEEP_TIMEOUT_SECONDS,
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

  // TASK-L6 (known-issues #11 / BUG-9): claimed legs the RPC only ever SELECTs (never mutates
  // -- it can't ask Telnyx anything). reconcileStaleClaimedLeg decides per candidate: past
  // Telnyx's own hard time_limit_secs+grace cap -> reap unconditionally, no need to ask;
  // otherwise ask Telnyx (getCallStatus/is_alive) and only reap on a DEFINITIVE not-alive/404
  // -- an API error or a genuinely live call never ends anything. Reuses the SAME per-org
  // client map as the hangup loop above.
  let reapedClaimedTimeout = 0;
  let reapedClaimedConfirmedDead = 0;
  let claimedLeftAlone = 0;
  for (const leg of result.stale_claimed_legs ?? []) {
    if (!orgClients.has(leg.org_id)) {
      orgClients.set(leg.org_id, await getConnectedOrgTelnyxContext(supabase, leg.org_id));
    }
    const ctx = orgClients.get(leg.org_id);
    const outcome = await reconcileStaleClaimedLeg(leg, {
      supabase,
      client: (ctx?.client ?? null) as TelnyxClient | null,
    });
    if (outcome === 'reaped_timeout') reapedClaimedTimeout++;
    else if (outcome === 'reaped_confirmed_dead') reapedClaimedConfirmedDead++;
    else claimedLeftAlone++;
  }

  // TASK-T3 review fix-forward: SQL has already flipped each returned row to status='ended' --
  // this is purely the best-effort real Telnyx hangup, same orgClients cache as the loops above.
  const { data: reapedCoachingData, error: coachingReapError } = await supabase.rpc(
    'reap_stale_coaching_sessions',
    {
      p_stuck_after_seconds: COACHING_STUCK_AFTER_SECONDS,
      p_hard_cap_seconds: COACHING_HARD_CAP_SECONDS,
    }
  );
  if (coachingReapError) {
    console.error(
      '[dialer-sweeper] reap_stale_coaching_sessions failed',
      coachingReapError.message
    );
  }
  const reapedCoachingSessions = (reapedCoachingData ?? []) as ReapedCoachingSession[];
  const coachingHungUp = await hangUpReapedCoachingSessions(reapedCoachingSessions, {
    resolveClient: async (orgId) => {
      if (!orgClients.has(orgId)) {
        orgClients.set(orgId, await getConnectedOrgTelnyxContext(supabase, orgId));
      }
      return orgClients.get(orgId)?.client ?? null;
    },
  });

  // TASK-T4: same split as the coaching reap above -- SQL has already flipped each returned row
  // to status='failed'; this is the best-effort Telnyx cleanup (target hangup, and for a
  // 'connected' row, unwinding the agent out of the side conference back to their main one).
  const { data: reapedTransferData, error: transferReapError } = await supabase.rpc(
    'reap_stale_call_transfers',
    {
      p_dialing_after_seconds: TRANSFER_DIALING_STUCK_AFTER_SECONDS,
      p_connected_hard_cap_seconds: TRANSFER_CONNECTED_HARD_CAP_SECONDS,
    }
  );
  if (transferReapError) {
    console.error('[dialer-sweeper] reap_stale_call_transfers failed', transferReapError.message);
  }
  const reapedCallTransfers = (reapedTransferData ?? []) as ReapedCallTransfer[];
  const transfersUnwound = await unwindReapedCallTransfers(reapedCallTransfers, {
    supabase,
    resolveClient: async (orgId) => {
      if (!orgClients.has(orgId)) {
        orgClients.set(orgId, await getConnectedOrgTelnyxContext(supabase, orgId));
      }
      return orgClients.get(orgId)?.client ?? null;
    },
  });

  console.log('[dialer-sweeper] sweep_done', {
    reaped: result.reaped_legs?.length ?? 0,
    hungUp,
    pausedAgentSessions: result.paused_agent_sessions,
    appliedOrphanedOutcomes: result.applied_orphaned_outcomes,
    requeuedLeads: result.requeued_leads,
    staleClaimedLegsChecked: result.stale_claimed_legs?.length ?? 0,
    reapedClaimedTimeout,
    reapedClaimedConfirmedDead,
    claimedLeftAlone,
    reapedCoachingSessions: reapedCoachingSessions.length,
    coachingHungUp,
    reapedCallTransfers: reapedCallTransfers.length,
    transfersUnwound,
  });

  return jsonResponse({
    reaped: result.reaped_legs?.length ?? 0,
    hungUp,
    pausedAgentSessions: result.paused_agent_sessions,
    appliedOrphanedOutcomes: result.applied_orphaned_outcomes,
    requeuedLeads: result.requeued_leads,
    staleClaimedLegsChecked: result.stale_claimed_legs?.length ?? 0,
    reapedClaimedTimeout,
    reapedClaimedConfirmedDead,
    claimedLeftAlone,
    reapedCoachingSessions: reapedCoachingSessions.length,
    coachingHungUp,
    reapedCallTransfers: reapedCallTransfers.length,
    transfersUnwound,
  });
});
