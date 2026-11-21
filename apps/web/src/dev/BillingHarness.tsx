import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { AddFundsDialog, AutoRechargeSection, RecentBillingActivity } from '../components/Settings';

/**
 * TASK-BF1: renders the REAL AddFundsDialog/AutoRechargeSection/RecentBillingActivity components
 * (exported from Settings.tsx for this harness only) against fixture data -- no live network/DB,
 * no test runner exists for the web client (CLAUDE.md's own "no automated tests" note), same
 * reason WebrtcRetryHarness/DialerStatesHarness exist. Reached via `?dev_billing=1` -- see
 * main.tsx.
 *
 * Every component here calls real `_shared`-free browser code (api.ts -> fetch/supabase), so
 * this harness stubs `window.fetch` (the `telnyx-billing` edge function's 3 actions) and
 * `supabase.auth`/`supabase.from` (the `profiles.active_org_id` lookup every api.ts call makes
 * via getActiveOrgId, and `org_billing_events`' own direct RLS read) for as long as it's
 * mounted, restoring both on unmount.
 *
 * Query params select which scenario renders:
 *   (default)                              -- connected: balance + auto-recharge, both dialog
 *                                              steps reachable, activity list populated.
 *   ?dev_billing_error=card_declined | no_payment_method | forbidden_key | rate_limited
 *                                           -- confirming the Add Funds dialog resolves with
 *                                              that specific mapped error.
 */
const FIXTURE_ORG_ID = 'dev-fixture-org';
const FIXTURE_BALANCE_USD = 42.5;

const FIXTURE_AUTO_RECHARGE = {
  id: 'pref-1',
  enabled: true,
  thresholdAmountUsd: 20,
  rechargeAmountUsd: 100,
  invoiceEnabled: false,
  preference: 'credit_paypal' as const,
};

const FIXTURE_EVENTS = [
  {
    id: 'evt-1',
    user_id: 'dev-fixture-user',
    kind: 'add_funds' as const,
    amount_usd: 50,
    status: 'succeeded' as const,
    telnyx_transaction_id: 'txn-fixture-1',
    error: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
  },
  {
    id: 'evt-2',
    user_id: 'dev-fixture-user',
    kind: 'add_funds' as const,
    amount_usd: 25,
    status: 'failed' as const,
    telnyx_transaction_id: null,
    error: 'The saved payment method was declined. Check it in the Telnyx portal.',
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
  },
  {
    id: 'evt-3',
    user_id: 'dev-fixture-user',
    kind: 'auto_recharge_update' as const,
    amount_usd: null,
    status: 'succeeded' as const,
    telnyx_transaction_id: null,
    error: null,
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

const ERROR_RESPONSES: Record<string, { status: number; error: string; code: string }> = {
  card_declined: {
    status: 502,
    error: 'The saved payment method was declined. Check it in the Telnyx portal.',
    code: 'CARD_DECLINED',
  },
  no_payment_method: {
    status: 502,
    error:
      'No payment method is saved on this Telnyx account yet. Add a card in the Telnyx portal first.',
    code: 'NO_PAYMENT_METHOD',
  },
  forbidden_key: {
    status: 502,
    error:
      "Your Telnyx API key doesn't have permission to charge the stored payment method. Check its scopes in the Telnyx portal.",
    code: 'FORBIDDEN_KEY',
  },
  rate_limited: {
    status: 429,
    error: 'Please wait a moment before adding funds again (at most once every 60s).',
    code: 'RATE_LIMITED',
  },
};

/** Installs the stubs SYNCHRONOUSLY during the initial render (via a `useState` lazy
 *  initializer), not inside a `useEffect` -- React fires a CHILD's own mount-time `useEffect`
 *  before its parent's (this hook's effect would be the parent's, since it's called from
 *  BillingHarness which renders AutoRechargeSection/RecentBillingActivity as children). Installing
 *  in an effect here let AutoRechargeSection's own `getBillingInfo()` call fire the real,
 *  unstubbed `fetch` first, hitting the live Supabase project and failing on CORS -- confirmed
 *  live via this exact harness before this fix. The whole render phase (parent AND every child)
 *  completes before ANY passive effect fires, so a render-time install is guaranteed to be in
 *  place before every child's effect runs. No React StrictMode in this app (verified: grepped
 *  main.tsx/App.tsx), so this runs exactly once, not twice. */
function useBillingFixtureStubs(errorScenario: string | null) {
  const [restore] = useState<() => void>(() => {
    const originalFetch = window.fetch;
    const authAny = supabase.auth as unknown as Record<string, unknown>;
    const originalGetSession = authAny.getSession;
    const originalGetUser = authAny.getUser;
    const supabaseAny = supabase as unknown as Record<string, unknown>;
    const originalFrom = supabaseAny.from;

    authAny.getSession = async () => ({
      data: { session: { access_token: 'dev-fixture-token' } },
      error: null,
    });
    authAny.getUser = async () => ({
      data: { user: { id: 'dev-fixture-user' } },
      error: null,
    });

    supabaseAny.from = (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { active_org_id: FIXTURE_ORG_ID }, error: null }),
            }),
          }),
        };
      }
      if (table === 'org_billing_events') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: FIXTURE_EVENTS, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`BillingHarness fake supabase: unexpected table ${table}`);
    };

    window.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (!u.includes('/telnyx-billing')) return originalFetch(url as RequestInfo, init);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (body.action === 'get') {
        return new Response(
          JSON.stringify({
            balanceUsd: FIXTURE_BALANCE_USD,
            availableCreditUsd: FIXTURE_BALANCE_USD,
            autoRecharge: FIXTURE_AUTO_RECHARGE,
          }),
          { status: 200 }
        );
      }
      if (body.action === 'update_auto_recharge') {
        return new Response(
          JSON.stringify({
            autoRecharge: {
              id: 'pref-1',
              enabled: body.enabled,
              thresholdAmountUsd: body.thresholdAmountUsd,
              rechargeAmountUsd: body.rechargeAmountUsd,
              invoiceEnabled: body.invoiceEnabled,
              preference: body.preference,
            },
          }),
          { status: 200 }
        );
      }
      if (body.action === 'add_funds') {
        if (errorScenario && ERROR_RESPONSES[errorScenario]) {
          const { status, error, code } = ERROR_RESPONSES[errorScenario];
          return new Response(JSON.stringify({ error, code }), { status });
        }
        return new Response(
          JSON.stringify({
            success: true,
            transactionId: 'dev-fixture-txn',
            balanceUsd: FIXTURE_BALANCE_USD + Number(body.amountUsd ?? 0),
            availableCreditUsd: FIXTURE_BALANCE_USD + Number(body.amountUsd ?? 0),
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 });
    }) as typeof fetch;

    return () => {
      window.fetch = originalFetch;
      authAny.getSession = originalGetSession;
      authAny.getUser = originalGetUser;
      supabaseAny.from = originalFrom;
    };
  });

  useEffect(() => restore, [restore]);
}

export function BillingHarness() {
  const params = new URLSearchParams(window.location.search);
  const errorScenario = params.get('dev_billing_error');
  useBillingFixtureStubs(errorScenario);

  const [addFundsOpen, setAddFundsOpen] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="min-h-screen bg-[#0A1628] p-8 text-white font-sans">
      <h1 className="text-lg font-bold mb-2">Billing harness (fixture data, no live network/DB)</h1>
      <p className="mb-6 text-sm text-white/60">
        Add{' '}
        <code>?dev_billing_error=card_declined|no_payment_method|forbidden_key|rate_limited</code>{' '}
        to make confirming the Add Funds dialog resolve with that specific error instead of
        succeeding.
        {errorScenario && (
          <span className="block mt-1 text-warning">
            Active scenario: <code>{errorScenario}</code>
          </span>
        )}
      </p>

      <div className="max-w-2xl space-y-6">
        <button
          type="button"
          onClick={() => setAddFundsOpen(true)}
          className="px-4 py-2 rounded-md bg-blue-600 text-white"
        >
          Open Add Funds dialog
        </button>

        <AutoRechargeSection isAdmin={true} />

        <RecentBillingActivity refreshKey={refreshKey} />
      </div>

      <AddFundsDialog
        open={addFundsOpen}
        onClose={() => setAddFundsOpen(false)}
        onSuccess={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}
