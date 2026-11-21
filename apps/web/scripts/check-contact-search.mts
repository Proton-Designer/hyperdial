// TASK-H38: parity check for the search matcher. Run: npm run check:search --workspace apps/web (Node 22.6+).
// The same cases are asserted in SQL by supabase/tests/h38_search_parity.sql -- keep the two lists identical.
import assert from 'node:assert/strict';
import { searchMatches } from '../src/lib/contactName.ts';

const cases: [query: string, text: string, phones: string[], expected: boolean][] = [
  ['bow stern', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], true],
  ['Bow Stern', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], true],
  ['bowstern', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], true],
  [
    'BOWSTERN marketing',
    'Bowstern Marketing Communications',
    ['+18505707252', '(850) 570-7252'],
    true,
  ],
  ['marketing bow', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], true],
  [
    'communications stern',
    'Bowstern Marketing Communications',
    ['+18505707252', '(850) 570-7252'],
    true,
  ],
  ['850 570', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], true],
  ['(850) 570-7252', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], true],
  ['8505707252', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], true],
  [
    '+1 850 570 7252',
    'Bowstern Marketing Communications',
    ['+18505707252', '(850) 570-7252'],
    true,
  ],
  ['570-7252', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], true],
  ['bow tie', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], false],
  ['850 571', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], false],
  ['99', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], false],
  ['zzz', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], false],
  ['8505707253', 'Bowstern Marketing Communications', ['+18505707252', '(850) 570-7252'], false],
  ['jose nunez smith', 'José Núñez-Smith', [], true],
  ['obrien sons', "O'Brien & Sons", [], true],
  ['lodz', 'Łódź Bakery', [], true],
  ['strasse', 'Straße Café', [], true],
  ['odense', 'Ødense Træ', [], true],
  ['dordevic', 'Đorđević Co', [], true],
  ['sogut', 'Söğüt Ltd', [], true],
  ['محمد', 'محمد للتجارة', [], true],
  ['للتجارة', 'محمد للتجارة', [], true],
  ['مرحبا', 'Acme Roofing', [], false],
  ['иван', 'Иван Петров ООО', [], true],
  ['!!!', 'Acme Roofing', [], false],
  ['   ', 'Acme Roofing', [], true],
  ['()', 'Acme', ['+12145550123'], false],
  ['12', 'Acme', ['+12145550123'], false],
  ['214', 'Acme', ['+12145550123'], true],
  ['214x', 'Acme 214 Plumbing', [], false],
];

let failed = 0;
for (const [query, text, phones, expected] of cases) {
  const got = searchMatches([text], phones, query);
  if (got !== expected) {
    failed++;
    console.error(
      `FAIL query=${JSON.stringify(query)} text=${JSON.stringify(text)}: expected ${expected}, got ${got}`
    );
  }
}
assert.equal(failed, 0, `${failed} search case(s) failed`);
console.log(`contact search matcher: ${cases.length} cases passed`);
