import { assertEquals } from 'jsr:@std/assert@1';
import { suggestGhlFieldMapping } from './ghl-field-mapping.ts';

Deno.test(
  'suggestGhlFieldMapping: exact (case-insensitive, trimmed) name matches are suggested',
  () => {
    const result = suggestGhlFieldMapping([
      { id: 'f1', name: '  Business Name  ' },
      { id: 'f2', name: 'website' },
      { id: 'f3', name: 'License #' },
    ]);
    assertEquals(result, { business_name: 'f1', website: 'f2', license_number: 'f3' });
  }
);

Deno.test('suggestGhlFieldMapping: a field with no matching target key contributes nothing', () => {
  const result = suggestGhlFieldMapping([{ id: 'f1', name: 'Favorite Color' }]);
  assertEquals(result, {});
});

Deno.test('suggestGhlFieldMapping: a near-miss (substring, not exact) is never suggested', () => {
  const result = suggestGhlFieldMapping([{ id: 'f1', name: 'Website Note' }]);
  assertEquals(result, {});
});

Deno.test('suggestGhlFieldMapping: an empty field-definition list suggests nothing', () => {
  assertEquals(suggestGhlFieldMapping([]), {});
});

Deno.test(
  'suggestGhlFieldMapping: duplicate normalized names -- the first one wins, deterministically',
  () => {
    const result = suggestGhlFieldMapping([
      { id: 'f1', name: 'Website' },
      { id: 'f2', name: 'website' },
    ]);
    assertEquals(result.website, 'f1');
  }
);

Deno.test(
  'suggestGhlFieldMapping: multiple synonyms for one target key -- the first matching synonym wins',
  () => {
    const result = suggestGhlFieldMapping([{ id: 'f1', name: 'Company Name' }]);
    assertEquals(result.business_name, 'f1');
  }
);

Deno.test(
  'suggestGhlFieldMapping: MISSION-4 TASK-T2 push-direction keys (last_call_at/last_call_outcome/call_attempts) match too',
  () => {
    const result = suggestGhlFieldMapping([
      { id: 'f1', name: 'Last Call At' },
      { id: 'f2', name: 'Last Outcome' },
      { id: 'f3', name: 'Call Attempts' },
    ]);
    assertEquals(result, {
      last_call_at: 'f1',
      last_call_outcome: 'f2',
      call_attempts: 'f3',
    });
  }
);
