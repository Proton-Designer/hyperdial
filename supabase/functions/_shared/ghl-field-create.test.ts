import { assertEquals } from 'jsr:@std/assert@1';
import { INTERN_SHIFT_FIELDS, PROVIDER_PUSH_FIELDS } from './ghl-field-catalog.ts';
import { classifyFieldCoverage, type CoverageDef } from './ghl-field-coverage.ts';
import {
  buildCreateFieldBody,
  createMissingFields,
  optionKeys,
  PERMISSION_MESSAGE,
  planCreateMissing,
  runCreateMissing,
} from './ghl-field-create.ts';

const def = (id: string, fieldKey: string, dataType = 'TEXT'): CoverageDef => ({
  id,
  name: fieldKey,
  fieldKey,
  dataType,
  options: [],
});
const spec = (key: string) =>
  [...PROVIDER_PUSH_FIELDS, ...INTERN_SHIFT_FIELDS].find((s) => s.key === key)!;

Deno.test('optionKeys: slug, unique, never empty (TASK-G29)', () => {
  assertEquals(optionKeys(['Bad numbers', 'Did not know the answer']), [
    'bad_numbers',
    'did_not_know_the_answer',
  ]);
  assertEquals(optionKeys(['A b', 'a-b']), ['a_b', 'a_b_2']);
  assertEquals(optionKeys(['???']), ['option_1']);
});

Deno.test(
  'buildCreateFieldBody: URL body per type -- text, number, large text, date, dropdown with EXACT labels',
  () => {
    const base = {
      locationId: 'loc-1',
      objectKey: 'contact',
      parentId: 'fold-1',
      showInForms: true,
    };
    assertEquals(buildCreateFieldBody(spec('last_call_at'), 'loc-1', 'fold-1'), {
      ...base,
      name: 'Last Call At',
      dataType: 'TEXT',
      fieldKey: 'contact.last_call_at',
    });
    assertEquals(
      buildCreateFieldBody(spec('call_attempts'), 'loc-1', 'fold-1').dataType,
      'NUMERICAL'
    );
    assertEquals(
      buildCreateFieldBody(spec('service_zips'), 'loc-1', 'fold-1').dataType,
      'LARGE_TEXT'
    );
    assertEquals(buildCreateFieldBody(spec('last_shift_date'), 'loc-1', 'fold-1').dataType, 'DATE');
    const dd = buildCreateFieldBody(spec('last_shift_slowed_by'), 'loc-1', 'fold-1');
    assertEquals(dd.dataType, 'SINGLE_OPTIONS');
    assertEquals(dd.fieldKey, 'contact.last_shift_slowed_by');
    assertEquals(dd.options, [
      { key: 'bad_numbers', label: 'Bad numbers' },
      { key: 'dialer_issue', label: 'Dialer issue' },
      { key: 'did_not_know_the_answer', label: 'Did not know the answer' },
      { key: 'script_felt_off', label: 'Script felt off' },
      { key: 'nothing', label: 'Nothing' },
    ]);
    assertEquals('options' in buildCreateFieldBody(spec('last_call_at'), 'l', 'f'), false);
  }
);

Deno.test('every catalog dropdown sends its labels unchanged', () => {
  for (const s of [...PROVIDER_PUSH_FIELDS, ...INTERN_SHIFT_FIELDS].filter((x) => x.options)) {
    const opts = buildCreateFieldBody(s, 'l', 'f').options as { label: string }[];
    assertEquals(
      opts.map((o) => o.label),
      s.options
    );
  }
});

Deno.test(
  'planCreateMissing: empty location -> everything; existing key -> map only; ready -> nothing',
  () => {
    const empty = classifyFieldCoverage({}, []);
    const plan = planCreateMissing(empty, []);
    assertEquals(plan.toCreate.length, PROVIDER_PUSH_FIELDS.length + INTERN_SHIFT_FIELDS.length);
    assertEquals(plan.toMap, []);

    const defs = [
      def('d1', 'contact.last_call_at'),
      def('d2', 'contact.last_shift_dials', 'NUMERICAL'),
    ];
    const cov = classifyFieldCoverage({}, defs);
    const p2 = planCreateMissing(cov, defs);
    assertEquals(p2.toMap, [{ key: 'last_call_at', label: 'Last Call At', id: 'd1' }]);
    assertEquals(
      p2.toCreate.some((c) => c.spec.key === 'last_call_at'),
      false
    );
    assertEquals(
      p2.toCreate.some((c) => c.spec.key === 'last_shift_dials'),
      false
    );

    // fully set up -> nothing to do (idempotent)
    const all: CoverageDef[] = [];
    const mapping: Record<string, string> = {};
    for (const s of PROVIDER_PUSH_FIELDS) {
      all.push(def(`id-${s.key}`, `contact.${s.key}`, s.type));
      mapping[s.key] = `id-${s.key}`;
    }
    for (const s of INTERN_SHIFT_FIELDS) all.push(def(`i-${s.key}`, `contact.${s.key}`, s.type));
    const done = planCreateMissing(classifyFieldCoverage(mapping, all), all);
    assertEquals([done.toCreate.length, done.toMap.length], [0, 0]);
  }
);

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
function fakeFetch(
  handler: (c: Call) => Response,
  calls: Call[] = []
): { fetchImpl: typeof fetch; calls: Call[] } {
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(c);
    return Promise.resolve(handler(c));
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const io = (fetchImpl: typeof fetch) => ({ token: 'tok', locationId: 'loc-1', fetchImpl });

Deno.test(
  'createMissingFields: creates the folder when absent, then each field; provider ids come back for the mapping',
  async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeFetch((c) => {
      if (c.method === 'GET')
        return Response.json({ fields: [], folders: [{ id: 'f9', name: 'Other' }] });
      if (c.url.endsWith('/custom-fields/folder'))
        return Response.json({ id: 'fold-1', name: 'HyperDial' }, { status: 201 });
      return Response.json({ field: { id: `new-${++n}` } }, { status: 201 });
    });
    const plan = {
      toCreate: [
        { group: 'provider' as const, spec: spec('last_call_at') },
        { group: 'intern' as const, spec: spec('last_shift_dials') },
      ],
      toMap: [{ key: 'called_by', label: 'Called By', id: 'exist-1' }],
    };
    const r = await createMissingFields(io(fetchImpl), plan);
    assertEquals(
      calls[0].url,
      'https://services.leadconnectorhq.com/custom-fields/object-key/contact?locationId=loc-1'
    );
    assertEquals(calls[1], {
      method: 'POST',
      url: 'https://services.leadconnectorhq.com/custom-fields/folder',
      body: { objectKey: 'contact', name: 'HyperDial', locationId: 'loc-1' },
    });
    assertEquals(calls[2].url, 'https://services.leadconnectorhq.com/custom-fields/');
    assertEquals(calls[2].body?.parentId, 'fold-1');
    assertEquals(calls[2].body?.fieldKey, 'contact.last_call_at');
    assertEquals(
      r.created.map((c) => c.key),
      ['last_call_at', 'last_shift_dials']
    );
    assertEquals(r.mappingAdditions, { called_by: 'exist-1', last_call_at: 'new-1' }); // intern ids are not mapped
    assertEquals([r.failed, r.stopped, r.notAttempted], [[], null, 0]);
  }
);

Deno.test(
  'createMissingFields: an existing HyperDial folder is reused (no folder POST)',
  async () => {
    const { fetchImpl, calls } = fakeFetch((c) =>
      c.method === 'GET'
        ? Response.json({ fields: [], folders: [{ id: 'f1', name: 'hyperdial' }] })
        : Response.json({ field: { id: 'x' } }, { status: 201 })
    );
    await createMissingFields(io(fetchImpl), {
      toCreate: [{ group: 'intern', spec: spec('week_dials') }],
      toMap: [],
    });
    assertEquals(
      calls.some((c) => c.url.endsWith('/folder')),
      false
    );
    assertEquals(calls[1].body?.parentId, 'f1');
  }
);

Deno.test('createMissingFields: 403 stops the run with the plain permission message', async () => {
  const { fetchImpl, calls } = fakeFetch((c) =>
    c.method === 'GET'
      ? Response.json({ fields: [], folders: [{ id: 'f1', name: 'HyperDial' }] })
      : new Response('{"message":"forbidden"}', { status: 403 })
  );
  const plan = {
    toCreate: ['week_dials', 'week_connects', 'week_sign_ups'].map((k) => ({
      group: 'intern' as const,
      spec: spec(k),
    })),
    toMap: [],
  };
  const r = await createMissingFields(io(fetchImpl), plan);
  assertEquals(r.stopped, PERMISSION_MESSAGE);
  assertEquals([r.created.length, r.notAttempted], [0, 3]);
  assertEquals(calls.length, 2); // list + one create attempt, then stop
});

Deno.test('createMissingFields: one bad field is reported, the rest continue', async () => {
  const { fetchImpl } = fakeFetch((c) => {
    if (c.method === 'GET')
      return Response.json({ fields: [], folders: [{ id: 'f1', name: 'HyperDial' }] });
    return c.body?.fieldKey === 'contact.week_dials'
      ? new Response('{"message":"fieldKey already exists"}', { status: 400 })
      : Response.json({ field: { id: 'ok' } }, { status: 201 });
  });
  const plan = {
    toCreate: ['week_dials', 'week_connects'].map((k) => ({
      group: 'intern' as const,
      spec: spec(k),
    })),
    toMap: [],
  };
  const r = await createMissingFields(io(fetchImpl), plan);
  assertEquals(
    r.created.map((c) => c.key),
    ['week_connects']
  );
  assertEquals(
    r.failed.map((f) => f.key),
    ['week_dials']
  );
  assertEquals(r.failed[0].error.includes('already exists'), true);
  assertEquals(r.stopped, null);
});

Deno.test('createMissingFields: nothing to create -> no GHL call at all', async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response('{}'));
  const r = await createMissingFields(io(fetchImpl), {
    toCreate: [],
    toMap: [{ key: 'called_by', label: 'Called By', id: 'e' }],
  });
  assertEquals(calls.length, 0);
  assertEquals(r.mappingAdditions, { called_by: 'e' });
});

Deno.test(
  'runCreateMissing: end to end on an empty location, then a second press creates nothing (idempotent)',
  async () => {
    const store: CoverageDef[] = [];
    let mapping: Record<string, string> = {};
    let n = 0;
    const { fetchImpl, calls } = fakeFetch((c) => {
      if (c.method === 'GET')
        return Response.json({ fields: [], folders: [{ id: 'f1', name: 'HyperDial' }] });
      const id = `new-${++n}`;
      store.push({
        id,
        name: String(c.body?.name),
        fieldKey: String(c.body?.fieldKey),
        dataType: String(c.body?.dataType),
        options: ((c.body?.options as { label: string }[] | undefined) ?? []).map((o) => o.label),
      });
      return Response.json({ field: { id } }, { status: 201 });
    });
    const deps = () => ({
      mapping,
      loadDefs: () => Promise.resolve([...store]),
      io: io(fetchImpl),
      saveMapping: (m: Record<string, string>) => {
        mapping = m;
        return Promise.resolve();
      },
    });
    const first = await runCreateMissing(deps());
    const total = PROVIDER_PUSH_FIELDS.length + INTERN_SHIFT_FIELDS.length;
    assertEquals(first.result.created.length, total);
    assertEquals(Object.keys(mapping).sort(), PROVIDER_PUSH_FIELDS.map((s) => s.key).sort());
    assertEquals([first.coverage.ready, first.coverage.total], [total, total]);
    assertEquals(
      first.coverage.provider.items.every((i) => i.issues.length === 0),
      true
    );
    assertEquals(
      first.coverage.intern.items.every((i) => i.issues.length === 0),
      true
    );

    const posts = calls.filter((c) => c.method === 'POST').length;
    const second = await runCreateMissing(deps());
    assertEquals([second.result.created.length, second.result.mapped.length], [0, 0]);
    assertEquals(calls.filter((c) => c.method === 'POST').length, posts); // no new POST
  }
);

Deno.test('runCreateMissing: a mapping save failure is reported, fields stay created', async () => {
  const { fetchImpl } = fakeFetch((c) =>
    c.method === 'GET'
      ? Response.json({ fields: [], folders: [{ id: 'f1', name: 'HyperDial' }] })
      : Response.json({ field: { id: 'z' } }, { status: 201 })
  );
  const out = await runCreateMissing({
    mapping: {},
    loadDefs: () => Promise.resolve([]),
    io: io(fetchImpl),
    saveMapping: () => Promise.reject(new Error('db down')),
  });
  assertEquals(out.mappingError, 'db down');
  assertEquals(out.result.created.length > 0, true);
});
