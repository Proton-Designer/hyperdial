import { assertEquals } from 'jsr:@std/assert@1';
import { readJsonBody } from './http-json.ts';

Deno.test('readJsonBody: valid JSON body is parsed and returned', async () => {
  const req = new Request('http://localhost/fn', {
    method: 'POST',
    body: JSON.stringify({ campaignId: 'abc' }),
  });
  const result = await readJsonBody<{ campaignId: string }>(req);
  assertEquals(result.errorResponse, undefined);
  assertEquals(result.body?.campaignId, 'abc');
});

Deno.test(
  'readJsonBody: malformed JSON body returns a 400 Response, not a thrown SyntaxError',
  async () => {
    const req = new Request('http://localhost/fn', {
      method: 'POST',
      body: 'not-json{{{',
    });
    const result = await readJsonBody<{ campaignId: string }>(req);
    assertEquals(result.body, undefined);
    const res = result.errorResponse!;
    assertEquals(res.status, 400);
    const payload = await res.json();
    assertEquals(payload, { error: 'Invalid JSON body' });
  }
);

Deno.test('readJsonBody: empty body returns a 400 Response', async () => {
  const req = new Request('http://localhost/fn', { method: 'POST', body: '' });
  const result = await readJsonBody<Record<string, never>>(req);
  assertEquals(result.body, undefined);
  assertEquals(result.errorResponse!.status, 400);
});
