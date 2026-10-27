import { assertEquals } from 'jsr:@std/assert@1';
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
    assertEquals(slugifyHeader('???'), 'field');
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
