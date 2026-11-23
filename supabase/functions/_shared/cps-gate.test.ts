import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { awaitDialSlot } from './cps-gate.ts';

function fakeSupabase(result: { data: unknown; error: { message: string } | null }) {
  const calls: { name: string; args: unknown }[] = [];
  return {
    calls,
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return Promise.resolve(result);
    },
  };
}

Deno.test('awaitDialSlot: a slot available now dials without sleeping', async () => {
  const sb = fakeSupabase({ data: 0, error: null });
  const slept: number[] = [];
  await awaitDialSlot(sb, 'org-1', { sleep: (ms) => (slept.push(ms), Promise.resolve()) });
  assertEquals(sb.calls, [{ name: 'reserve_dial_slot', args: { p_org: 'org-1' } }]);
  assertEquals(slept, []);
});

Deno.test('awaitDialSlot: sleeps exactly the wait the RPC returns', async () => {
  const sb = fakeSupabase({ data: 640, error: null });
  const slept: number[] = [];
  await awaitDialSlot(sb, 'org-1', { sleep: (ms) => (slept.push(ms), Promise.resolve()) });
  assertEquals(slept, [640]);
});

Deno.test('awaitDialSlot: fails open on an RPC error', async () => {
  const sb = fakeSupabase({ data: null, error: { message: 'boom' } });
  const slept: number[] = [];
  await awaitDialSlot(sb, 'org-1', { sleep: (ms) => (slept.push(ms), Promise.resolve()) });
  assertEquals(slept, []);
});

Deno.test('awaitDialSlot: throws when the slot is further away than maxWaitMs', async () => {
  const sb = fakeSupabase({ data: 20_000, error: null });
  await assertRejects(
    () => awaitDialSlot(sb, 'org-1', { maxWaitMs: 15_000, sleep: () => Promise.resolve() }),
    Error,
    'cps_gate_timeout'
  );
});
