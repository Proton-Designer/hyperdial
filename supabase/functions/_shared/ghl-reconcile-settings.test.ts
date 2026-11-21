import { assertEquals } from 'jsr:@std/assert@1';
import {
  parseReconcileSettingsBody,
  cleanStageIds,
  cleanTagList,
} from './ghl-reconcile-settings.ts';

Deno.test(
  'cleanTagList: trims, drops blanks, dedupes case-insensitively, caps entries and length',
  () => {
    assertEquals(cleanTagList([' Signed Up ', 'signed up', '', '  ', 'Active']), [
      'Signed Up',
      'Active',
    ]);
    assertEquals(cleanTagList('x'), null);
    assertEquals(cleanTagList(['ok', 5]), null);
    assertEquals(cleanTagList(['a'.repeat(101)]), null);
    const many = Array.from({ length: 80 }, (_, i) => `t${i}`);
    assertEquals(cleanTagList(many)?.length, 50);
  }
);

Deno.test(
  'cleanStageIds: strings of letters/digits/-/_ only, trimmed, deduped, capped at 20',
  () => {
    assertEquals(cleanStageIds([' abc123 ', 'abc123', 'Stage_9-x']), ['abc123', 'Stage_9-x']);
    assertEquals(cleanStageIds(['has space']), null);
    assertEquals(cleanStageIds(['<script>']), null);
    assertEquals(cleanStageIds([1]), null);
    assertEquals(cleanStageIds('abc'), null);
    assertEquals(cleanStageIds(Array.from({ length: 30 }, (_, i) => `s${i}`))?.length, 20);
  }
);

Deno.test('parseReconcileSettingsBody: get / set shapes and rejections', () => {
  assertEquals(parseReconcileSettingsBody({ action: 'get' }), {
    ok: true,
    value: { action: 'get' },
  });
  assertEquals(
    parseReconcileSettingsBody({
      action: 'set',
      enabled: true,
      excludeTags: [' Signed up '],
      excludeStageIds: ['st1'],
    }),
    {
      ok: true,
      value: { action: 'set', enabled: true, excludeTags: ['Signed up'], excludeStageIds: ['st1'] },
    }
  );
  assertEquals(
    parseReconcileSettingsBody({
      action: 'set',
      enabled: false,
      excludeTags: [],
      excludeStageIds: [],
    }).ok,
    true
  );
  assertEquals(
    parseReconcileSettingsBody({
      action: 'set',
      enabled: 'yes',
      excludeTags: [],
      excludeStageIds: [],
    }).ok,
    false
  );
  assertEquals(
    parseReconcileSettingsBody({
      action: 'set',
      enabled: true,
      excludeTags: 'x',
      excludeStageIds: [],
    }).ok,
    false
  );
  assertEquals(
    parseReconcileSettingsBody({
      action: 'set',
      enabled: true,
      excludeTags: [],
      excludeStageIds: ['a b'],
    }).ok,
    false
  );
  assertEquals(parseReconcileSettingsBody({ action: 'delete' }).ok, false);
  assertEquals(parseReconcileSettingsBody(null).ok, false);
  assertEquals(parseReconcileSettingsBody('x').ok, false);
});
