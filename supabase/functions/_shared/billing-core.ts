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
  ADD_FUNDS_DAILY_CAP_USD,
  ADD_FUNDS_MIN_INTERVAL_SECONDS,
  isAddFundsRateLimited,
  isValidIdempotencyKey,
  mapTelnyxBillingError,
  validateAddFundsAmount,
  validateAutoRechargePrefs,
  wouldExceedDailyAddFundsCap,
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

  // Rate limit 1: at most 1 SUCCESSFUL add_funds per org per ADD_FUNDS_MIN_INTERVAL_SECONDS.
  const windowStart = new Date(Date.now() - ADD_FUNDS_MIN_INTERVAL_SECONDS * 1000).toISOString();
  const { data: recentSucceeded } = await supabase
    .from('org_billing_events')
    .select('created_at')
    .eq('org_id', orgId)
    .eq('kind', 'add_funds')
    .eq('status', 'succeeded')
    .gte('created_at', windowStart)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    recentSucceeded &&
    isAddFundsRateLimited(new Date(recentSucceeded.created_at as string), new Date())
  ) {
    return {
      status: 429,
      body: {
        error: `Please wait a moment before adding funds again (at most once every ${ADD_FUNDS_MIN_INTERVAL_SECONDS}s).`,
        code: 'RATE_LIMITED',
      },
    };
  }

  // Rate limit 2: at most ADD_FUNDS_DAILY_CAP_USD of SUCCESSFUL add_funds per org per rolling
  // 24h.
  const dayStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: last24h } = await supabase
    .from('org_billing_events')
    .select('amount_usd')
    .eq('org_id', orgId)
    .eq('kind', 'add_funds')
    .eq('status', 'succeeded')
    .gte('created_at', dayStart);
  const succeededLast24hUsd = ((last24h ?? []) as { amount_usd: number | null }[]).reduce(
    (sum, row) => sum + Number(row.amount_usd ?? 0),
    0
  );
  if (wouldExceedDailyAddFundsCap(amountUsd, succeededLast24hUsd)) {
    return {
      status: 400,
      body: {
        error: `This would exceed the $${ADD_FUNDS_DAILY_CAP_USD.toFixed(2)}/24h add-funds limit for this org ($${succeededLast24hUsd.toFixed(2)} already added in the last 24h).`,
        code: 'DAILY_CAP_EXCEEDED',
      },
    };
  }

  // Idempotency: insert the 'pending' row BEFORE calling Telnyx. A 23505 on the
  // (org_id, idempotency_key) unique index means this exact key was already used for this org --
  // refuse without ever calling Telnyx a second time.
  const { data: pendingRow, error: insertError } = await supabase
    .from('org_billing_events')
    .insert({
      org_id: orgId,
      user_id: userId,
      kind: 'add_funds',
      amount_usd: amountUsd,
      idempotency_key: idempotencyKey,
      status: 'pending',
    })
    .select('id')
    .single();
  if (insertError) {
    if (insertError.code === '23505') {
      return {
        status: 409,
        body: { error: 'This add-funds request was already submitted.', code: 'DUPLICATE_REQUEST' },
      };
    }
    console.error('[billing-core] audit insert failed (add_funds)', insertError.message);
    return { status: 500, body: { error: 'Failed to record the billing event' } };
  }

  let result;
  try {
    result = await client.addFunds(amountUsd);
  } catch (err) {
    console.error('[billing-core] add_funds failed', err);
    const mapped = mapTelnyxBillingError(err);
    await supabase
      .from('org_billing_events')
      .update({ status: 'failed', error: mapped.message })
      .eq('id', pendingRow.id);
    return { status: 502, body: { error: mapped.message, code: mapped.code } };
  }

  await supabase
    .from('org_billing_events')
    .update({ status: 'succeeded', telnyx_transaction_id: result.transactionId })
    .eq('id', pendingRow.id);

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
