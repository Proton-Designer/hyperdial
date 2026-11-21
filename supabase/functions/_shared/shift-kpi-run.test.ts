import { assertEquals } from 'jsr:@std/assert@1';
import { processShift, type KpiDeps, type KpiRunShift } from './shift-kpi-run.ts';

const SETTINGS = {
  timezone: 'America/Chicago',
  grace_minutes: 10,
  idle_flag_minutes: 20,
  adherence_flag_pct: 75,
  conversation_min_seconds: 60,
  open_session_tail_minutes: 5,
};
const shift = (over: Partial<KpiRunShift> = {}): KpiRunShift => ({
  id: 's1',
  org_id: 'o',
  user_id: 'u',
  activity: 'dialing',
  starts_at: '2026-10-13T19:00:00Z',
  ends_at: '2026-10-13T21:00:00Z',
  ...over,
});

function deps(nowIso: string, over: Partial<KpiDeps> = {}) {
  const saved: { id: string; flags: string[] | null; final: boolean }[] = [];
  const d: KpiDeps = {
    nowMs: Date.parse(nowIso),
    settings: () => Promise.resolve(SETTINGS),
    windows: () => Promise.resolve([]),
    inputs: () => Promise.resolve({ events: [], legs: [], last_leg_end: {} }),
    save: (id, kpi, final) => {
      saved.push({ id, flags: kpi ? kpi.flags : null, final });
      return Promise.resolve(
        final ? (kpi?.flags.includes('no_show') ? 'missed' : 'completed') : 'saved'
      );
    },
    ...over,
  };
  return { d, saved };
}

Deno.test('a dialing shift that has not started is left alone', async () => {
  const { d, saved } = deps('2026-10-13T18:00:00Z');
  assertEquals(await processShift(d, shift()), { action: 'none' });
  assertEquals(saved, []);
});

Deno.test('in progress: saved as live numbers, never final', async () => {
  const { d, saved } = deps('2026-10-13T20:00:00Z');
  const r = await processShift(d, shift());
  assertEquals(r.action, 'saved');
  assertEquals(
    saved.map((s) => s.final),
    [false]
  );
});

Deno.test('ended less than 2 hours ago: still not final; after 2 hours: final', async () => {
  const early = deps('2026-10-13T22:30:00Z');
  assertEquals((await processShift(early.d, shift())).action, 'saved');
  assertEquals(early.saved[0].final, false);
  const late = deps('2026-10-13T23:30:00Z');
  const r = await processShift(late.d, shift());
  assertEquals(r.action, 'finalized');
  assertEquals(late.saved[0].final, true);
});

Deno.test('zero dials finalizes as missed (the no_show flag decides)', async () => {
  const { d } = deps('2026-10-14T00:00:00Z');
  const r = await processShift(d, shift());
  assertEquals(r.action === 'finalized' && r.status, 'missed');
});

Deno.test('a client (live) call never finalizes, even long after the shift', async () => {
  const { d, saved } = deps('2026-10-14T05:00:00Z');
  const r = await processShift(d, shift(), { live: true });
  assertEquals(r.action, 'saved');
  assertEquals(saved[0].final, false);
});

Deno.test(
  'non-dialing shifts: completed at end with no KPIs; nothing before; nothing for a client call',
  async () => {
    const social = shift({ activity: 'social' });
    const before = deps('2026-10-13T20:00:00Z');
    assertEquals(await processShift(before.d, social), { action: 'none' });
    const after = deps('2026-10-13T21:01:00Z');
    assertEquals(await processShift(after.d, social), {
      action: 'finalized',
      status: 'completed',
      kpi: null,
    });
    assertEquals(after.saved, [{ id: 's1', flags: null, final: true }]);
    assertEquals(await processShift(after.d, social, { live: true }), { action: 'none' });
  }
);

Deno.test(
  'a save that answers skipped (a manager changed the shift) is reported as skipped',
  async () => {
    const { d } = deps('2026-10-14T00:00:00Z', { save: () => Promise.resolve('skipped') });
    assertEquals((await processShift(d, shift())).action, 'skipped');
  }
);

Deno.test('missing inputs (shift gone) -> none', async () => {
  const { d, saved } = deps('2026-10-13T20:00:00Z', { inputs: () => Promise.resolve(null) });
  assertEquals(await processShift(d, shift()), { action: 'none' });
  assertEquals(saved, []);
});
