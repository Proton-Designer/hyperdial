import { assertEquals } from 'jsr:@std/assert@1';
import {
  checkViewAs,
  clearViewAsCache,
  functionNameFromUrl,
  isViewAsAllowed,
  jwtSessionId,
  VIEW_AS_ALLOWLIST,
} from './view-as-guard.ts';

const SID = '11111111-2222-4333-8444-555555555555';
function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'HS256' })}.${enc(claims)}.sig`;
}
function fakeDb(row: Record<string, unknown> | null, error: string | null = null) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle() {
                  calls++;
                  return Promise.resolve({ data: row, error: error ? { message: error } : null });
                },
              };
            },
          };
        },
      };
    },
  };
}
const req = (fn: string, method = 'GET') =>
  new Request(`https://x.supabase.co/functions/v1/${fn}?a=1`, { method });
const viewRow = { session_id: SID, org_id: 'o', viewer_id: 'v', target_id: 't', ended_at: null };

Deno.test('jwtSessionId: reads the claim, rejects junk', () => {
  assertEquals(jwtSessionId(jwt({ session_id: SID })), SID);
  assertEquals(jwtSessionId(jwt({ session_id: 'not-a-uuid' })), null);
  assertEquals(jwtSessionId(jwt({})), null);
  assertEquals(jwtSessionId('abc'), null);
  assertEquals(jwtSessionId('a.%%%.c'), null);
});

Deno.test('functionNameFromUrl', () => {
  assertEquals(
    functionNameFromUrl('https://x.supabase.co/functions/v1/dialer-session-get?x=1'),
    'dialer-session-get'
  );
  assertEquals(functionNameFromUrl('not a url'), null);
});

Deno.test('allowlist: default deny, method must match, no write function listed', () => {
  assertEquals(isViewAsAllowed('dialer-session-get', 'GET'), true);
  assertEquals(isViewAsAllowed('dialer-session-get', 'POST'), false);
  assertEquals(isViewAsAllowed('org-audit-log', 'POST'), false);
  assertEquals(isViewAsAllowed('recording-url', 'POST'), true);
  assertEquals(isViewAsAllowed('some-new-function', 'GET'), false);
  assertEquals(isViewAsAllowed('constructor', 'GET'), false);
  assertEquals(isViewAsAllowed(null, 'GET'), false);
  for (const denied of [
    'dialer-session-start',
    'dialer-session-resume',
    'dialer-session-stop',
    'dialer-session-pause',
    'dialer-session-reconnect',
    'dialer-session-hangup-live',
    'dialer-session-disposition',
    'dialer-session-raise-hand',
    'dialer-session-recording',
    'dialer-send-dtmf',
    'dialer-transfer',
    'dialer-coaching',
    'telnyx-webrtc-credentials',
    'telnyx-connect',
    'telnyx-purchase-number',
    'ensure-week-summary',
    'log-contact-close',
    'view-as-start',
    'shift-clock',
    'org-invite-create',
  ]) {
    assertEquals(denied in VIEW_AS_ALLOWLIST, false, denied);
    assertEquals(isViewAsAllowed(denied, 'POST'), false, denied);
    assertEquals(isViewAsAllowed(denied, 'GET'), false, denied);
  }
});

Deno.test('checkViewAs: normal session passes; positive control for the denial below', async () => {
  clearViewAsCache();
  const db = fakeDb(null);
  assertEquals(
    await checkViewAs(db, jwt({ session_id: SID }), req('dialer-session-start', 'POST')),
    null
  );
});

Deno.test('checkViewAs: token without session_id is not restricted', async () => {
  clearViewAsCache();
  assertEquals(
    await checkViewAs(fakeDb(viewRow), jwt({ role: 'authenticated' }), req('x', 'POST')),
    null
  );
});

Deno.test(
  'checkViewAs: view session -> allowlisted read passes, anything else 403 View-only',
  async () => {
    clearViewAsCache();
    const db = fakeDb(viewRow);
    const t = jwt({ session_id: SID });
    assertEquals(await checkViewAs(db, t, req('dialer-session-get')), null);
    const r = await checkViewAs(db, t, req('dialer-session-resume', 'POST'));
    assertEquals(r?.status, 403);
    assertEquals((await r!.json()).error, 'View-only');
    assertEquals((await checkViewAs(db, t, req('dialer-session-get', 'POST')))?.status, 403);
  }
);

Deno.test('checkViewAs: ended session 401; lookup failure fails closed 503', async () => {
  clearViewAsCache();
  const ended = await checkViewAs(
    fakeDb({ ...viewRow, ended_at: '2026-11-02T00:00:00Z' }),
    jwt({ session_id: SID }),
    req('dialer-session-get')
  );
  assertEquals(ended?.status, 401);
  clearViewAsCache();
  const failed = await checkViewAs(
    fakeDb(null, 'boom'),
    jwt({ session_id: SID }),
    req('dialer-session-get')
  );
  assertEquals(failed?.status, 503);
});

Deno.test('checkViewAs: one lookup per session within the cache window', async () => {
  clearViewAsCache();
  const db = fakeDb(viewRow);
  const t = jwt({ session_id: SID });
  await checkViewAs(db, t, req('dialer-session-get'));
  await checkViewAs(db, t, req('dialer-session-get'));
  assertEquals(db.calls, 1);
});
