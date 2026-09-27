import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  decodeDialClientState,
  encodeDialClientState,
  decodeCoachingClientState,
  encodeCoachingClientState,
} from './client-state.ts';

Deno.test(
  'encodeDialClientState/decodeDialClientState: round-trips, kind defaults to contact',
  () => {
    const state = { org: 'org-1', session: 'session-1', leg: 'leg-1' };
    const encoded = encodeDialClientState(state);
    assertEquals(decodeDialClientState(encoded), { ...state, kind: 'contact' });
  }
);

Deno.test('encodeDialClientState/decodeDialClientState: round-trips an explicit agent kind', () => {
  const state = { org: 'org-1', session: 'session-1', leg: 'leg-1', kind: 'agent' as const };
  const encoded = encodeDialClientState(state);
  assertEquals(decodeDialClientState(encoded), state);
});

Deno.test('encodeDialClientState: throws on missing field', () => {
  assertThrows(() => encodeDialClientState({ org: '', session: 'session-1', leg: 'leg-1' }));
});

Deno.test('decodeDialClientState: null/undefined/empty input returns null', () => {
  assertEquals(decodeDialClientState(null), null);
  assertEquals(decodeDialClientState(undefined), null);
  assertEquals(decodeDialClientState(''), null);
});

Deno.test('decodeDialClientState: non-base64 garbage returns null, does not throw', () => {
  assertEquals(decodeDialClientState('!!!not-base64!!!'), null);
});

Deno.test('decodeDialClientState: valid base64 but not JSON returns null', () => {
  const notJson = btoa('this is not json');
  assertEquals(decodeDialClientState(notJson), null);
});

Deno.test('decodeDialClientState: JSON missing a required field returns null', () => {
  const missingLeg = btoa(JSON.stringify({ org: 'org-1', session: 'session-1' }));
  assertEquals(decodeDialClientState(missingLeg), null);
});

Deno.test('decodeDialClientState: JSON with wrong types returns null', () => {
  const wrongTypes = btoa(JSON.stringify({ org: 1, session: 'session-1', leg: 'leg-1' }));
  assertEquals(decodeDialClientState(wrongTypes), null);
});

Deno.test('decodeDialClientState: rejects the legacy agent-callback shape', () => {
  const legacyAgentState = btoa(JSON.stringify({ t: 'agent', userId: 'u1', sessionId: 's1' }));
  assertEquals(decodeDialClientState(legacyAgentState), null);
});

// TASK-T3 review NIT (review-eng1.md #2): CoachingClientState had no direct encode/decode test
// -- only exercised indirectly via coaching-core.test.ts's own happy-path assertion.

Deno.test('encodeCoachingClientState/decodeCoachingClientState: round-trips every mode', () => {
  for (const mode of ['listen', 'whisper', 'barge'] as const) {
    const state = { org: 'org-1', coaching: 'coaching-1', mode, targetSession: 'session-1' };
    const encoded = encodeCoachingClientState(state);
    assertEquals(decodeCoachingClientState(encoded), { ...state, kind: 'coaching' });
  }
});

Deno.test('encodeCoachingClientState: throws on missing org/coaching/targetSession', () => {
  assertThrows(() =>
    encodeCoachingClientState({
      org: '',
      coaching: 'coaching-1',
      mode: 'listen',
      targetSession: 'session-1',
    })
  );
  assertThrows(() =>
    encodeCoachingClientState({
      org: 'org-1',
      coaching: '',
      mode: 'listen',
      targetSession: 'session-1',
    })
  );
  assertThrows(() =>
    encodeCoachingClientState({
      org: 'org-1',
      coaching: 'coaching-1',
      mode: 'listen',
      targetSession: '',
    })
  );
});

Deno.test('encodeCoachingClientState: throws on an invalid mode', () => {
  assertThrows(() =>
    encodeCoachingClientState({
      org: 'org-1',
      coaching: 'coaching-1',
      // deno-lint-ignore no-explicit-any
      mode: 'bargein' as any,
      targetSession: 'session-1',
    })
  );
});

Deno.test('decodeCoachingClientState: null/undefined/empty input returns null', () => {
  assertEquals(decodeCoachingClientState(null), null);
  assertEquals(decodeCoachingClientState(undefined), null);
  assertEquals(decodeCoachingClientState(''), null);
});

Deno.test(
  'decodeCoachingClientState: non-base64 garbage and non-JSON base64 both return null',
  () => {
    assertEquals(decodeCoachingClientState('!!!not-base64!!!'), null);
    assertEquals(decodeCoachingClientState(btoa('this is not json')), null);
  }
);

Deno.test('decodeCoachingClientState: missing kind/org/coaching returns null', () => {
  assertEquals(
    decodeCoachingClientState(btoa(JSON.stringify({ org: 'org-1', coaching: 'coaching-1' }))),
    null
  );
  assertEquals(
    decodeCoachingClientState(btoa(JSON.stringify({ kind: 'coaching', coaching: 'coaching-1' }))),
    null
  );
  assertEquals(
    decodeCoachingClientState(btoa(JSON.stringify({ kind: 'coaching', org: 'org-1' }))),
    null
  );
});

Deno.test(
  'decodeCoachingClientState: an invalid mode falls back to "listen" rather than failing',
  () => {
    const encoded = btoa(
      JSON.stringify({
        org: 'org-1',
        coaching: 'coaching-1',
        kind: 'coaching',
        mode: 'bargein',
        targetSession: 'session-1',
      })
    );
    assertEquals(decodeCoachingClientState(encoded), {
      org: 'org-1',
      coaching: 'coaching-1',
      kind: 'coaching',
      mode: 'listen',
      targetSession: 'session-1',
    });
  }
);

Deno.test(
  'decodeCoachingClientState: a missing targetSession defaults to "" rather than failing (only the banner-polling safety layer degrades)',
  () => {
    const encoded = btoa(
      JSON.stringify({ org: 'org-1', coaching: 'coaching-1', kind: 'coaching', mode: 'listen' })
    );
    assertEquals(decodeCoachingClientState(encoded), {
      org: 'org-1',
      coaching: 'coaching-1',
      kind: 'coaching',
      mode: 'listen',
      targetSession: '',
    });
  }
);

Deno.test(
  'decodeCoachingClientState: never matches a DialClientState payload (no collision)',
  () => {
    const dialEncoded = encodeDialClientState({ org: 'org-1', session: 'session-1', leg: 'leg-1' });
    assertEquals(decodeCoachingClientState(dialEncoded), null);
  }
);

Deno.test(
  'decodeDialClientState: never matches a CoachingClientState payload (no collision)',
  () => {
    const coachingEncoded = encodeCoachingClientState({
      org: 'org-1',
      coaching: 'coaching-1',
      mode: 'whisper',
      targetSession: 'session-1',
    });
    assertEquals(decodeDialClientState(coachingEncoded), null);
  }
);
