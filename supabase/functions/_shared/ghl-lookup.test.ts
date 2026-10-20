import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import type { GhlClient, GhlContact } from './ghl-client.ts';
import { lookupUnlinkedContacts, matchGhlContactsByPhone } from './ghl-lookup.ts';

const gc = (id: string, phone: string | undefined): GhlContact => ({ id, phone });

Deno.test(
  'matchGhlContactsByPhone: formatted numbers match after normalising; other numbers and duplicate ids do not',
  () => {
    const found = matchGhlContactsByPhone(
      [
        gc('a', '(415) 555-2671'),
        gc('b', '+1 415 555 2672'),
        gc('a', '+14155552671'),
        gc('c', undefined),
        gc('d', 'garbage'),
      ],
      '+14155552671'
    );
    assertEquals(
      found.map((c) => c.id),
      ['a']
    );
  }
);

function fakeSupabase(opts: {
  claim?: { contact_id: string; phone_number: string | null; prev_lookup_at: string | null }[];
  linkedIds?: string[] | 'all';
  linkError?: string;
  conflicts?: number;
}) {
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    rpcs,
    sb: {
      async rpc(fn: string, args: Record<string, unknown>) {
        rpcs.push({ fn, args });
        if (fn === 'claim_ghl_lookup_batch') return { data: opts.claim ?? [], error: null };
        if (fn === 'link_ghl_contacts') {
          if (opts.linkError) return { data: null, error: { message: opts.linkError } };
          const items = args.p_items as { contact_id: string }[];
          const ids =
            opts.linkedIds === 'all' || opts.linkedIds === undefined
              ? items.map((i) => i.contact_id)
              : opts.linkedIds;
          return {
            data: { linked: ids.length, conflicts: opts.conflicts ?? 0, linked_ids: ids },
            error: null,
          };
        }
        return { data: 1, error: null };
      },
    },
  };
}

function ghlWith(byQuery: Record<string, GhlContact[] | Error>, calls: string[] = []): GhlClient {
  return {
    searchContacts: async (a: { query?: string }) => {
      calls.push(a.query ?? '');
      const r = byQuery[a.query ?? ''];
      if (r instanceof Error) throw r;
      return { contacts: r ?? [], count: (r ?? []).length };
    },
  } as unknown as GhlClient;
}

const ARGS = { orgId: 'org-1', locationId: 'loc-1', batchSize: 25 };
const row = (id: string, phone: string | null, prev: string | null = null) => ({
  contact_id: id,
  phone_number: phone,
  prev_lookup_at: prev,
});

Deno.test(
  'lookup: exactly one match links the contact and hands it to the reconcile read (positive control)',
  async () => {
    const { sb, rpcs } = fakeSupabase({ claim: [row('c1', '+14155552671')] });
    const out = await lookupUnlinkedContacts(
      sb,
      ghlWith({ '+14155552671': [gc('g1', '(415) 555-2671')] }),
      ARGS
    );
    assertEquals(out.result.linked, 1);
    assertEquals(out.linked, [
      { contact_id: 'c1', ghl_contact_id: 'g1', prev_reconciled_at: null },
    ]);
    assertEquals(rpcs.find((r) => r.fn === 'link_ghl_contacts')?.args.p_items, [
      { contact_id: 'c1', ghl_contact_id: 'g1' },
    ]);
  }
);

Deno.test(
  'lookup: no match links nothing and releases nothing (the stamp stays: not re-searched every tick)',
  async () => {
    const { sb, rpcs } = fakeSupabase({ claim: [row('c1', '+14155552671')] });
    const out = await lookupUnlinkedContacts(sb, ghlWith({ '+14155552671': [] }), ARGS);
    assertEquals([out.result.noMatch, out.result.linked, out.linked.length], [1, 0, 0]);
    assertEquals(
      rpcs.map((r) => r.fn),
      ['claim_ghl_lookup_batch']
    );
  }
);

Deno.test('lookup: several GHL contacts with the same phone are NOT linked', async () => {
  const { sb, rpcs } = fakeSupabase({ claim: [row('c1', '+14155552671')] });
  const out = await lookupUnlinkedContacts(
    sb,
    ghlWith({ '+14155552671': [gc('g1', '+14155552671'), gc('g2', '4155552671')] }),
    ARGS
  );
  assertEquals([out.result.ambiguous, out.result.linked], [1, 0]);
  assertEquals(
    rpcs.some((r) => r.fn === 'link_ghl_contacts'),
    false
  );
});

Deno.test('lookup: a fuzzy GHL hit with a different phone is ignored (no match)', async () => {
  const { sb } = fakeSupabase({ claim: [row('c1', '+14155552671')] });
  const out = await lookupUnlinkedContacts(
    sb,
    ghlWith({ '+14155552671': [gc('g9', '+14155552679')] }),
    ARGS
  );
  assertEquals([out.result.noMatch, out.result.linked], [1, 0]);
});

Deno.test(
  'lookup: a GHL id already linked to another contact is a conflict; only really linked rows are returned',
  async () => {
    const { sb } = fakeSupabase({
      claim: [row('c1', '+14155552671'), row('c2', '+14155552672')],
      linkedIds: ['c2'],
      conflicts: 1,
    });
    const out = await lookupUnlinkedContacts(
      sb,
      ghlWith({
        '+14155552671': [gc('g1', '+14155552671')],
        '+14155552672': [gc('g2', '+14155552672')],
      }),
      ARGS
    );
    assertEquals([out.result.linked, out.result.conflicts], [1, 1]);
    assertEquals(
      out.linked.map((r) => r.contact_id),
      ['c2']
    );
  }
);

Deno.test(
  'lookup: a deadline already passed claims nothing; a deadline hit mid-batch releases the unsearched tail',
  async () => {
    const past = fakeSupabase({ claim: [row('c1', '+14155552671')] });
    const r0 = await lookupUnlinkedContacts(past.sb, ghlWith({}), {
      ...ARGS,
      deadlineMs: Date.now() - 1,
    });
    assertEquals(r0.result.deadlineHit, true);
    assertEquals(past.rpcs.length, 0);

    const { sb, rpcs } = fakeSupabase({
      claim: [
        row('c1', '+14155552671', '2026-10-01T00:00:00Z'),
        row('c2', '+14155552672', '2026-10-02T00:00:00Z'),
      ],
    });
    const client = {
      searchContacts: async () => {
        await new Promise((r) => setTimeout(r, 60)); // the first search outlives the 30 ms budget
        return { contacts: [], count: 0 };
      },
    } as unknown as GhlClient;
    const out = await lookupUnlinkedContacts(sb, client, { ...ARGS, deadlineMs: Date.now() + 30 });
    assertEquals([out.result.deadlineHit, out.result.released], [true, 1]);
    assertEquals(rpcs.find((r) => r.fn === 'release_ghl_lookup_leases')?.args.p_items, [
      { contact_id: 'c2', prev_lookup_at: '2026-10-02T00:00:00Z' },
    ]);
  }
);

Deno.test(
  'lookup: transient search errors are handed back (outage -> all); a permanent 400 keeps the stamp',
  async () => {
    const transient = fakeSupabase({
      claim: [row('c1', '+14155552671', '2026-10-01T00:00:00Z'), row('c2', '+14155552672', null)],
    });
    const down = new Error('GHL API GET /contacts/ failed (503): down');
    await lookupUnlinkedContacts(
      transient.sb,
      ghlWith({ '+14155552671': down, '+14155552672': down }),
      ARGS
    );
    const rel = transient.rpcs.find((r) => r.fn === 'release_ghl_lookup_leases');
    assertEquals(rel?.args.p_items, [
      { contact_id: 'c1', prev_lookup_at: '2026-10-01T00:00:00Z' },
      { contact_id: 'c2', prev_lookup_at: null },
    ]);

    const permanent = fakeSupabase({ claim: [row('c1', '+14155552671')] });
    await lookupUnlinkedContacts(
      permanent.sb,
      ghlWith({ '+14155552671': new Error('GHL API GET /contacts/ failed (422): bad') }),
      ARGS
    );
    assertEquals(
      permanent.rpcs.some((r) => r.fn === 'release_ghl_lookup_leases'),
      false
    );
  }
);

Deno.test('lookup: a failed link hands the stamps back and throws', async () => {
  const { sb, rpcs } = fakeSupabase({
    claim: [row('c1', '+14155552671', null)],
    linkError: 'boom',
  });
  await assertRejects(
    () => lookupUnlinkedContacts(sb, ghlWith({ '+14155552671': [gc('g1', '+14155552671')] }), ARGS),
    Error,
    'link_ghl_contacts failed'
  );
  assertEquals(rpcs.find((r) => r.fn === 'release_ghl_lookup_leases')?.args.p_items, [
    { contact_id: 'c1', prev_lookup_at: null },
  ]);
});

Deno.test(
  'lookup: batchSize 0 turns it off; an unparsable phone is a no-match without a GHL call',
  async () => {
    const off = fakeSupabase({ claim: [row('c1', '+14155552671')] });
    const r = await lookupUnlinkedContacts(off.sb, ghlWith({}), { ...ARGS, batchSize: 0 });
    assertEquals([r.result.claimed, off.rpcs.length], [0, 0]);

    const calls: string[] = [];
    const bad = fakeSupabase({ claim: [row('c1', 'not a number')] });
    const out = await lookupUnlinkedContacts(bad.sb, ghlWith({}, calls), ARGS);
    assertEquals([out.result.noMatch, calls.length], [1, 0]);
  }
);
