import { assertEquals } from 'jsr:@std/assert@1';
import { syncOrgTagsForOrg } from './ghl-tags-io.ts';

Deno.test(
  'syncOrgTagsForOrg: a throwing lookup is returned as listError, never thrown (TASK-G28.5)',
  async () => {
    const supabase = {
      from: () => {
        throw new Error('connection reset');
      },
    };
    const r = await syncOrgTagsForOrg(supabase, 'org-1');
    assertEquals(r, { existing: [], created: [], failed: [], listError: 'connection reset' });
  }
);

Deno.test('syncOrgTagsForOrg: GHL not connected -> null', async () => {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
      }),
    }),
  };
  assertEquals(await syncOrgTagsForOrg(supabase, 'org-1'), null);
});
