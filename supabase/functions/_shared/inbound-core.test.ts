import { assertEquals } from 'jsr:@std/assert';
import {
  isAgentBusyOnACall,
  isAgentInJoinableSession,
  isAgentOnline,
  planInboundSteps,
  nextInboundStep,
  outcomeForEndedCall,
  isPlausibleE164,
  INBOUND_PRESENCE_WINDOW_MS,
  type InboundRoutingInputs,
} from './inbound-core.ts';

Deno.test('isAgentBusyOnACall: true only for on_call/connecting/wrap_up', () => {
  assertEquals(isAgentBusyOnACall(null), false);
  for (const state of ['on_call', 'connecting', 'wrap_up']) {
    assertEquals(isAgentBusyOnACall({ id: 's', state }), true, state);
  }
  for (const state of [
    'ready_pending',
    'ready',
    'dialing',
    'paused',
    'paused_agent_lost',
    'stopped',
    'completed',
  ]) {
    assertEquals(isAgentBusyOnACall({ id: 's', state }), false, state);
  }
});

Deno.test('isAgentInJoinableSession: true only for ready/dialing/paused', () => {
  assertEquals(isAgentInJoinableSession(null), false);
  for (const state of ['ready', 'dialing', 'paused']) {
    assertEquals(isAgentInJoinableSession({ id: 's', state }), true, state);
  }
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
    assertEquals(isAgentInJoinableSession({ id: 's', state }), false, state);
  }
});

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
  'nextInboundStep: a step that is not in the (recomputed) plan at all returns null, not a crash',
  () => {
    // e.g. the intern went offline between the first webhook and this one -- 'ringing_intern'
    // is legitimately gone from a freshly recomputed plan. Must not throw or silently resume it.
    assertEquals(nextInboundStep('ringing_intern', inputs({ hasSharedDestination: true })), null);
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
