import { assert, assertEquals } from 'jsr:@std/assert@1';
import { buildInviteEmail, inviteLink, sendInviteEmail } from './invite-email.ts';

const input = {
  to: 'jane@example.com',
  token: 'tok_abc-123',
  role: 'agent',
  orgName: 'MyHomeBase <Solutions>',
  inviterName: 'Kareem',
  expiresAt: '2026-10-29T12:00:00.000Z',
};
const appUrl = 'https://hyperdial.myhomebasesolutions.com/';

Deno.test('inviteLink: same shape InviteLanding reads (?invite=), no double slash', () => {
  assertEquals(
    inviteLink(appUrl, 'a/b+c'),
    'https://hyperdial.myhomebasesolutions.com/?invite=a%2Fb%2Bc'
  );
});

Deno.test(
  'buildInviteEmail: names the inviter, org and role, links the invite, escapes HTML',
  () => {
    const { subject, html, text } = buildInviteEmail(input, appUrl);
    assertEquals(subject, 'Kareem invited you to join MyHomeBase <Solutions> on HyperDial');
    assert(text.includes('as an agent'));
    assert(text.includes('https://hyperdial.myhomebasesolutions.com/?invite=tok_abc-123'));
    assert(text.includes('Thu, 29 Oct 2026'));
    assert(html.includes('MyHomeBase &lt;Solutions&gt;'));
    assert(!html.includes('<Solutions>'));
  }
);

Deno.test(
  'sendInviteEmail: unset key or sender -> not_configured, and nothing is fetched',
  async () => {
    let calls = 0;
    const f = (() => {
      calls++;
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    assertEquals(
      await sendInviteEmail({ apiKey: undefined, from: 'a@b.c', appUrl }, input, f),
      'not_configured'
    );
    assertEquals(
      await sendInviteEmail({ apiKey: 'k', from: '', appUrl }, input, f),
      'not_configured'
    );
    assertEquals(calls, 0);
  }
);

Deno.test('sendInviteEmail: posts to Resend with the key, sender and recipient', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const f = ((url: string, init: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(new Response('{"id":"x"}', { status: 200 }));
  }) as unknown as typeof fetch;
  const out = await sendInviteEmail(
    { apiKey: 're_key', from: 'HyperDial <invites@x.com>', appUrl },
    input,
    f
  );
  assertEquals(out, 'emailed');
  assertEquals(seen!.url, 'https://api.resend.com/emails');
  assertEquals((seen!.init.headers as Record<string, string>).Authorization, 'Bearer re_key');
  const body = JSON.parse(seen!.init.body as string);
  assertEquals(body.from, 'HyperDial <invites@x.com>');
  assertEquals(body.to, ['jane@example.com']);
});

Deno.test('sendInviteEmail: a non-2xx or a thrown fetch is failed, never thrown', async () => {
  const cfg = { apiKey: 'k', from: 'a@b.c', appUrl };
  const bad = (() => Promise.resolve(new Response('nope', { status: 403 }))) as typeof fetch;
  const boom = (() => Promise.reject(new Error('net'))) as typeof fetch;
  assertEquals(await sendInviteEmail(cfg, input, bad), 'failed');
  assertEquals(await sendInviteEmail(cfg, input, boom), 'failed');
});
