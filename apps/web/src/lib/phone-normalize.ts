/**
 * Client-side mirror of supabase/functions/_shared/phone-normalize.ts (TASK-P2-P1, design
 * §7: strict E.164 via libphonenumber-js). Duplicated deliberately, not imported: the Deno
 * copy uses an `npm:libphonenumber-js` specifier that only resolves inside Supabase Edge
 * Functions, and Vite needs the plain package import instead. Keep the two in sync by hand
 * if the normalization rule ever changes -- see .brain/domains/contacts.md.
 *
 * Used by createContact/updateContact (api.ts) and AddContactModal's inline validation, so
 * a contact added or edited from the UI gets the same strict validation contacts-import
 * already applies to a CSV row.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export interface NormalizedPhone {
  e164: string;
  areaCode: string | null;
}

const NANP_COUNTRIES: ReadonlySet<string> = new Set(['US', 'CA']);

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
