/**
 * TASK-G30 (design: audit/G26/webhook-design.md): the pure parts of the GHL -> HyperDial webhook
 * (`ghl-webhook`). Authentication, payload parsing and the per-org secret, with no I/O, so it is
 * `deno test`-able. Every function here fails CLOSED: anything unexpected is a rejection, never a pass.
 *
 * Two ways in, both end in "trigger only": the endpoint never believes the payload, it re-reads the
 * contact from GHL and runs the same decision + apply path as the 5-minute sweep.
 *   A. Marketplace app: header `X-GHL-Signature`, Ed25519 over the request body, one key published by GHL.
 *   B. Workflow "Custom Webhook" (works with a Private Integration): header `X-HyperDial-Webhook-Secret`,
 *      a random per-org secret stored only as its SHA-256 hash.
 *
 * Sources (fetched 2026-10-19, never tested against a live GHL account):
 *  - https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide : `X-GHL-Signature` is Ed25519
 *    (the legacy RSA `X-WH-Signature` is deprecated since 1 Sep 2026 -> rejected here); the public key below.
 *  - https://marketplace.gohighlevel.com/docs/webhook/ContactDndUpdate, .../ContactTagUpdate,
 *    .../OpportunityStageUpdate, .../ContactUpdate : event types and payload fields used by parseGhlWebhookEvent.
 * UNVERIFIED: whether the signature covers the raw body bytes (the guide's sample verifies
 * JSON.stringify(req.body)). `signedPayload: 'raw'` is the default; `'json'` re-serialises and is switched on with
 * the GHL_WEBHOOK_SIGNED_PAYLOAD=json secret if the live test shows GHL signs that. Never both at once.
 */
import type { VerifyResult } from './webhook-verify.ts';

/** GHL's published Ed25519 public key, SPKI DER, base64 (the PEM body from the Webhook Integration Guide).
 *  Overridable with the GHL_WEBHOOK_PUBLIC_KEY secret so a key rotation needs no deploy. */
export const GHL_WEBHOOK_PUBLIC_KEY_SPKI_B64 =
  'MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=';

/** Header carrying a Marketplace-app signature. */
export const GHL_SIGNATURE_HEADER = 'x-ghl-signature';
/** Legacy RSA header: seeing only this is a rejection (deprecated by GHL, we never verify it). */
export const GHL_LEGACY_SIGNATURE_HEADER = 'x-wh-signature';
/** Header carrying the workflow-webhook secret. */
export const GHL_SECRET_HEADER = 'x-hyperdial-webhook-secret';

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

const SIGNATURE_BYTES = 64;
const SPKI_ED25519_BYTES = 44;

function decodeBase64(value: string): Uint8Array | null {
  const v = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v) || v.length % 4 !== 0) return null;
  try {
    const bin = atob(v);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export interface VerifyGhlSignatureArgs {
  rawBody: string;
  signatureB64: string | null | undefined;
  /** SPKI DER, base64. Defaults to the pinned GHL key. */
  publicKeySpkiB64?: string | null;
  /** What the signature covers. Default 'raw' (the body as received). */
  signedPayload?: 'raw' | 'json';
}

/** Verifies `X-GHL-Signature`. Every failure is `{ok:false, reason}`; there is no fail-open branch. */
export async function verifyGhlSignature(args: VerifyGhlSignatureArgs): Promise<VerifyResult> {
  if (!args.signatureB64) return { ok: false, reason: 'missing_signature' };
  const signature = decodeBase64(args.signatureB64);
  if (!signature || signature.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: 'invalid_signature_encoding' };
  }
  const spki = decodeBase64(args.publicKeySpkiB64 || GHL_WEBHOOK_PUBLIC_KEY_SPKI_B64);
  if (!spki || spki.length !== SPKI_ED25519_BYTES) {
    return { ok: false, reason: 'invalid_public_key_encoding' };
  }
  let payload = args.rawBody;
  if (args.signedPayload === 'json') {
    try {
      payload = JSON.stringify(JSON.parse(args.rawBody));
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
  }
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      spki as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'Ed25519',
      key,
      signature as BufferSource,
      new TextEncoder().encode(payload) as BufferSource
    );
    return valid ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
  } catch (err) {
    return {
      ok: false,
      reason: `verification_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---- per-org secret (workflow webhook) ---------------------------------------------------------

const SECRET_PREFIX = 'hdwh_';
const SECRET_RE = /^hdwh_[A-Za-z0-9_-]{43}$/;

/** `hdwh_` + 32 random bytes as base64url (43 chars). Shown to the admin once, stored only hashed. */
export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return SECRET_PREFIX + b64url;
}

/** Cheap shape check before hashing / touching the database. */
export function isWellFormedWebhookSecret(secret: string | null | undefined): secret is string {
  return typeof secret === 'string' && SECRET_RE.test(secret);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- payload -----------------------------------------------------------------------------------

/** Event types the Marketplace path acts on. `ContactUpdate` is the only candidate for an owner change. */
export const SUPPORTED_GHL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'ContactDndUpdate',
  'ContactTagUpdate',
  'ContactUpdate',
  'OpportunityStageUpdate',
  'OpportunityAssignedToUpdate',
]);

export interface GhlWebhookEvent {
  /** `type` of a Marketplace event; null for a workflow Custom Webhook (user-defined body). */
  type: string | null;
  locationId: string | null;
  /** The GHL contact to re-read; null when the payload carries none. */
  contactId: string | null;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function asId(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Pulls `{type, locationId, contactId}` out of a Marketplace event or a workflow Custom Webhook body.
 *  Ids must be plain GHL ids (letters, digits, `-`, `_`); anything else is treated as absent. */
export function parseGhlWebhookEvent(
  rawBody: string
): { ok: true; event: GhlWebhookEvent } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const o = asObj(json);
  if (!o) return { ok: false, reason: 'not_an_object' };
  const type = typeof o.type === 'string' && o.type.length <= 80 ? o.type : null;
  const location = asObj(o.location);
  const contact = asObj(o.contact);
  const locationId = asId(o.locationId) ?? asId(o.location_id) ?? asId(location?.id);
  // Opportunity events carry the contact in `contactId`; contact events carry it in `id`.
  const contactId =
    type?.startsWith('Opportunity') === true
      ? (asId(o.contactId) ?? asId(o.contact_id) ?? asId(contact?.id))
      : (asId(o.id) ?? asId(o.contactId) ?? asId(o.contact_id) ?? asId(contact?.id));
  return { ok: true, event: { type, locationId, contactId } };
}

/** Reads a request body as text, stopping as soon as more than `maxBytes` have arrived (so a chunked or lying
 *  Content-Length body is never buffered in full before auth). Returns null when the limit was exceeded. */
export async function readBodyCapped(
  req: { body: ReadableStream<Uint8Array> | null },
  maxBytes: number
): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
