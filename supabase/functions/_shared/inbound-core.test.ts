import { assertEquals } from 'jsr:@std/assert';
import {
  isAgentBusyOnACall,
  isAgentInJoinableSession,
  isAgentOnline,
  planInboundSteps,
  nextInboundStep,
  outcomeForEndedCall,
  isPlausibleE164,
  normalizeToE164,
  INBOUND_PRESENCE_WINDOW_MS,
  type InboundRoutingInputs,
} from './inbound-core.ts';

Deno.test(
  'isAgentBusyOnACall: true for on_call/connecting/wrap_up, and for paused-for-inbound_call',
  () => {
    assertEquals(isAgentBusyOnACall(null), false);
    for (const state of ['on_call', 'connecting', 'wrap_up']) {
      assertEquals(isAgentBusyOnACall({ id: 's', state, pauseReason: null }), true, state);
    }
    // Review fix (eng1 review-eng1.md finding #4): a prior bridged inbound call also counts as
    // busy, even though the bare state is 'paused' -- the intern's WebRTC leg is occupied.
    assertEquals(
      isAgentBusyOnACall({ id: 's', state: 'paused', pauseReason: 'inbound_call' }),
      true,
      'paused for a prior inbound call -- busy'
    );
    for (const state of [
      'ready_pending',
      'ready',
      'dialing',
      'paused_agent_lost',
      'stopped',
      'completed',
    ]) {
      assertEquals(isAgentBusyOnACall({ id: 's', state, pauseReason: null }), false, state);
    }
    assertEquals(
      isAgentBusyOnACall({ id: 's', state: 'paused', pauseReason: null }),
      false,
      'plain manual pause -- not busy'
    );
    assertEquals(
      isAgentBusyOnACall({ id: 's', state: 'paused', pauseReason: 'manual' }),
      false,
      'a different pause reason -- not busy'
    );
  }
);

Deno.test(
  'isAgentInJoinableSession: true only for ready/dialing/paused (not from inbound_call)',
  () => {
    assertEquals(isAgentInJoinableSession(null), false);
    for (const state of ['ready', 'dialing']) {
      assertEquals(isAgentInJoinableSession({ id: 's', state, pauseReason: null }), true, state);
    }
    assertEquals(
      isAgentInJoinableSession({ id: 's', state: 'paused', pauseReason: null }),
      true,
      'paused, no reason'
    );
    assertEquals(
      isAgentInJoinableSession({ id: 's', state: 'paused', pauseReason: 'manual' }),
      true,
      'paused, manual reason'
    );
    // Review fix (eng1 review-eng1.md finding #4): 'paused' because a PRIOR inbound call is
    // already bridged into this same conference is NOT safe to join a second caller into.
    assertEquals(
      isAgentInJoinableSession({ id: 's', state: 'paused', pauseReason: 'inbound_call' }),
      false,
      'paused for a prior inbound call -- NOT joinable'
    );
    // Explicitly excluded even though they're not "busy" either: no live agent leg to bridge to.
    for (const state of [
      'ready_pending',
      'paused_agent_lost',
      'on_call',
      'connecting',
      'wrap_up',
      'stopped',
      'completed',
    ]) {
      assertEquals(isAgentInJoinableSession({ id: 's', state, pauseReason: null }), false, state);
    }
  }
);

Deno.test('isAgentOnline: within the 2-minute window, not outside it, not for null', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  assertEquals(isAgentOnline(null, now), false);
  assertEquals(isAgentOnline('2026-09-25T11:59:00Z', now), true);
  assertEquals(
    isAgentOnline(new Date(now - INBOUND_PRESENCE_WINDOW_MS).toISOString(), now),
    true,
    'inclusive boundary'
  );
  assertEquals(
    isAgentOnline(new Date(now - INBOUND_PRESENCE_WINDOW_MS - 1000).toISOString(), now),
    false
  );
  assertEquals(isAgentOnline('not-a-date', now), false);
});

function inputs(overrides: Partial<InboundRoutingInputs> = {}): InboundRoutingInputs {
  return {
    hasAssignedIntern: false,
    internBusyOnACall: false,
    joinableSessionId: null,
    internOnline: false,
    hasForwardNumber: false,
    hasSharedDestination: false,
    ...overrides,
  };
}

Deno.test(
  'planInboundSteps: team-pool number (no assigned intern) skips straight to fallbacks + voicemail',
  () => {
    assertEquals(planInboundSteps(inputs()), ['voicemail']);
    assertEquals(planInboundSteps(inputs({ hasForwardNumber: true, hasSharedDestination: true })), [
      'ringing_cell',
      'ringing_shared',
      'voicemail',
    ]);
  }
);

Deno.test(
  'planInboundSteps: assigned intern in a joinable session -> bridging_session first',
  () => {
    assertEquals(
      planInboundSteps(inputs({ hasAssignedIntern: true, joinableSessionId: 'sess-1' })),
      ['bridging_session', 'voicemail']
    );
  }
);

Deno.test(
  'planInboundSteps: assigned intern, no joinable session, online -> ringing_intern',
  () => {
    assertEquals(planInboundSteps(inputs({ hasAssignedIntern: true, internOnline: true })), [
      'ringing_intern',
      'voicemail',
    ]);
  }
);

Deno.test(
  'planInboundSteps: assigned intern, no joinable session, offline -> intern is skipped entirely',
  () => {
    assertEquals(
      planInboundSteps(
        inputs({ hasAssignedIntern: true, internOnline: false, hasForwardNumber: true })
      ),
      ['ringing_cell', 'voicemail']
    );
  }
);

Deno.test(
  'planInboundSteps: assigned intern who is busy on a call is never rung, even if also "online"',
  () => {
    assertEquals(
      planInboundSteps(
        inputs({
          hasAssignedIntern: true,
          internBusyOnACall: true,
          internOnline: true,
          joinableSessionId: 'sess-1',
        })
      ),
      ['voicemail']
    );
  }
);

Deno.test('planInboundSteps: full chain in the documented order', () => {
  assertEquals(
    planInboundSteps(
      inputs({
        hasAssignedIntern: true,
        internOnline: true,
        hasForwardNumber: true,
        hasSharedDestination: true,
      })
    ),
    ['ringing_intern', 'ringing_cell', 'ringing_shared', 'voicemail']
  );
});

Deno.test(
  'nextInboundStep: walks the same recomputed plan forward, null after the last step',
  () => {
    const withEverything = inputs({
      hasAssignedIntern: true,
      internOnline: true,
      hasForwardNumber: true,
      hasSharedDestination: true,
    });
    assertEquals(nextInboundStep('ringing_intern', withEverything), 'ringing_cell');
    assertEquals(nextInboundStep('ringing_cell', withEverything), 'ringing_shared');
    assertEquals(nextInboundStep('ringing_shared', withEverything), 'voicemail');
    assertEquals(nextInboundStep('voicemail', withEverything), null);
  }
);

Deno.test(
  'nextInboundStep: a step that is not in the (recomputed) plan at all advances to the next ' +
    'higher-ranked step instead of dead-ending -- never silent dead air (eng1 review fix #3)',
  () => {
    // e.g. the intern went offline between the first webhook and this one -- 'ringing_intern'
    // is legitimately gone from a freshly recomputed plan. Ranking by a FIXED priority order
    // (not `indexOf`-ing the stale step into the fresh plan) means this advances to whatever
    // real step outranks it (here, ringing_shared) rather than returning null and leaving the
    // caller on a dead leg with no further Telnyx command ever issued.
    assertEquals(
      nextInboundStep('ringing_intern', inputs({ hasSharedDestination: true })),
      'ringing_shared'
    );
  }
);

Deno.test(
  'nextInboundStep: only returns null when current was already the last-ranked step ' +
    '(voicemail) -- the ONLY real "nothing left to try" case',
  () => {
    // Mirrors finding #3's own repro: the intern started a session mid-ring, so a freshly
    // recomputed plan now leads with 'bridging_session' instead of 'ringing_intern' -- but
    // bridging_session is ranked BEFORE ringing_intern (it's a higher-priority path we've
    // already moved past for this call), so it's correctly skipped, not resumed backward.
    assertEquals(
      nextInboundStep(
        'ringing_intern',
        inputs({
          hasAssignedIntern: true,
          joinableSessionId: 'session-1',
          hasSharedDestination: true,
        })
      ),
      'ringing_shared'
    );
    // Only 'voicemail' itself (rank 4, nothing outranks it) ever returns null.
    assertEquals(
      nextInboundStep(
        'voicemail',
        inputs({ hasAssignedIntern: true, joinableSessionId: 'session-1' })
      ),
      null
    );
  }
);

Deno.test('outcomeForEndedCall: the exact INB-4 4-value mapping', () => {
  assertEquals(
    outcomeForEndedCall({ lastStep: 'bridging_session', connected: true }),
    'answered_by_agent'
  );
  assertEquals(
    outcomeForEndedCall({ lastStep: 'ringing_intern', connected: true }),
    'answered_by_agent'
  );
  assertEquals(outcomeForEndedCall({ lastStep: 'ringing_cell', connected: true }), 'forwarded');
  assertEquals(outcomeForEndedCall({ lastStep: 'ringing_shared', connected: true }), 'forwarded');
  assertEquals(outcomeForEndedCall({ lastStep: 'voicemail', connected: true }), 'voicemail');
  assertEquals(outcomeForEndedCall({ lastStep: 'voicemail', connected: false }), 'missed');
  assertEquals(outcomeForEndedCall({ lastStep: 'ringing_intern', connected: false }), 'missed');
});

Deno.test('isPlausibleE164: a real E.164 passes, garbage does not', () => {
  assertEquals(isPlausibleE164('+12145550001'), true);
  assertEquals(isPlausibleE164('2145550001'), false);
  assertEquals(isPlausibleE164('+1'), false);
  assertEquals(isPlausibleE164(null), false);
  assertEquals(isPlausibleE164(undefined), false);
  assertEquals(isPlausibleE164(''), false);
});

Deno.test('normalizeToE164: US numbers typed any way become +1..., anything unsafe is null', () => {
  assertEquals(normalizeToE164('8305635638'), '+18305635638');
  assertEquals(normalizeToE164('(830) 563-5638'), '+18305635638');
  assertEquals(normalizeToE164('1 830 563 5638'), '+18305635638');
  assertEquals(normalizeToE164('+18305635638'), '+18305635638');
  assertEquals(normalizeToE164('+44 20 7946 0958'), '+442079460958');
  assertEquals(normalizeToE164(''), null);
  assertEquals(normalizeToE164(null), null);
  assertEquals(normalizeToE164('call me'), null);
  assertEquals(normalizeToE164('12345'), null);
  assertEquals(normalizeToE164('0305635638'), null, 'NANP area codes never start with 0/1');
  assertEquals(normalizeToE164('sip:agent@sip.telnyx.com'), null);
});
