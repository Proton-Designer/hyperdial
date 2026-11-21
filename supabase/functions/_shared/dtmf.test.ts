import { assertEquals } from 'jsr:@std/assert@1';
import { parseDtmfDigits, resolveDtmfTarget, type DtmfTargetInput } from './dtmf.ts';

Deno.test('parseDtmfDigits: accepts keypad keys and trims', () => {
  assertEquals(parseDtmfDigits(' 1 '), { digits: '1' });
  assertEquals(parseDtmfDigits('0123456789*#'), { digits: '0123456789*#' });
});

Deno.test(
  'parseDtmfDigits: rejects empty, non-string, too long, and anything off the keypad',
  () => {
    for (const bad of [
      undefined,
      null,
      5,
      '',
      '   ',
      '12a',
      '1 2',
      'w',
      'A',
      '1,2',
      '\n',
      '1;rm',
      '+1',
    ]) {
      assertEquals('error' in parseDtmfDigits(bad), true, JSON.stringify(bad));
    }
    assertEquals('error' in parseDtmfDigits('1'.repeat(17)), true);
    assertEquals('digits' in parseDtmfDigits('1'.repeat(16)), true);
  }
);

const base: DtmfTargetInput = {
  sessionOrgId: 'org1',
  callerOrgId: 'org1',
  sessionAgentId: 'me',
  callerUserId: 'me',
  activeLegId: 'leg1',
  sessionId: 's1',
  leg: {
    id: 'leg1',
    org_id: 'org1',
    session_id: 's1',
    kind: 'contact',
    state: 'claimed',
    call_control_id: 'v3:abc',
  },
};

Deno.test('resolveDtmfTarget: own session, claimed contact leg -> its call_control_id', () => {
  assertEquals(resolveDtmfTarget(base), { callControlId: 'v3:abc' });
  assertEquals(resolveDtmfTarget({ ...base, leg: { ...base.leg!, state: 'answered' } }), {
    callControlId: 'v3:abc',
  });
});

Deno.test("resolveDtmfTarget: another agent's session -> 403, whatever the role", () => {
  assertEquals(resolveDtmfTarget({ ...base, sessionAgentId: 'someone-else' }), {
    status: 403,
    error: 'Not your session',
  });
});

Deno.test('resolveDtmfTarget: other org / missing session -> 404', () => {
  assertEquals(
    (resolveDtmfTarget({ ...base, sessionOrgId: 'org2' }) as { status: number }).status,
    404
  );
  assertEquals(
    (resolveDtmfTarget({ ...base, sessionOrgId: null }) as { status: number }).status,
    404
  );
});

Deno.test(
  'resolveDtmfTarget: no live leg, ended/ringing leg, agent leg, mismatched leg -> 400',
  () => {
    const st = (r: unknown) => (r as { status?: number }).status;
    assertEquals(st(resolveDtmfTarget({ ...base, activeLegId: null })), 400);
    assertEquals(st(resolveDtmfTarget({ ...base, leg: null })), 400);
    assertEquals(st(resolveDtmfTarget({ ...base, leg: { ...base.leg!, state: 'ended' } })), 400);
    assertEquals(st(resolveDtmfTarget({ ...base, leg: { ...base.leg!, state: 'ringing' } })), 400);
    assertEquals(st(resolveDtmfTarget({ ...base, leg: { ...base.leg!, kind: 'agent' } })), 400);
    assertEquals(st(resolveDtmfTarget({ ...base, leg: { ...base.leg!, id: 'other' } })), 400);
    assertEquals(st(resolveDtmfTarget({ ...base, leg: { ...base.leg!, session_id: 's2' } })), 400);
    assertEquals(st(resolveDtmfTarget({ ...base, leg: { ...base.leg!, org_id: 'org2' } })), 400);
    assertEquals(
      st(resolveDtmfTarget({ ...base, leg: { ...base.leg!, call_control_id: null } })),
      400
    );
  }
);
