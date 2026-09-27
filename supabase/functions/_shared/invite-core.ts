/**
 * MISSION-5 TASK-M5-A2 fix-forward (eng2 review, BLOCKER 1): `org-invite-accept`'s GET preview
 * and POST accept never checked `revoked_at` at all -- Revoke was cosmetic (the token stayed
 * valid until its own `expires_at`), and Resend's own "revoke the old row" never actually killed
 * the old token either, since accept never read the column it wrote. Pulled into `_shared` (not
 * left inline in `org-invite-accept/index.ts`) specifically so it's covered by
 * `npm run test:functions` (`deno test supabase/functions/_shared` -- `org-invite-accept/` itself
 * has no test file today and isn't in that gate's scope).
 */

export interface InvitableFields {
  accepted_at: string | null;
  revoked_at: string | null | undefined;
  expires_at: string;
}

/** The landing-page preview's `valid`/`reason`. Priority matches `org-invite-create/index.ts`'s
 *  own `inviteStatus()`: accepted, then revoked, then expired. */
export function deriveInvitePreview(invite: InvitableFields): {
  valid: boolean;
  reason: 'accepted' | 'revoked' | 'expired' | null;
} {
  if (invite.accepted_at) return { valid: false, reason: 'accepted' };
  if (invite.revoked_at) return { valid: false, reason: 'revoked' };
  if (new Date(invite.expires_at).getTime() < Date.now())
    return { valid: false, reason: 'expired' };
  return { valid: true, reason: null };
}

/** The POST accept path's guard -- returns the exact 400 message to send, or null to proceed. */
export function checkInviteAcceptable(invite: InvitableFields): string | null {
  if (invite.accepted_at) return 'This invite has already been used';
  if (invite.revoked_at) return 'This invite was revoked';
  if (new Date(invite.expires_at).getTime() < Date.now()) return 'This invite has expired';
  return null;
}

/** MISSION-5 TASK-M5-A2 fix-forward (eng2 review BLOCKER 2): "does this row currently block a
 *  fresh invite to the same email" -- exactly "acceptable" (not accepted/revoked/expired),
 *  reused rather than re-implemented so `org-invite-create`'s bulk-create `liveInvitedEmails`
 *  exclusion set can never drift out of sync with `checkInviteAcceptable`'s own definition of
 *  "live". Before this fix, `liveInvitedEmails` was built with NO expiry filter at all -- an
 *  expired-but-unrevoked row matched it, so `already_invited` fired before the per-email loop's
 *  own auto-revoke-expired block ever got a chance to run, making that block dead code and the
 *  email permanently un-invitable through the UI. */
export function isInviteLive(invite: InvitableFields): boolean {
  return checkInviteAcceptable(invite) === null;
}
