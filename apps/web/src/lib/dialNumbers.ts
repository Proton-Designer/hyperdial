import type { UserPhoneNumber } from '@/contexts/PhoneNumbersContext';

/**
 * TASK-H23 (C/D/E): which of the org's numbers THIS user can actually dial from. RLS lets every
 * org member see every number (needed to label caller IDs elsewhere), so the list a screen
 * receives is the whole org's -- a number assigned to someone else, or retired, is not this
 * user's to dial from. Mirrors StartSessionPanel's own filter (assigned to me, or unassigned =
 * the team pool).
 */
export function dialableNumbers(
  numbers: UserPhoneNumber[],
  userId: string | null | undefined,
  isManager: boolean
): UserPhoneNumber[] {
  return numbers.filter(
    (n) =>
      n.status !== 'retired' &&
      (isManager || n.assigned_user_id === null || n.assigned_user_id === userId)
  );
}

/**
 * Manual-dial caller ID: the user's own assigned number first, then an unassigned pool number,
 * active before resting. Only an owner/admin may fall back to a number assigned to someone
 * else (`dialableNumbers(..., true)` already widened their list; own/pool still win).
 */
export function pickCallerId(
  numbers: UserPhoneNumber[],
  userId: string | null | undefined
): UserPhoneNumber | null {
  const rank = (n: UserPhoneNumber): number => {
    const own = n.assigned_user_id !== null && n.assigned_user_id === userId;
    const pool = n.assigned_user_id === null;
    const active = n.status === 'active';
    if (own) return active ? 0 : 2;
    if (pool) return active ? 1 : 3;
    return active ? 4 : 5;
  };
  let best: UserPhoneNumber | null = null;
  for (const n of numbers) {
    if (best === null || rank(n) < rank(best)) best = n;
  }
  return best;
}

export type PendingDialAction =
  { kind: 'wait' } | { kind: 'refuse'; message: string } | { kind: 'dial' };

/**
 * TASK-H23 (B): what the Dialer does with a number left by Inbox "Call back" / contact "Call".
 * Every refusal consumes the number (so it can never fire later by surprise); only "not ready
 * yet" (numbers still loading) waits.
 */
export function decidePendingDial(s: {
  numbersLoading: boolean;
  isViewOnly: boolean;
  isAgentLineOwner: boolean;
  inParallelSession: boolean;
  callActive: boolean;
  hasFromNumber: boolean;
  viewOnlyMessage: string;
}): PendingDialAction {
  if (s.numbersLoading) return { kind: 'wait' };
  if (s.isViewOnly) return { kind: 'refuse', message: s.viewOnlyMessage };
  if (!s.isAgentLineOwner) {
    return {
      kind: 'refuse',
      message: 'HyperDial is open in another tab. Close it there first, then try again.',
    };
  }
  if (s.inParallelSession) {
    return {
      kind: 'refuse',
      message: 'End your dial session before calling a number manually.',
    };
  }
  if (s.callActive) return { kind: 'refuse', message: "You're already on a call." };
  if (!s.hasFromNumber) {
    return {
      kind: 'refuse',
      message: "You don't have a phone number yet. Ask your manager to assign you one.",
    };
  }
  return { kind: 'dial' };
}
