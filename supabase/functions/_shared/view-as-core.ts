/** TASK-H21: who may be viewed. Pure so it is unit-tested; view-as-start feeds it every org_members row of the target. */
export interface TargetMembership {
  org_id: string;
  role: string;
  status: string;
}

export type ViewAsTargetVerdict =
  { ok: true } | { ok: false; status: number; code: string; message: string };

export function checkViewAsTarget(args: {
  viewerId: string;
  targetId: string;
  orgId: string;
  memberships: TargetMembership[];
}): ViewAsTargetVerdict {
  if (args.viewerId === args.targetId) {
    return { ok: false, status: 400, code: 'self', message: 'You cannot view as yourself.' };
  }
  const here = args.memberships.find((m) => m.org_id === args.orgId);
  if (!here || here.role !== 'agent' || here.status !== 'active') {
    return {
      ok: false,
      status: 403,
      code: 'not_an_agent',
      message: 'You can only view as an active intern (agent) of this org.',
    };
  }
  // A GoTrue session is global to the user: it would also open their other orgs.
  if (args.memberships.some((m) => m.org_id !== args.orgId)) {
    return {
      ok: false,
      status: 403,
      code: 'multi_org',
      message: 'That person belongs to more than one org, so a view-only session is not possible.',
    };
  }
  return { ok: true };
}
