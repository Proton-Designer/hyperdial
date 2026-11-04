import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  MAX_BODY_BYTES,
  PRO_TOKEN_RE,
  clientIp,
  hashIp,
  parseProApplicationBody,
  submitResponse,
} from './pro-application.ts';

const good = {
  token: 'a'.repeat(64),
  ownerName: 'Ann',
  businessName: 'Acme',
  mobile: '(318) 555-0100',
  services: ['Cleaning'],
  cities: ['Monroe'],
  frequencies: ['weekly'],
  insured: true,
};

Deno.test('token format: only 64 lowercase hex chars pass', () => {
  assert(PRO_TOKEN_RE.test('0123456789abcdef'.repeat(4)));
  for (const bad of [
    '',
    'abc',
    'A'.repeat(64),
    'g'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
    "a'; drop table x;--" + 'a'.repeat(50),
  ]) {
    assert(!PRO_TOKEN_RE.test(bad), bad);
  }
});

Deno.test('a filled honeypot is detected (any non-empty value), an empty one is not', () => {
  assertEquals(
    parseProApplicationBody({ ...good, website: 'http://spam.example' }).kind,
    'honeypot'
  );
  assertEquals(parseProApplicationBody({ ...good, website: 1 }).kind, 'honeypot');
  assertEquals(parseProApplicationBody({ ...good, website: '' }).kind, 'ok');
  assertEquals(parseProApplicationBody({ ...good, website: '   ' }).kind, 'ok');
});

Deno.test('a good body parses; optional bits default to null / empty', () => {
  const r = parseProApplicationBody(good);
  assert(r.kind === 'ok');
  assertEquals(r.input.email, null);
  assertEquals(r.input.insured, true);
  assertEquals(r.input.startingPrice, null);
  assertEquals(r.input.services, ['Cleaning']);
  const r2 = parseProApplicationBody({ token: 'x' });
  assert(r2.kind === 'ok');
  assertEquals(r2.input.services, []);
  assertEquals(r2.input.insured, null);
});

Deno.test(
  'field errors: wrong types, oversize lists, non-integers are refused with a readable error',
  () => {
    for (const body of [
      null,
      [],
      'x',
      { ...good, services: 'Cleaning' },
      { ...good, services: [1] },
      { ...good, cities: new Array(61).fill('x') },
      { ...good, ownerName: 5 },
      { ...good, mobile: 'x'.repeat(61) },
      { ...good, insured: 'yes' },
      { ...good, startingPrice: '5' },
      { ...good, capacity: 1.5 },
      { ...good, yearsInBusiness: 2.2 },
    ]) {
      const r = parseProApplicationBody(body);
      assert(r.kind === 'bad', JSON.stringify(body));
      assert(r.error.length > 0);
    }
  }
);

Deno.test(
  'the IP hash is salted HMAC hex: stable, salt-dependent, never the raw address',
  async () => {
    const a = await hashIp('203.0.113.9', 'salt-1');
    assertEquals(a, await hashIp('203.0.113.9', 'salt-1'));
    assert(/^[0-9a-f]{64}$/.test(a));
    assert(a !== (await hashIp('203.0.113.9', 'salt-2')));
    assert(a !== (await hashIp('203.0.113.10', 'salt-1')));
    assert(!a.includes('203'));
  }
);

Deno.test('client IP: cf-connecting-ip, then first x-forwarded-for, else unknown', () => {
  assertEquals(
    clientIp(new Headers({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })),
    '1.1.1.1'
  );
  assertEquals(clientIp(new Headers({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' })), '2.2.2.2');
  assertEquals(clientIp(new Headers()), 'unknown');
});

Deno.test(
  'RPC status -> HTTP: ok 200, not_found 404, rate_limited 429, invalid 400 with the message, anything else 500',
  () => {
    assertEquals(submitResponse('ok', null), { status: 200, body: { ok: true } });
    assertEquals(submitResponse('not_found', null).status, 404);
    assertEquals(submitResponse('rate_limited', null).status, 429);
    assertEquals(submitResponse('invalid', 'Owner name is required'), {
      status: 400,
      body: { error: 'Owner name is required' },
    });
    assertEquals(submitResponse(undefined, null).status, 500);
    assertEquals(submitResponse('weird', 'leak?').status, 500);
    // the 404 and 429 answers carry no database-derived text
    assertEquals(JSON.stringify(submitResponse('not_found', 'leak').body), '{"error":"Not found"}');
  }
);

Deno.test('body limit constant is small', () => {
  assert(MAX_BODY_BYTES <= 50_000);
});
