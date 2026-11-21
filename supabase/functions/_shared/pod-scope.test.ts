import { assertEquals } from 'jsr:@std/assert@1';
import { FakeDb, createFakeSupabase } from './dialer-fake-supabase.ts';
import {
  isManagerScopedToAgent,
  resolveAlertRecipients,
  filterByNotificationPreference,
} from './pod-scope.ts';

const ORG = 'org-1';

function seedOrg(db: FakeDb) {
  db.insert('org_pods', { id: 'pod-a', org_id: ORG, name: 'Pod A' });
  db.insert('org_pods', { id: 'pod-b', org_id: ORG, name: 'Pod B' });
  db.insert('org_members', {
    id: 'm-owner',
    org_id: ORG,
    user_id: 'owner-1',
    role: 'owner',
    status: 'active',
    pod_id: null,
  });
  db.insert('org_members', {
    id: 'm-admin',
    org_id: ORG,
    user_id: 'admin-1',
    role: 'admin',
    status: 'active',
    pod_id: null,
  });
  db.insert('org_members', {
    id: 'm-mgr-a',
    org_id: ORG,
    user_id: 'manager-a',
    role: 'manager',
    status: 'active',
    pod_id: null,
  });
  db.insert('org_members', {
    id: 'm-mgr-b',
    org_id: ORG,
    user_id: 'manager-b',
    role: 'manager',
    status: 'active',
    pod_id: null,
  });
  db.insert('org_members', {
    id: 'm-agent-a',
    org_id: ORG,
    user_id: 'agent-pod-a',
    role: 'agent',
    status: 'active',
    pod_id: 'pod-a',
  });
  db.insert('org_members', {
    id: 'm-agent-none',
    org_id: ORG,
    user_id: 'agent-no-pod',
    role: 'agent',
    status: 'active',
    pod_id: null,
  });
  db.insert('org_manager_pods', { manager_user_id: 'manager-a', org_id: ORG, pod_id: 'pod-a' });
  db.insert('org_manager_pods', { manager_user_id: 'manager-b', org_id: ORG, pod_id: 'pod-b' });
}

Deno.test("isManagerScopedToAgent: true when the agent is in the manager's own pod", async () => {
  const db = new FakeDb();
  seedOrg(db);
  const supabase = createFakeSupabase(db);
  assertEquals(await isManagerScopedToAgent(supabase, ORG, 'manager-a', 'agent-pod-a'), true);
});

Deno.test(
  "isManagerScopedToAgent: false for a DIFFERENT manager's pod (the A5 leak this task closes)",
  async () => {
    const db = new FakeDb();
    seedOrg(db);
    const supabase = createFakeSupabase(db);
    assertEquals(await isManagerScopedToAgent(supabase, ORG, 'manager-b', 'agent-pod-a'), false);
  }
);

Deno.test('isManagerScopedToAgent: false for an agent with no pod at all', async () => {
  const db = new FakeDb();
  seedOrg(db);
  const supabase = createFakeSupabase(db);
  assertEquals(await isManagerScopedToAgent(supabase, ORG, 'manager-a', 'agent-no-pod'), false);
});

Deno.test(
  'resolveAlertRecipients: owner + admin + the in-scope manager, never the out-of-scope one',
  async () => {
    const db = new FakeDb();
    seedOrg(db);
    const supabase = createFakeSupabase(db);
    const recipients = await resolveAlertRecipients(supabase, ORG, 'agent-pod-a');
    assertEquals(new Set(recipients), new Set(['owner-1', 'admin-1', 'manager-a']));
  }
);

Deno.test(
  'resolveAlertRecipients: an unassigned agent still reaches owner/admin, no manager',
  async () => {
    const db = new FakeDb();
    seedOrg(db);
    const supabase = createFakeSupabase(db);
    const recipients = await resolveAlertRecipients(supabase, ORG, 'agent-no-pod');
    assertEquals(new Set(recipients), new Set(['owner-1', 'admin-1']));
  }
);

Deno.test(
  'filterByNotificationPreference: absent row means on (positive control: everyone passes with zero rows)',
  async () => {
    const db = new FakeDb();
    const supabase = createFakeSupabase(db);
    const result = await filterByNotificationPreference(
      supabase,
      ORG,
      ['owner-1', 'admin-1'],
      'wrap_up_stuck'
    );
    assertEquals(new Set(result), new Set(['owner-1', 'admin-1']));
  }
);

Deno.test(
  'filterByNotificationPreference: an explicit enabled=false row excludes only that user for that type',
  async () => {
    const db = new FakeDb();
    db.insert('user_notification_preferences', {
      id: 'pref-1',
      org_id: ORG,
      user_id: 'admin-1',
      alert_type: 'wrap_up_stuck',
      enabled: false,
    });
    db.insert('user_notification_preferences', {
      id: 'pref-2',
      org_id: ORG,
      user_id: 'admin-1',
      alert_type: 'paused_stuck',
      enabled: false,
    });
    const supabase = createFakeSupabase(db);
    const wrapUp = await filterByNotificationPreference(
      supabase,
      ORG,
      ['owner-1', 'admin-1'],
      'wrap_up_stuck'
    );
    assertEquals(new Set(wrapUp), new Set(['owner-1']));
    // Positive control: a DIFFERENT alert_type the user didn't opt out of still passes them.
    const callStuck = await filterByNotificationPreference(
      supabase,
      ORG,
      ['owner-1', 'admin-1'],
      'call_stuck'
    );
    assertEquals(new Set(callStuck), new Set(['owner-1', 'admin-1']));
  }
);
