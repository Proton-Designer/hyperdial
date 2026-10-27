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
