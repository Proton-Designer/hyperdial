import { assertEquals } from 'jsr:@std/assert@1';
import { checkViewAsTarget } from './view-as-core.ts';

const ORG = 'org-1';
const base = { viewerId: 'v', targetId: 't', orgId: ORG };

Deno.test('view-as target: an active agent of the org only', () => {
  assertEquals(
    checkViewAsTarget({ ...base, memberships: [{ org_id: ORG, role: 'agent', status: 'active' }] }),
    { ok: true }
  );
});

Deno.test('view-as target: refused roles, statuses, self, other orgs', () => {
  const code = (m: { org_id: string; role: string; status: string }[], t = 't') => {
    const r = checkViewAsTarget({ ...base, targetId: t, memberships: m });
    return r.ok ? 'ok' : r.code;
  };
  for (const role of ['owner', 'admin', 'manager'])
    assertEquals(code([{ org_id: ORG, role, status: 'active' }]), 'not_an_agent');
  assertEquals(code([{ org_id: ORG, role: 'agent', status: 'removed' }]), 'not_an_agent');
  assertEquals(code([{ org_id: ORG, role: 'agent', status: 'invited' }]), 'not_an_agent');
  assertEquals(code([]), 'not_an_agent');
  assertEquals(code([{ org_id: 'other', role: 'agent', status: 'active' }]), 'not_an_agent');
  assertEquals(
    code([
      { org_id: ORG, role: 'agent', status: 'active' },
      { org_id: 'other', role: 'agent', status: 'active' },
    ]),
    'multi_org'
  );
  // a membership in another org counts even when it is not active (a token is global to the user)
  assertEquals(
    code([
      { org_id: ORG, role: 'agent', status: 'active' },
      { org_id: 'other', role: 'owner', status: 'removed' },
    ]),
    'multi_org'
  );
  assertEquals(code([{ org_id: ORG, role: 'agent', status: 'active' }], 'v'), 'self');
});
