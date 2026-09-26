/**
 * TASK-BF1: the actual add-funds/auto-recharge orchestration logic, separated from
 * `telnyx-billing/index.ts`'s thin `Deno.serve` wrapper so it can be deno-tested with a fake
 * supabase + fake `TelnyxClient` -- same "pure/testable core, thin HTTP shell" split as
 * `dialer-engine.ts`/`inbound-engine.ts`, and the reason this function (unusually for this repo
 * -- see spend-estimate.ts's own header, "no Edge Function `index.ts` has a test file of its
 * own") gets direct orchestration tests: `Deno.serve` runs as an import-time side effect, so
 * `index.ts` itself is never imported by a test, only this module.
 *
 * Returns a plain `{status, body}` result rather than a `Response` -- keeps every test a plain
 * object assertion, no `Response`/`fetch` involved at all.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { TelnyxClient } from './telnyx-client.ts';
import {
  classifyAddFundsFailure,
  isValidIdempotencyKey,
  mapTelnyxBillingError,
  validateAddFundsAmount,
  validateAutoRechargePrefs,
} from './billing-validation.ts';

export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

export async function runGetAction(client: TelnyxClient): Promise<ActionResult> {
  try {
    const [balance, autoRecharge] = await Promise.all([
      client.getBalance(),
      client.getAutoRechargePrefs(),
    ]);
    return {
      status: 200,
      body: {
        balanceUsd: balance.balanceUsd,
        availableCreditUsd: balance.availableCreditUsd,
        autoRecharge,
      },
    };
  } catch (err) {
    console.error('[billing-core] get failed', err);
    const mapped = mapTelnyxBillingError(err);
    return { status: 502, body: { error: mapped.message, code: mapped.code } };
  }
}

export async function runUpdateAutoRechargeAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  userId: string,
  body: Record<string, unknown>
): Promise<ActionResult> {
  const validation = validateAutoRechargePrefs({
    enabled: body.enabled,
    thresholdAmountUsd: body.thresholdAmountUsd,
    rechargeAmountUsd: body.rechargeAmountUsd,
    invoiceEnabled: body.invoiceEnabled,
    preference: body.preference,
  });
  if (!validation.ok) return { status: 400, body: { error: validation.error } };

  let before: unknown = null;
  try {
    before = await client.getAutoRechargePrefs();
  } catch (err) {
    console.warn('[billing-core] update_auto_recharge: could not read prior prefs', err);
  }

  const { data: pendingRow, error: insertError } = await supabase
    .from('org_billing_events')
    .insert({
      org_id: orgId,
      user_id: userId,
      kind: 'auto_recharge_update',
      status: 'pending',
      request_snapshot: { before, attempted: validation.value },
    })
    .select('id')
    .single();
  if (insertError || !pendingRow) {
    console.error(
      '[billing-core] audit insert failed (auto_recharge_update)',
      insertError?.message
    );
    return { status: 500, body: { error: 'Failed to record the billing event' } };
  }

  let after;
  try {
    after = await client.updateAutoRechargePrefs(validation.value);
  } catch (err) {
    console.error('[billing-core] update_auto_recharge failed', err);
    const mapped = mapTelnyxBillingError(err);
    await supabase
      .from('org_billing_events')
      .update({ status: 'failed', error: mapped.message })
      .eq('id', pendingRow.id);
    return { status: 502, body: { error: mapped.message, code: mapped.code } };
  }

  await supabase
    .from('org_billing_events')
    .update({ status: 'succeeded', request_snapshot: { before, after } })
    .eq('id', pendingRow.id);

  return { status: 200, body: { autoRecharge: after } };
}

export async function runAddFundsAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  userId: string,
  body: Record<string, unknown>
): Promise<ActionResult> {
  const validation = validateAddFundsAmount(body.amountUsd);
  if (!validation.ok) return { status: 400, body: { error: validation.error } };
  const { amountUsd } = validation;

  if (!isValidIdempotencyKey(body.idempotencyKey)) {
    return { status: 400, body: { error: 'A valid idempotencyKey (uuid) is required.' } };
  }
  const idempotencyKey = body.idempotencyKey as string;

  // TASK-BF1 fix (lead + eng2 review, HIGH): the rate-limit check, the daily-cap check, and the
  // 'pending' row insert used to be three separate round-trips, each looking only at
  // status='succeeded' -- two concurrent add_funds requests with DIFFERENT idempotency keys (so
  // the unique index never fires) each saw "nothing recent yet" before either one's own Telnyx
  // call resolved, and both charged. `reserve_add_funds` (migration 20260925080301) does all
  // three atomically inside one pg_advisory_xact_lock'd SQL function, counting
  // pending/succeeded/unknown (never just succeeded), and raises a distinct SQLSTATE per
  // rejection reason that this function maps below.
  const { data: reservedId, error: reserveError } = await supabase.rpc('reserve_add_funds', {
    p_org: orgId,
    p_user: userId,
    p_amount: amountUsd,
    p_key: idempotencyKey,
  });
  if (reserveError || !reservedId) {
    switch (reserveError?.code) {
      case 'BF001':
        return { status: 429, body: { error: reserveError.message, code: 'RATE_LIMITED' } };
      case 'BF002':
        return { status: 400, body: { error: reserveError.message, code: 'DAILY_CAP_EXCEEDED' } };
      case 'BF003':
        return { status: 409, body: { error: reserveError.message, code: 'DUPLICATE_REQUEST' } };
      default:
        console.error('[billing-core] reserve_add_funds failed', reserveError?.message);
        return { status: 500, body: { error: 'Failed to record the billing event' } };
    }
  }
  const pendingRowId = reservedId as string;

  let result;
  try {
    result = await client.addFunds(amountUsd);
  } catch (err) {
    console.error('[billing-core] add_funds failed', err);
    const mapped = mapTelnyxBillingError(err);
    if (classifyAddFundsFailure(err) === 'definitive') {
      // Telnyx itself rejected the request outright (a 4xx) -- no charge was attempted, so it's
      // safe to free the idempotency key: the dialog mints a new one and returns to the amount
      // step (eng2 review finding #2 -- the old unconditional-unique-key shape permanently burned
      // the key on every failure, including this safe case, leaving no real retry affordance
      // short of closing and reopening the dialog).
      await supabase
        .from('org_billing_events')
        .update({ status: 'failed', error: mapped.message, idempotency_key: null })
        .eq('id', pendingRowId);
      return { status: 502, body: { error: mapped.message, code: mapped.code } };
    }
    // Ambiguous (network error/timeout/5xx) -- Telnyx may or may not have actually charged the
    // card. The key is NOT freed: a same-key retry hits the unique constraint (409) instead of
    // risking a second real charge, and the row keeps counting toward both rate limits
    // (conservative, per the lead's own review).
    await supabase
      .from('org_billing_events')
      .update({ status: 'unknown', error: 'outcome unknown' })
      .eq('id', pendingRowId);
    return {
      status: 502,
      body: {
        error:
          "We couldn't confirm the charge with Telnyx. Check your balance in the Telnyx portal before trying again.",
        code: 'OUTCOME_UNKNOWN',
      },
    };
  }

  await supabase
    .from('org_billing_events')
    .update({
      status: 'succeeded',
      telnyx_transaction_id: result.transactionId,
      // eng2 review finding #3 (LOW): Telnyx's own processor_status was read then silently
      // dropped -- stored here so there's something to reconcile against if it's ever not a
      // plain success value.
      request_snapshot: { processorStatus: result.processorStatus },
    })
    .eq('id', pendingRowId);

  let balance: { balanceUsd: number; availableCreditUsd: number } | null = null;
  try {
    balance = await client.getBalance();
  } catch (err) {
    // The charge itself already succeeded (recorded above) -- a balance re-fetch failing here
    // is not the charge failing, just a stale number in this one response.
    console.warn('[billing-core] add_funds succeeded but re-fetching balance failed', err);
  }

  return {
    status: 200,
    body: {
      success: true,
      transactionId: result.transactionId,
      balanceUsd: balance?.balanceUsd ?? null,
      availableCreditUsd: balance?.availableCreditUsd ?? null,
    },
  };
}
