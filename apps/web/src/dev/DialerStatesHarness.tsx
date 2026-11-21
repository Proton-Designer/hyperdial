import { useEffect, useMemo, useState } from 'react';
import { ParallelDialerUI } from '@/components/dialer/ParallelDialerUI';
import { DialerStateBanner } from '@/components/dialer/DialerStateBanner';
import { ActiveCall } from '@/components/dialer/ActiveCall';
import { WrapUpModal } from '@/components/dialer/WrapUpModal';
import type { BatchContactPreview } from '@/hooks/useDialerSession';
import type {
  ActiveTransfer,
  InboundCallInfo,
  Disposition,
  DialSessionState,
  SubmitDispositionResult,
} from '@/lib/api';

/**
 * Dev-only fixture harness for TASK-L2b's own acceptance line ("dev render of each state
 * (fixture/mock sim)... a full cycle incl. wrap-up submit -> dialing"). `scripts/dev/
 * dialer-sim.ts` (the old functions-serve + real local Postgres way to drive this) is
 * unrunnable now (local Docker retired) -- this harness renders every `dial_sessions.state`
 * against `ParallelDialerUI`/`DialerStateBanner` with plain fixture props, no network, no DB,
 * same spirit as `WrapUpModalHarness` (TASK-L2a). Reached via `?dev_dialer_states=1` -- see
 * main.tsx, which only imports this behind `import.meta.env.DEV`.
 */

const ALL_STATES: DialSessionState[] = [
  'ready_pending',
  'ready',
  'dialing',
  'connecting',
  'on_call',
  'wrap_up',
  'paused',
  'paused_agent_lost',
];

const FIXTURE_CONTACTS: BatchContactPreview[] = [
  { id: 'c1', name: 'Jordan Ramirez', phone: '+15125550100' },
  { id: 'c2', name: 'Priya Natarajan', phone: '+15125550101' },
  { id: 'c3', name: 'Sam Okafor', phone: '+15125550102' },
];

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
    key: 'no_answer',
    label: 'No answer (manual)',
    lead_effect: 'queued',
    ghl_tag: null,
    creates_task: false,
    sort: 20,
    active: true,
    is_win: false,
    required_fields: null,
    ghl_pipeline_id: null,
    ghl_pipeline_stage_id: null,
  },
];

/** TASK-MOB6b: sub-variants of the on_call state (and a manual-dial call), picked by buttons or `&fx=`. */
const CALL_FIXTURES = ['live', 'recording', 'held', 'warm', 'inbound', 'manual'] as const;
type CallFixture = (typeof CALL_FIXTURES)[number];

const ANSWERED_2MIN_AGO = new Date(Date.now() - 2 * 60_000 - 15_000).toISOString();

export function DialerStatesHarness() {
  const [selectedState, setSelectedState] = useState<DialSessionState>('dialing');
  const [wrapUpResult, setWrapUpResult] = useState<SubmitDispositionResult | null>(null);
  const [wrapUpKey, setWrapUpKey] = useState(0);
  // TASK-N1: only meaningful for a 'paused' toggle -- a second, independent checkbox rather
  // than a 9th ALL_STATES button, since it's a sub-variant of one existing state, not a new one.
  const [noNumbersAvailable, setNoNumbersAvailable] = useState(false);
  // MISSION-4 TASK-T7 (auto-resume): a 'paused' sub-variant fixture, same pattern as
  // noNumbersAvailable just above. 'off' = plain manual pause (unchanged); 'counting' drives a
  // REAL ticking countdown (not a static fixture number) so the Cancel button has something
  // genuine to cancel; 'manual' shows the post_wrapup banner with no countdown running at all
  // (the agent's own "Manual" preference).
  const [pausedFixture, setPausedFixture] = useState<'off' | 'counting' | 'manual' | 'takenOver'>(
    'off'
  );
  const [autoResumeSecondsLeft, setAutoResumeSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (pausedFixture !== 'counting') {
      setAutoResumeSecondsLeft(null);
      return;
    }
    setAutoResumeSecondsLeft(8);
  }, [pausedFixture]);
  useEffect(() => {
    if (autoResumeSecondsLeft == null) return;
    if (autoResumeSecondsLeft <= 0) {
      window.alert('Auto-resume fired (fixture, no-op)');
      setPausedFixture('off');
      return;
    }
    const t = setTimeout(() => setAutoResumeSecondsLeft((s) => (s == null ? null : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [autoResumeSecondsLeft]);
  // TASK-T7: real fixture state (not a no-op) so the Mute button visually toggles in this harness.
  const [muted, setMuted] = useState(false);
  const [fx, setFx] = useState<CallFixture>(() => {
    const v = new URLSearchParams(window.location.search).get('fx');
    return (CALL_FIXTURES as readonly string[]).includes(v ?? '') ? (v as CallFixture) : 'live';
  });
  const [recPaused, setRecPaused] = useState(false);

  const scenario = useMemo(() => {
    switch (selectedState) {
      case 'dialing':
        return {
          batchContacts: FIXTURE_CONTACTS,
          answeredContactId: null,
          connectedContactId: null,
        };
      case 'connecting':
        return {
          batchContacts: FIXTURE_CONTACTS,
          answeredContactId: FIXTURE_CONTACTS[0].id,
          connectedContactId: null,
        };
      case 'on_call':
        return {
          batchContacts: FIXTURE_CONTACTS,
          answeredContactId: null,
          connectedContactId: fx === 'inbound' || fx === 'manual' ? null : FIXTURE_CONTACTS[0].id,
        };
      default:
        return { batchContacts: [], answeredContactId: null, connectedContactId: null };
    }
  }, [selectedState, fx]);

  const fixtureLoadDispositions = () => Promise.resolve(FIXTURE_DISPOSITIONS);
  const fixtureLoadHistory = () => Promise.resolve([]);
  const fixtureSubmitDisposition = async (): Promise<SubmitDispositionResult> => {
    const result: SubmitDispositionResult = {
      sessionId: 'dev-session',
      alreadySubmitted: false,
      dialed: 1,
    };
    setWrapUpResult(result);
    return result;
  };

  return (
    <div className="min-h-screen bg-[#0A1628] p-8">
      <div className="max-w-3xl mx-auto mb-6 rounded-2xl border border-white/10 bg-[#1A2332]/70 p-4">
        <p className="text-white font-semibold mb-3">
          dial_sessions.state fixture toggle (dev only)
        </p>
        <div className="flex flex-wrap gap-2">
          {ALL_STATES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSelectedState(s);
                setWrapUpResult(null);
              }}
              className={`px-3 py-1.5 rounded-lg text-sm border ${
                selectedState === s
                  ? 'border-[#00D9FF] bg-[#00D9FF]/10 text-white'
                  : 'border-white/10 text-[#B0BEC5] hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        {selectedState === 'on_call' && (
          <div className="mt-3 flex flex-wrap gap-2">
            {CALL_FIXTURES.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFx(f)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  fx === f
                    ? 'border-[#00D9FF] bg-[#00D9FF]/10 text-white'
                    : 'border-white/10 text-[#B0BEC5] hover:text-white'
                }`}
              >
                call: {f}
              </button>
            ))}
          </div>
        )}
        {wrapUpResult && (
          <p className="text-[#00E676] text-sm mt-3">
            Wrap-up submitted → session returns to "dialing" (real backend behavior; this harness
            switches the toggle above to demonstrate the cycle).
          </p>
        )}
        {selectedState === 'paused' && (
          <div className="flex flex-col gap-1 mt-3">
            <label className="flex items-center gap-2 text-sm text-[#B0BEC5]">
              <input
                type="checkbox"
                checked={noNumbersAvailable}
                onChange={(e) => setNoNumbersAvailable(e.target.checked)}
              />
              TASK-N1: pause_reason = 'no_numbers_available'
            </label>
            <label className="flex items-center gap-2 text-sm text-[#B0BEC5]">
              <input
                type="radio"
                name="paused-fixture"
                checked={pausedFixture === 'off'}
                onChange={() => setPausedFixture('off')}
              />
              TASK-T7: no auto-resume (plain manual pause)
            </label>
            <label className="flex items-center gap-2 text-sm text-[#B0BEC5]">
              <input
                type="radio"
                name="paused-fixture"
                checked={pausedFixture === 'counting'}
                onChange={() => setPausedFixture('counting')}
              />
              TASK-T7: pause_reason = 'post_wrapup', counting down
            </label>
            <label className="flex items-center gap-2 text-sm text-[#B0BEC5]">
              <input
                type="radio"
                name="paused-fixture"
                checked={pausedFixture === 'manual'}
                onChange={() => setPausedFixture('manual')}
              />
              TASK-T7: pause_reason = 'post_wrapup', manual (no timer)
            </label>
            <label className="flex items-center gap-2 text-sm text-[#B0BEC5]">
              <input
                type="radio"
                name="paused-fixture"
                checked={pausedFixture === 'takenOver'}
                onChange={() => setPausedFixture('takenOver')}
              />
              MISSION-5 TASK-M5-N1: pause_reason = 'call_taken_over_by_manager'
            </label>
          </div>
        )}
      </div>

      <div className="max-w-3xl mx-auto">
        <DialerStateBanner
          sessionState={selectedState}
          pauseReason={
            selectedState === 'paused' && noNumbersAvailable
              ? 'no_numbers_available'
              : selectedState === 'paused' && pausedFixture === 'takenOver'
                ? 'call_taken_over_by_manager'
                : selectedState === 'paused' && pausedFixture !== 'off'
                  ? 'post_wrapup'
                  : null
          }
          takenOverByManagerName={
            selectedState === 'paused' && pausedFixture === 'takenOver' ? 'Jamie Chen' : null
          }
          autoResumeSecondsLeft={autoResumeSecondsLeft}
          onCancelAutoResume={() => setAutoResumeSecondsLeft(null)}
          ringingCount={scenario.batchContacts.length}
          connectedContact={
            scenario.connectedContactId
              ? { name: FIXTURE_CONTACTS[0].name, phone: FIXTURE_CONTACTS[0].phone }
              : null
          }
          connectedAnsweredAt={scenario.connectedContactId ? ANSWERED_2MIN_AGO : null}
          webrtcReady={selectedState !== 'ready_pending'}
          webrtcConnecting={false}
          webrtcError={null}
          onReconnect={() => window.alert('Reconnect clicked (fixture, no-op)')}
          reconnecting={false}
          onResume={() => window.alert('Resume clicked (fixture, no-op)')}
          resuming={false}
        />

        <ParallelDialerUI
          sessionState={selectedState}
          lines={3}
          amdMode="premium"
          callsMade={7}
          connected={2}
          voicemail={1}
          noAnswer={4}
          resolvedCount={7}
          totalContacts={20}
          progress={35}
          batchContacts={scenario.batchContacts}
          answeredContactId={scenario.answeredContactId}
          connectedContactId={scenario.connectedContactId}
          connectedLegId={scenario.connectedContactId ? 'dev-leg' : null}
          connectedAnsweredAt={scenario.connectedContactId ? ANSWERED_2MIN_AGO : null}
          sessionId={selectedState === 'on_call' ? 'dev-session' : null}
          inboundCall={
            selectedState === 'on_call' && fx === 'inbound'
              ? ({
                  id: 'dev-inbound',
                  from_e164: '+15125550199',
                  contact_id: null,
                  answered_at: ANSWERED_2MIN_AGO,
                  contact: {
                    business_name: 'Riverside Realty',
                    first_name: null,
                    last_name: null,
                    phone_number: '+15125550199',
                  },
                } satisfies InboundCallInfo)
              : null
          }
          coachingMode={null}
          heldAt={selectedState === 'on_call' && fx === 'held' ? ANSWERED_2MIN_AGO : null}
          recordingStatus={
            selectedState === 'on_call' && (fx === 'recording' || fx === 'live')
              ? recPaused
                ? 'paused'
                : 'recording'
              : null
          }
          activeTransfer={
            selectedState === 'on_call' && fx === 'warm'
              ? ({
                  id: 'dev-transfer',
                  type: 'warm',
                  target_kind: 'external',
                  target_user_id: null,
                  target_number: '+15125550177',
                  status: 'connected',
                } satisfies ActiveTransfer)
              : null
          }
          connectedContact={
            scenario.connectedContactId
              ? {
                  id: scenario.connectedContactId,
                  name: FIXTURE_CONTACTS[0].name,
                  phone: FIXTURE_CONTACTS[0].phone,
                  rating: 4.8,
                  reviewCount: 120,
                  website: 'https://example.com',
                  ownerContact: 'Jane Owner',
                  licenseNumber: 'LIC-12345',
                  serviceZips: '90210, 90211',
                  tier: 'Gold',
                }
              : null
          }
          connectedContactHistory={
            scenario.connectedContactId
              ? [
                  {
                    legId: 'fixture-history-1',
                    createdAt: ANSWERED_2MIN_AGO,
                    outcome: 'no_answer',
                    dispositionLabel: null,
                    durationSeconds: null,
                    notes: null,
                    isVoicemail: false,
                    hasRecording: false,
                    callbackAt: null,
                  },
                ]
              : []
          }
          campaignScript={{
            scriptText: 'Hi, this is {agent} calling from {company}...',
            objectionSheetText: '"Not interested" -> acknowledge, then ask what changed.',
          }}
          pendingCampaignScript={null}
          onApplyPendingCampaignScript={() =>
            window.alert('Apply pending script clicked (fixture, no-op)')
          }
          onPause={() => window.alert('Pause clicked (fixture, no-op)')}
          onResume={() => window.alert('Resume clicked (fixture, no-op)')}
          onStop={(opts) =>
            window.alert(
              `Stop confirmed (fixture, no-op)${opts?.force ? ' -- force:true (via confirm dialog)' : ''}`
            )
          }
          muted={muted}
          onMuteChange={setMuted}
          onEndLiveCall={() => window.alert('End live call clicked (fixture, no-op)')}
          onHoldCall={() => window.alert('Hold clicked (fixture, no-op)')}
          onResumeCall={() => window.alert('Resume call clicked (fixture, no-op)')}
          onToggleRecording={() => setRecPaused((p) => !p)}
          onStartTransfer={async () => window.alert('Start transfer (fixture, no-op)')}
          onCompleteTransfer={() => window.alert('Complete transfer clicked (fixture, no-op)')}
          onCancelTransfer={() => window.alert('Cancel transfer clicked (fixture, no-op)')}
        />
      </div>

      {selectedState === 'on_call' && fx === 'manual' && (
        <div className="mt-6 px-4">
          <ActiveCall
            outboundNumber="+15125550123"
            fromNumber="+15125550000"
            duration="01:12"
            onEndCall={() => window.alert('End manual call (fixture, no-op)')}
            onMuteChange={() => undefined}
          />
        </div>
      )}

      {selectedState === 'wrap_up' && !wrapUpResult && (
        <WrapUpModal
          key={wrapUpKey}
          sessionId="dev-session"
          legId="dev-leg"
          contact={{
            id: FIXTURE_CONTACTS[0].id,
            name: FIXTURE_CONTACTS[0].name,
            phone: FIXTURE_CONTACTS[0].phone,
          }}
          callDurationSeconds={135}
          onSubmitted={(result) => {
            setWrapUpResult(result);
            setSelectedState('dialing');
            setWrapUpKey((k) => k + 1);
          }}
          loadDispositions={fixtureLoadDispositions}
          submitWrapUp={fixtureSubmitDisposition}
          loadHistory={fixtureLoadHistory}
        />
      )}
    </div>
  );
}
