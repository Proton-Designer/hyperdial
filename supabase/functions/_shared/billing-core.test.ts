import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import { runAddFundsAction, runGetAction, runUpdateAutoRechargeAction } from './billing-core.ts';
import type { TelnyxClient, UpdateAutoRechargePrefsArgs } from './telnyx-client.ts';

// ---------------------------------------------------------------------------
// A minimal fake supabase client, backed by an in-memory `org_billing_events` table -- real
// filtering (.eq/.gte), a real unique-constraint simulation on (org_id, idempotency_key) (23505,
// same as the live migration's own partial unique index), and real insert/update mutation, so
// the idempotency/rate-limit/audit-row tests below exercise the actual query shape billing-core.ts
// sends, not a hand-picked canned response.
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  org_id: string;
  user_id: string | null;
  kind: string;
  amount_usd: number | null;
  idempotency_key: string | null;
  status: string;
  telnyx_transaction_id: string | null;
  error: string | null;
  request_snapshot: unknown;
  created_at: string;
}

function makeFakeSupabase(seedRows: Partial<FakeRow>[] = []) {
  let nextId = 1;
  const rows: FakeRow[] = seedRows.map((r) => ({
    id: r.id ?? `seed-${nextId++}`,
    org_id: r.org_id as string,
    user_id: r.user_id ?? null,
    kind: r.kind as string,
    amount_usd: r.amount_usd ?? null,
    idempotency_key: r.idempotency_key ?? null,
    status: r.status ?? 'pending',
    telnyx_transaction_id: r.telnyx_transaction_id ?? null,
    error: r.error ?? null,
    request_snapshot: r.request_snapshot ?? null,
    created_at: r.created_at ?? new Date().toISOString(),
  }));

  function insertRow(values: Partial<FakeRow>) {
    if (values.idempotency_key) {
      const dup = rows.find(
        (r) => r.org_id === values.org_id && r.idempotency_key === values.idempotency_key
      );
      if (dup) {
        return {
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        };
      }
    }
    const row: FakeRow = {
      id: `row-${nextId++}`,
      org_id: values.org_id as string,
      user_id: (values.user_id as string) ?? null,
      kind: values.kind as string,
      amount_usd: (values.amount_usd as number) ?? null,
      idempotency_key: (values.idempotency_key as string) ?? null,
      status: (values.status as string) ?? 'pending',
      telnyx_transaction_id: null,
      error: null,
      request_snapshot: values.request_snapshot ?? null,
      created_at: new Date().toISOString(),
    };
    rows.push(row);
    return { data: row, error: null };
  }

  function query() {
    const filters: Array<(r: FakeRow) => boolean> = [];
    let limitN: number | null = null;
    let ascending = true;
    let mode: 'select' | 'insert' | 'update' = 'select';
    let insertValues: Partial<FakeRow> | null = null;
    let updatePatch: Partial<FakeRow> | null = null;

    function applyFilters(): FakeRow[] {
      let matched = rows.filter((r) => filters.every((f) => f(r)));
      matched = [...matched].sort((a, b) =>
        ascending ? (a.created_at < b.created_at ? -1 : 1) : a.created_at < b.created_at ? 1 : -1
      );
      if (limitN !== null) matched = matched.slice(0, limitN);
      return matched;
    }

    async function runDefault() {
      if (mode === 'update') {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        for (const r of matched) Object.assign(r, updatePatch);
        return { data: null, error: null };
      }
      return { data: applyFilters(), error: null };
    }

    const builder = {
      select(_cols?: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
        return builder;
      },
      gte(col: string, val: string) {
        filters.push((r) => (r as unknown as Record<string, string>)[col] >= val);
        return builder;
      },
      order(_col: string, opts?: { ascending?: boolean }) {
        ascending = opts?.ascending !== false;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      insert(values: Partial<FakeRow>) {
        mode = 'insert';
        insertValues = values;
        return builder;
      },
      update(patch: Partial<FakeRow>) {
        mode = 'update';
        updatePatch = patch;
        return builder;
      },
      async single() {
        if (mode === 'insert') return insertRow(insertValues!);
        const matched = applyFilters();
        return { data: matched[0] ?? null, error: null };
      },
      async maybeSingle() {
        const matched = applyFilters();
        return { data: matched[0] ?? null, error: null };
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return runDefault().then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    rows,
    from(table: string) {
      if (table !== 'org_billing_events') {
        throw new Error(`fake supabase: unexpected table ${table}`);
      }
      return query();
    },
  };
}

function makeFakeTelnyxClient(overrides: Partial<TelnyxClient> = {}): TelnyxClient {
  return {
    getBalance: async () => ({
      balanceUsd: 100,
      availableCreditUsd: 100,
      creditLimitUsd: 0,
      currency: 'USD',
    }),
    getAutoRechargePrefs: async () => ({
      id: 'pref-1',
      enabled: false,
      thresholdAmountUsd: 20,
      rechargeAmountUsd: 100,
      invoiceEnabled: false,
      preference: 'credit_paypal',
    }),
    updateAutoRechargePrefs: async (args: UpdateAutoRechargePrefsArgs) => ({
      id: 'pref-1',
      enabled: args.enabled,
      thresholdAmountUsd: args.thresholdAmountUsd,
      rechargeAmountUsd: args.rechargeAmountUsd,
      invoiceEnabled: args.invoiceEnabled,
      preference: args.preference,
    }),
    addFunds: async (amountUsd: number) => ({
      transactionId: 'txn-1',
      amountCents: Math.round(amountUsd * 100),
      processorStatus: 'succeeded',
    }),
    ...overrides,
  } as unknown as TelnyxClient;
}

const ORG = 'org-1';
const USER = 'user-1';

// ---------------------------------------------------------------------------
// runGetAction
// ---------------------------------------------------------------------------

Deno.test('runGetAction: returns balance + auto-recharge prefs together', async () => {
  const client = makeFakeTelnyxClient();
  const result = await runGetAction(client);
  assertEquals(result.status, 200);
  assertEquals(result.body.balanceUsd, 100);
  assertExists(result.body.autoRecharge);
});

Deno.test('runGetAction: a Telnyx error maps to a clear message, not a raw throw', async () => {
  const client = makeFakeTelnyxClient({
    getBalance: async () => {
      throw new Error('Telnyx API GET /balance failed (403): {}');
    },
  });
  const result = await runGetAction(client);
  assertEquals(result.status, 502);
  assertEquals(result.body.code, 'FORBIDDEN_KEY');
});

// ---------------------------------------------------------------------------
// runUpdateAutoRechargeAction
// ---------------------------------------------------------------------------

Deno.test(
  'runUpdateAutoRechargeAction: validates server-side before calling Telnyx at all',
  async () => {
    const supabase = makeFakeSupabase();
    let called = false;
    const client = makeFakeTelnyxClient({
      updateAutoRechargePrefs: async (args) => {
        called = true;
        return { id: 'x', ...args };
      },
    });
    const result = await runUpdateAutoRechargeAction(supabase as any, client, ORG, USER, {
      enabled: true,
      thresholdAmountUsd: 20,
      rechargeAmountUsd: 5, // below the $10 floor
      invoiceEnabled: false,
      preference: 'credit_paypal',
    });
    assertEquals(result.status, 400);
    assertEquals(called, false);
    assertEquals(supabase.rows.length, 0);
  }
);

Deno.test(
  'runUpdateAutoRechargeAction: records a pending row then flips it to succeeded',
  async () => {
    const supabase = makeFakeSupabase();
    const client = makeFakeTelnyxClient();
    const result = await runUpdateAutoRechargeAction(supabase as any, client, ORG, USER, {
      enabled: true,
      thresholdAmountUsd: 20,
      rechargeAmountUsd: 100,
      invoiceEnabled: false,
      preference: 'credit_paypal',
    });
    assertEquals(result.status, 200);
    assertEquals(supabase.rows.length, 1);
    assertEquals(supabase.rows[0].kind, 'auto_recharge_update');
    assertEquals(supabase.rows[0].status, 'succeeded');
  }
);

Deno.test(
  'runUpdateAutoRechargeAction: a Telnyx failure leaves the audit row failed, not pending',
  async () => {
    const supabase = makeFakeSupabase();
    const client = makeFakeTelnyxClient({
      updateAutoRechargePrefs: async () => {
        throw new Error('Telnyx API PATCH /payment/auto_recharge_prefs failed (422): {}');
      },
    });
    const result = await runUpdateAutoRechargeAction(supabase as any, client, ORG, USER, {
      enabled: true,
      thresholdAmountUsd: 20,
      rechargeAmountUsd: 100,
      invoiceEnabled: false,
      preference: 'credit_paypal',
    });
    assertEquals(result.status, 502);
    assertEquals(supabase.rows.length, 1);
    assertEquals(supabase.rows[0].status, 'failed');
  }
);

// ---------------------------------------------------------------------------
// runAddFundsAction
// ---------------------------------------------------------------------------

const VALID_KEY = '98200000-0000-4000-8000-0000000000a1';

Deno.test(
  'runAddFundsAction: an invalid amount is refused before any DB write or Telnyx call',
  async () => {
    const supabase = makeFakeSupabase();
    const client = makeFakeTelnyxClient();
    const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
      amountUsd: 1, // below the $5 minimum
      idempotencyKey: VALID_KEY,
    });
    assertEquals(result.status, 400);
    assertEquals(supabase.rows.length, 0);
  }
);

Deno.test('runAddFundsAction: a missing/invalid idempotency key is refused', async () => {
  const supabase = makeFakeSupabase();
  const client = makeFakeTelnyxClient();
  const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
    amountUsd: 25,
    idempotencyKey: 'not-a-uuid',
  });
  assertEquals(result.status, 400);
  assertEquals(supabase.rows.length, 0);
});

Deno.test(
  'runAddFundsAction: happy path records pending then succeeded, with the real Telnyx transaction id',
  async () => {
    const supabase = makeFakeSupabase();
    const client = makeFakeTelnyxClient();
    const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
      amountUsd: 25,
      idempotencyKey: VALID_KEY,
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.success, true);
    assertEquals(result.body.transactionId, 'txn-1');
    assertEquals(supabase.rows.length, 1);
    assertEquals(supabase.rows[0].status, 'succeeded');
    assertEquals(supabase.rows[0].telnyx_transaction_id, 'txn-1');
  }
);

Deno.test(
  'runAddFundsAction: a duplicate idempotency key is refused, and Telnyx is never called a second time',
  async () => {
    const supabase = makeFakeSupabase([
      {
        org_id: ORG,
        kind: 'add_funds',
        idempotency_key: VALID_KEY,
        status: 'succeeded',
        amount_usd: 25,
        // Well outside the 60s rate-limit window -- this test isolates the idempotency check,
        // not the rate limit (a real duplicate retry could equally arrive minutes later).
        created_at: new Date(Date.now() - 300_000).toISOString(),
      },
    ]);
    let callCount = 0;
    const client = makeFakeTelnyxClient({
      addFunds: async (amountUsd) => {
        callCount++;
        return {
          transactionId: 'txn-should-not-happen',
          amountCents: amountUsd * 100,
          processorStatus: 'succeeded',
        };
      },
    });
    const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
      amountUsd: 25,
      idempotencyKey: VALID_KEY,
    });
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'DUPLICATE_REQUEST');
    assertEquals(callCount, 0);
    // Still exactly the one seeded row -- no second row was inserted for the duplicate attempt.
    assertEquals(supabase.rows.length, 1);
  }
);

Deno.test(
  'runAddFundsAction: a second charge within 60s of a succeeded one is rate-limited, Telnyx never called',
  async () => {
    const supabase = makeFakeSupabase([
      {
        org_id: ORG,
        kind: 'add_funds',
        idempotency_key: '98200000-0000-4000-8000-0000000000a2',
        status: 'succeeded',
        amount_usd: 25,
        created_at: new Date().toISOString(), // just now -- well within the 60s window
      },
    ]);
    let callCount = 0;
    const client = makeFakeTelnyxClient({
      addFunds: async () => {
        callCount++;
        return { transactionId: 'x', amountCents: 100, processorStatus: 'succeeded' };
      },
    });
    const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
      amountUsd: 25,
      idempotencyKey: VALID_KEY,
    });
    assertEquals(result.status, 429);
    assertEquals(result.body.code, 'RATE_LIMITED');
    assertEquals(callCount, 0);
  }
);

Deno.test(
  'runAddFundsAction: a charge that would push the org over $2,000/24h is refused before charging',
  async () => {
    const supabase = makeFakeSupabase([
      {
        org_id: ORG,
        kind: 'add_funds',
        idempotency_key: '98200000-0000-4000-8000-0000000000a3',
        status: 'succeeded',
        amount_usd: 1980,
        // Just outside the 60s rate-limit window so only the daily cap is exercised here.
        created_at: new Date(Date.now() - 120_000).toISOString(),
      },
    ]);
    let callCount = 0;
    const client = makeFakeTelnyxClient({
      addFunds: async () => {
        callCount++;
        return { transactionId: 'x', amountCents: 100, processorStatus: 'succeeded' };
      },
    });
    const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
      amountUsd: 25, // 1980 + 25 = 2005 > 2000
      idempotencyKey: VALID_KEY,
    });
    assertEquals(result.status, 400);
    assertEquals(result.body.code, 'DAILY_CAP_EXCEEDED');
    assertEquals(callCount, 0);
  }
);

Deno.test('runAddFundsAction: staying at or under the $2,000/24h cap is allowed', async () => {
  const supabase = makeFakeSupabase([
    {
      org_id: ORG,
      kind: 'add_funds',
      idempotency_key: '98200000-0000-4000-8000-0000000000a4',
      status: 'succeeded',
      amount_usd: 1975,
      created_at: new Date(Date.now() - 120_000).toISOString(),
    },
  ]);
  const client = makeFakeTelnyxClient();
  const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
    amountUsd: 25, // 1975 + 25 = 2000 exactly
    idempotencyKey: VALID_KEY,
  });
  assertEquals(result.status, 200);
});

Deno.test(
  'runAddFundsAction: a FAILED prior attempt does not count toward the rate limit or the daily cap',
  async () => {
    const supabase = makeFakeSupabase([
      {
        org_id: ORG,
        kind: 'add_funds',
        idempotency_key: '98200000-0000-4000-8000-0000000000a5',
        status: 'failed',
        amount_usd: 1980,
        created_at: new Date().toISOString(),
      },
    ]);
    const client = makeFakeTelnyxClient();
    const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
      amountUsd: 25,
      idempotencyKey: VALID_KEY,
    });
    assertEquals(result.status, 200);
  }
);

Deno.test(
  'runAddFundsAction: a Telnyx failure during the charge leaves the audit row failed, not pending or succeeded',
  async () => {
    const supabase = makeFakeSupabase();
    const client = makeFakeTelnyxClient({
      addFunds: async () => {
        throw new Error(
          'Telnyx API POST /payment/stored_payment_transactions failed (422): {"errors":[{"detail":"card declined"}]}'
        );
      },
    });
    const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
      amountUsd: 25,
      idempotencyKey: VALID_KEY,
    });
    assertEquals(result.status, 502);
    assertEquals(result.body.code, 'CARD_DECLINED');
    assertEquals(supabase.rows.length, 1);
    assertEquals(supabase.rows[0].status, 'failed');
    // Never retried -- exactly one row, one attempt.
    assertEquals(supabase.rows[0].idempotency_key, VALID_KEY);
  }
);

Deno.test(
  'runAddFundsAction: a balance re-fetch failure after a successful charge does not undo the success',
  async () => {
    const supabase = makeFakeSupabase();
    const client = makeFakeTelnyxClient({
      getBalance: async () => {
        throw new Error('Telnyx API GET /balance failed (503): {}');
      },
    });
    const result = await runAddFundsAction(supabase as any, client, ORG, USER, {
      amountUsd: 25,
      idempotencyKey: VALID_KEY,
    });
    assertEquals(result.status, 200);
    assertEquals(result.body.success, true);
    assertEquals(result.body.balanceUsd, null);
    assertEquals(supabase.rows[0].status, 'succeeded');
  }
);
