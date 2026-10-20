import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { GhlFieldCoverageCard } from '../components/settings/GhlFieldCoverageCard';

/**
 * TASK-G17: the REAL GhlFieldCoverageCard against fixture data, no live network/DB.
 * `?dev_ghl_fields=1`, plus `&scenario=`:
 *   (default)  some provider fields ready, one with a type warning, some intern fields ready
 *   none       nothing set up yet
 *   all        everything ready
 *   error      the endpoint answers 502
 *   slow       the call takes 2.5 s
 *   TASK-G29, press "Create N missing fields": (default) all created, coverage becomes ready; `perm` the token lacks
 *   the Custom Fields write permission; `partial` one field fails; `create_error` the call answers 502
 */
const ORG = 'dev-fixture-org';

const item = (
  key: string,
  label: string,
  type: string,
  status: string,
  extra: Record<string, unknown> = {}
) => ({
  key,
  label,
  type,
  options: null,
  status,
  ghlType: status === 'ready' ? type : null,
  issues: [],
  missingOptions: [],
  ...extra,
});

function fixture(scenario: string) {
  const all = scenario === 'all';
  const none = scenario === 'none';
  const st = (ok: boolean, miss: string) => (all || (!none && ok) ? 'ready' : miss);
  const provider = [
    item('last_call_outcome', 'Last Call Outcome', 'TEXT', st(true, 'not_mapped')),
    item('call_attempts', 'Call Attempts', 'NUMERICAL', st(true, 'not_mapped'), {
      ...(all || none ? {} : { ghlType: 'TEXT', issues: ['type'] }),
    }),
    item('called_by', 'Called By', 'TEXT', st(false, 'not_mapped')),
    item(
      'lead_list',
      'Lead List / Batch ID',
      'TEXT',
      none ? 'not_mapped' : all ? 'ready' : 'missing_in_ghl'
    ),
    item('top_objection', 'Top Objection', 'SINGLE_OPTIONS', st(true, 'not_mapped'), {
      options: [
        'Too busy',
        'Has enough work',
        'Fees',
        'Does not trust apps',
        'Not interested in app jobs',
        'Other',
      ],
      ...(all || none ? {} : { issues: ['options'], missingOptions: ['Other'] }),
    }),
  ];
  const intern = [
    item('last_shift_status', 'Last shift status', 'SINGLE_OPTIONS', st(true, 'missing'), {
      options: ['completed', 'missed'],
    }),
    item('week_dials', 'Week dials', 'NUMERICAL', st(true, 'missing')),
    item('week_sign_ups', 'Week sign-ups', 'NUMERICAL', st(false, 'missing')),
    item('hyper_dialer_user_id', 'Hyper Dialer user id', 'TEXT', st(false, 'missing')),
  ];
  const g = (items: ReturnType<typeof item>[]) => ({
    items,
    ready: items.filter((i) => i.status === 'ready').length,
    total: items.length,
  });
  const p = g(provider);
  const i = g(intern);
  return { provider: p, intern: i, ready: p.ready + i.ready, total: p.total + i.total };
}

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
      throw new Error(`GhlFieldCoverageHarness fake supabase: unexpected table ${table}`);
    };
    window.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes('/ghl-field-coverage'))
        return originalFetch(url as RequestInfo, init);
      await new Promise((r) => setTimeout(r, scenario === 'slow' ? 2500 : 120));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.action === 'create_missing') {
        if (scenario === 'create_error')
          return new Response(JSON.stringify({ error: 'GHL request failed: timeout' }), {
            status: 502,
          });
        const f = fixture('default');
        const missing = [...f.provider.items, ...f.intern.items].filter(
          (i) => i.status !== 'ready'
        );
        const perm = scenario === 'perm';
        const partial = scenario === 'partial';
        const made = perm ? [] : partial ? missing.slice(1) : missing;
        return new Response(
          JSON.stringify({
            coverage: fixture(perm || partial ? 'default' : 'all'),
            result: {
              created: made.map((m) => ({ key: m.key, label: m.label, id: `new-${m.key}` })),
              mapped: [],
              failed: partial
                ? [
                    {
                      key: missing[0].key,
                      label: missing[0].label,
                      error: 'GHL POST /custom-fields/ failed (400): fieldKey already exists',
                    },
                  ]
                : [],
              notAttempted: perm ? missing.length : 0,
              stopped: perm
                ? 'GoHighLevel refused to create fields: the Private Integration token needs the Custom Fields write permission (in GoHighLevel: Settings -> Private Integrations -> your integration -> Scopes -> Custom Fields: view and edit).'
                : null,
            },
            mappingError: null,
          }),
          { status: 200 }
        );
      }
      return scenario === 'error'
        ? new Response(JSON.stringify({ error: 'GHL request failed: timeout' }), { status: 502 })
        : new Response(JSON.stringify(fixture(scenario)), { status: 200 });
    }) as typeof fetch;
  });
}

export function GhlFieldCoverageHarness() {
  const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'default';
  useStubs(scenario);
  return (
    <div className="min-h-screen bg-surface-0 p-4">
      <p className="text-xs text-text-muted mb-2">
        GHL field coverage harness: scenario = {scenario}
      </p>
      <GhlFieldCoverageCard />
    </div>
  );
}
