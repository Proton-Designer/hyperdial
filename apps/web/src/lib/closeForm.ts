/** TASK-H03: pure helpers for the Log Close form (kept out of the component so they stay easy to reason about). */

const STATE_ZIP = /^[A-Za-z]{2}(\s+\d{5}(-\d{4})?)?$/;

/**
 * Best-effort city from a free-text address ("12 Main St, Austin, TX 78701" -> "Austin"). Never throws,
 * returns null when unsure -- the field is editable and never blocks submit.
 */
export function cityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const candidate = STATE_ZIP.test(last) ? parts[parts.length - 2] : null;
  if (!candidate || candidate.length > 60 || /\d/.test(candidate)) return null;
  return candidate;
}

/** The city to prefill: the canonical column first (TASK-H01), then the address parse. */
export function prefillCity(city: string | null, address: string | null): string | null {
  const c = city?.trim();
  return c ? c : cityFromAddress(address);
}

/** Adds `raw` (comma-separated allowed) to `list`: trimmed, case-insensitive de-dupe, 80 chars max, 30 items max. */
export function addCities(list: string[], raw: string): string[] {
  const out = [...list];
  for (const piece of raw.split(',')) {
    const v = piece.trim().replace(/\s+/g, ' ');
    if (!v || v.length > 80 || out.length >= 30) continue;
    if (out.some((x) => x.toLowerCase() === v.toLowerCase())) continue;
    out.push(v);
  }
  return out;
}

/** Client-side mirror of the RPC's phone rule: 10 digits (US) or 11-15 digits. */
export function isPlausibleMobile(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 || (digits.length >= 11 && digits.length <= 15);
}

/** '' -> null, otherwise a finite number (or NaN-safe undefined when it is not numeric). */
export function parseOptionalNumber(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const EMAIL_LIKE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function looksLikeEmail(raw: string): boolean {
  return EMAIL_LIKE.test(raw.trim());
}

/** Phone-shaped: at least 7 digits and nothing but digits and phone punctuation. */
function looksLikePhone(raw: string): boolean {
  const t = raw.trim();
  return /^[+\d\s().\-x#]+$/i.test(t) && t.replace(/\D/g, '').length >= 7;
}

function looksLikeUrl(raw: string): boolean {
  const t = raw.trim();
  return /^(https?:\/\/|www\.)/i.test(t) || (/^\S+\.[a-z]{2,}(\/\S*)?$/i.test(t) && !/\s/.test(t));
}

/**
 * `contacts.owner_contact` is a free "Owner / email" column: it holds a person's name, an email address or a phone number.
 * Only a name may prefill "Owner name"; an email goes to the Email field (owner name left empty for the intern to fill),
 * a phone or URL is not used at all. Only when the column is empty does it fall back to the first/last name.
 */
export function splitOwnerContact(
  ownerContact: string | null | undefined,
  personName: string | null | undefined
): { ownerName: string | null; email: string | null } {
  const raw = ownerContact?.trim() ?? '';
  if (!raw) return { ownerName: personName?.trim() || null, email: null };
  if (looksLikeEmail(raw)) return { ownerName: null, email: raw };
  if (looksLikePhone(raw) || looksLikeUrl(raw)) return { ownerName: null, email: null };
  return { ownerName: raw, email: null };
}
