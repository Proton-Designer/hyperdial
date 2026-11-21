import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  checkDialNumberAvailable,
  NO_NUMBER_MESSAGE,
  NUMBERS_CAPPED_MESSAGE,
} from './dial-number-check.ts';

interface NumRow {
  org_id: string;
  status: string;
  assigned_user_id: string | null;
}

/** Evaluates the exact filters the helper sends (eq / in / the one `or` it uses) over real rows. */
function fake(opts: {
  available: boolean;
  rows?: NumRow[];
  usable?: number;
  rpcError?: string;
  countError?: string;
}) {
  const rows = opts.rows ?? [];
  const preds: Array<(r: NumRow) => boolean> = [];
  const rpcArgs: unknown[] = [];
  let queried = false;
  const chain = {
    select() {
      queried = true;
      return chain;
    },
    eq(col: keyof NumRow, v: string) {
      preds.push((r) => r[col] === v);
      return chain;
    },
    in(col: keyof NumRow, vs: string[]) {
      preds.push((r) => vs.includes(r[col] as string));
      return chain;
    },
    or(expr: string) {
      const m = /^assigned_user_id\.is\.null,assigned_user_id\.eq\.(.+)$/.exec(expr);
      if (!m) throw new Error(`unexpected or(): ${expr}`);
      preds.push((r) => r.assigned_user_id === null || r.assigned_user_id === m[1]);
      return Promise.resolve({
        count: rows.filter((r) => preds.every((p) => p(r))).length,
        error: opts.countError ? { message: opts.countError } : null,
      });
    },
  };
  return {
    get queried() {
      return queried;
    },
    rpcArgs,
    rpc(name: string, args: unknown) {
      rpcArgs.push([name, args]);
      return Promise.resolve({
        data: opts.available,
        error: opts.rpcError ? { message: opts.rpcError } : null,
      });
    },
    from() {
      return chain;
    },
  };
}
const row = (status: string, assigned: string | null, org = 'org'): NumRow => ({
  org_id: org,
  status,
  assigned_user_id: assigned,
});

Deno.test('CONTROL: a number is available -> null, no further query', async () => {
  const db = fake({ available: true });
  assertEquals(await checkDialNumberAvailable(db, 'org', 'agent'), null);
  assertEquals(db.queried, false);
  assertEquals(db.rpcArgs, [
    ['has_available_dial_number', { p_org_id: 'org', p_agent_id: 'agent' }],
  ]);
});

const NONE = { error: NO_NUMBER_MESSAGE, code: 'NO_DIAL_NUMBER' };
const CAPPED = { error: NUMBERS_CAPPED_MESSAGE, code: 'NO_DIAL_NUMBER' };

Deno.test('org has no numbers at all -> "none" wording', async () => {
  assertEquals(await checkDialNumberAvailable(fake({ available: false }), 'org', 'agent'), NONE);
});

Deno.test('all org numbers belong to someone else -> "none" (the live hjleo08 case)', async () => {
  const rows = [row('active', 'other'), row('active', 'other2')];
  assertEquals(
    await checkDialNumberAvailable(fake({ available: false, rows }), 'org', 'agent'),
    NONE
  );
});

Deno.test(
  'MUST (lead review): the only number is resting (cap reached) -> "capped", not "none"',
  async () => {
    const rows = [row('resting', 'agent')];
    assertEquals(
      await checkDialNumberAvailable(fake({ available: false, rows }), 'org', 'agent'),
      CAPPED
    );
  }
);

Deno.test('a resting unassigned pool number also counts as "has a number"', async () => {
  const rows = [row('resting', null)];
  assertEquals(
    await checkDialNumberAvailable(fake({ available: false, rows }), 'org', 'agent'),
    CAPPED
  );
});

Deno.test('active but at the daily cap -> "capped"', async () => {
  const rows = [row('active', 'agent')];
  assertEquals(
    await checkDialNumberAvailable(fake({ available: false, rows }), 'org', 'agent'),
    CAPPED
  );
});

Deno.test(
  "retired numbers, other agents' numbers and other orgs' numbers never count",
  async () => {
    const rows = [
      row('retired', 'agent'),
      row('retired', null),
      row('resting', 'other'),
      row('resting', 'agent', 'other-org'),
    ];
    assertEquals(
      await checkDialNumberAvailable(fake({ available: false, rows }), 'org', 'agent'),
      NONE
    );
  }
);

Deno.test(
  'a failed lookup throws (the caller returns 500), never silently allows or blocks',
  async () => {
    await assertRejects(
      () => checkDialNumberAvailable(fake({ available: true, rpcError: 'boom' }), 'o', 'a'),
      Error,
      'boom'
    );
    await assertRejects(
      () => checkDialNumberAvailable(fake({ available: false, countError: 'bad' }), 'o', 'a'),
      Error,
      'bad'
    );
  }
);
