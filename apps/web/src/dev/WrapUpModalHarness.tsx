import { useState } from 'react';
import { WrapUpModal } from '@/components/dialer/WrapUpModal';
import type { Disposition, SubmitDispositionResult } from '@/lib/api';

/**
 * Dev-only fixture harness for TASK-L2a's acceptance check: renders WrapUpModal with fixture
 * dispositions and a fixture submit function (via its `loadDispositions`/`submitWrapUp` test
 * overrides), so every disposition, the callback-required validation, the 500-char limit, the
 * shortcuts, and the error+retry path can all be checked with no live session, DB, or edge
 * function call. Reached via `?dev_wrapup=1` (add `&dev_wrapup_fail=1` to make the first submit
 * attempt fail, to exercise the retry path) -- see main.tsx, which only imports this module
 * behind `import.meta.env.DEV`, so it (and its fixture data) never reaches the production bundle.
 */
const FIXTURE_DISPOSITIONS: Disposition[] = [
  {
    id: '1',
    org_id: 'dev',
    key: 'yes_build_profile',
    label: 'Yes - Build Profile',
    lead_effect: 'completed',
    ghl_tag: 'Interested',
    creates_task: false,
    sort: 10,
    active: true,
    is_win: true,
    required_fields: ['license_number', 'zips'],
    ghl_pipeline_id: null,
    ghl_pipeline_stage_id: null,
  },
  {
    id: '2',
    org_id: 'dev',
    key: 'callback',
    label: 'Callback',
    lead_effect: 'callback',
    ghl_tag: 'Callback',
    creates_task: true,
    sort: 20,
    active: true,
    is_win: false,
    required_fields: null,
    ghl_pipeline_id: null,
    ghl_pipeline_stage_id: null,
  },
  {
    id: '3',
    org_id: 'dev',
    key: 'not_interested',
    label: 'Not interested',
    lead_effect: 'completed',
    ghl_tag: 'Not Interested',
    creates_task: false,
    sort: 30,
    active: true,
    is_win: false,
    required_fields: null,
    ghl_pipeline_id: null,
    ghl_pipeline_stage_id: null,
  },
  {
    id: '4',
    org_id: 'dev',
    key: 'wrong_number',
    label: 'Wrong number',
    lead_effect: 'exhausted',
    ghl_tag: 'Wrong Number',
    creates_task: false,
    sort: 40,
    active: true,
    is_win: false,
    required_fields: null,
    ghl_pipeline_id: null,
    ghl_pipeline_stage_id: null,
  },
  {
    id: '5',
    org_id: 'dev',
    key: 'do_not_call',
    label: 'Do not call',
    lead_effect: 'dnc',
    ghl_tag: 'DNC',
    creates_task: false,
    sort: 50,
    active: true,
    is_win: false,
    required_fields: null,
    ghl_pipeline_id: null,
    ghl_pipeline_stage_id: null,
  },
  {
    id: '6',
    org_id: 'dev',
    key: 'voicemail_left',
    label: 'Left voicemail',
    lead_effect: 'queued',
    ghl_tag: null,
    creates_task: false,
    sort: 60,
    active: true,
    is_win: false,
    required_fields: null,
    ghl_pipeline_id: null,
    ghl_pipeline_stage_id: null,
  },
  {
    id: '7',
    org_id: 'dev',
    key: 'no_answer',
    label: 'No answer (manual)',
    lead_effect: 'queued',
    ghl_tag: null,
    creates_task: false,
    sort: 70,
    active: true,
    is_win: false,
    required_fields: null,
    ghl_pipeline_id: null,
    ghl_pipeline_stage_id: null,
  },
  // Inactive on purpose: fixture proof that WrapUpModal filters to active=true itself.
  {
    id: '8',
    org_id: 'dev',
    key: 'retired',
    label: 'Retired disposition',
    lead_effect: 'completed',
    ghl_tag: null,
    creates_task: false,
    sort: 80,
    active: false,
    is_win: false,
    required_fields: null,
    ghl_pipeline_id: null,
    ghl_pipeline_stage_id: null,
  },
];

export function WrapUpModalHarness() {
  const failFirstAttempt =
    new URLSearchParams(window.location.search).get('dev_wrapup_fail') === '1';
  const [hasFailedOnce, setHasFailedOnce] = useState(false);
  const [result, setResult] = useState<SubmitDispositionResult | null>(null);
  const [instanceKey, setInstanceKey] = useState(0);

  const fixtureLoad = () => Promise.resolve(FIXTURE_DISPOSITIONS);

  const fixtureHistory = () =>
    Promise.resolve([
      {
        leg_id: 'dev-leg-prev-1',
        dispositioned_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        agent_name: 'Sam Rivera',
        disposition_label: 'Left voicemail',
        notes: 'No pickup, left a quick message.',
        has_recording: false,
      },
      {
        leg_id: 'dev-leg-prev-2',
        dispositioned_at: new Date(Date.now() - 86_400_000).toISOString(),
        agent_name: 'Jordan Ramirez',
        disposition_label: 'Callback',
        notes: 'Asked to call back this week.',
        has_recording: true,
      },
    ]);

  const fixtureSubmit = async (): Promise<SubmitDispositionResult> => {
    if (failFirstAttempt && !hasFailedOnce) {
      setHasFailedOnce(true);
      throw new Error('Simulated failure (dev fixture) -- retry should succeed.');
    }
    return { sessionId: 'dev-session', alreadySubmitted: false, dialed: 0 };
  };

  if (result) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0A1628] text-white">
        <div className="text-center">
          <p className="text-lg font-semibold">Submitted</p>
          <pre className="text-xs text-[#B0BEC5] mt-2">{JSON.stringify(result, null, 2)}</pre>
          <button
            type="button"
            className="mt-4 rounded-lg bg-[#0066FF] px-4 py-2 text-sm"
            onClick={() => {
              setResult(null);
              setHasFailedOnce(false);
              setInstanceKey((k) => k + 1);
            }}
          >
            Render again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0A1628]">
      <WrapUpModal
        key={instanceKey}
        sessionId="dev-session"
        legId="dev-leg"
        contact={{ id: 'dev-contact', name: 'Jordan Ramirez', phone: '+15125550100' }}
        callDurationSeconds={154}
        onSubmitted={setResult}
        loadDispositions={fixtureLoad}
        submitWrapUp={fixtureSubmit}
        loadHistory={fixtureHistory}
      />
    </div>
  );
}
