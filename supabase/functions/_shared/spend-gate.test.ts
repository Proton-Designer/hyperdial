import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import { checkSpendGate, getOrgSpendSnapshot } from './spend-gate.ts';

// ---------------------------------------------------------------------------
// A minimal fake supabase client -- just the `.from()`/`.rpc()` chains
// getConnectedOrgTelnyxContext + spend-gate.ts's own queries actually use.
// Every chain method returns a thenable, so both `.select().eq().maybeSingle()`
// and `.select().eq().not().gte()` (no `.maybeSingle()`) resolve correctly,
// matching real supabase-js's own {data, error}/{count, error} shapes.
// ---------------------------------------------------------------------------

function chain(result: unknown) {
  const node: Record<string, unknown> = {
    select: () => chain(result),
    eq: () => chain(result),
    not: () => chain(result),
    gte: () => chain(result),
    maybeSingle: async () => result,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return node;
}

interface FakeOpts {
  telephony: {
    status: string;
    call_control_app_id: string | null;
    credential_connection_id: string | null;
  } | null;
  apiKey: string | null;
  spendSettings: Record<string, unknown> | null;
  callLegsRows: { duration_seconds: number | null }[];
  numberCount: number;
}

function makeFakeSupabase(opts: FakeOpts) {
  return {
    from(table: string) {
      if (table === 'org_telephony') return chain({ data: opts.telephony, error: null });
      if (table === 'org_spend_settings') return chain({ data: opts.spendSettings, error: null });
      if (table === 'call_legs') return chain({ data: opts.callLegsRows, error: null });
      if (table === 'user_phone_numbers') return chain({ count: opts.numberCount, error: null });
      throw new Error(`fake supabase: unexpected table ${table}`);
    },
    rpc(name: string) {
      if (name === 'get_org_telnyx_key') return Promise.resolve({ data: opts.apiKey, error: null });
      throw new Error(`fake supabase: unexpected rpc ${name}`);
    },
  };
}

const CONNECTED_TELEPHONY = {
  status: 'connected',
  call_control_app_id: 'app-1',
  credential_connection_id: 'cred-1',
};

function stubFetch(handler: (url: string) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) =>
    Promise.resolve(handler(String(url)))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function balanceResponse(balance: string, availableCredit: string) {
  return new Response(
    JSON.stringify({
      data: { balance, available_credit: availableCredit, credit_limit: '0.00', currency: 'USD' },
    }),
    { status: 200 }
  );
}

Deno.test('checkSpendGate: fails OPEN when Telnyx is not connected for the org', async () => {
  const supabase = makeFakeSupabase({
    telephony: null, // no row at all -- "not connected"
    apiKey: null,
    spendSettings: null,
    callLegsRows: [],
    numberCount: 0,
  });
  const result = await checkSpendGate(supabase as any, 'org-1');
  assertEquals(result.blocked, false);
});

Deno.test(
  'checkSpendGate: fails OPEN when the stored Telnyx key lookup returns nothing',
  async () => {
    const supabase = makeFakeSupabase({
      telephony: CONNECTED_TELEPHONY,
      apiKey: null, // get_org_telnyx_key returned null
      spendSettings: null,
      callLegsRows: [],
      numberCount: 0,
    });
    const result = await checkSpendGate(supabase as any, 'org-1');
    assertEquals(result.blocked, false);
  }
);

Deno.test('checkSpendGate: fails OPEN when the Telnyx balance API itself errors', async () => {
  const restore = stubFetch(() => new Response('{"errors":[{"detail":"down"}]}', { status: 503 }));
  try {
    const supabase = makeFakeSupabase({
      telephony: CONNECTED_TELEPHONY,
      apiKey: 'key-1',
      spendSettings: null,
      callLegsRows: [],
      numberCount: 0,
    });
    const result = await checkSpendGate(supabase as any, 'org-1');
    assertEquals(result.blocked, false);
  } finally {
    restore();
  }
});

Deno.test(
  'checkSpendGate: blocks with LOW_BALANCE when available credit is below the org minimum',
  async () => {
    const restore = stubFetch(() => balanceResponse('4.00', '4.00'));
    try {
      const supabase = makeFakeSupabase({
        telephony: CONNECTED_TELEPHONY,
        apiKey: 'key-1',
        spendSettings: { min_balance_to_dial_usd: 5, monthly_spend_cap_usd: null },
        callLegsRows: [],
        numberCount: 0,
      });
      const result = await checkSpendGate(supabase as any, 'org-1');
      assertEquals(result.blocked, true);
      assertEquals(result.code, 'LOW_BALANCE');
      assertExists(result.message);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'checkSpendGate: blocks with SPEND_CAP_REACHED once MTD estimate hits the cap',
  async () => {
    const restore = stubFetch(() => balanceResponse('500.00', '500.00'));
    try {
      const supabase = makeFakeSupabase({
        telephony: CONNECTED_TELEPHONY,
        apiKey: 'key-1',
        spendSettings: {
          min_balance_to_dial_usd: 5,
          monthly_spend_cap_usd: 10,
          estimated_per_minute_rate_usd: 1, // 10 minutes -> $10 exactly, at the cap
          estimated_monthly_number_price_usd: 0,
        },
        callLegsRows: [{ duration_seconds: 600 }],
        numberCount: 0,
      });
      const result = await checkSpendGate(supabase as any, 'org-1');
      assertEquals(result.blocked, true);
      assertEquals(result.code, 'SPEND_CAP_REACHED');
    } finally {
      restore();
    }
  }
);

Deno.test('checkSpendGate: a null cap never blocks no matter how high MTD spend is', async () => {
  const restore = stubFetch(() => balanceResponse('500.00', '500.00'));
  try {
    const supabase = makeFakeSupabase({
      telephony: CONNECTED_TELEPHONY,
      apiKey: 'key-1',
      spendSettings: {
        min_balance_to_dial_usd: 5,
        monthly_spend_cap_usd: null,
        estimated_per_minute_rate_usd: 100,
        estimated_monthly_number_price_usd: 100,
      },
      callLegsRows: [{ duration_seconds: 6000 }],
      numberCount: 5,
    });
    const result = await checkSpendGate(supabase as any, 'org-1');
    assertEquals(result.blocked, false);
  } finally {
    restore();
  }
});

Deno.test('checkSpendGate: allows dialing when balance and spend are both healthy', async () => {
  const restore = stubFetch(() => balanceResponse('100.00', '100.00'));
  try {
    const supabase = makeFakeSupabase({
      telephony: CONNECTED_TELEPHONY,
      apiKey: 'key-1',
      spendSettings: { min_balance_to_dial_usd: 5, monthly_spend_cap_usd: 1000 },
      callLegsRows: [{ duration_seconds: 60 }],
      numberCount: 1,
    });
    const result = await checkSpendGate(supabase as any, 'org-1');
    assertEquals(result.blocked, false);
  } finally {
    restore();
  }
});

Deno.test(
  'getOrgSpendSnapshot: missing org_spend_settings row falls back to defaults, not an error',
  async () => {
    const restore = stubFetch(() => balanceResponse('50.00', '50.00'));
    try {
      const supabase = makeFakeSupabase({
        telephony: CONNECTED_TELEPHONY,
        apiKey: 'key-1',
        spendSettings: null,
        callLegsRows: [],
        numberCount: 0,
      });
      const snapshot = await getOrgSpendSnapshot(supabase as any, 'org-1');
      assertEquals(snapshot.ok, true);
      if (snapshot.ok) {
        assertEquals(snapshot.settings.low_balance_alert_usd, 20);
        assertEquals(snapshot.settings.min_balance_to_dial_usd, 5);
        assertEquals(snapshot.settings.monthly_spend_cap_usd, null);
      }
    } finally {
      restore();
    }
  }
);
