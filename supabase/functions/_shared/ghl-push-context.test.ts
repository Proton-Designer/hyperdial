import { assertEquals } from 'jsr:@std/assert@1';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { resolveCallerGhlUserId, resolveDispositionPushTimeContext } from './ghl-push-context.ts';

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
  dial_sessions: [{ id: 'sess-1', agent_id: 'agent-1' }],
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
    });
  }
);

Deno.test(
  'resolveDispositionPushTimeContext: no leg id / unknown leg -> all null, no further queries',
  async () => {
    const log: string[] = [];
    const nulls = { lastCallAt: null, callAttempts: null, callerGhlUserId: null };
    assertEquals(
      await resolveDispositionPushTimeContext(stubSupabase(TABLES, log), 'org-1', null),
      nulls
    );
    assertEquals(
      await resolveDispositionPushTimeContext(stubSupabase(TABLES, log), 'org-1', 'nope'),
      nulls
    );
    assertEquals(log, ['call_legs:dispositioned_at, ended_at, lead_id, session_id']);
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
