import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import {
  GHL_WEBHOOK_PUBLIC_KEY_SPKI_B64,
  generateWebhookSecret,
  isWellFormedWebhookSecret,
  parseGhlWebhookEvent,
  sha256Hex,
  verifyGhlSignature,
} from './ghl-webhook.ts';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function makeKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { priv: pair.privateKey, spkiB64: b64(spki) };
}

async function sign(priv: CryptoKey, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', priv, new TextEncoder().encode(payload));
  return b64(new Uint8Array(sig));
}

const BODY = '{"type":"ContactDndUpdate","id":"c1","locationId":"loc1"}';

Deno.test('verifyGhlSignature: a good signature passes (positive control)', async () => {
  const k = await makeKey();
  const r = await verifyGhlSignature({
    rawBody: BODY,
    signatureB64: await sign(k.priv, BODY),
    publicKeySpkiB64: k.spkiB64,
  });
  assertEquals(r, { ok: true });
});

Deno.test('verifyGhlSignature: a tampered body fails', async () => {
  const k = await makeKey();
  const sig = await sign(k.priv, BODY);
  const r = await verifyGhlSignature({
    rawBody: BODY.replace('c1', 'c2'),
    signatureB64: sig,
    publicKeySpkiB64: k.spkiB64,
  });
  assertEquals(r.ok, false);
  assertEquals(r.reason, 'signature_mismatch');
});

Deno.test('verifyGhlSignature: a signature from another key fails', async () => {
  const signer = await makeKey();
  const other = await makeKey();
  const r = await verifyGhlSignature({
    rawBody: BODY,
    signatureB64: await sign(signer.priv, BODY),
    publicKeySpkiB64: other.spkiB64,
  });
  assertEquals(r.ok, false);
  assertEquals(r.reason, 'signature_mismatch');
});

Deno.test(
  'verifyGhlSignature: the pinned GHL key rejects a signature made with our own key',
  async () => {
    const k = await makeKey();
    const r = await verifyGhlSignature({ rawBody: BODY, signatureB64: await sign(k.priv, BODY) });
    assertEquals(r.ok, false);
  }
);

Deno.test('verifyGhlSignature: the pinned key is a valid 44-byte Ed25519 SPKI', async () => {
  const r = await verifyGhlSignature({
    rawBody: BODY,
    signatureB64: b64(new Uint8Array(64)),
    publicKeySpkiB64: GHL_WEBHOOK_PUBLIC_KEY_SPKI_B64,
  });
  // imports fine, the all-zero signature simply does not verify
  assertEquals(r.reason, 'signature_mismatch');
});

Deno.test('verifyGhlSignature: missing / malformed signature and key fail closed', async () => {
  const k = await makeKey();
  for (const sig of [undefined, null, '', 'not base64!!', b64(new Uint8Array(10))]) {
    const r = await verifyGhlSignature({
      rawBody: BODY,
      signatureB64: sig,
      publicKeySpkiB64: k.spkiB64,
    });
    assertEquals(r.ok, false, `signature ${String(sig)}`);
  }
  const r = await verifyGhlSignature({
    rawBody: BODY,
    signatureB64: b64(new Uint8Array(64)),
    publicKeySpkiB64: 'AAAA',
  });
  assertEquals(r.reason, 'invalid_public_key_encoding');
});

Deno.test(
  'verifyGhlSignature: json mode verifies the re-serialised body, raw mode does not',
  async () => {
    const k = await makeKey();
    const pretty = '{ "type": "ContactDndUpdate",  "id": "c1" }';
    const compact = JSON.stringify(JSON.parse(pretty));
    const sig = await sign(k.priv, compact);
    const json = await verifyGhlSignature({
      rawBody: pretty,
      signatureB64: sig,
      publicKeySpkiB64: k.spkiB64,
      signedPayload: 'json',
    });
    assertEquals(json.ok, true);
    const raw = await verifyGhlSignature({
      rawBody: pretty,
      signatureB64: sig,
      publicKeySpkiB64: k.spkiB64,
    });
    assertEquals(raw.ok, false);
  }
);

Deno.test('webhook secret: generated shape, uniqueness, hash', async () => {
  const a = generateWebhookSecret();
  const b = generateWebhookSecret();
  assert(isWellFormedWebhookSecret(a));
  assertNotEquals(a, b);
  assertEquals((await sha256Hex(a)).length, 64);
  assertEquals(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

Deno.test('webhook secret: malformed values are rejected before any lookup', () => {
  for (const s of [undefined, null, '', 'hdwh_short', 'x'.repeat(48), `hdwh_${'a'.repeat(44)}`]) {
    assertEquals(isWellFormedWebhookSecret(s as string | null | undefined), false, String(s));
  }
  assert(isWellFormedWebhookSecret(`hdwh_${'a'.repeat(43)}`));
});

Deno.test('parseGhlWebhookEvent: marketplace contact event', () => {
  const r = parseGhlWebhookEvent(BODY);
  assert(r.ok);
  assertEquals(r.event, { type: 'ContactDndUpdate', locationId: 'loc1', contactId: 'c1' });
});

Deno.test('parseGhlWebhookEvent: opportunity event takes contactId, not the opportunity id', () => {
  const r = parseGhlWebhookEvent(
    '{"type":"OpportunityStageUpdate","id":"opp9","contactId":"c7","locationId":"loc1"}'
  );
  assert(r.ok);
  assertEquals(r.event.contactId, 'c7');
});

Deno.test('parseGhlWebhookEvent: workflow custom-webhook body (no type)', () => {
  const r = parseGhlWebhookEvent('{"contact_id":"c3","location":{"id":"loc2"}}');
  assert(r.ok);
  assertEquals(r.event, { type: null, locationId: 'loc2', contactId: 'c3' });
});

Deno.test('parseGhlWebhookEvent: bad JSON, non-object and unsafe ids', () => {
  assertEquals(parseGhlWebhookEvent('not json').ok, false);
  assertEquals(parseGhlWebhookEvent('[1,2]').ok, false);
  const r = parseGhlWebhookEvent('{"type":"ContactUpdate","id":"../x?y","locationId":"a b"}');
  assert(r.ok);
  assertEquals(r.event.contactId, null);
  assertEquals(r.event.locationId, null);
});
