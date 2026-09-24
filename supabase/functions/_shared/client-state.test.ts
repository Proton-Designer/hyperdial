import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { decodeDialClientState, encodeDialClientState } from './client-state.ts';

Deno.test('encodeDialClientState/decodeDialClientState: round-trips', () => {
  const state = { org: 'org-1', session: 'session-1', leg: 'leg-1' };
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
