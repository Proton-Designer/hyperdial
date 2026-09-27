/**
 * TASK-T1 (MISSION-4, GHL-2 shared helper -- GHL-2 itself is formally T2's task; this file is
 * built here per T1's own instruction ("share the limiter helper you build here") since T1 is
 * the first GHL caller in this mission that makes enough requests per run (paging every contact/
 * opportunity in a location) to actually risk tripping a rate limit).
 *
 * GHL's OpenAPI specs (opportunities.json, contacts.json, users.json, custom-fields.json --
 * curled 2026-09-26, never WebFetched) contain NO `x-ratelimit-*` extension anywhere -- rate
 * limits aren't modeled in the spec at all. The published numbers (100 requests/10s burst,
 * 200,000/day, per sub-account) come from GHL's marketplace docs SITE, which this codebase has
 * already established (ghl-client.ts's own header) is a client-rendered Docusaurus app a plain
 * `fetch` can't read -- so these numbers are cited from that documentation, not independently
 * re-derived from a machine-readable source, and should be corrected the first time a live 429
 * response's own headers (`X-RateLimit-*` or similar) are actually observed.
 *
 * A simple sliding-window pacer, not a full token bucket: `throttle()` records this call's
 * timestamp, drops timestamps older than the window, and awaits (sleeps) just long enough that
 * the window never holds more than `maxPerWindow` calls. Injectable `now`/`sleep` so a deno test
 * never has to actually wait 10 real seconds to prove the pacing math.
 */

export const GHL_RATE_LIMIT_MAX_PER_WINDOW = 100;
export const GHL_RATE_LIMIT_WINDOW_MS = 10_000;

export interface GhlRateLimiterOptions {
  maxPerWindow?: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GhlRateLimiter {
  /** Call once immediately before every outgoing GHL request. Resolves immediately if the
   *  sliding window has room; otherwise awaits until the oldest call in the window falls out of
   *  it. */
  throttle(): Promise<void>;
}

/** Wraps every method of a real `GhlClient` so it calls `limiter.throttle()` immediately before
 *  making the underlying HTTP request -- lets a caller (e.g. `ghl-pull-run.ts`, which may fetch
 *  hundreds of contacts/opportunities/detail records in one run) rate-limit an EXISTING client
 *  without changing the signature of anything that already takes a plain `GhlClient` (
 *  `fetchAllGhlContacts`, `planGhlImport`'s callers, etc). Not implemented as a change to
 *  `createGhlClient` itself: rate limiting is a concern of the CALLER's own request volume (a
 *  single ad-hoc `ghl-import` call rarely needs it), not of the client construction itself. */
// deno-lint-ignore no-explicit-any
export function withGhlRateLimit<T extends Record<string, any>>(
  client: T,
  limiter: GhlRateLimiter
): T {
  const wrapped = {} as Record<string, unknown>;
  for (const key of Object.keys(client)) {
    const original = (client as Record<string, unknown>)[key];
    if (typeof original !== 'function') {
      wrapped[key] = original;
      continue;
    }
    wrapped[key] = async (...args: unknown[]) => {
      await limiter.throttle();
      return (original as (...a: unknown[]) => Promise<unknown>).apply(client, args);
    };
  }
  return wrapped as T;
}

export function createGhlRateLimiter(options: GhlRateLimiterOptions = {}): GhlRateLimiter {
  const maxPerWindow = options.maxPerWindow ?? GHL_RATE_LIMIT_MAX_PER_WINDOW;
  const windowMs = options.windowMs ?? GHL_RATE_LIMIT_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const callTimestamps: number[] = [];

  return {
    async throttle() {
      for (;;) {
        const cutoff = now() - windowMs;
        while (callTimestamps.length > 0 && callTimestamps[0] <= cutoff) {
          callTimestamps.shift();
        }
        if (callTimestamps.length < maxPerWindow) {
          callTimestamps.push(now());
          return;
        }
        const waitMs = callTimestamps[0] + windowMs - now();
        await sleep(Math.max(waitMs, 1));
      }
    },
  };
}
