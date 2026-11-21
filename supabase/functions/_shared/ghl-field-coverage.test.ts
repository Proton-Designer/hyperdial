import { assertEquals } from 'jsr:@std/assert@1';
import { buildPushCustomFields } from './ghl-sync-worker.ts';
import { GHL_FIELD_MAPPING_TARGET_KEYS } from './ghl-field-mapping.ts';
import { INTERN_SHIFT_FIELDS, PROVIDER_PUSH_FIELDS } from './ghl-field-catalog.ts';
import {
  classifyFieldCoverage,
  fetchCoverageDefs,
  type CoverageDef,
} from './ghl-field-coverage.ts';

const def = (
  id: string,
  fieldKey: string,
  dataType: string,
  options: string[] = []
): CoverageDef => ({
  id,
  name: fieldKey,
  fieldKey,
  dataType,
  options,
});

Deno.test(
  'provider catalog == the keys buildPushCustomFields writes (and only mapping keys)',
  () => {
    const mapping: Record<string, string> = {};
    for (const k of GHL_FIELD_MAPPING_TARGET_KEYS) mapping[k] = `id-${k}`;
    const written = buildPushCustomFields(mapping, {
      lastCallAt: 'x',
      lastCallOutcome: 'x',
      callAttempts: 1,
      licenseNumber: 'x',
      serviceZips: ['1'],
      callbackAt: 'x',
      callDurationSeconds: 0,
      recordingUrl: 'x',
      calledBy: 'x',
      calledByGhlUserId: 'x',
      leadList: 'x',
      topObjection: 'x',
    })
      .map((f) => f.id.replace(/^id-/, ''))
      .sort();
    assertEquals(PROVIDER_PUSH_FIELDS.map((f) => f.key).sort(), written);
    assertEquals(new Set(written).size, written.length);
  }
);

Deno.test('provider catalog: positive control -- an unpushed key would be caught', () => {
  // buildPushCustomFields ignores a mapping key it does not push (pull-only 'tier')
  const w = buildPushCustomFields({ tier: 'id-tier' }, { lastCallAt: 'x' });
  assertEquals(w, []);
  assertEquals(
    PROVIDER_PUSH_FIELDS.some((f) => f.key === 'tier'),
    false
  );
});

Deno.test('intern catalog == every shift field key the SQL emits (both directions)', async () => {
  const dir = new URL('../../migrations/', import.meta.url);
  let sql = '';
  for await (const e of Deno.readDir(dir)) {
    if (/^2026(1006|1019)\d+_shifts_.*\.sql$/.test(e.name)) {
      sql += await Deno.readTextFile(new URL(e.name, dir));
    }
  }
  const catalog = new Set(INTERN_SHIFT_FIELDS.map((f) => f.key));
  assertEquals(catalog.size, INTERN_SHIFT_FIELDS.length); // no duplicates
  for (const k of catalog) {
    if (!sql.includes(`'${k}'`))
      throw new Error(`catalog key ${k} not emitted by any shifts migration`);
  }
  // every GHL-field-looking key literal in the SQL must be in the catalog: last_shift_* / week_* and
  // (TASK-G22) the schedule/other prefixes shift_*, shifts_*, power_*, hyper_dialer_*
  const found = new Set(
    [...sql.matchAll(/'((?:last_shift|week|shift|shifts|power|hyper_dialer)_[a-z_]+)'/g)].map(
      (m) => m[1]
    )
  );
  // SQL string literals that are not GHL field keys (events, columns, error codes, tags' stems)
  const notFields = new Set([
    'week_closed',
    'week_start',
    'week_end',
    'week_lock',
    'week_submitted',
    'power_active_minutes',
    'power_pct',
    'power_week',
    'shift_completed',
    'shift_ended',
    'shift_missed',
    'shift_not_scheduled',
    'shift_over',
    'shift_request',
    'shift_request_reviewed',
    'shift_started',
    'shift_week_not_submitted',
    'shifts_disabled',
  ]);
  const stray = [...found].filter((k) => !catalog.has(k) && !notFields.has(k));
  assertEquals(stray, []);
});

Deno.test(
  'classifyFieldCoverage: provider statuses (ready / missing_in_ghl / not_mapped) + counts',
  () => {
    const r = classifyFieldCoverage({ called_by: 'f1', lead_list: 'gone', call_attempts: 'f3' }, [
      def('f1', 'contact.called_by', 'TEXT'),
      def('f3', 'contact.call_attempts', 'TEXT'),
    ]);
    const st = (k: string) => r.provider.items.find((i) => i.key === k)!;
    assertEquals(st('called_by').status, 'ready');
    assertEquals(st('lead_list').status, 'missing_in_ghl');
    assertEquals(st('last_call_at').status, 'not_mapped');
    assertEquals(st('call_attempts').status, 'ready');
    assertEquals(st('call_attempts').issues, ['type']); // NUMERICAL expected, TEXT in GHL
    assertEquals(r.provider.ready, 2);
    assertEquals(r.provider.total, PROVIDER_PUSH_FIELDS.length);
    assertEquals(r.total, PROVIDER_PUSH_FIELDS.length + INTERN_SHIFT_FIELDS.length);
  }
);

Deno.test(
  'classifyFieldCoverage: intern matched by fieldKey (with or without contact. prefix)',
  () => {
    const r = classifyFieldCoverage(null, [
      def('a', 'contact.week_dials', 'NUMERICAL'),
      def('b', 'last_shift_status', 'SINGLE_OPTIONS', ['completed']),
    ]);
    const st = (k: string) => r.intern.items.find((i) => i.key === k)!;
    assertEquals(st('week_dials').status, 'ready');
    assertEquals(st('week_dials').issues, []);
    assertEquals(st('last_shift_status').status, 'ready');
    assertEquals(st('last_shift_status').issues, ['options']);
    assertEquals(st('last_shift_status').missingOptions, ['missed']);
    assertEquals(st('week_sign_ups').status, 'missing');
    assertEquals(r.intern.ready, 2);
    assertEquals(r.provider.ready, 0); // no mapping at all
  }
);

Deno.test('classifyFieldCoverage: empty-string mapping id is not mapped; date accepts text', () => {
  const r = classifyFieldCoverage({ called_by: '' }, [def('d', 'contact.last_shift_date', 'TEXT')]);
  assertEquals(r.provider.items.find((i) => i.key === 'called_by')!.status, 'not_mapped');
  const d = r.intern.items.find((i) => i.key === 'last_shift_date')!;
  assertEquals([d.status, d.issues], ['ready', []]);
});

Deno.test(
  'fetchCoverageDefs: one GET, parses id/key/type/options, sends bearer + version',
  async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fake = ((url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return Promise.resolve(
        Response.json({
          fields: [
            {
              id: 'a',
              name: 'A',
              fieldKey: 'contact.x',
              dataType: 'SINGLE_OPTIONS',
              options: [{ key: 'k', label: 'One' }, 'Two'],
            },
            { id: 5, fieldKey: 'bad' },
          ],
        })
      );
    }) as unknown as typeof fetch;
    const defs = await fetchCoverageDefs('tok', 'loc 1', 'https://ghl.test', fake);
    assertEquals(calls.length, 1);
    assertEquals(
      calls[0].url,
      'https://ghl.test/custom-fields/object-key/contact?locationId=loc+1'
    );
    assertEquals(calls[0].headers.Authorization, 'Bearer tok');
    assertEquals(defs, [
      {
        id: 'a',
        name: 'A',
        fieldKey: 'contact.x',
        dataType: 'SINGLE_OPTIONS',
        options: ['One', 'Two'],
      },
    ]);
    const bad = (() =>
      Promise.resolve(new Response('no', { status: 403 }))) as unknown as typeof fetch;
    let threw = false;
    try {
      await fetchCoverageDefs('tok', 'loc', 'https://ghl.test', bad);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }
);

Deno.test(
  'classifyFieldCoverage: last_call_outcome may be text OR a dropdown (no false type warning); other text fields still warn on a dropdown (TASK-G20)',
  () => {
    const dropdown = classifyFieldCoverage({ last_call_outcome: 'o', called_by: 'c' }, [
      def('o', 'contact.last_call_outcome', 'SINGLE_OPTIONS', ['Callback']),
      def('c', 'contact.called_by', 'SINGLE_OPTIONS', ['Jane']),
    ]);
    const outcome = dropdown.provider.items.find((i) => i.key === 'last_call_outcome')!;
    assertEquals([outcome.status, outcome.issues], ['ready', []]);
    // a free-text field made a dropdown still warns (positive control: the allowance is per key)
    const calledBy = dropdown.provider.items.find((i) => i.key === 'called_by')!;
    assertEquals(calledBy.issues, ['type']);
    // and a number field is still wrong for last_call_outcome
    const num = classifyFieldCoverage({ last_call_outcome: 'o' }, [
      def('o', 'contact.last_call_outcome', 'NUMERICAL'),
    ]);
    assertEquals(num.provider.items.find((i) => i.key === 'last_call_outcome')!.issues, ['type']);
  }
);

Deno.test(
  'fetchCoverageDefs: throttles through the injected limiter BEFORE the request',
  async () => {
    const order: string[] = [];
    const limiter = {
      throttle: () => {
        order.push('throttle');
        return Promise.resolve();
      },
    };
    const fake = (() => {
      order.push('fetch');
      return Promise.resolve(Response.json({ fields: [] }));
    }) as unknown as typeof fetch;
    await fetchCoverageDefs('tok', 'loc', 'https://ghl.test', fake, limiter);
    assertEquals(order, ['throttle', 'fetch']);
  }
);
