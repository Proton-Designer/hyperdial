import { assertEquals } from 'jsr:@std/assert@1';
import {
  PAGE_LIMIT,
  decodeCursor,
  encodeCursor,
  handlePublicApi,
  parseIsoInstant,
  sha256Hex,
  type CallRow,
  type PublicApiDeps,
} from './public-api-core.ts';

const KEY_A = 'hd_live_' + 'A'.repeat(43);
const KEY_B = 'hd_live_' + 'B'.repeat(43);
const KEY_REVOKED = 'hd_live_' + 'R'.repeat(43);
const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}

function row(n: number, org: string, extra: Partial<CallRow> = {}): CallRow & { org: string } {
  return {
    org,
    id: uuid(n),
    ended_at: new Date(Date.UTC(2026, 10, 19, 10, 0, 0) + n * 1000).toISOString(),
    duration_seconds: 60,
    agent_name: 'Rayan',
    agent_email: 'r@x.com',
    campaign: 'C',
    disposition: 'Not interested',
    contact_name: 'N',
    contact_business: 'B',
    contact_phone: '+12145550123',
    contact_email: null,
    contact_timezone: 'America/Chicago',
    contact_notes: null,
    callback_at: null,
    recording_path: `${org}/${n}.mp3`,
    recording_status: 'saved',
    recording_channels: 2,
    ...extra,
  };
}

async function setup(
  rows: (CallRow & { org: string })[],
  opts: { signFail?: boolean; signThrow?: boolean } = {}
) {
  const hashes = new Map<string, { org_id: string; key_id: string; allowed: boolean }>();
  hashes.set(await sha256Hex(KEY_A), { org_id: ORG_A, key_id: 'ka', allowed: true });
  hashes.set(await sha256Hex(KEY_B), { org_id: ORG_B, key_id: 'kb', allowed: true });
  const calls: { orgId: string }[] = [];
  const deps: PublicApiDeps = {
    checkKey: (h) => Promise.resolve(hashes.get(h) ?? null), // KEY_REVOKED is simply not present
    listCalls: (a) => {
      calls.push({ orgId: a.orgId });
      const out = rows
        .filter((r) => r.org === a.orgId && r.ended_at > (a.since === '-infinity' ? '' : a.since))
        .filter(
          (r) =>
            !a.afterEndedAt ||
            r.ended_at > a.afterEndedAt ||
            (r.ended_at === a.afterEndedAt && r.id > a.afterId!)
        )
        .sort((x, y) => (x.ended_at + x.id < y.ended_at + y.id ? -1 : 1))
        .slice(0, a.limit);
      return Promise.resolve(out);
    },
    signUrl: (p) => {
      if (opts.signThrow) return Promise.reject(new Error('storage 503'));
      return Promise.resolve(opts.signFail ? null : `https://signed/${p}`);
    },
  };
  return { deps, calls, hashes };
}

const get = (qs: string, key: string | null, path = '/public-api/v1/calls') =>
  new Request(`https://x.test${path}${qs}`, { headers: key ? { 'x-api-key': key } : {} });

Deno.test(
  'auth: missing, malformed, unknown and revoked keys get 401 and never reach the data layer',
  async () => {
    const { deps, calls } = await setup([row(1, ORG_A)]);
    for (const k of [null, '', 'nope', KEY_REVOKED, 'hd_live_short']) {
      const res = await handlePublicApi(get('?since=2026-01-01', k), deps);
      assertEquals(res.status, 401);
      await res.text();
    }
    assertEquals(calls.length, 0);
  }
);

Deno.test('only GET on /v1/calls', async () => {
  const { deps } = await setup([]);
  const post = await handlePublicApi(
    new Request('https://x.test/public-api/v1/calls', {
      method: 'POST',
      headers: { 'x-api-key': KEY_A },
    }),
    deps
  );
  assertEquals(post.status, 405);
  await post.text();
  const other = await handlePublicApi(
    get('?since=2026-01-01', KEY_A, '/public-api/v1/contacts'),
    deps
  );
  assertEquals(other.status, 404);
  await other.text();
});

Deno.test(
  'org isolation: key of org A never returns org B rows (and the org is never read from the request)',
  async () => {
    const { deps } = await setup([row(1, ORG_A), row(2, ORG_B), row(3, ORG_A)]);
    const res = await handlePublicApi(
      get(`?since=2026-01-01&org_id=${ORG_B}&org=${ORG_B}`, KEY_A),
      deps
    );
    const body = await res.json();
    assertEquals(
      body.calls.map((c: { id: string }) => c.id),
      [uuid(1), uuid(3)]
    );
    const resB = await handlePublicApi(get('?since=2026-01-01', KEY_B), deps);
    assertEquals(
      (await resB.json()).calls.map((c: { id: string }) => c.id),
      [uuid(2)]
    );
  }
);

Deno.test('since: required without cursor, validated, and filters', async () => {
  const { deps } = await setup([row(1, ORG_A), row(5, ORG_A)]);
  assertEquals((await handlePublicApi(get('', KEY_A), deps)).status, 400);
  assertEquals((await handlePublicApi(get('?since=yesterday', KEY_A), deps)).status, 400);
  assertEquals(
    (await handlePublicApi(get('?since=2026-13-45T00:00:00Z', KEY_A), deps)).status,
    400
  );
  const res = await handlePublicApi(get('?since=2026-11-19T10:00:03Z', KEY_A), deps);
  assertEquals(
    (await res.json()).calls.map((c: { id: string }) => c.id),
    [uuid(5)]
  ); // strictly after
});

Deno.test(
  'cursor paging: 450 rows come back as 200 + 200 + 50, oldest first, no gaps or repeats',
  async () => {
    const rows = Array.from({ length: 450 }, (_, i) => row(i + 1, ORG_A));
    // ties on ended_at must still page cleanly
    rows[10] = { ...rows[10], ended_at: rows[9].ended_at };
    const { deps } = await setup(rows);
    const seen: string[] = [];
    let qs = '?since=2026-01-01';
    const sizes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await handlePublicApi(get(qs, KEY_A), deps);
      const body = await res.json();
      sizes.push(body.calls.length);
      seen.push(...body.calls.map((c: { id: string }) => c.id));
      if (body.calls.length === 0) break;
      qs = `?cursor=${body.next_cursor}`;
    }
    assertEquals(sizes, [PAGE_LIMIT, PAGE_LIMIT, 50, 0]);
    assertEquals(new Set(seen).size, 450);
    assertEquals(seen.length, 450);
  }
);

Deno.test('cursor: bad cursors are 400; round-trips', async () => {
  const { deps } = await setup([]);
  for (const c of [
    'x',
    '!!!!!!!!!!!!',
    btoa('[1,2]').replace(/=/g, ''),
    btoa('["2026-01-01T00:00:00Z","not-a-uuid"]').replace(/=/g, ''),
  ]) {
    const res = await handlePublicApi(get(`?cursor=${c}`, KEY_A), deps);
    assertEquals(res.status, 400);
    await res.text();
  }
  const c = encodeCursor('2026-11-19T10:00:01.000Z', uuid(7));
  assertEquals(decodeCursor(c), { endedAt: '2026-11-19T10:00:01.000Z', id: uuid(7) });
});

Deno.test(
  'recording: signed url + channel map; missing recording -> nulls + status; sign failure never fails the page',
  async () => {
    const rows = [
      row(1, ORG_A),
      row(2, ORG_A, {
        recording_path: null,
        recording_status: 'pending',
        recording_channels: null,
      }),
    ];
    const ok = await (
      await handlePublicApi(get('?since=2026-01-01', KEY_A), (await setup(rows)).deps)
    ).json();
    assertEquals(ok.calls[0].recording_url, `https://signed/${ORG_A}/1.mp3`);
    assertEquals(ok.calls[0].recording_channels, 2);
    assertEquals(ok.calls[0].recording_channel_map, { left: 'contact', right: 'agent' });
    assertEquals(ok.calls[1].recording_url, null);
    assertEquals(ok.calls[1].recording_status, 'pending');
    assertEquals(ok.calls[1].recording_channel_map, null);
    assertEquals('recording_error' in ok.calls[1], false);

    for (const o of [{ signFail: true }, { signThrow: true }]) {
      const res = await handlePublicApi(
        get('?since=2026-01-01', KEY_A),
        (await setup(rows, o)).deps
      );
      assertEquals(res.status, 200);
      const b = await res.json();
      assertEquals(b.calls[0].recording_url, null);
      assertEquals(b.calls[0].recording_error, 'signing_failed');
      assertEquals(b.calls.length, 2);
    }
  }
);

Deno.test(
  'rate limit: over the limit is 429 with Retry-After; data layer failure is 500, key layer failure 503',
  async () => {
    const { deps } = await setup([row(1, ORG_A)]);
    const limited = await handlePublicApi(get('?since=2026-01-01', KEY_A), {
      ...deps,
      checkKey: () => Promise.resolve({ org_id: ORG_A, key_id: 'k', allowed: false }),
    });
    assertEquals(limited.status, 429);
    assertEquals(limited.headers.has('Retry-After'), true);
    await limited.text();
    const boom = await handlePublicApi(get('?since=2026-01-01', KEY_A), {
      ...deps,
      listCalls: () => Promise.reject(new Error('db')),
    });
    assertEquals(boom.status, 500);
    assertEquals((await boom.text()).includes('db'), false);
    const down = await handlePublicApi(get('?since=2026-01-01', KEY_A), {
      ...deps,
      checkKey: () => Promise.reject(new Error('db')),
    });
    assertEquals(down.status, 503);
    await down.text();
  }
);

Deno.test('response shape matches the request', async () => {
  const { deps } = await setup([row(1, ORG_A)]);
  const b = await (await handlePublicApi(get('?since=2026-01-01', KEY_A), deps)).json();
  assertEquals(Object.keys(b.calls[0]).sort(), [
    'agent',
    'callback_at',
    'campaign',
    'contact',
    'disposition',
    'duration_seconds',
    'ended_at',
    'id',
    'recording_channel_map',
    'recording_channels',
    'recording_status',
    'recording_url',
  ]);
  assertEquals(Object.keys(b.calls[0].contact).sort(), [
    'business',
    'email',
    'name',
    'notes',
    'phone',
    'timezone',
  ]);
  assertEquals(typeof b.next_cursor, 'string');
});

Deno.test('parseIsoInstant', () => {
  assertEquals(parseIsoInstant('2026-11-19'), '2026-11-19T00:00:00.000Z');
  assertEquals(parseIsoInstant('2026-11-19T17:47:53+02:00'), '2026-11-19T15:47:53.000Z');
  assertEquals(parseIsoInstant('2026-11-19T17:47:53'), '2026-11-19T17:47:53.000Z');
  assertEquals(parseIsoInstant('1; drop table'), null);
});
