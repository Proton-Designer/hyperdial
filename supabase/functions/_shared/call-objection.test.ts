import { assertEquals } from 'jsr:@std/assert@1';
import { TOP_OBJECTIONS } from './shifts-core.ts';
import {
  TOP_OBJECTION_GHL_LABELS,
  parseTopObjection,
  topObjectionLabel,
} from './call-objection.ts';

Deno.test(
  'parseTopObjection: absent/blank -> null, known key -> itself, anything else invalid',
  () => {
    assertEquals(parseTopObjection(undefined), { ok: true, value: null });
    assertEquals(parseTopObjection(null), { ok: true, value: null });
    assertEquals(parseTopObjection('  '), { ok: true, value: null });
    assertEquals(parseTopObjection(' fees '), { ok: true, value: 'fees' });
    for (const k of TOP_OBJECTIONS) assertEquals(parseTopObjection(k), { ok: true, value: k });
    assertEquals(parseTopObjection('Fees'), { ok: false });
    assertEquals(parseTopObjection('too busy'), { ok: false });
    assertEquals(parseTopObjection(3), { ok: false });
  }
);

Deno.test('labels cover exactly the six keys and match the shift-push labels', () => {
  assertEquals(Object.keys(TOP_OBJECTION_GHL_LABELS).sort(), [...TOP_OBJECTIONS].sort());
  assertEquals(topObjectionLabel('enough_work'), 'Has enough work');
  assertEquals(topObjectionLabel('dont_trust_apps'), 'Does not trust apps');
  assertEquals(topObjectionLabel(null), null);
  assertEquals(topObjectionLabel('bogus'), null);
});

Deno.test('the migration check list and edge keys stay in sync', async () => {
  const dir = new URL('../../migrations/', import.meta.url);
  let sql = '';
  for await (const e of Deno.readDir(dir)) {
    if (e.name.endsWith('_call_top_objection.sql'))
      sql = await Deno.readTextFile(new URL(e.name, dir));
  }
  for (const k of TOP_OBJECTIONS)
    assertEquals(sql.includes(`'${k}'`), true, `migration lists ${k}`);
});
