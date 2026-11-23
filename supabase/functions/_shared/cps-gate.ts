/**
 * Outbound dial pacing (proposal). Call `awaitDialSlot` immediately before every Telnyx
 * `client.dial()` so an org's combined origination rate, across every concurrent session and
 * edge isolate, stays at or under its `org_telephony.dial_cps_limit` (default 5, Telnyx's free
 * tier) in any rolling 1.1 s window -- see migration 20261124000000_dial_cps_gate.sql.
 *
 * Dials under the limit go out with no wait; only the excess is delayed, so one agent's
 * 10-line redial after a connected call finishes about 1.1 s after it starts at worst.
 *
 * Fails OPEN on an RPC error: a pacing outage should cost at most a small surcharge, never stop
 * the dial loop. Throws when the reserved slot is more than `maxWaitMs` away, which dialLead's
 * own catch already turns into a retryable `no_answer` leg.
 */
// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

const MAX_WAIT_MS = 15_000;

export async function awaitDialSlot(
  supabase: SupabaseClient,
  orgId: string,
  opts: { maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { data, error } = await supabase.rpc('reserve_dial_slot', { p_org: orgId });
  if (error) {
    console.warn(JSON.stringify({ step: 'cps_gate_rpc_failed_open', orgId, error: error.message }));
    return;
  }
  const waitMs = typeof data === 'number' ? data : 0;
  if (waitMs > (opts.maxWaitMs ?? MAX_WAIT_MS)) throw new Error('cps_gate_timeout');
  if (waitMs > 0) {
    console.log(JSON.stringify({ step: 'cps_gate_wait', orgId, waitMs }));
    await sleep(waitMs);
  }
}
