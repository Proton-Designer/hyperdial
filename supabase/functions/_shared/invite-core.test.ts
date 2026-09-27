/**
 * MISSION-5 TASK-M5-A2 fix-forward (eng2 review, BLOCKER 1): see `invite-core.ts`'s own header.
 */
import { assertEquals } from 'jsr:@std/assert@1';
import {
  deriveInvitePreview,
  checkInviteAcceptable,
  isInviteLive,
  resolveMembershipConflict,
} from './invite-core.ts';

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

Deno.test('deriveInvitePreview: a revoked invite is invalid with reason "revoked"', () => {
  const result = deriveInvitePreview({
    accepted_at: null,
    revoked_at: new Date().toISOString(),
    expires_at: FUTURE,
  });
  assertEquals(result, { valid: false, reason: 'revoked' });
});

Deno.test('deriveInvitePreview: an untouched, unexpired invite is valid', () => {
  const result = deriveInvitePreview({ accepted_at: null, revoked_at: null, expires_at: FUTURE });
  assertEquals(result, { valid: true, reason: null });
});

Deno.test(
  'deriveInvitePreview: priority is accepted > revoked > expired (positive control -- proves this is a real priority order, not just "any truthy field wins")',
  () => {
    // accepted_at set AND revoked_at set -- accepted must win, matching org-invite-create's own
    // inviteStatus() ordering (an accepted invite stays "accepted" even if someone later revokes
    // the now-irrelevant row).
    assertEquals(
      deriveInvitePreview({
        accepted_at: new Date().toISOString(),
        revoked_at: new Date().toISOString(),
        expires_at: FUTURE,
      }),
      { valid: false, reason: 'accepted' }
    );
    // revoked_at set AND expired -- revoked must win over expired.
    assertEquals(
      deriveInvitePreview({
        accepted_at: null,
        revoked_at: new Date().toISOString(),
        expires_at: PAST,
      }),
      { valid: false, reason: 'revoked' }
    );
  }
);

Deno.test(
  'deriveInvitePreview: expired-only (never revoked) is invalid with reason "expired"',
  () => {
    const result = deriveInvitePreview({ accepted_at: null, revoked_at: null, expires_at: PAST });
    assertEquals(result, { valid: false, reason: 'expired' });
  }
);

Deno.test(
  "checkInviteAcceptable: a revoked invite is rejected -- this is what actually kills a Resend's old token / makes Revoke non-cosmetic",
  () => {
    const result = checkInviteAcceptable({
      accepted_at: null,
      revoked_at: new Date().toISOString(),
      expires_at: FUTURE,
    });
    assertEquals(result, 'This invite was revoked');
  }
);

Deno.test('checkInviteAcceptable: an untouched, unexpired invite is acceptable (null)', () => {
  const result = checkInviteAcceptable({ accepted_at: null, revoked_at: null, expires_at: FUTURE });
  assertEquals(result, null);
});

Deno.test('checkInviteAcceptable: already-accepted takes priority over revoked', () => {
  const result = checkInviteAcceptable({
    accepted_at: new Date().toISOString(),
    revoked_at: new Date().toISOString(),
    expires_at: FUTURE,
  });
  assertEquals(result, 'This invite has already been used');
});

Deno.test(
  'checkInviteAcceptable: expired-only (never revoked) is rejected with the expiry message',
  () => {
    const result = checkInviteAcceptable({ accepted_at: null, revoked_at: null, expires_at: PAST });
    assertEquals(result, 'This invite has expired');
  }
);

// MISSION-5 TASK-M5-A2 fix-forward (eng2 review BLOCKER 2): "an expired-but-unrevoked invite
// makes that email permanently un-invitable" -- `isInviteLive` is what org-invite-create's bulk
// `liveInvitedEmails` set now filters on; before the fix, the equivalent DB query had no expiry
// check at all, so an expired row was wrongly treated as still blocking a fresh invite.
Deno.test(
  'isInviteLive: an expired-but-unrevoked invite is NOT live -- this is the exact bug (an expired row must fall through to auto-revoke-then-insert, not be misreported as already_invited)',
  () => {
    assertEquals(isInviteLive({ accepted_at: null, revoked_at: null, expires_at: PAST }), false);
  }
);

Deno.test(
  "isInviteLive: positive control -- an untouched, unexpired invite IS live (proves the check isn't vacuously false for every row)",
  () => {
    assertEquals(isInviteLive({ accepted_at: null, revoked_at: null, expires_at: FUTURE }), true);
  }
);

Deno.test('isInviteLive: an already-revoked invite is not live, regardless of expiry', () => {
  assertEquals(
    isInviteLive({ accepted_at: null, revoked_at: new Date().toISOString(), expires_at: FUTURE }),
    false
  );
});

Deno.test('isInviteLive: an already-accepted invite is not live, regardless of expiry', () => {
  assertEquals(
    isInviteLive({ accepted_at: new Date().toISOString(), revoked_at: null, expires_at: FUTURE }),
    false
  );
});

// MISSION-5 TASK-M5-A3 fix-forward (eng2 review BLOCKER 2): resolveMembershipConflict is the
// decision org-invite-accept makes when a fresh invite's membership insert hits an EXISTING
// (org_id, user_id) row -- see invite-core.ts's own header for the full incident this fixes.
Deno.test(
  'resolveMembershipConflict: a disabled member is rejected, not silently reactivated',
  () => {
    assertEquals(resolveMembershipConflict('disabled', 'agent'), { action: 'reject_disabled' });
  }
);

Deno.test(
  "resolveMembershipConflict: a removed member is reactivated with the INVITE's own role, not their old one",
  () => {
    assertEquals(resolveMembershipConflict('removed', 'admin'), {
      action: 'reactivate',
      role: 'admin',
    });
  }
);

Deno.test(
  'resolveMembershipConflict: an already-active member is a no-op (the genuinely idempotent retry case, unchanged from the old behavior)',
  () => {
    assertEquals(resolveMembershipConflict('active', 'agent'), { action: 'noop' });
  }
);

Deno.test(
  'resolveMembershipConflict: positive control -- disabled and removed produce DIFFERENT resolutions (proves this is a real branch, not one status accidentally shadowing the other)',
  () => {
    const disabled = resolveMembershipConflict('disabled', 'agent');
    const removed = resolveMembershipConflict('removed', 'agent');
    assertEquals(disabled.action === removed.action, false);
  }
);
