import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { GhlReconcileCard } from '../components/settings/GhlReconcileCard';

/**
 * TASK-G12: the REAL GhlReconcileCard against fixture data, no live network/DB (same stubbing
 * approach as BillingHarness). `?dev_ghl_reconcile=1`, plus `&scenario=`:
 *   (default)   loaded, enabled, one tag + one stage, a successful last run; saving works
 *   fresh       never ran, nothing configured
 *   failed_run  last run recorded an error
 *   load_error  the settings endpoint answers 500
 *   save_error  loading works, saving answers 400
 *   stages_error  the pipelines endpoint answers 500
 *   slow        every call takes 2.5 s
 */
const ORG = 'dev-fixture-org';
const STAGES = [
  { pipelineId: 'p1', pipelineName: 'Providers', stageId: 'stg-signed', stageName: 'Signed up' },
  {
    pipelineId: 'p1',
    pipelineName: 'Providers',
    stageId: 'stg-talk',
    stageName: 'In conversation',
  },
  { pipelineId: 'p2', pipelineName: 'Onboarding', stageId: 'stg-live', stageName: 'Live' },
];

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
      throw new Error(`GhlReconcileHarness fake supabase: unexpected table ${table}`);
    };

    let state = {
      enabled: scenario !== 'fresh',
      excludeTags: scenario === 'fresh' ? [] : ['signed up'],
      excludeStageIds: scenario === 'fresh' ? [] : ['stg-signed'],
      lastReconcileAt: scenario === 'fresh' ? null : new Date(Date.now() - 240_000).toISOString(),
      lastReconcileCounts:
        scenario === 'fresh'
          ? null
          : scenario === 'failed_run'
            ? { error: 'GHL token rejected (401)' }
            : { checked: 100, applied: { leads_moved: 7, dnc_contacts: 2 } },
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const delay = () => new Promise((r) => setTimeout(r, scenario === 'slow' ? 2500 : 120));

    window.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/ghl-list-pipelines')) {
        await delay();
        return scenario === 'stages_error'
          ? json({ error: 'GHL is not answering' }, 500)
          : json({ stages: STAGES });
      }
      if (!u.includes('/ghl-reconcile-settings')) return originalFetch(url as RequestInfo, init);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      await delay();
      if (body.action === 'get') {
        return scenario === 'load_error'
          ? json({ error: 'Something went wrong' }, 500)
          : json(state);
      }
      if (scenario === 'save_error') return json({ error: 'GoHighLevel is not connected' }, 400);
      state = {
        ...state,
        enabled: body.enabled,
        excludeTags: body.excludeTags,
        excludeStageIds: body.excludeStageIds,
      };
      return json(state);
    }) as typeof fetch;
  });
}

export function GhlReconcileHarness() {
  const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'default';
  useStubs(scenario);
  return (
    <div className="min-h-screen bg-surface-0 p-4">
      <p className="text-xs text-text-muted mb-2">GHL reconcile harness: scenario = {scenario}</p>
      <GhlReconcileCard />
    </div>
  );
}
