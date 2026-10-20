import { assertEquals } from 'jsr:@std/assert@1';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  resolveCallerGhlUserId,
  resolveDispositionPushTimeContext,
  resolveSessionContext,
} from './ghl-push-context.ts';

type Row = Record<string, unknown>;

/** Minimal `.from(t).select().eq()...maybeSingle()` stub over in-memory rows; logs each query. */
function stubSupabase(tables: Record<string, Row[]>, log: string[] = []): SupabaseClient {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const q = {
        select(cols: string) {
          log.push(`${table}:${cols}`);
          return q;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return q;
        },
        maybeSingle() {
          const row = (tables[table] ?? []).find((r) => filters.every(([c, v]) => r[c] === v));
          return Promise.resolve({ data: row ?? null, error: null });
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const TABLES = {
  call_legs: [
    {
      id: 'leg-1',
      ended_at: '2026-10-19T20:00:00Z',
      dispositioned_at: '2026-10-19T20:05:00Z',
      lead_id: 'lead-1',
      session_id: 'sess-1',
    },
    {
      id: 'leg-2',
      ended_at: null,
      dispositioned_at: '2026-10-19T21:00:00Z',
      lead_id: null,
      session_id: null,
    },
  ],
  campaign_leads: [{ id: 'lead-1', attempts: 4 }],
  dial_sessions: [{ id: 'sess-1', agent_id: 'agent-1', campaign_id: 'camp-1' }],
  profiles: [{ user_id: 'agent-1', first_name: 'Jane', last_name: 'Intern' }],
  campaigns: [{ id: 'camp-1', name: 'Austin HVAC batch 3' }],
  org_members: [
    { org_id: 'org-1', user_id: 'agent-1', ghl_user_id: 'ghl-u-9' },
    { org_id: 'org-2', user_id: 'agent-1', ghl_user_id: 'other-org-user' },
  ],
};

Deno.test(
  'resolveDispositionPushTimeContext: last_call_at is ended_at, not dispositioned_at',
  async () => {
    const ctx = await resolveDispositionPushTimeContext(stubSupabase(TABLES), 'org-1', 'leg-1');
    assertEquals(ctx, {
      lastCallAt: '2026-10-19T20:00:00Z',
      callAttempts: 4,
      callerGhlUserId: 'ghl-u-9',
      callerName: 'Jane Intern',
      leadList: 'Austin HVAC batch 3',
    });
  }
);

Deno.test(
  'resolveDispositionPushTimeContext: falls back to dispositioned_at; no lead/session -> nulls',
  async () => {
    const ctx = await resolveDispositionPushTimeContext(stubSupabase(TABLES), 'org-1', 'leg-2');
    assertEquals(ctx, {
      lastCallAt: '2026-10-19T21:00:00Z',
      callAttempts: null,
      callerGhlUserId: null,
      callerName: null,
      leadList: null,
    });
  }
);

Deno.test(
  'resolveDispositionPushTimeContext: no leg id / unknown leg -> all null, no further queries',
  async () => {
    const log: string[] = [];
    const nulls = {
      lastCallAt: null,
      callAttempts: null,
      callerGhlUserId: null,
      callerName: null,
      leadList: null,
    };
    assertEquals(
      await resolveDispositionPushTimeContext(stubSupabase(TABLES, log), 'org-1', null),
      nulls
    );
    assertEquals(
      await resolveDispositionPushTimeContext(stubSupabase(TABLES, log), 'org-1', 'nope'),
      nulls
    );
    assertEquals(log, [
      'call_legs:dispositioned_at, ended_at, created_at, lead_id, session_id, contact_id',
    ]);
  }
);

Deno.test('resolveCallerGhlUserId: session agent -> that org membership only', async () => {
  const sb = stubSupabase(TABLES);
  assertEquals(await resolveCallerGhlUserId(sb, 'org-1', 'sess-1'), 'ghl-u-9');
  assertEquals(await resolveCallerGhlUserId(sb, 'org-2', 'sess-1'), 'other-org-user');
  assertEquals(await resolveCallerGhlUserId(sb, 'org-3', 'sess-1'), null); // not a member
  assertEquals(await resolveCallerGhlUserId(sb, 'org-1', null), null);
  assertEquals(await resolveCallerGhlUserId(sb, 'org-1', 'ghost-session'), null);
});

Deno.test('resolveCallerGhlUserId: member without ghl_user_id -> null', async () => {
  const sb = stubSupabase({
    ...TABLES,
    org_members: [{ org_id: 'org-1', user_id: 'agent-1', ghl_user_id: null }],
  });
  assertEquals(await resolveCallerGhlUserId(sb, 'org-1', 'sess-1'), null);
});

Deno.test(
  'resolveDispositionPushTimeContext: TASK-G11 last resort created_at when ended_at and dispositioned_at are null',
  async () => {
    const sb = stubSupabase({
      ...TABLES,
      call_legs: [
        {
          id: 'leg-3',
          ended_at: null,
          dispositioned_at: null,
          created_at: '2026-10-19T19:00:00Z',
          lead_id: null,
          session_id: null,
        },
      ],
    });
    const ctx = await resolveDispositionPushTimeContext(sb, 'org-1', 'leg-3');
    assertEquals(ctx.lastCallAt, '2026-10-19T19:00:00Z');
  }
);

Deno.test(
  'resolveSessionContext: TASK-G11 caller name (first + last, blanks dropped) and campaign name',
  async () => {
    assertEquals(await resolveSessionContext(stubSupabase(TABLES), 'org-1', 'sess-1'), {
      callerGhlUserId: 'ghl-u-9',
      callerName: 'Jane Intern',
      leadList: 'Austin HVAC batch 3',
    });
    const noLast = stubSupabase({
      ...TABLES,
      profiles: [{ user_id: 'agent-1', first_name: 'Jane', last_name: ' ' }],
    });
    assertEquals((await resolveSessionContext(noLast, 'org-1', 'sess-1')).callerName, 'Jane');
    const noProfile = stubSupabase({ ...TABLES, profiles: [], campaigns: [] });
    const r = await resolveSessionContext(noProfile, 'org-1', 'sess-1');
    assertEquals([r.callerName, r.leadList, r.callerGhlUserId], [null, null, 'ghl-u-9']);
    assertEquals(await resolveSessionContext(stubSupabase(TABLES), 'org-1', null), {
      callerGhlUserId: null,
      callerName: null,
      leadList: null,
    });
  }
);

Deno.test(
  'resolveDispositionPushTimeContext: lead_list prefers the lead list name, then the contact import list, then the campaign (TASK-G18)',
  async () => {
    const legBase = {
      ended_at: '2026-10-19T20:00:00Z',
      dispositioned_at: null,
      session_id: 'sess-1',
    };
    const tables = {
      ...TABLES,
      call_legs: [
        { ...legBase, id: 'leg-a', lead_id: 'lead-a', contact_id: 'c-1' },
        { ...legBase, id: 'leg-b', lead_id: 'lead-b', contact_id: 'c-1' },
        { ...legBase, id: 'leg-c', lead_id: null, contact_id: 'c-1' },
        { ...legBase, id: 'leg-d', lead_id: 'lead-b', contact_id: 'c-2' },
      ],
      campaign_leads: [
        { id: 'lead-a', attempts: 1, list_name: 'Scraped Austin 10-12' },
        { id: 'lead-b', attempts: 2, list_name: null },
      ],
      contacts: [
        { id: 'c-1', org_id: 'org-1', import_list: 'First CSV' },
        { id: 'c-2', org_id: 'org-1', import_list: null },
      ],
    };
    const sb = stubSupabase(tables);
    assertEquals(
      (await resolveDispositionPushTimeContext(sb, 'org-1', 'leg-a')).leadList,
      'Scraped Austin 10-12'
    );
    assertEquals(
      (await resolveDispositionPushTimeContext(sb, 'org-1', 'leg-b')).leadList,
      'First CSV'
    );
    assertEquals(
      (await resolveDispositionPushTimeContext(sb, 'org-1', 'leg-c')).leadList,
      'First CSV'
    );
    assertEquals(
      (await resolveDispositionPushTimeContext(sb, 'org-1', 'leg-d')).leadList,
      'Austin HVAC batch 3'
    );
    // another org's contact never supplies the name (falls through to the campaign name)
    assertEquals(
      (await resolveDispositionPushTimeContext(sb, 'org-2', 'leg-c')).leadList,
      'Austin HVAC batch 3'
    );
  }
);
