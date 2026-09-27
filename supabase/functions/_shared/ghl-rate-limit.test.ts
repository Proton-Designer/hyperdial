import { assertEquals } from 'jsr:@std/assert@1';
import { createGhlRateLimiter, withGhlRateLimit } from './ghl-rate-limit.ts';

/** A fake clock + sleep so the pacing math is provable without a real wait. `sleep(ms)` advances
 *  the fake clock by exactly `ms` before resolving -- deterministic, no flakiness. */
function makeFakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

Deno.test('createGhlRateLimiter: calls under the cap never wait', async () => {
  const clock = makeFakeClock();
  const limiter = createGhlRateLimiter({
    maxPerWindow: 3,
    windowMs: 10_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  await limiter.throttle();
  await limiter.throttle();
  await limiter.throttle();
  assertEquals(clock.now(), 0); // no sleep was ever needed
});

Deno.test(
  'createGhlRateLimiter: the (maxPerWindow + 1)th call within the window waits',
  async () => {
    const clock = makeFakeClock();
    const limiter = createGhlRateLimiter({
      maxPerWindow: 2,
      windowMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.throttle(); // t=0
    await limiter.throttle(); // t=0
    await limiter.throttle(); // must wait until the first call (t=0) falls out of the 10s window
    assertEquals(clock.now() >= 10_000, true);
  }
);

Deno.test(
  'createGhlRateLimiter: a call outside the window never waits, even after the cap was hit',
  async () => {
    const clock = makeFakeClock();
    const limiter = createGhlRateLimiter({
      maxPerWindow: 1,
      windowMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.throttle(); // t=0
    clock.advance(10_001); // window has fully elapsed
    const before = clock.now();
    await limiter.throttle();
    assertEquals(clock.now(), before); // no additional wait needed
  }
);

Deno.test(
  "createGhlRateLimiter: defaults match GHL's published burst limit (100/10s)",
  async () => {
    const clock = makeFakeClock();
    const limiter = createGhlRateLimiter({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 100; i++) {
      await limiter.throttle();
    }
    assertEquals(clock.now(), 0); // exactly 100 calls fit in the window with zero waiting
    await limiter.throttle(); // the 101st must wait
    assertEquals(clock.now() >= 10_000, true);
  }
);

Deno.test(
  'withGhlRateLimit: throttles before delegating, and returns the real result',
  async () => {
    const clock = makeFakeClock();
    const limiter = createGhlRateLimiter({
      maxPerWindow: 1,
      windowMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    let calls = 0;
    const fakeClient = {
      getContact: async (id: string) => {
        calls++;
        return { id };
      },
    };
    const wrapped = withGhlRateLimit(fakeClient, limiter);
    const first = await wrapped.getContact('c1');
    const second = await wrapped.getContact('c2');
    assertEquals(first, { id: 'c1' });
    assertEquals(second, { id: 'c2' });
    assertEquals(calls, 2);
    assertEquals(clock.now() >= 10_000, true); // the second call had to wait
  }
);
