import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  CLOSE_MAX_ATTEMPTS,
  buildClosePayload,
  checkHostResolvesPublic,
  deliverClose as realDeliverClose,
  isBlockedAddress,
  nextDeliveryState,
  signBody,
  validateWebhookUrl,
  type CloseRow,
  type DeliverArgs,
} from './close-delivery.ts';

const PUBLIC_IP = () => Promise.resolve(['93.184.216.34']);
/** Every test resolves to a public address unless it passes its own resolver. */
const deliverClose = (a: DeliverArgs) => realDeliverClose({ resolveHost: PUBLIC_IP, ...a });

const close: CloseRow = {
  id: 'c1',
  org_id: 'o1',
  contact_id: 'k1',
  closed_by: 'u1',
  owner_name: 'Pat Doe',
  business_name: 'Sparkle LLC',
  mobile: '+15125550100',
  email: null,
  services: ['A'],
  cities: ['Austin'],
  frequencies: ['weekly'],
  insured: true,
  best_contact: 'text after 5',
  starting_price: '85.50',
  capacity: 4,
  years_in_business: 7,
  created_at: '2026-10-27T12:00:00Z',
  delivery_attempts: 1,
};

function fake(status: number, headers: Record<string, string> = {}, body: string | null = null) {
  return fakeSeq([{ status, headers, body }]);
}

/** One scripted answer per call (the last one repeats). */
function fakeSeq(
  answers: { status: number; headers?: Record<string, string>; body?: string | null }[]
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return Promise.resolve(new Response(a.body ?? null, { status: a.status, headers: a.headers }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

Deno.test('payload carries the form, numeric price and agent', () => {
  const p = buildClosePayload(close, { id: 'u1', name: 'Ann' });
  assertEquals(p.event, 'contact.closed');
  assertEquals(p.close_id, 'c1');
  assertEquals(p.form.starting_price, 85.5);
  assertEquals(p.agent, { id: 'u1', name: 'Ann' });
  assertEquals(p.form.email, null);
});

Deno.test('url guard accepts https hostnames, rejects the SSRF shapes', () => {
  assert(validateWebhookUrl('https://script.google.com/macros/s/abc/exec').ok);
  for (const bad of [
    'http://example.com/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest',
    'https://[::1]/x',
    'https://localhost/x',
    'https://intranet/x',
    'https://db.internal/x',
    'https://user:pw@example.com/x',
    'https://example.com:8443/x',
    'https://2130706433/x',
    'https://localhost./x',
    'https://db.internal./x',
    'https://metadata.google.internal./x',
    'https://127.0.0.1./x',
    'not a url',
  ]) {
    assertEquals(validateWebhookUrl(bad).ok, false, bad);
  }
});

Deno.test('2xx is delivered, request is signed and never follows redirects', async () => {
  const f = fake(200);
  const out = await deliverClose({
    url: 'https://example.com/hook',
    secret: 's3cret',
    payload: { a: 1 },
    fetchImpl: f.impl,
    now: () => 1_000_000,
  });
  assertEquals(out.kind, 'sent');
  const init = f.calls[0].init;
  assertEquals(init.redirect, 'manual');
  const h = init.headers as Record<string, string>;
  assertEquals(h['X-Softdial-Timestamp'], '1000');
  assertEquals(h['X-Softdial-Signature'], `sha256=${await signBody('s3cret', '1000', '{"a":1}')}`);
});

Deno.test('no secret -> no signature headers', async () => {
  const f = fake(204);
  await deliverClose({
    url: 'https://example.com/h',
    secret: null,
    payload: {},
    fetchImpl: f.impl,
  });
  assertEquals(
    (f.calls[0].init.headers as Record<string, string>)['X-Softdial-Signature'],
    undefined
  );
});

const ECHO = 'https://script.googleusercontent.com/macros/echo?user_content_key=x';
const APPS = 'https://script.google.com/macros/s/a/exec';
const redirect = { status: 302, headers: { location: ECHO } };

Deno.test('Apps Script: 302 to the echo host, then {ok:true} behind it, is delivered', async () => {
  const f = fakeSeq([redirect, { status: 200, body: '{"ok":true}' }]);
  const out = await deliverClose({ url: APPS, secret: null, payload: {}, fetchImpl: f.impl });
  assertEquals(out.kind, 'sent');
  assertEquals(f.calls.length, 2);
  assertEquals(f.calls[1].url, ECHO);
  assertEquals(f.calls[1].init.method, 'GET');
  assertEquals(f.calls[1].init.redirect, 'manual'); // the echo is fetched once, never followed further
});

Deno.test(
  'Apps Script: {ok:false,error} behind the redirect is a retryable failure with the text',
  async () => {
    const f = fakeSeq([
      redirect,
      { status: 200, body: '{"ok":false,"error":"Sheet Closes not found"}' },
    ]);
    const out = await deliverClose({ url: APPS, secret: null, payload: {}, fetchImpl: f.impl });
    assertEquals(out.kind, 'retry');
    assert(out.kind === 'retry' && out.error.includes('Sheet Closes not found'));
  }
);

Deno.test(
  'Apps Script: a non-JSON answer (the HTML error page) is retryable and the text is capped',
  async () => {
    const html =
      '<!DOCTYPE html><html><body>' + 'TypeError: x is undefined '.repeat(50) + '</body></html>';
    const f = fakeSeq([redirect, { status: 200, body: html }]);
    const out = await deliverClose({ url: APPS, secret: null, payload: {}, fetchImpl: f.impl });
    assertEquals(out.kind, 'retry');
    assert(out.kind === 'retry' && out.error.length < 220 && out.error.includes('TypeError'));
  }
);

Deno.test(
  'Apps Script: JSON without ok:true, a non-2xx echo, and a second redirect are all retryable',
  async () => {
    for (const second of [
      { status: 200, body: '{"fine":1}' },
      { status: 500, body: 'x' },
      { status: 302, headers: { location: 'https://evil.example.com/' } },
    ]) {
      const f = fakeSeq([redirect, second]);
      const out = await deliverClose({ url: APPS, secret: null, payload: {}, fetchImpl: f.impl });
      assertEquals(out.kind, 'retry', JSON.stringify(second));
      assertEquals(f.calls.length, 2); // never a third request
    }
  }
);

Deno.test('Apps Script: the echo host is DNS-checked too', async () => {
  const f = fakeSeq([redirect, { status: 200, body: '{"ok":true}' }]);
  const out = await realDeliverClose({
    url: APPS,
    secret: null,
    payload: {},
    fetchImpl: f.impl,
    resolveHost: (h) =>
      Promise.resolve(h === 'script.googleusercontent.com' ? ['10.0.0.5'] : ['93.184.216.34']),
  });
  assertEquals(out.kind, 'permanent');
  assertEquals(f.calls.length, 1);
});

Deno.test('another receiver: any 2xx is delivered without reading a body', async () => {
  const f = fake(200, {}, 'whatever');
  assertEquals(
    (
      await deliverClose({
        url: 'https://hooks.example.com/x',
        secret: null,
        payload: {},
        fetchImpl: f.impl,
      })
    ).kind,
    'sent'
  );
});

Deno.test('a 302 to any other host is a failure and is not followed', async () => {
  for (const loc of [
    'https://evil.example.com/x',
    'http://script.googleusercontent.com/x',
    'https://script.googleusercontent.com.evil.com/x',
    'http://169.254.169.254/latest',
  ]) {
    const f = fake(302, { location: loc });
    const out = await deliverClose({
      url: 'https://example.com/h',
      secret: null,
      payload: {},
      fetchImpl: f.impl,
    });
    assertEquals(out.kind, 'permanent', loc);
    assertEquals(f.calls.length, 1);
  }
});

Deno.test('status classes: 5xx/429/network retry, other 4xx permanent', async () => {
  assertEquals(
    (
      await deliverClose({
        url: 'https://e.com/h',
        secret: null,
        payload: {},
        fetchImpl: fake(503).impl,
      })
    ).kind,
    'retry'
  );
  assertEquals(
    (
      await deliverClose({
        url: 'https://e.com/h',
        secret: null,
        payload: {},
        fetchImpl: fake(429).impl,
      })
    ).kind,
    'retry'
  );
  assertEquals(
    (
      await deliverClose({
        url: 'https://e.com/h',
        secret: null,
        payload: {},
        fetchImpl: fake(404).impl,
      })
    ).kind,
    'permanent'
  );
  const boom = (() => Promise.reject(new Error('dns'))) as unknown as typeof fetch;
  assertEquals(
    (await deliverClose({ url: 'https://e.com/h', secret: null, payload: {}, fetchImpl: boom }))
      .kind,
    'retry'
  );
});

Deno.test(
  'connect/timeout failures return plain categories, never the raw error text',
  async () => {
    const raw = (() =>
      Promise.reject(
        new Error('tcp connect error: Connection refused (os error 111) 10.1.2.3:443')
      )) as unknown as typeof fetch;
    const refused = await deliverClose({
      url: 'https://e.com/h',
      secret: null,
      payload: {},
      fetchImpl: raw,
    });
    assertEquals(refused, { kind: 'retry', error: 'could not connect' });
    const slow = (() =>
      Promise.reject(
        new DOMException('signal timed out', 'TimeoutError')
      )) as unknown as typeof fetch;
    assertEquals(
      await deliverClose({ url: 'https://e.com/h', secret: null, payload: {}, fetchImpl: slow }),
      {
        kind: 'retry',
        error: 'timed out',
      }
    );
    assertEquals(
      await deliverClose({
        url: 'https://e.com/h',
        secret: null,
        payload: {},
        fetchImpl: fake(404).impl,
      }),
      { kind: 'permanent', error: 'rejected: HTTP 404' }
    );
  }
);

Deno.test(
  'address guard: private, loopback, link-local, CGNAT, ULA, multicast and mapped forms are blocked',
  () => {
    for (const bad of [
      '127.0.0.1',
      '127.8.8.8',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.255',
      '0.0.0.0',
      '0.1.2.3',
      '224.0.0.1',
      '239.255.255.255',
      '255.255.255.255',
      '240.0.0.1',
      '198.18.0.1',
      '192.0.2.1',
      '::',
      '::1',
      'fe80::1',
      'febf::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.1.2.3',
      '::ffff:169.254.169.254',
      '64:ff9b::7f00:1',
      '2002:7f00:1::1',
      '2001:db8::1',
      'not an address',
      '',
    ]) {
      assertEquals(isBlockedAddress(bad), true, bad);
    }
    for (const good of [
      '93.184.216.34',
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.255.255',
      '100.128.0.1',
      '169.253.0.1',
      '2606:2800:220:1:248:1893:25c8:1946',
      '2001:4860:4860::8888',
      '::ffff:8.8.8.8',
    ]) {
      assertEquals(isBlockedAddress(good), false, good);
    }
  }
);

Deno.test(
  'dns check: one private answer among public ones blocks; nothing resolving is transient',
  async () => {
    const mixed = await checkHostResolvesPublic('x.example.com', () =>
      Promise.resolve(['93.184.216.34', '127.0.0.1'])
    );
    assertEquals(mixed, {
      ok: false,
      kind: 'permanent',
      error: 'the host points at a private or internal address',
    });
    const none = await checkHostResolvesPublic('x.example.com', () => Promise.resolve([]));
    assertEquals(none, { ok: false, kind: 'retry', error: 'could not resolve the host' });
    const boom = await checkHostResolvesPublic('x.example.com', () =>
      Promise.reject(new Error('NXDOMAIN'))
    );
    assertEquals(boom, { ok: false, kind: 'retry', error: 'could not resolve the host' });
    assertEquals(await checkHostResolvesPublic('x.example.com', PUBLIC_IP), { ok: true });
  }
);

Deno.test('delivery to a host that resolves privately never calls fetch', async () => {
  const f = fake(200);
  const out = await realDeliverClose({
    url: 'https://sneaky.example.com/h',
    secret: null,
    payload: {},
    fetchImpl: f.impl,
    resolveHost: () => Promise.resolve(['169.254.169.254']),
  });
  assertEquals(out.kind, 'permanent');
  assertEquals(f.calls.length, 0);
  const unresolved = await realDeliverClose({
    url: 'https://sneaky.example.com/h',
    secret: null,
    payload: {},
    fetchImpl: f.impl,
    resolveHost: () => Promise.resolve([]),
  });
  assertEquals(unresolved.kind, 'retry');
  assertEquals(f.calls.length, 0);
});

Deno.test('a bad stored URL fails permanently without calling fetch', async () => {
  const f = fake(200);
  const out = await deliverClose({
    url: 'http://127.0.0.1/x',
    secret: null,
    payload: {},
    fetchImpl: f.impl,
  });
  assertEquals(out.kind, 'permanent');
  assertEquals(f.calls.length, 0);
});

Deno.test('retry schedule: backoff, then failed at the max attempt', () => {
  const now = Date.UTC(2026, 9, 27);
  const retry = { kind: 'retry', error: 'x' } as const;
  assertEquals(nextDeliveryState({ kind: 'sent' }, 1, now), {
    status: 'sent',
    nextAttemptAt: null,
  });
  assertEquals(nextDeliveryState(retry, 1, now), {
    status: 'pending',
    nextAttemptAt: new Date(now + 5 * 60_000).toISOString(),
  });
  assertEquals(nextDeliveryState(retry, 3, now), {
    status: 'pending',
    nextAttemptAt: new Date(now + 60 * 60_000).toISOString(),
  });
  assertEquals(nextDeliveryState(retry, CLOSE_MAX_ATTEMPTS - 1, now).status, 'pending');
  assertEquals(nextDeliveryState(retry, CLOSE_MAX_ATTEMPTS, now), {
    status: 'failed',
    nextAttemptAt: null,
  });
  assertEquals(nextDeliveryState({ kind: 'permanent', error: 'x' }, 1, now).status, 'failed');
});
