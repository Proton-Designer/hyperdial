/**
 * TASK-H29: pure helpers for the PUBLIC pro-application endpoint (no login). Everything a visitor sends is untrusted:
 * this file parses and shape-checks it, the database (submit_pro_application) validates the values and rate-limits.
 * Kept free of I/O so it is unit-testable.
 */

/** Tokens are 64 lowercase hex chars (two gen_random_uuid(), dashes removed). Anything else is a 404 without a DB call. */
export const PRO_TOKEN_RE = /^[0-9a-f]{64}$/;
/** The form is a few hundred bytes; refuse anything bigger before parsing. */
export const MAX_BODY_BYTES = 20_000;
/** Honeypot: a field real people never see. Any non-empty value gets a fake success and no database call. */
export const HONEYPOT_FIELD = 'hd_chk';

export interface ProApplicationInput {
  token: string;
  ownerName: string;
  businessName: string;
  mobile: string;
  email: string | null;
  services: string[];
  cities: string[];
  frequencies: string[];
  insured: boolean | null;
  bestContact: string | null;
  startingPrice: number | null;
  capacity: number | null;
  yearsInBusiness: number | null;
}

export type ParsedBody =
  | { kind: 'honeypot' }
  | { kind: 'bad'; error: string }
  | { kind: 'ok'; input: ProApplicationInput };

const MAX_LIST_ITEMS = 60; // the database allows 10 / 30; this only bounds what is sent to it

function text(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined; // wrong type
  return v.length > max ? undefined : v;
}

function list(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_LIST_ITEMS) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || x.length > 200) return undefined;
    out.push(x);
  }
  return out;
}

function num(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Shape check of the POST body. Value rules (required fields, ranges, formats) live in the database function. */
export function parseProApplicationBody(raw: unknown): ParsedBody {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'bad', error: 'Invalid request' };
  }
  const b = raw as Record<string, unknown>;
  const trap = b[HONEYPOT_FIELD];
  if (typeof trap === 'string' ? trap.trim() !== '' : trap !== undefined && trap !== null) {
    return { kind: 'honeypot' };
  }
  const token = typeof b.token === 'string' ? b.token : '';
  const ownerName = text(b.ownerName, 400);
  const businessName = text(b.businessName, 400);
  const mobile = text(b.mobile, 60);
  const email = text(b.email, 400);
  const bestContact = text(b.bestContact, 1000);
  const services = list(b.services);
  const cities = list(b.cities);
  const frequencies = list(b.frequencies);
  const price = num(b.startingPrice);
  const capacity = num(b.capacity);
  const years = num(b.yearsInBusiness);
  if (
    ownerName === undefined ||
    businessName === undefined ||
    mobile === undefined ||
    email === undefined ||
    bestContact === undefined ||
    !services ||
    !cities ||
    !frequencies ||
    price === undefined ||
    capacity === undefined ||
    years === undefined
  ) {
    return { kind: 'bad', error: 'Some answers are not in the expected format' };
  }
  if (b.insured !== undefined && b.insured !== null && typeof b.insured !== 'boolean') {
    return { kind: 'bad', error: 'Some answers are not in the expected format' };
  }
  if (capacity !== null && !Number.isInteger(capacity)) {
    return { kind: 'bad', error: 'Capacity must be a whole number' };
  }
  if (years !== null && !Number.isInteger(years)) {
    return { kind: 'bad', error: 'Years in business must be a whole number' };
  }
  return {
    kind: 'ok',
    input: {
      token,
      ownerName: ownerName ?? '',
      businessName: businessName ?? '',
      mobile: mobile ?? '',
      email,
      services,
      cities,
      frequencies,
      insured: typeof b.insured === 'boolean' ? b.insured : null,
      bestContact,
      startingPrice: price,
      capacity,
      yearsInBusiness: years,
    },
  };
}

/** The caller's address as the platform's edge proxy reports it; 'unknown' still gets rate limited as one bucket. */
export function clientIp(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return xff || 'unknown';
}

/** HMAC-SHA256(salt, ip) as hex. Only this hash is ever stored; the raw address is never written anywhere. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type SubmitStatus = 'ok' | 'not_found' | 'rate_limited' | 'invalid';

/** The one place an RPC status becomes an HTTP answer. Nothing from the database is returned except the readable validation message. */
export function submitResponse(
  status: string | undefined,
  message: string | null | undefined
): { status: number; body: Record<string, unknown> } {
  switch (status) {
    case 'ok':
      return { status: 200, body: { ok: true } };
    case 'not_found':
      return { status: 404, body: { error: 'Not found' } };
    case 'rate_limited':
      return { status: 429, body: { error: 'Too many submissions. Please try again later.' } };
    case 'invalid':
      return { status: 400, body: { error: message || 'Please check your answers' } };
    default:
      return { status: 500, body: { error: 'Could not save your answers' } };
  }
}
