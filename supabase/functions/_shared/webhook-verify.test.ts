import { assertEquals } from 'jsr:@std/assert@1';
import { verifyTelnyxSignature } from './webhook-verify.ts';

const NOW = 1_700_000_000;

async function makeKeyPair(): Promise<CryptoKeyPair> {
  // Cast needed: Deno's DOM lib types have no Ed25519 overload for generateKey.
  return (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

async function exportPublicKeyB64(publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

async function signB64(privateKey: CryptoKey, timestamp: string, rawBody: string): Promise<string> {
  const payload = new TextEncoder().encode(`${timestamp}|${rawBody}`);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, payload as BufferSource);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

Deno.test('verifyTelnyxSignature: positive control — valid signature passes', async () => {
  const { privateKey, publicKey } = await makeKeyPair();
  const publicKeyB64 = await exportPublicKeyB64(publicKey);
  const rawBody = '{"data":{"event_type":"call.answered"}}';
  const timestamp = String(NOW);
  const signatureB64 = await signB64(privateKey, timestamp, rawBody);

  const result = await verifyTelnyxSignature({
    rawBody,
    signatureB64,
    timestamp,
    publicKeyB64,
    now: NOW,
  });
  assertEquals(result, { ok: true });
});

Deno.test('verifyTelnyxSignature: tampered body fails', async () => {
  const { privateKey, publicKey } = await makeKeyPair();
  const publicKeyB64 = await exportPublicKeyB64(publicKey);
  const rawBody = '{"data":{"event_type":"call.answered"}}';
  const timestamp = String(NOW);
  const signatureB64 = await signB64(privateKey, timestamp, rawBody);

  const result = await verifyTelnyxSignature({
    rawBody: '{"data":{"event_type":"call.hangup"}}',
    signatureB64,
    timestamp,
    publicKeyB64,
    now: NOW,
  });
  assertEquals(result.ok, false);
  assertEquals(result.reason, 'signature_mismatch');
});

Deno.test('verifyTelnyxSignature: wrong key fails', async () => {
  const { privateKey } = await makeKeyPair();
  const { publicKey: otherPublicKey } = await makeKeyPair();
  const wrongPublicKeyB64 = await exportPublicKeyB64(otherPublicKey);
  const rawBody = '{"data":{}}';
  const timestamp = String(NOW);
  const signatureB64 = await signB64(privateKey, timestamp, rawBody);

  const result = await verifyTelnyxSignature({
    rawBody,
    signatureB64,
    timestamp,
    publicKeyB64: wrongPublicKeyB64,
    now: NOW,
  });
  assertEquals(result.ok, false);
  assertEquals(result.reason, 'signature_mismatch');
});

Deno.test('verifyTelnyxSignature: stale timestamp (outside 300s tolerance) fails', async () => {
  const { privateKey, publicKey } = await makeKeyPair();
  const publicKeyB64 = await exportPublicKeyB64(publicKey);
  const rawBody = '{"data":{}}';
  const staleTimestamp = String(NOW - 301);
  const signatureB64 = await signB64(privateKey, staleTimestamp, rawBody);

  const result = await verifyTelnyxSignature({
    rawBody,
    signatureB64,
    timestamp: staleTimestamp,
    publicKeyB64,
    now: NOW,
  });
  assertEquals(result, { ok: false, reason: 'timestamp_out_of_tolerance' });
});

Deno.test('verifyTelnyxSignature: timestamp 300s old (inclusive boundary) passes', async () => {
  const { privateKey, publicKey } = await makeKeyPair();
  const publicKeyB64 = await exportPublicKeyB64(publicKey);
  const rawBody = '{"data":{}}';
  const boundaryTimestamp = String(NOW - 300);
  const signatureB64 = await signB64(privateKey, boundaryTimestamp, rawBody);

  const result = await verifyTelnyxSignature({
    rawBody,
    signatureB64,
    timestamp: boundaryTimestamp,
    publicKeyB64,
    now: NOW,
  });
  assertEquals(result, { ok: true });
});

Deno.test('verifyTelnyxSignature: missing signature header fails closed', async () => {
  const result = await verifyTelnyxSignature({
    rawBody: '{}',
    signatureB64: undefined,
    timestamp: String(NOW),
    publicKeyB64: 'eu2zvPjhY6odxV34Z/EsRiERvTodkev4Fq0SlK90Izg=',
    now: NOW,
  });
  assertEquals(result, { ok: false, reason: 'missing_signature' });
});

Deno.test('verifyTelnyxSignature: missing timestamp header fails closed', async () => {
  const result = await verifyTelnyxSignature({
    rawBody: '{}',
    signatureB64: 'YWJjZA==',
    timestamp: null,
    publicKeyB64: 'eu2zvPjhY6odxV34Z/EsRiERvTodkev4Fq0SlK90Izg=',
    now: NOW,
  });
  assertEquals(result, { ok: false, reason: 'missing_timestamp' });
});

Deno.test('verifyTelnyxSignature: missing public key fails closed', async () => {
  const result = await verifyTelnyxSignature({
    rawBody: '{}',
    signatureB64: 'YWJjZA==',
    timestamp: String(NOW),
    publicKeyB64: undefined,
    now: NOW,
  });
  assertEquals(result, { ok: false, reason: 'missing_public_key' });
});

Deno.test(
  'verifyTelnyxSignature: unset secret is not a fail-open path (no such branch exists)',
  async () => {
    // Regression guard for known-issues #0: there is no code path here that returns
    // ok:true because a secret/key was absent — every "missing" case above returns false.
    const result = await verifyTelnyxSignature({
      rawBody: '{}',
      signatureB64: null,
      timestamp: null,
      publicKeyB64: null,
      now: NOW,
    });
    assertEquals(result.ok, false);
  }
);

Deno.test('verifyTelnyxSignature: malformed base64 signature fails closed', async () => {
  const { publicKey } = await makeKeyPair();
  const publicKeyB64 = await exportPublicKeyB64(publicKey);
  const result = await verifyTelnyxSignature({
    rawBody: '{}',
    signatureB64: 'not-valid-base64!!',
    timestamp: String(NOW),
    publicKeyB64,
    now: NOW,
  });
  assertEquals(result, { ok: false, reason: 'invalid_signature_encoding' });
});

Deno.test('verifyTelnyxSignature: non-numeric timestamp fails closed', async () => {
  const { publicKey } = await makeKeyPair();
  const publicKeyB64 = await exportPublicKeyB64(publicKey);
  const result = await verifyTelnyxSignature({
    rawBody: '{}',
    signatureB64: 'YWJjZA==',
    timestamp: 'not-a-number',
    publicKeyB64,
    now: NOW,
  });
  assertEquals(result, { ok: false, reason: 'invalid_timestamp_format' });
});
