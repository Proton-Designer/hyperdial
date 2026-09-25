import { useMemo, useState } from 'react';
import { ParallelDialerUI } from '@/components/dialer/ParallelDialerUI';
import { DialerStateBanner } from '@/components/dialer/DialerStateBanner';
import { WrapUpModal } from '@/components/dialer/WrapUpModal';
import type { BatchContactPreview } from '@/hooks/useDialerSession';
import type { Disposition, DialSessionState, SubmitDispositionResult } from '@/lib/api';

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
  },
];

const ANSWERED_2MIN_AGO = new Date(Date.now() - 2 * 60_000 - 15_000).toISOString();

export function DialerStatesHarness() {
  const [selectedState, setSelectedState] = useState<DialSessionState>('dialing');
  const [wrapUpResult, setWrapUpResult] = useState<SubmitDispositionResult | null>(null);
  const [wrapUpKey, setWrapUpKey] = useState(0);

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
          connectedContactId: FIXTURE_CONTACTS[0].id,
        };
      default:
        return { batchContacts: [], answeredContactId: null, connectedContactId: null };
    }
  }, [selectedState]);

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
        {wrapUpResult && (
          <p className="text-[#00E676] text-sm mt-3">
            Wrap-up submitted → session returns to "dialing" (real backend behavior; this harness
            switches the toggle above to demonstrate the cycle).
          </p>
        )}
      </div>

      <div className="max-w-3xl mx-auto">
        <DialerStateBanner
          sessionState={selectedState}
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
          amdMode="on"
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
          connectedAnsweredAt={scenario.connectedContactId ? ANSWERED_2MIN_AGO : null}
          onPause={() => window.alert('Pause clicked (fixture, no-op)')}
          onResume={() => window.alert('Resume clicked (fixture, no-op)')}
          onStop={() => window.alert('Stop clicked (fixture, no-op)')}
          onMuteChange={() => {}}
          onEndLiveCall={() => window.alert('End live call clicked (fixture, no-op)')}
        />
      </div>

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
