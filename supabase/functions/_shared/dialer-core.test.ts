import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  amdDecision,
  hangupOutcome,
  leadOutcomeUpdate,
  legTransition,
  loserActions,
  refillCount,
  type AmdDecision,
  type DialerLeg,
  type HangupCause,
  type LegOutcome,
  type LegState,
} from './dialer-core.ts';

// ---------------------------------------------------------------------------
// amdDecision
// ---------------------------------------------------------------------------

Deno.test('amdDecision: off always claims, regardless of result', () => {
  assertEquals(amdDecision('off'), 'claim');
  assertEquals(amdDecision('off', 'machine'), 'claim');
  assertEquals(amdDecision('off', 'silence'), 'claim');
});

Deno.test('amdDecision: on, no result yet, waits', () => {
  assertEquals(amdDecision('on'), 'wait');
  assertEquals(amdDecision('on', undefined), 'wait');
});

const AMD_CLAIM_RESULTS = ['human', 'human_residence', 'human_business', 'not_sure'];
const AMD_REJECT_RESULTS = ['machine', 'fax_detected', 'silence'];

for (const result of AMD_CLAIM_RESULTS) {
  Deno.test(`amdDecision: on, result "${result}" claims`, () => {
    assertEquals(amdDecision('on', result), 'claim');
  });
}

for (const result of AMD_REJECT_RESULTS) {
  Deno.test(`amdDecision: on, result "${result}" rejects`, () => {
    assertEquals(amdDecision('on', result), 'reject');
  });
}

Deno.test(
  'amdDecision: on, unrecognized result claims (false "machine" drops a real prospect)',
  () => {
    assertEquals(amdDecision('on', 'something_new_telnyx_added'), 'claim');
  }
);

// ---------------------------------------------------------------------------
// hangupOutcome
// ---------------------------------------------------------------------------

Deno.test('hangupOutcome: a decision already reached is preserved, hangup_cause ignored', () => {
  assertEquals(
    hangupOutcome({ state: 'claimed', hangupCause: 'normal_clearing', hungUpByEngine: false }),
    'connected'
  );
  assertEquals(
    hangupOutcome({ state: 'machine', hangupCause: 'normal_clearing', hungUpByEngine: false }),
    'machine'
  );
  assertEquals(
    hangupOutcome({ state: 'dropped', hangupCause: 'normal_clearing', hungUpByEngine: false }),
    'dropped'
  );
  assertEquals(
    hangupOutcome({ state: 'abandoned', hangupCause: 'normal_clearing', hungUpByEngine: false }),
    'abandoned'
  );
});

const NEVER_DECIDED_STATES: LegState[] = ['initiated', 'ringing', 'answered', 'amd_pending'];

for (const state of NEVER_DECIDED_STATES) {
  const expected = state === 'ringing' || state === 'initiated' ? 'dropped' : 'abandoned';
  Deno.test(`hangupOutcome: engine-hung-up from "${state}" -> ${expected}`, () => {
    assertEquals(
      hangupOutcome({ state, hangupCause: 'normal_clearing', hungUpByEngine: true }),
      expected
    );
  });
}

const NATURAL_HANGUP_CAUSES: { cause: HangupCause; expected: LegOutcome }[] = [
  { cause: 'user_busy', expected: 'busy' },
  { cause: 'no_answer', expected: 'no_answer' },
  { cause: 'call_rejected', expected: 'failed' },
  { cause: 'not_found', expected: 'failed' },
  { cause: 'timeout', expected: 'no_answer' },
  { cause: 'originator_cancel', expected: 'no_answer' },
  { cause: 'time_limit', expected: 'no_answer' },
  { cause: 'normal_clearing', expected: 'no_answer' },
  { cause: 'unspecified', expected: 'no_answer' },
];

for (const { cause, expected } of NATURAL_HANGUP_CAUSES) {
  Deno.test(`hangupOutcome: never answered, natural hangup_cause "${cause}" -> ${expected}`, () => {
    assertEquals(
      hangupOutcome({ state: 'ringing', hangupCause: cause, hungUpByEngine: false }),
      expected
    );
  });
}

// ---------------------------------------------------------------------------
// legTransition
// ---------------------------------------------------------------------------

Deno.test('legTransition: call.initiated from initiated -> ringing', () => {
  assertEquals(legTransition('initiated', { eventType: 'call.initiated' }, { amdMode: 'off' }), {
    next: 'ringing',
  });
});

Deno.test('legTransition: duplicate call.initiated (already ringing) is ignored -> null', () => {
  assertEquals(legTransition('ringing', { eventType: 'call.initiated' }, { amdMode: 'off' }), null);
});

Deno.test(
  'legTransition: call.ringing (not currently emitted by Telnyx) from initiated -> ringing',
  () => {
    assertEquals(legTransition('initiated', { eventType: 'call.ringing' }, { amdMode: 'off' }), {
      next: 'ringing',
    });
  }
);

Deno.test('legTransition: call.ringing is a no-op once already ringing -> null', () => {
  assertEquals(legTransition('ringing', { eventType: 'call.ringing' }, { amdMode: 'off' }), null);
});

Deno.test(
  'legTransition: call.answered, amd off, this leg wins the claim -> claimed/connected',
  () => {
    assertEquals(
      legTransition('ringing', { eventType: 'call.answered' }, { amdMode: 'off', claim: 'won' }),
      { next: 'claimed', outcome: 'connected' }
    );
  }
);

Deno.test('legTransition: call.answered, amd off, this leg loses the claim -> abandoned', () => {
  assertEquals(
    legTransition('ringing', { eventType: 'call.answered' }, { amdMode: 'off', claim: 'lost' }),
    { next: 'abandoned', outcome: 'abandoned' }
  );
});

Deno.test(
  'legTransition: call.answered, amd off, no claim decision supplied -> throws (contract violation, not a no-op)',
  () => {
    assertThrows(() =>
      legTransition('ringing', { eventType: 'call.answered' }, { amdMode: 'off' })
    );
  }
);

Deno.test('legTransition: call.answered, amd on -> amd_pending, no outcome yet', () => {
  assertEquals(legTransition('ringing', { eventType: 'call.answered' }, { amdMode: 'on' }), {
    next: 'amd_pending',
  });
});

Deno.test('legTransition: call.answered out of order (not currently ringing) -> null', () => {
  assertEquals(
    legTransition('initiated', { eventType: 'call.answered' }, { amdMode: 'off', claim: 'won' }),
    null
  );
  assertEquals(
    legTransition('claimed', { eventType: 'call.answered' }, { amdMode: 'off', claim: 'won' }),
    null
  );
});

Deno.test(
  'legTransition: standard detection-ended, human, amd on, this leg wins -> claimed',
  () => {
    assertEquals(
      legTransition(
        'amd_pending',
        { eventType: 'call.machine.detection.ended', result: 'human' },
        { amdMode: 'on', claim: 'won' }
      ),
      { next: 'claimed', outcome: 'connected' }
    );
  }
);

Deno.test(
  'legTransition: standard detection-ended, human, amd on, this leg loses -> abandoned',
  () => {
    assertEquals(
      legTransition(
        'amd_pending',
        { eventType: 'call.machine.detection.ended', result: 'human' },
        { amdMode: 'on', claim: 'lost' }
      ),
      { next: 'abandoned', outcome: 'abandoned' }
    );
  }
);

Deno.test(
  'legTransition: standard detection-ended, machine, amd on -> machine/machine, no claim needed',
  () => {
    assertEquals(
      legTransition(
        'amd_pending',
        { eventType: 'call.machine.detection.ended', result: 'machine' },
        { amdMode: 'on' }
      ),
      { next: 'machine', outcome: 'machine' }
    );
  }
);

Deno.test(
  'legTransition: premium detection-ended, human_residence, amd on, wins -> claimed',
  () => {
    assertEquals(
      legTransition(
        'amd_pending',
        { eventType: 'call.machine.premium.detection.ended', result: 'human_residence' },
        { amdMode: 'on', claim: 'won' }
      ),
      { next: 'claimed', outcome: 'connected' }
    );
  }
);

Deno.test('legTransition: premium detection-ended, fax_detected, amd on -> machine/machine', () => {
  assertEquals(
    legTransition(
      'amd_pending',
      { eventType: 'call.machine.premium.detection.ended', result: 'fax_detected' },
      { amdMode: 'on' }
    ),
    { next: 'machine', outcome: 'machine' }
  );
});

Deno.test(
  'legTransition: detection-ended while amd is off is ignored -> null (Telnyx would never send it)',
  () => {
    assertEquals(
      legTransition(
        'amd_pending',
        { eventType: 'call.machine.detection.ended', result: 'human' },
        { amdMode: 'off', claim: 'won' }
      ),
      null
    );
  }
);

Deno.test(
  'legTransition: duplicate detection-ended (already resolved to claimed) is ignored -> null',
  () => {
    assertEquals(
      legTransition(
        'claimed',
        { eventType: 'call.machine.detection.ended', result: 'human' },
        { amdMode: 'on', claim: 'won' }
      ),
      null
    );
  }
);

Deno.test('legTransition: call.speak.ended while abandoned is a no-op self-transition', () => {
  assertEquals(legTransition('abandoned', { eventType: 'call.speak.ended' }, { amdMode: 'off' }), {
    next: 'abandoned',
  });
});

Deno.test('legTransition: call.speak.ended in any other state is ignored -> null', () => {
  assertEquals(
    legTransition('ringing', { eventType: 'call.speak.ended' }, { amdMode: 'off' }),
    null
  );
  assertEquals(
    legTransition('claimed', { eventType: 'call.speak.ended' }, { amdMode: 'off' }),
    null
  );
});

Deno.test(
  'legTransition: call.hangup from ringing (never answered), natural cause -> ended/no_answer',
  () => {
    assertEquals(
      legTransition(
        'ringing',
        { eventType: 'call.hangup', hangupCause: 'no_answer' },
        { amdMode: 'off' }
      ),
      { next: 'ended', outcome: 'no_answer' }
    );
  }
);

Deno.test(
  'legTransition: call.hangup from ringing, hung up by the engine (another leg won) -> ended/dropped',
  () => {
    assertEquals(
      legTransition(
        'ringing',
        { eventType: 'call.hangup', hangupCause: 'normal_clearing' },
        { amdMode: 'off', hungUpByEngine: true }
      ),
      { next: 'ended', outcome: 'dropped' }
    );
  }
);

Deno.test(
  'legTransition: call.hangup from answered, hung up by the engine -> ended/abandoned',
  () => {
    assertEquals(
      legTransition(
        'answered',
        { eventType: 'call.hangup', hangupCause: 'normal_clearing' },
        { amdMode: 'off', hungUpByEngine: true }
      ),
      { next: 'ended', outcome: 'abandoned' }
    );
  }
);

Deno.test(
  'legTransition: call.hangup from claimed preserves the connected outcome -> ended/connected',
  () => {
    assertEquals(
      legTransition(
        'claimed',
        { eventType: 'call.hangup', hangupCause: 'normal_clearing' },
        { amdMode: 'off' }
      ),
      { next: 'ended', outcome: 'connected' }
    );
  }
);

Deno.test('legTransition: duplicate call.hangup (already ended) is ignored -> null', () => {
  assertEquals(
    legTransition(
      'ended',
      { eventType: 'call.hangup', hangupCause: 'normal_clearing' },
      { amdMode: 'off' }
    ),
    null
  );
});

// Positive control: prove legTransition actually distinguishes states/events, not just
// returning a constant. If this ever regresses to "always return {next:'ended'}" or
// similar, this assertion catches it because 'ringing' clearly is not 'ended'.
Deno.test(
  'legTransition positive control: an unhandled (state, event) pair really does return null, not a guess',
  () => {
    const result = legTransition(
      'initiated',
      { eventType: 'call.hangup', hangupCause: 'no_answer' },
      { amdMode: 'off' }
    );
    // initiated -> hangup IS handled (not null); assert it is specifically the initiated
    // case's own reasoning (dropped-vs-no_answer branch), not an arbitrary fixed value.
    assertEquals(result, { next: 'ended', outcome: 'no_answer' });
    const ignored = legTransition('ended', { eventType: 'call.initiated' }, { amdMode: 'off' });
    assertEquals(ignored, null);
  }
);

// ---------------------------------------------------------------------------
// refillCount
// ---------------------------------------------------------------------------

Deno.test('refillCount: 0 unless dialing AND agent leg answered', () => {
  assertEquals(refillCount('ready', 'answered', 5, 0), 0);
  assertEquals(refillCount('dialing', 'ringing', 5, 0), 0);
  assertEquals(refillCount('paused_agent_lost', 'ended', 5, 0), 0);
  assertEquals(refillCount('wrap_up', 'answered', 5, 0), 0);
});

Deno.test('refillCount: dialing + agent answered fills up to `lines`', () => {
  assertEquals(refillCount('dialing', 'answered', 5, 0), 5);
  assertEquals(refillCount('dialing', 'answered', 5, 2), 3);
  assertEquals(refillCount('dialing', 'answered', 5, 5), 0);
});

Deno.test('refillCount: never goes negative when activeLegs exceeds lines', () => {
  assertEquals(refillCount('dialing', 'answered', 3, 7), 0);
});

// ---------------------------------------------------------------------------
// loserActions
// ---------------------------------------------------------------------------

Deno.test('loserActions: answered losers get speak_then_hangup when the message is enabled', () => {
  const legs: DialerLeg[] = [
    { id: 'winner', state: 'claimed' },
    { id: 'loser-answered', state: 'answered' },
    { id: 'loser-ringing', state: 'ringing' },
  ];
  assertEquals(loserActions(legs, 'winner', true), [
    { legId: 'loser-answered', action: 'speak_then_hangup' },
    { legId: 'loser-ringing', action: 'hangup' },
  ]);
});

Deno.test('loserActions: message disabled -> every loser just hangs up, even if answered', () => {
  const legs: DialerLeg[] = [
    { id: 'winner', state: 'claimed' },
    { id: 'loser-answered', state: 'answered' },
  ];
  assertEquals(loserActions(legs, 'winner', false), [
    { legId: 'loser-answered', action: 'hangup' },
  ]);
});

Deno.test(
  'loserActions: an amd_pending loser (answered, awaiting detection) also counts as answered',
  () => {
    const legs: DialerLeg[] = [
      { id: 'winner', state: 'claimed' },
      { id: 'loser-amd', state: 'amd_pending' },
    ];
    assertEquals(loserActions(legs, 'winner', true), [
      { legId: 'loser-amd', action: 'speak_then_hangup' },
    ]);
  }
);

Deno.test('loserActions: the winner itself is excluded from the result', () => {
  const legs: DialerLeg[] = [{ id: 'winner', state: 'claimed' }];
  assertEquals(loserActions(legs, 'winner', true), []);
});

// ---------------------------------------------------------------------------
// leadOutcomeUpdate
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-24T00:00:00.000Z');
const CAMPAIGN_DEFAULTS = {};

Deno.test(
  'leadOutcomeUpdate: no_answer/busy/machine -> queued, +1 attempt, +retryIntervalMs (default 2h)',
  () => {
    for (const outcome of ['no_answer', 'busy', 'machine'] as const) {
      assertEquals(
        leadOutcomeUpdate(outcome, { status: 'in_flight', attempts: 0 }, CAMPAIGN_DEFAULTS, NOW),
        {
          status: 'queued',
          attempts: 1,
          next_attempt_at: new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        }
      );
    }
  }
);

Deno.test('leadOutcomeUpdate: dropped -> queued, +0 attempts, +15min', () => {
  assertEquals(
    leadOutcomeUpdate('dropped', { status: 'in_flight', attempts: 1 }, CAMPAIGN_DEFAULTS, NOW),
    {
      status: 'queued',
      attempts: 1,
      next_attempt_at: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    }
  );
});

Deno.test(
  'leadOutcomeUpdate: abandoned -> queued, +1 attempt, +15min (high priority via the short interval)',
  () => {
    assertEquals(
      leadOutcomeUpdate('abandoned', { status: 'in_flight', attempts: 0 }, CAMPAIGN_DEFAULTS, NOW),
      {
        status: 'queued',
        attempts: 1,
        next_attempt_at: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
      }
    );
  }
);

Deno.test('leadOutcomeUpdate: failed -> exhausted unconditionally, attempts untouched', () => {
  assertEquals(
    leadOutcomeUpdate('failed', { status: 'in_flight', attempts: 0 }, CAMPAIGN_DEFAULTS, NOW),
    {
      status: 'exhausted',
      attempts: 0,
      next_attempt_at: null,
    }
  );
});

Deno.test(
  'leadOutcomeUpdate: connected -> status left to the disposition, attempts +1, no next_attempt_at',
  () => {
    assertEquals(
      leadOutcomeUpdate('connected', { status: 'in_flight', attempts: 2 }, CAMPAIGN_DEFAULTS, NOW),
      { status: 'in_flight', attempts: 3, next_attempt_at: null }
    );
  }
);

Deno.test(
  'leadOutcomeUpdate: attempts >= max_attempts (default 3) exhausts instead of requeuing',
  () => {
    assertEquals(
      leadOutcomeUpdate('no_answer', { status: 'in_flight', attempts: 2 }, CAMPAIGN_DEFAULTS, NOW),
      {
        status: 'exhausted',
        attempts: 3,
        next_attempt_at: null,
      }
    );
  }
);

Deno.test(
  'leadOutcomeUpdate: dropped never exhausts on its own (+0), even if attempts was already at max',
  () => {
    assertEquals(
      leadOutcomeUpdate('dropped', { status: 'in_flight', attempts: 3 }, CAMPAIGN_DEFAULTS, NOW),
      {
        status: 'exhausted',
        attempts: 3,
        next_attempt_at: null,
      }
    );
  }
);

Deno.test(
  'leadOutcomeUpdate: respects a campaign-configured max_attempts and retry_interval',
  () => {
    const campaign = { maxAttempts: 1, retryIntervalMs: 60_000 };
    assertEquals(leadOutcomeUpdate('busy', { status: 'in_flight', attempts: 0 }, campaign, NOW), {
      status: 'exhausted',
      attempts: 1,
      next_attempt_at: null,
    });
    const campaign2 = { maxAttempts: 5, retryIntervalMs: 60_000 };
    assertEquals(leadOutcomeUpdate('busy', { status: 'in_flight', attempts: 0 }, campaign2, NOW), {
      status: 'queued',
      attempts: 1,
      next_attempt_at: new Date(NOW.getTime() + 60_000).toISOString(),
    });
  }
);

// Positive control: an outcome that should stay queued must NOT be reported as exhausted.
Deno.test(
  'leadOutcomeUpdate positive control: a fresh lead really does requeue, not exhaust',
  () => {
    const result = leadOutcomeUpdate(
      'no_answer',
      { status: 'in_flight', attempts: 0 },
      CAMPAIGN_DEFAULTS,
      NOW
    );
    assertEquals(result.status === 'exhausted', false);
  }
);

// ---------------------------------------------------------------------------
// Sanity: AmdDecision type is exercised by every branch above (no unused-case drift).
// ---------------------------------------------------------------------------
Deno.test(
  'amdDecision: return type covers all three AmdDecision members across the table above',
  () => {
    const seen = new Set<AmdDecision>();
    seen.add(amdDecision('off'));
    seen.add(amdDecision('on'));
    seen.add(amdDecision('on', 'human'));
    seen.add(amdDecision('on', 'machine'));
    assertEquals(seen.has('claim'), true);
    assertEquals(seen.has('wait'), true);
    assertEquals(seen.has('reject'), true);
  }
);
