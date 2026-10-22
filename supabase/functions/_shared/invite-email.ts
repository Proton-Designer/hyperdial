/**
 * Invite emails, sent through Resend's HTTP API (https://resend.com/docs/api-reference/emails).
 * HyperDial had no email-sending integration at all: an invite "sent" only ever created a link
 * for an admin to copy. This is that integration, and it is opt-in: with RESEND_API_KEY or
 * INVITE_EMAIL_FROM unset, `sendInviteEmail` returns 'not_configured' and the caller reports
 * the invite as link-only, exactly as before. A failed send never fails the invite itself -- the
 * row and its link already exist, so the admin can still copy it.
 *
 * Why HTTP and not SMTP: Supabase Edge Functions block outbound ports 25 and 587.
 */

export interface InviteEmailConfig {
  apiKey: string | undefined;
  /** e.g. `HyperDial <invites@myhomebasesolutions.com>` -- the domain must be verified in Resend. */
  from: string | undefined;
  /** The web app's origin; the invite link is `${appUrl}/?invite=<token>` (InviteLanding). */
  appUrl: string;
}

export interface InviteEmailInput {
  to: string;
  token: string;
  role: string;
  orgName: string | null;
  inviterName: string | null;
  expiresAt: string;
}

export type InviteEmailOutcome = 'emailed' | 'not_configured' | 'failed';

const ROLE_LABEL: Record<string, string> = {
  owner: 'an owner',
  admin: 'an admin',
  manager: 'a manager',
  agent: 'an agent',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function inviteLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/?invite=${encodeURIComponent(token)}`;
}

export function buildInviteEmail(
  input: InviteEmailInput,
  appUrl: string
): { subject: string; html: string; text: string } {
  const link = inviteLink(appUrl, input.token);
  const org = input.orgName?.trim() || 'their team';
  const who = input.inviterName?.trim() || 'Your team';
  const role = ROLE_LABEL[input.role] ?? 'a member';
  const expires = new Date(input.expiresAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
  const subject = `${who} invited you to join ${org} on HyperDial`;
  const text = [
    `${who} invited you to join ${org} on HyperDial as ${role}.`,
    '',
    `Accept the invite and create your account: ${link}`,
    '',
    `This link expires on ${expires}. If you weren't expecting this, you can ignore this email.`,
  ].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
<h2 style="margin:0 0 16px">You're invited to HyperDial</h2>
<p>${escapeHtml(who)} invited you to join <strong>${escapeHtml(org)}</strong> as ${role}.</p>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#0b84ff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">Accept invite</a></p>
<p style="font-size:13px;color:#555">Or paste this link into your browser:<br>${escapeHtml(link)}</p>
<p style="font-size:13px;color:#555">This link expires on ${escapeHtml(expires)}. If you weren't expecting this, you can ignore this email.</p>
</div>`;
  return { subject, html, text };
}

export async function sendInviteEmail(
  config: InviteEmailConfig,
  input: InviteEmailInput,
  fetchImpl: typeof fetch = fetch
): Promise<InviteEmailOutcome> {
  if (!config.apiKey || !config.from) return 'not_configured';
  const { subject, html, text } = buildInviteEmail(input, config.appUrl);
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.from, to: [input.to], subject, html, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error('invite email: Resend returned', res.status, (await res.text()).slice(0, 300));
      return 'failed';
    }
    return 'emailed';
  } catch (e) {
    console.error('invite email: send threw', String(e));
    return 'failed';
  }
}
