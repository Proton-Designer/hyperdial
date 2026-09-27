/**
 * TASK-L6 (known-issues #11 / BUG-9): the decision logic for reconciling a `claimed` contact
 * leg whose own `call.hangup` webhook was lost. `run_dialer_sweep` (SQL,
 * `20260925010000_dialer_sweeper_claimed_legs.sql`) only ever SELECTs candidates -- it cannot
 * ask Telnyx anything -- so this is the one place that decides, for each candidate, whether to
 * reap it:
 *
 *   1. Older than `timeLimitSecs + timeLimitGraceSecs` (Telnyx's own hard cap on how long the
 *      call leg can run, BUG-8) -- definitely dead, no need to ask. Reap unconditionally.
 *   2. Otherwise, ask Telnyx directly (`getCallStatus`, `is_alive`) -- Telnyx says not alive
 *      (or the call is unknown to it at all, a 404) -- reap.
 *   3. Telnyx says alive -- leave it alone. A real conversation is silent on the webhook
 *      stream for its whole duration by design; that's not evidence of anything wrong.
 *   4. Any other Telnyx response (a genuine API error, or a malformed one) -- leave it alone.
 *      Never end a leg on an INCONCLUSIVE result -- only a definitive one.
 *
 * Reaping itself (branches 1 and 2) is the same one call either way:
 * `reap_dead_claimed_leg` (SQL) -- this file never mutates anything directly, only decides
 * whether to call it and with what hangup_cause.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { TelnyxClient } from './telnyx-client.ts';
import { CONTACT_DIAL_TIME_LIMIT_SECS } from './dialer-engine.ts';

export interface StaleClaimedLegCandidate {
  id: string;
  call_control_id: string;
  org_id: string;
  /** ISO timestamp -- the leg's own `created_at` (when it was dialed), the anchor for the
   *  Telnyx time_limit_secs hard cap, per BUG-8's own header comment. */
  created_at: string;
}

export type ReconcileOutcome =
  'reaped_timeout' | 'reaped_confirmed_dead' | 'alive' | 'inconclusive';

export interface ReconcileStaleClaimedLegDeps {
  supabase: SupabaseClient;
  client: TelnyxClient | null;
  /** Defaults to the SAME constant every contact dial actually uses (BUG-8) -- see that
   *  export's own comment on why this must not be an independently-maintained copy. */
  timeLimitSecs?: number;
  /** The spec's own "+ 5 min" grace window, TASK-L6. */
  timeLimitGraceSecs?: number;
  now?: () => Date;
}

/** Review fix (minor 3): after a SUCCESSFUL reap, best-effort hang up the real Telnyx call --
 *  a false "dead" read (a stale/rotated Telnyx key after a BYO-account swap, a wrong
 *  TELNYX_API_BASE, or any other reason `getCallStatus`/the hard-timeout branch was wrong)
 *  would otherwise leave a live customer parked in the conference while our own bookkeeping
 *  has already moved on to wrap_up/dialing and a NEW winner joins the same conference. Mirrors
 *  dialer-sweeper/index.ts's own existing best-effort hangup loop for `reaped_legs` -- a failed
 *  hangup is logged, never fatal (our own state is already 'ended' regardless). A no-op on a
 *  genuinely dead call. */
async function bestEffortHangup(client: TelnyxClient | null, callControlId: string): Promise<void> {
  if (!client) return;
  try {
    await client.hangup(callControlId);
  } catch {
    // Swallow -- see this function's own comment. Nothing to escalate to; the caller has no
    // more useful action to take than what it already did (reap the leg in our own bookkeeping).
  }
}

export async function reconcileStaleClaimedLeg(
  candidate: StaleClaimedLegCandidate,
  deps: ReconcileStaleClaimedLegDeps
): Promise<ReconcileOutcome> {
  // Review fix (minor 3): a placeholder call_control_id (claim_next_leads inserts the leg row
  // BEFORE dialing, dialer-engine.ts's refillSession) was never actually dialed on Telnyx --
  // asking Telnyx about it would 404 (a definitive "not alive" per getCallStatus's own
  // contract) for a leg that in reality just hasn't been dialed yet, a false positive this
  // candidate set should never contain in practice (a 'claimed' leg is always past dialing) but
  // is cheap and correct to guard against explicitly rather than relying on that invariant.
  if (candidate.call_control_id.startsWith('pending-')) return 'inconclusive';

  const now = (deps.now ?? (() => new Date()))();
  const timeLimitSecs = deps.timeLimitSecs ?? CONTACT_DIAL_TIME_LIMIT_SECS;
  const graceSecs = deps.timeLimitGraceSecs ?? 300;
  const ageSeconds = (now.getTime() - new Date(candidate.created_at).getTime()) / 1000;

  if (ageSeconds >= timeLimitSecs + graceSecs) {
    const { data } = await deps.supabase.rpc('reap_dead_claimed_leg', {
      p_leg: candidate.id,
      p_hangup_cause: 'timeout',
    });
    if (!data) return 'inconclusive';
    await bestEffortHangup(deps.client, candidate.call_control_id);
    return 'reaped_timeout';
  }

  if (!deps.client) return 'inconclusive';
  const status = await deps.client.getCallStatus(candidate.call_control_id).catch(() => null);
  if (!status) return 'inconclusive';
  if (status.isAlive) return 'alive';

  const { data } = await deps.supabase.rpc('reap_dead_claimed_leg', {
    p_leg: candidate.id,
    p_hangup_cause: 'call_not_alive',
  });
  if (!data) return 'inconclusive';
  await bestEffortHangup(deps.client, candidate.call_control_id);
  return 'reaped_confirmed_dead';
}

/**
 * TASK-T3 review fix-forward (eng1's review-eng1.md #1): the server-side safety net for a
 * coaching manager's own leg outliving the coached call (a crashed/backgrounded tab -- the
 * client-side poll in CoachingBanner.tsx is the normal, fast path; this only matters when that
 * never runs). `reap_stale_coaching_sessions` (SQL,
 * `20260926070001_coaching_autoend.sql`) has ALREADY flipped each returned row's
 * `coaching_sessions.status` to 'ended' by the time this runs -- unlike
 * `reconcileStaleClaimedLeg`, there is no live Telnyx "is it actually dead" check to make here
 * (staleness was derived from the TARGET session's own state, not from asking Telnyx anything),
 * so this function's only job is the best-effort real hangup, one Telnyx client per org.
 */
export interface ReapedCoachingSession {
  id: string;
  org_id: string;
  manager_call_control_id: string | null;
}

export interface HangUpReapedCoachingSessionsDeps {
  /** Resolves (and should itself cache/memoize) a connected org's Telnyx client. Returns null
   *  for an org with no usable connection -- that org's rows are just skipped, never fatal. */
  resolveClient: (orgId: string) => Promise<TelnyxClient | null>;
}

export async function hangUpReapedCoachingSessions(
  rows: ReapedCoachingSession[],
  deps: HangUpReapedCoachingSessionsDeps
): Promise<number> {
  let hungUp = 0;
  for (const row of rows) {
    // A coaching session can be reaped before the manager's own dial() ever returned a
    // call_control_id (a crash mid-start) -- nothing real to hang up.
    if (!row.manager_call_control_id) continue;
    const client = await deps.resolveClient(row.org_id);
    if (!client) continue;
    try {
      // Deliberately NOT bestEffortHangup -- that helper swallows the outcome entirely, and
      // the return count here should reflect real successes (dialer-sweeper/index.ts's own
      // reaped_legs loop, the pattern this mirrors, counts the same way).
      await client.hangup(row.manager_call_control_id);
      hungUp++;
    } catch {
      // Our own bookkeeping already reads 'ended' regardless (set by the SQL reap itself,
      // before this ever runs) -- nothing left to escalate to.
    }
  }
  return hungUp;
}
