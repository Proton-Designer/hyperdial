import { assertEquals } from 'jsr:@std/assert@1';
import { normalizePhoneStrict } from './phone-normalize.ts';

// ---------------------------------------------------------------------------
// Positive control: a real, valid NANP number with a NANP-style area code.
// ---------------------------------------------------------------------------

Deno.test('normalizePhoneStrict: valid 10-digit US number -> E.164 + area code', () => {
  assertEquals(normalizePhoneStrict('415-555-2671'), {
    e164: '+14155552671',
    areaCode: '415',
  });
});

Deno.test('normalizePhoneStrict: already-E.164 input round-trips', () => {
  assertEquals(normalizePhoneStrict('+14155552671'), {
    e164: '+14155552671',
    areaCode: '415',
  });
});

Deno.test('normalizePhoneStrict: formatting noise (parens, dots, spaces) is stripped', () => {
  assertEquals(normalizePhoneStrict('(415) 555.2671'), {
    e164: '+14155552671',
    areaCode: '415',
  });
});

Deno.test('normalizePhoneStrict: leading country-code "1" is accepted', () => {
  assertEquals(normalizePhoneStrict('1-415-555-2671'), {
    e164: '+14155552671',
    areaCode: '415',
  });
});

// ---------------------------------------------------------------------------
// Invalid numbers are rejected (null), not coerced.
// ---------------------------------------------------------------------------

Deno.test('normalizePhoneStrict: too few digits -> null', () => {
  assertEquals(normalizePhoneStrict('555-2671'), null);
});

Deno.test('normalizePhoneStrict: not-a-real-NANP-number -> null', () => {
  // Area code 000 is not assigned; libphonenumber-js rejects it as invalid.
  assertEquals(normalizePhoneStrict('000-555-2671'), null);
});

Deno.test('normalizePhoneStrict: letters in the input -> null', () => {
  assertEquals(normalizePhoneStrict('1-800-CALL-NOW'), null);
});

Deno.test('normalizePhoneStrict: empty/whitespace/null/undefined -> null', () => {
  assertEquals(normalizePhoneStrict(''), null);
  assertEquals(normalizePhoneStrict('   '), null);
  assertEquals(normalizePhoneStrict(null), null);
  assertEquals(normalizePhoneStrict(undefined), null);
});

// ---------------------------------------------------------------------------
// Non-NANP numbers: still validated, but no area code (nothing to key a
// timezone lookup off).
// ---------------------------------------------------------------------------

Deno.test('normalizePhoneStrict: valid non-NANP number has a null area code', () => {
  const result = normalizePhoneStrict('+442071838750');
  assertEquals(result?.areaCode, null);
  assertEquals(result?.e164, '+442071838750');
});

Deno.test(
  'normalizePhoneStrict: a toll-free-pattern NANP number has an area code (833 is a real NANP code)',
  () => {
    // 833 is an assigned NANP toll-free code -- it's still a syntactically valid
    // 10-digit NANP number, just not one area-code-tz.ts maps to a timezone.
    const result = normalizePhoneStrict('833-555-0100');
    assertEquals(result?.areaCode, '833');
  }
);
