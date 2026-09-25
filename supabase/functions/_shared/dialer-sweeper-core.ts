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

export async function reconcileStaleClaimedLeg(
  candidate: StaleClaimedLegCandidate,
  deps: ReconcileStaleClaimedLegDeps
): Promise<ReconcileOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const timeLimitSecs = deps.timeLimitSecs ?? CONTACT_DIAL_TIME_LIMIT_SECS;
  const graceSecs = deps.timeLimitGraceSecs ?? 300;
  const ageSeconds = (now.getTime() - new Date(candidate.created_at).getTime()) / 1000;

  if (ageSeconds >= timeLimitSecs + graceSecs) {
    const { data } = await deps.supabase.rpc('reap_dead_claimed_leg', {
      p_leg: candidate.id,
      p_hangup_cause: 'timeout',
    });
    return data ? 'reaped_timeout' : 'inconclusive';
  }

  if (!deps.client) return 'inconclusive';
  const status = await deps.client.getCallStatus(candidate.call_control_id).catch(() => null);
  if (!status) return 'inconclusive';
  if (status.isAlive) return 'alive';

  const { data } = await deps.supabase.rpc('reap_dead_claimed_leg', {
    p_leg: candidate.id,
    p_hangup_cause: 'call_not_alive',
  });
  return data ? 'reaped_confirmed_dead' : 'inconclusive';
}
