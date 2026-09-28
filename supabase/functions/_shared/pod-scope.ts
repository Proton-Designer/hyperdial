import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

/**
 * MISSION-5 TASK-M5-B4: shared pod-scoping helpers for the TypeScript side of the manager role
 * (TASK-M5-A5). The actual scoping PRIMITIVE lives in Postgres (`private.is_agent_in_
 * callers_pod_scope`, `manager_role_and_pods.sql`) and is used by every RPC in that lane -- but a
 * `private.*` function cannot be called via `supabase.rpc()` (RULES-CARD: every rpc() name must
 * be a PUBLIC function), and these two call sites (remote dialer actions, alert/notification
 * fan-out) aren't RPC calls at all, they're plain edge-function logic deciding who may act on an
 * agent's session or who should be notified about one. Reimplements the SAME two-table shape
 * (`org_members.pod_id` -- the target agent's own single pod; `org_manager_pods` -- the manager's
 * many-to-many scope) directly, exactly as org-members/index.ts and org-audit-log/index.ts (A5)
 * already do for their own pod-scoped GETs -- this just gives the shape a name so a THIRD and
 * FOURTH caller (this task) don't re-derive it a third and fourth time.
 */

interface MemberRow {
  user_id: string;
  role: string;
  pod_id: string | null;
}

/** True iff `managerId` (assumed already confirmed to hold role='manager' by the caller -- this
 *  function does not re-check that) may act on `agentId`'s session: the agent is an ACTIVE member
 *  with a pod, and that pod is one of the manager's own rows in `org_manager_pods`. False for an
 *  agent with no pod at all (a manager's scope is pod-based; an unassigned agent is nobody's
 *  manager's business) or a non-active agent row (matches `recording-url/index.ts`'s own copy of
 *  this check, which this function now replaces -- see MISSION-5 B5 follow-up). */
export async function isManagerScopedToAgent(
  supabase: SupabaseClient,
  orgId: string,
  managerId: string,
  agentId: string
): Promise<boolean> {
  const { data: agentRow } = await supabase
    .from('org_members')
    .select('pod_id')
    .eq('org_id', orgId)
    .eq('user_id', agentId)
    .eq('status', 'active')
    .maybeSingle();
  const podId = (agentRow as { pod_id: string | null } | null)?.pod_id;
  if (!podId) return false;

  const { data: scopeRow } = await supabase
    .from('org_manager_pods')
    .select('pod_id')
    .eq('org_id', orgId)
    .eq('manager_user_id', managerId)
    .eq('pod_id', podId)
    .maybeSingle();
  return scopeRow != null;
}

/** Every owner/admin (unconditionally) plus every manager whose pod scope covers `agentId`'s own
 *  pod -- the "who should hear about this agent" recipient set, shared by supervisor alerts
 *  (reliability-alert-check) and the raise-hand notifier (dialer-session-raise-hand). An agent
 *  with no pod is still visible to every owner/admin, just to no manager (same "pod-based scope,
 *  no pod means no manager's business" rule as `isManagerScopedToAgent` above). */
export async function resolveAlertRecipients(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string
): Promise<string[]> {
  const { data: agentRow } = await supabase
    .from('org_members')
    .select('pod_id')
    .eq('org_id', orgId)
    .eq('user_id', agentId)
    .maybeSingle();
  const podId = (agentRow as { pod_id: string | null } | null)?.pod_id ?? null;

  const { data: members } = await supabase
    .from('org_members')
    .select('user_id, role, pod_id')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .in('role', ['owner', 'admin', 'manager']);
  const rows = (members ?? []) as MemberRow[];

  const recipients = new Set<string>();
  for (const m of rows) {
    if (m.role === 'owner' || m.role === 'admin') recipients.add(m.user_id);
  }

  if (podId) {
    const managerIds = rows.filter((m) => m.role === 'manager').map((m) => m.user_id);
    if (managerIds.length > 0) {
      const { data: scopeRows } = await supabase
        .from('org_manager_pods')
        .select('manager_user_id')
        .eq('org_id', orgId)
        .eq('pod_id', podId)
        .in('manager_user_id', managerIds);
      for (const r of (scopeRows ?? []) as { manager_user_id: string }[]) {
        recipients.add(r.manager_user_id);
      }
    }
  }

  return [...recipients];
}

export type SupervisorAlertType = 'wrap_up_stuck' | 'paused_stuck' | 'call_stuck' | 'zero_connects';

/** Narrows `userIds` to those who have NOT explicitly turned `alertType` off
 *  (`user_notification_preferences`) -- absence of a row means on, matching the migration's own
 *  "defaults = everything on" convention. Only used for the 4 configurable supervisor-alert
 *  types (TASK-M5-B4's own scope) -- NOT applied to the pre-existing `agent_raised_hand`
 *  notification, which this task does not make opt-out-able. */
export async function filterByNotificationPreference(
  supabase: SupabaseClient,
  orgId: string,
  userIds: string[],
  alertType: SupervisorAlertType
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { data: prefRows } = await supabase
    .from('user_notification_preferences')
    .select('user_id, enabled')
    .eq('org_id', orgId)
    .eq('alert_type', alertType)
    .in('user_id', userIds);
  const disabled = new Set(
    ((prefRows ?? []) as { user_id: string; enabled: boolean }[])
      .filter((r) => r.enabled === false)
      .map((r) => r.user_id)
  );
  return userIds.filter((id) => !disabled.has(id));
}
