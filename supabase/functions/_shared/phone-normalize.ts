/**
 * Strict E.164 phone normalization (TASK-P2-P1, design §7: "Numbers are normalized
 * to strict E.164 with libphonenumber-js; invalid ones are rejected at import with
 * a count.").
 *
 * Used by contacts-parse-csv (preview/validation) and contacts-import (the actual
 * write). Both call the same pure function so "invalid" means the same thing in
 * the preview and at import time.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'npm:libphonenumber-js';

export interface NormalizedPhone {
  /** Strict E.164, e.g. "+14155552671". This is what dialer-engine.ts dials as
   *  contacts.phone_number -- never change what that column holds without also
   *  changing the dial engine (out of this lane, see LANE-eng1.md). */
  e164: string;
  /** 3-digit NANP area code, only when the number is a 10-digit US/CA number.
   *  Null for anything else (short codes, non-NANP countries) -- timezone lookup
   *  has nothing to key off in that case. */
  areaCode: string | null;
}

const NANP_COUNTRIES: ReadonlySet<string> = new Set(['US', 'CA']);

/**
 * Returns null for anything libphonenumber-js can't parse as a valid number --
 * never throws. `defaultCountry` only matters for numbers with no country code
 * prefix (a bare 10-digit string is assumed domestic).
 */
export function normalizePhoneStrict(
  raw: string | null | undefined,
  defaultCountry: CountryCode = 'US'
): NormalizedPhone | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;

  const areaCode =
    parsed.country && NANP_COUNTRIES.has(parsed.country) && parsed.nationalNumber.length === 10
      ? parsed.nationalNumber.slice(0, 3)
      : null;

  return { e164: parsed.number, areaCode };
}
