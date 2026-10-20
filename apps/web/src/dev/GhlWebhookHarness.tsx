import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { GhlWebhookCard } from '../components/settings/GhlWebhookCard';

/**
 * TASK-G30: the REAL GhlWebhookCard against fixture data, no live network/DB.
 * `?dev_ghl_webhook=1`, plus `&scenario=`:
 *   fresh         no secret, no events yet (default)
 *   configured    a secret exists, events are arriving
 *   reconcile_off the call-list switch is off (warning shown)
 *   load_error    the first load answers 500
 *   action_error  create / replace / delete answer 500
 *   slow          every call takes 2.5 s
 */
const ORG = 'dev-fixture-org';

function useStubs(scenario: string) {
  useState(() => {
    const originalFetch = window.fetch;
    const authAny = supabase.auth as unknown as Record<string, unknown>;
    const supabaseAny = supabase as unknown as Record<string, unknown>;
    authAny.getSession = async () => ({
      data: { session: { access_token: 'dev-fixture-token' } },
      error: null,
    });
    authAny.getUser = async () => ({ data: { user: { id: 'dev-fixture-user' } }, error: null });
    supabaseAny.from = (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { active_org_id: ORG }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`GhlWebhookHarness fake supabase: unexpected table ${table}`);
    };
    let hasSecret = scenario === 'configured';
    let rotatedAt: string | null = hasSecret ? '2026-10-19T18:00:00Z' : null;
    window.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes('/ghl-webhook-settings'))
        return originalFetch(url as RequestInfo, init);
      await new Promise((r) => setTimeout(r, scenario === 'slow' ? 2500 : 150));
      const action = JSON.parse(String(init?.body ?? '{}')).action as string;
      if (scenario === 'load_error' && action === 'get')
        return new Response(JSON.stringify({ error: 'Failed to load' }), { status: 500 });
      if (scenario === 'action_error' && action !== 'get')
        return new Response(JSON.stringify({ error: 'Could not save the secret' }), {
          status: 500,
        });
      let secret: string | undefined;
      if (action === 'rotate') {
        hasSecret = true;
        rotatedAt = new Date().toISOString();
        secret = 'hdwh_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE'.slice(0, 43);
      }
      if (action === 'revoke') hasSecret = false;
      const live = scenario === 'configured';
      return new Response(
        JSON.stringify({
          webhookUrl: 'https://example.supabase.co/functions/v1/ghl-webhook',
          locationId: 'loc-fixture',
          reconcileEnabled: scenario !== 'reconcile_off',
          hasSecret,
          secretRotatedAt: rotatedAt,
          lastEventAt: live ? '2026-10-19T20:30:00Z' : null,
          lastEventType: live ? 'ContactDndUpdate' : null,
          handledCount: live ? 42 : 0,
          ...(secret ? { secret } : {}),
        }),
        { status: 200 }
      );
    }) as typeof fetch;
  });
}

export function GhlWebhookHarness() {
  const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'fresh';
  useStubs(scenario);
  return (
    <div className="min-h-screen bg-surface-0 p-4">
      <p className="text-xs text-text-muted mb-2">GHL webhook harness: scenario = {scenario}</p>
      <GhlWebhookCard />
    </div>
  );
}
