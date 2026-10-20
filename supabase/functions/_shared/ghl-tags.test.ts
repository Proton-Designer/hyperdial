import { assertEquals } from 'jsr:@std/assert@1';
import {
  cleanTagName,
  ensureGhlTags,
  type GhlTagApi,
  missingTags,
  parseTagsBody,
  sortTagNames,
  uniqueTags,
} from './ghl-tags.ts';

function fakeApi(
  existing: string[],
  opts: { failCreate?: string[]; listFails?: boolean; dupOn?: string[] } = {}
) {
  const created: string[] = [];
  const api: GhlTagApi = {
    listTags: () => {
      if (opts.listFails) return Promise.reject(new Error('GHL API GET failed (401)'));
      return Promise.resolve(existing.map((name, i) => ({ id: `t${i}`, name })));
    },
    createTag: (_loc, name) => {
      if (opts.dupOn?.includes(name)) return Promise.reject(new Error('Tag already exists (400)'));
      if (opts.failCreate?.includes(name))
        return Promise.reject(new Error('GHL API POST failed (403)'));
      created.push(name);
      return Promise.resolve({ id: `n${created.length}`, name });
    },
  };
  return { api, created };
}

Deno.test(
  'cleanTagName / uniqueTags: trims, collapses spaces, drops blanks, case-insensitive dedupe',
  () => {
    assertEquals(cleanTagName('  signed   up '), 'signed up');
    assertEquals(cleanTagName('   '), null);
    assertEquals(cleanTagName('x'.repeat(101)), null);
    assertEquals(cleanTagName(5), null);
    assertEquals(uniqueTags(['Signed Up', 'active'], null, ['signed up', ' ', 'DNC']), [
      'Signed Up',
      'active',
      'DNC',
    ]);
  }
);

Deno.test('missingTags: case-insensitive against the location', () => {
  assertEquals(missingTags(['signed up', 'Active', 'dnc'], ['SIGNED UP', 'active']), ['dnc']);
});

Deno.test('ensureGhlTags: creates only the missing tags (TASK-G28)', async () => {
  const { api, created } = fakeApi(['active']);
  const r = await ensureGhlTags(api, 'loc-1', ['signed up', 'Active', 'DNC']);
  assertEquals(created, ['signed up', 'DNC']);
  assertEquals(r, {
    existing: ['Active'],
    created: ['signed up', 'DNC'],
    failed: [],
    listError: null,
  });
});

Deno.test('ensureGhlTags: a failed create is reported and the rest still go', async () => {
  const { api, created } = fakeApi([], { failCreate: ['signed up'] });
  const r = await ensureGhlTags(api, 'loc-1', ['signed up', 'active']);
  assertEquals(created, ['active']);
  assertEquals(r.failed, [{ tag: 'signed up', error: 'GHL API POST failed (403)' }]);
});

Deno.test('ensureGhlTags: if listing fails nothing is created', async () => {
  const { api, created } = fakeApi([], { listFails: true });
  const r = await ensureGhlTags(api, 'loc-1', ['signed up']);
  assertEquals(created, []);
  assertEquals(r.listError, 'GHL API GET failed (401)');
});

Deno.test(
  'ensureGhlTags: "already exists" on create counts as existing; nothing wanted = no calls',
  async () => {
    const { api } = fakeApi([], { dupOn: ['active'] });
    const r = await ensureGhlTags(api, 'loc-1', ['active']);
    assertEquals([r.existing, r.failed], [['active'], []]);
    const none = fakeApi([], { listFails: true });
    assertEquals((await ensureGhlTags(none.api, 'loc-1', [])).listError, null);
  }
);

Deno.test('parseTagsBody / sortTagNames', () => {
  assertEquals(parseTagsBody({ action: 'list' }), { ok: true, value: { action: 'list' } });
  assertEquals(parseTagsBody({ action: 'create', name: '  New tag ' }), {
    ok: true,
    value: { action: 'create', name: 'New tag' },
  });
  assertEquals(parseTagsBody({ action: 'create', name: '' }).ok, false);
  assertEquals(parseTagsBody({ action: 'delete' }).ok, false);
  assertEquals(parseTagsBody(null).ok, false);
  assertEquals(sortTagNames(['b', 'A', 'c']), ['A', 'b', 'c']);
});
