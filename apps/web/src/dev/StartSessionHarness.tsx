import { useState } from 'react';
import { StartSessionPanel } from '@/components/dialer/StartSessionPanel';
import type { CampaignWithStats } from '@/lib/api';
import type { UserPhoneNumber } from '@/contexts/PhoneNumbersContext';

/**
 * Dev-only fixture harness for TASK-L7's own acceptance line ("dev render (fixture) of: no
 * campaigns, campaigns list, pre-flight failing, starting, 409 existing session"). Same spirit
 * as `DialerStatesHarness.tsx` (TASK-L2b) -- renders the real `StartSessionPanel` component
 * against plain fixture props, no network/no DB. Reached via `?dev_start_session=1` (main.tsx).
 * `Dialer.tsx` itself is not fixtured here (it owns live hooks -- WebRTC client, `listCampaigns`,
 * `startDialerSession` -- that this panel's own props already abstract away).
 */

type Scenario = 'no_campaigns' | 'list' | 'preflight_failing' | 'starting' | 'conflict';

const SCENARIOS: Scenario[] = ['no_campaigns', 'list', 'preflight_failing', 'starting', 'conflict'];

const FIXTURE_NUMBERS: UserPhoneNumber[] = [
  {
    id: 'number-1',
    phone_number: '+15125550100',
    telnyx_phone_number_id: 'tn-1',
    created_at: new Date().toISOString(),
    assigned_user_id: null,
    status: 'active',
    resting_until: null,
    daily_cap: 100,
    dials_today: 0,
  },
];

const FIXTURE_CAMPAIGNS: CampaignWithStats[] = [
  {
    id: 'campaign-1',
    user_id: 'user-1',
    org_id: 'org-1',
    name: 'Q4 Warm Leads',
    status: 'active',
    total_calls_made: 42,
    connect_rate: 0.18,
    last_called_at: null,
    lines: 3,
    amd_mode: 'premium',
    voicemail_drop_mode: 'first_attempt',
    caller_id_number_id: 'number-1',
    max_attempts: 4,
    retry_interval_minutes: 120,
    calling_window_start: '09:00:00',
    calling_window_end: '18:00:00',
    abandon_message_enabled: true,
    script_text: null,
    objection_sheet_text: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    total_contacts: 120,
    queued: 87,
    completed: 20,
    passthrough: 13,
  },
  {
    id: 'campaign-2',
    user_id: 'user-1',
    org_id: 'org-1',
    name: 'Cold Outreach — West Region',
    status: 'active',
    total_calls_made: 5,
    connect_rate: 0.05,
    last_called_at: null,
    lines: 5,
    amd_mode: 'off',
    voicemail_drop_mode: 'never',
    caller_id_number_id: null,
    max_attempts: 3,
    retry_interval_minutes: 180,
    calling_window_start: '08:00:00',
    calling_window_end: '17:00:00',
    abandon_message_enabled: false,
    script_text: null,
    objection_sheet_text: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    total_contacts: 40,
    queued: 40,
    completed: 0,
    passthrough: 0,
  },
];

export function StartSessionHarness() {
  const [scenario, setScenario] = useState<Scenario>('list');

  const campaigns = scenario === 'no_campaigns' ? [] : FIXTURE_CAMPAIGNS;
  const startingCampaignId = scenario === 'starting' ? FIXTURE_CAMPAIGNS[0].id : null;
  const startError =
    scenario === 'preflight_failing'
      ? 'Microphone access is required to take calls. Allow microphone access and try again.'
      : null;
  const conflict =
    scenario === 'conflict'
      ? {
          campaignId: FIXTURE_CAMPAIGNS[0].id,
          campaignName: FIXTURE_CAMPAIGNS[0].name,
          existingSessionId: 'dev-existing-session',
        }
      : null;

  return (
    <div className="min-h-screen bg-[#0A1628] p-8">
      <div className="max-w-3xl mx-auto mb-6 rounded-2xl border border-white/10 bg-[#1A2332]/70 p-4">
        <p className="text-white font-semibold mb-3">
          StartSessionPanel fixture toggle (dev only, TASK-L7)
        </p>
        <div className="flex flex-wrap gap-2">
          {SCENARIOS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScenario(s)}
              className={`px-3 py-1.5 rounded-lg text-sm border ${
                scenario === s
                  ? 'border-[#00D9FF] bg-[#00D9FF]/10 text-white'
                  : 'border-white/10 text-[#B0BEC5] hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <StartSessionPanel
        campaigns={campaigns}
        campaignsError={null}
        userNumbers={FIXTURE_NUMBERS}
        startingCampaignId={startingCampaignId}
        micRegistering={scenario === 'starting'}
        startError={startError}
        conflict={conflict}
        onStart={(campaign) => window.alert(`Start clicked (fixture, no-op): ${campaign.name}`)}
        onOpenConflict={() => window.alert('Open it clicked (fixture, no-op)')}
        onDismissConflict={() => setScenario('list')}
      />
    </div>
  );
}
