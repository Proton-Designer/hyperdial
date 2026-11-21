/**
 * Ed25519 verification for Telnyx webhooks (fails closed on every branch).
 *
 * Header names (`telnyx-signature-ed25519`, `telnyx-timestamp`), the signed-payload
 * format `${timestamp}|${rawBody}`, and the encodings (signature = base64 of 64 raw
 * bytes, public key = base64 of 32 raw bytes, both from Telnyx Mission Control) were
 * verified 2026-09-23 against:
 *   - https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks.md
 *     (header names, portal location of the public key)
 *   - https://raw.githubusercontent.com/team-telnyx/telnyx-node/master/src/lib/webhooks.ts
 *     (Telnyx's own Node SDK — the byte-level format the docs page doesn't spell out)
 * `crypto.subtle.importKey('raw', ..., {name:'Ed25519'}, false, ['verify'])` was
 * smoke-tested against Deno 2.9.5 directly (generate/sign/export-raw/import-raw/verify
 * round trip) before relying on it here.
 *
 * NEEDS-LIVE-VERIFY: this has been checked against Telnyx's published SDK source and
 * against Deno's own Ed25519 implementation, but never against a real signed webhook
 * from a live Telnyx account.
 */

const DEFAULT_TOLERANCE_SEC = 300;
const SIGNATURE_BYTES = 64;
const PUBLIC_KEY_BYTES = 32;

export interface VerifyTelnyxSignatureArgs {
  rawBody: string;
  signatureB64: string | null | undefined;
  timestamp: string | null | undefined;
  publicKeyB64: string | null | undefined;
  /** Unix seconds. Defaults to the real clock; pass a fixed value in tests. */
  now?: number;
  /** Replay window, in seconds. Defaults to 300 (design §3). */
  toleranceSec?: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

function decodeBase64Strict(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Verifies a Telnyx `telnyx-signature-ed25519` header against the org's stored
 * public key. Every failure mode returns `{ok: false, reason}` rather than
 * throwing or defaulting to true — there is no fail-open path.
 */
export async function verifyTelnyxSignature(
  args: VerifyTelnyxSignatureArgs
): Promise<VerifyResult> {
  const { rawBody, signatureB64, timestamp, publicKeyB64 } = args;
  const tolerance = args.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = args.now ?? Math.floor(Date.now() / 1000);

  if (!timestamp) return { ok: false, reason: 'missing_timestamp' };
  if (!signatureB64) return { ok: false, reason: 'missing_signature' };
  if (!publicKeyB64) return { ok: false, reason: 'missing_public_key' };

  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'invalid_timestamp_format' };
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts)) return { ok: false, reason: 'invalid_timestamp_format' };
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const signature = decodeBase64Strict(signatureB64);
  if (!signature || signature.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: 'invalid_signature_encoding' };
  }

  const publicKey = decodeBase64Strict(publicKeyB64);
  if (!publicKey || publicKey.length !== PUBLIC_KEY_BYTES) {
    return { ok: false, reason: 'invalid_public_key_encoding' };
  }

  const signedPayload = new TextEncoder().encode(`${timestamp}|${rawBody}`);

  try {
    // Deno's DOM lib types don't carry an Ed25519 overload for importKey/verify,
    // so the BufferSource params need an explicit cast; verified functionally
    // against Deno 2.9.5's actual Ed25519 implementation (see file header).
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'Ed25519',
      key,
      signature as BufferSource,
      signedPayload as BufferSource
    );
    return valid ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
  } catch (err) {
    return {
      ok: false,
      reason: `verification_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
