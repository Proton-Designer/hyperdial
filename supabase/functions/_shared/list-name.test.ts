import { assertEquals } from 'jsr:@std/assert@1';
import { defaultGhlListName, LIST_NAME_MAX, normalizeListName } from './list-name.ts';

Deno.test('normalizeListName: trims, collapses whitespace and control characters', () => {
  assertEquals(normalizeListName('  Austin   HVAC\tbatch 3 '), 'Austin HVAC batch 3');
  assertEquals(normalizeListName('a\u0000b\nc'), 'a b c');
});

Deno.test('normalizeListName: blank, missing or non-string is null (old clients)', () => {
  assertEquals(normalizeListName(undefined), null);
  assertEquals(normalizeListName(null), null);
  assertEquals(normalizeListName(''), null);
  assertEquals(normalizeListName('   \n '), null);
  assertEquals(normalizeListName(42), null);
});

Deno.test('normalizeListName: capped at 120 characters (matches the column check)', () => {
  const out = normalizeListName('x'.repeat(500));
  assertEquals(out?.length, LIST_NAME_MAX);
});

Deno.test('defaultGhlListName: "GHL import <UTC date>"', () => {
  assertEquals(defaultGhlListName(new Date('2026-10-19T23:30:00Z')), 'GHL import 2026-10-19');
});

Deno.test(
  'defaultGhlListName: uses the org time zone date (evening US import is not tomorrow)',
  () => {
    const t = new Date('2026-10-20T02:30:00Z'); // 21:30 on the 19th in Chicago (CDT)
    assertEquals(defaultGhlListName(t, 'America/Chicago'), 'GHL import 2026-10-19');
    assertEquals(defaultGhlListName(t, 'UTC'), 'GHL import 2026-10-20');
    assertEquals(defaultGhlListName(t, 'Pacific/Auckland'), 'GHL import 2026-10-20');
  }
);

Deno.test('defaultGhlListName: invalid or missing zone falls back to the UTC date', () => {
  const t = new Date('2026-10-20T02:30:00Z');
  assertEquals(defaultGhlListName(t, 'Not/AZone'), 'GHL import 2026-10-20');
  assertEquals(defaultGhlListName(t, null), 'GHL import 2026-10-20');
  assertEquals(defaultGhlListName(t), 'GHL import 2026-10-20');
});
