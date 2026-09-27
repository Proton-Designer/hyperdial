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

export type OrgMemberStatus = 'active' | 'disabled' | 'removed';
export type OrgMemberRole = 'owner' | 'admin' | 'agent';

export type MembershipConflictResolution =
  | { action: 'reject_disabled' }
  | { action: 'reactivate'; role: OrgMemberRole }
  | { action: 'noop' };

/** MISSION-5 TASK-M5-A3 fix-forward (eng2 review BLOCKER 2, audit/M5-A3/review-eng2.md):
 *  `org-invite-accept`'s membership insert used to treat ANY `23505` (PK violation on
 *  (org_id, user_id)) as "already a member, fine" -- but a soft-removed or disabled member's row
 *  occupies that PK forever (A3's soft-remove design), so their OLD status silently stuck around
 *  while the endpoint reported success. This is the decision that insert conflict resolves to,
 *  pulled out as pure logic (same reason as every other function in this file: `org-invite-
 *  accept/index.ts` itself has no test file and isn't in `npm run test:functions`' scope) --
 *  `index.ts` does the actual Supabase update/no-op/reject, this function only decides which.
 *
 *  - 'disabled': a live, deliberate admin decision -- accepting a new invite must not be a silent
 *    way to bypass it. `enable` (org-members/index.ts) stays the one intended path back.
 *  - 'removed': accepting a fresh invite (re-invitable once BLOCKER 1's own fix lands, since
 *    org_member_emails excludes 'removed' from `already_member`) is the intended second path back
 *    in once Restore's 72h window has lapsed -- reactivate with the INVITE's own role (an owner
 *    may deliberately bring a returning agent back as a different role).
 *  - 'active': a genuinely idempotent retry (e.g. a double-submitted request) -- nothing to do. */
export function resolveMembershipConflict(
  existingStatus: OrgMemberStatus,
  inviteRole: OrgMemberRole
): MembershipConflictResolution {
  if (existingStatus === 'disabled') return { action: 'reject_disabled' };
  if (existingStatus !== 'active') return { action: 'reactivate', role: inviteRole };
  return { action: 'noop' };
}
