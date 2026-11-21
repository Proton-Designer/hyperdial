import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import {
  MAX_CUSTOM_FIELDS_PER_ORG,
  MAX_CUSTOM_VALUE_LENGTH,
  normalizeCustomValue,
  planCustomFields,
  slugifyHeader,
} from './custom-fields.ts';

Deno.test(
  'slugifyHeader: lowercases, collapses symbols, prefixes digit starts, never empty',
  () => {
    assertEquals(slugifyHeader('  Years in Business? '), 'years_in_business');
    assertEquals(slugifyHeader('2024 Revenue'), 'f_2024_revenue');
    assertEquals(slugifyHeader('Año de fundación'), 'ano_de_fundacion');
    assertEquals(slugifyHeader('x'.repeat(100)).length, 40);
  }
);

Deno.test(
  'planCustomFields: same header twice, or an existing def, is one field (idempotent)',
  () => {
    const plan = planCustomFields({
      headers: ['Insured', 'Insured', 'Tier'],
      existingKeys: ['tier'],
    });
    assertEquals(plan.newDefs, [{ key: 'insured', label: 'Insured' }]);
    assertEquals(plan.keyByHeader.get('Tier'), 'tier');
    assertEquals(plan.keyByHeader.get('Insured'), 'insured');
  }
);

Deno.test(
  'slugifyHeader: non-Latin / symbol-only headers get a stable hashed key, never a positional one',
  () => {
    const key = slugifyHeader('رقم الهاتف');
    assertEquals(key, slugifyHeader('  رقم   الهاتف '), 'whitespace-insensitive and stable');
    assertEquals(/^field_[0-9a-f]{8}$/.test(key), true);
    assertEquals(/^[a-z][a-z0-9_]{0,39}$/.test(slugifyHeader('城市')), true);
    assertNotEquals(slugifyHeader('城市'), slugifyHeader('省份'));
    assertNotEquals(slugifyHeader('???'), slugifyHeader('###'));
    // mixed: the Latin part is kept readable, the CJK part still distinguishes it from the plain header
    assertEquals(slugifyHeader('Ciudad 城市').startsWith('ciudad_'), true);
    assertNotEquals(slugifyHeader('Ciudad 城市'), slugifyHeader('Ciudad'));
    assertEquals(slugifyHeader('Ciudad'), 'ciudad');
  }
);

Deno.test(
  'planCustomFields: non-Latin headers map to the same key whatever the column order or file',
  () => {
    const first = planCustomFields({ headers: ['رقم', 'اسم'], existingKeys: [] });
    const later = planCustomFields({
      headers: ['اسم'],
      existingKeys: first.newDefs.map((d) => d.key),
    });
    assertEquals(later.keyByHeader.get('اسم'), first.keyByHeader.get('اسم'));
    assertEquals(later.newDefs, []);
    assertNotEquals(first.keyByHeader.get('رقم'), first.keyByHeader.get('اسم'));
  }
);

Deno.test('planCustomFields: two different headers with one slug stay two fields', () => {
  const plan = planCustomFields({ headers: ['Foo Bar', 'foo_bar'], existingKeys: [] });
  assertEquals(plan.keyByHeader.get('Foo Bar'), 'foo_bar');
  assertEquals(plan.keyByHeader.get('foo_bar'), 'foo_bar_2');
  assertEquals(plan.newDefs.length, 2);
});

Deno.test('planCustomFields: a header that would shadow a real column gets a suffix', () => {
  const plan = planCustomFields({ headers: ['phone_raw', 'Dnc'], existingKeys: [] });
  assertEquals(plan.keyByHeader.get('phone_raw'), 'phone_raw_2');
  assertEquals(plan.keyByHeader.get('Dnc'), 'dnc_2');
});

Deno.test(
  'planCustomFields: past the org cap the extra headers fall back, reused defs still map',
  () => {
    const existingKeys = Array.from({ length: MAX_CUSTOM_FIELDS_PER_ORG - 1 }, (_, i) => `f${i}`);
    const plan = planCustomFields({ headers: ['F0', 'Brand New', 'Another New'], existingKeys });
    assertEquals(plan.keyByHeader.get('F0'), 'f0');
    assertEquals(
      plan.newDefs.map((d) => d.key),
      ['brand_new']
    );
    assertEquals(plan.overCapHeaders, ['Another New']);
  }
);

Deno.test('normalizeCustomValue: trims, drops blanks, truncates', () => {
  assertEquals(normalizeCustomValue('  yes '), 'yes');
  assertEquals(normalizeCustomValue('   '), null);
  assertEquals(normalizeCustomValue(null), null);
  assertEquals(normalizeCustomValue('a'.repeat(900))?.length, MAX_CUSTOM_VALUE_LENGTH);
});
