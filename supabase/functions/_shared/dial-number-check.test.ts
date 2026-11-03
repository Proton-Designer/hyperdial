import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  checkDialNumberAvailable,
  NO_NUMBER_MESSAGE,
  NUMBERS_CAPPED_MESSAGE,
} from './dial-number-check.ts';

function fake(opts: {
  available: boolean;
  usable: number;
  rpcError?: string;
  countError?: string;
}) {
  const filters: Array<[string, string]> = [];
  const rpcArgs: unknown[] = [];
  const chain = {
    select() {
      return chain;
    },
    eq(col: string, v: string) {
      filters.push([col, v]);
      return chain;
    },
    or(expr: string) {
      filters.push(['or', expr]);
      return Promise.resolve({
        count: opts.usable,
        error: opts.countError ? { message: opts.countError } : null,
      });
    },
  };
  return {
    filters,
    rpcArgs,
    rpc(name: string, args: unknown) {
      rpcArgs.push([name, args]);
      return Promise.resolve({
        data: opts.available,
        error: opts.rpcError ? { message: opts.rpcError } : null,
      });
    },
    from(table: string) {
      filters.push(['from', table]);
      return chain;
    },
  };
}

Deno.test('CONTROL: a number is available -> null, no further query', async () => {
  const db = fake({ available: true, usable: 0 });
  assertEquals(await checkDialNumberAvailable(db, 'org', 'agent'), null);
  assertEquals(db.filters.length, 0);
  assertEquals(db.rpcArgs, [
    ['has_available_dial_number', { p_org_id: 'org', p_agent_id: 'agent' }],
  ]);
});

Deno.test(
  'no usable number at all (none assigned to the agent, no pool) -> NO_DIAL_NUMBER, "none" wording',
  async () => {
    const db = fake({ available: false, usable: 0 });
    assertEquals(await checkDialNumberAvailable(db, 'org', 'agent'), {
      error: NO_NUMBER_MESSAGE,
      code: 'NO_DIAL_NUMBER',
    });
  }
);

Deno.test(
  'usable numbers exist but all capped/resting -> NO_DIAL_NUMBER, "capped" wording',
  async () => {
    const db = fake({ available: false, usable: 2 });
    assertEquals(await checkDialNumberAvailable(db, 'org', 'agent'), {
      error: NUMBERS_CAPPED_MESSAGE,
      code: 'NO_DIAL_NUMBER',
    });
  }
);

Deno.test(
  '"has a number" means active AND (unassigned OR assigned to this agent), same org',
  async () => {
    const db = fake({ available: false, usable: 0 });
    await checkDialNumberAvailable(db, 'org-1', 'agent-1');
    assertEquals(db.filters, [
      ['from', 'user_phone_numbers'],
      ['org_id', 'org-1'],
      ['status', 'active'],
      ['or', 'assigned_user_id.is.null,assigned_user_id.eq.agent-1'],
    ]);
  }
);

Deno.test(
  'a failed lookup throws (the caller returns 500), never silently allows or blocks',
  async () => {
    await assertRejects(
      () =>
        checkDialNumberAvailable(fake({ available: true, usable: 0, rpcError: 'boom' }), 'o', 'a'),
      Error,
      'boom'
    );
    await assertRejects(
      () =>
        checkDialNumberAvailable(
          fake({ available: false, usable: 0, countError: 'bad' }),
          'o',
          'a'
        ),
      Error,
      'bad'
    );
  }
);
