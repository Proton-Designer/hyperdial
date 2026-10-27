import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  CLOSE_MAX_ATTEMPTS,
  buildClosePayload,
  deliverClose,
  nextDeliveryState,
  signBody,
  validateWebhookUrl,
  type CloseRow,
} from './close-delivery.ts';

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

function fake(status: number, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status, headers }));
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

Deno.test('Apps Script 302 to script.googleusercontent.com counts as delivered', async () => {
  const f = fake(302, {
    location: 'https://script.googleusercontent.com/macros/echo?user_content_key=x',
  });
  const out = await deliverClose({
    url: 'https://script.google.com/macros/s/a/exec',
    secret: null,
    payload: {},
    fetchImpl: f.impl,
  });
  assertEquals(out.kind, 'sent');
  assertEquals(f.calls.length, 1); // the redirect target was never fetched
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
