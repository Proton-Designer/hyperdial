import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  MAX_BODY_BYTES,
  PRO_TOKEN_RE,
  clientIp,
  isIpLiteral,
  hashIp,
  parseProApplicationBody,
  readBoundedBody,
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
    parseProApplicationBody({ ...good, hd_chk: 'http://spam.example' }).kind,
    'honeypot'
  );
  assertEquals(parseProApplicationBody({ ...good, hd_chk: 1 }).kind, 'honeypot');
  assertEquals(parseProApplicationBody({ ...good, hd_chk: '' }).kind, 'ok');
  assertEquals(parseProApplicationBody({ ...good, hd_chk: '   ' }).kind, 'ok');
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

Deno.test('client IP: only a valid IP literal is used, junk falls to unknown', () => {
  for (const ok of ['1.2.3.4', '255.255.255.255', '2001:db8::1', '::1', '::ffff:1.2.3.4']) {
    assert(isIpLiteral(ok), ok);
  }
  for (const bad of [
    '',
    'abc',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.4:80',
    'a'.repeat(60),
    "1.1.1.1'; --",
    '::g',
    'localhost',
    '1111:'.repeat(10),
  ]) {
    assert(!isIpLiteral(bad), bad);
  }
  assertEquals(
    clientIp(new Headers({ 'cf-connecting-ip': 'evil<script>', 'x-forwarded-for': '2.2.2.2' })),
    '2.2.2.2'
  );
  assertEquals(
    clientIp(new Headers({ 'x-forwarded-for': 'random-' + 'x'.repeat(500) })),
    'unknown'
  );
  assertEquals(clientIp(new Headers({ 'x-forwarded-for': '2001:db8::1, 3.3.3.3' })), '2001:db8::1');
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

Deno.test(
  'bounded body read: under the limit returns the bytes, over it stops early without content-length',
  async () => {
    const small = new Request('http://x/', { method: 'POST', body: '{"a":1}' });
    const r = await readBoundedBody(small, 100);
    assert(r !== 'too_large');
    assertEquals(new TextDecoder().decode(r), '{"a":1}');
    // chunked stream with no content-length: 50 chunks of 1000 bytes, limit 5000 -> stops, never reads it all
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= 50) return c.close();
        pulled++;
        c.enqueue(new Uint8Array(1000));
      },
    });
    const big = new Request('http://x/', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    assertEquals(await readBoundedBody(big, 5000), 'too_large');
    assert(pulled < 50, `pulled ${pulled}`);
    // exactly at the limit passes
    const exact = await readBoundedBody(
      new Request('http://x/', { method: 'POST', body: 'x'.repeat(100) }),
      100
    );
    assert(exact !== 'too_large' && exact.byteLength === 100);
    assertEquals(await readBoundedBody(new Request('http://x/'), 10), new Uint8Array(0));
  }
);

Deno.test(
  'numeric answers are bounded like the SQL: out of range is a 400 field message, edges pass',
  () => {
    for (const [field, value, msg] of [
      ['startingPrice', -1, 'Starting price is not valid'],
      ['startingPrice', 100_000_000, 'Starting price is not valid'],
      ['capacity', 10_001, 'Capacity is not valid'],
      ['capacity', -1, 'Capacity is not valid'],
      ['capacity', 3_000_000_000, 'Capacity is not valid'],
      ['yearsInBusiness', 151, 'Years in business is not valid'],
      ['yearsInBusiness', -3, 'Years in business is not valid'],
      ['yearsInBusiness', 1e12, 'Years in business is not valid'],
    ] as const) {
      const r = parseProApplicationBody({ ...good, [field]: value });
      assert(r.kind === 'bad', `${field}=${value}`);
      assertEquals(r.error, msg);
    }
    const edge = parseProApplicationBody({
      ...good,
      startingPrice: 99_999_999,
      capacity: 10_000,
      yearsInBusiness: 150,
    });
    assertEquals(edge.kind, 'ok');
    const zero = parseProApplicationBody({
      ...good,
      startingPrice: 0,
      capacity: 0,
      yearsInBusiness: 0,
    });
    assertEquals(zero.kind, 'ok');
  }
);
