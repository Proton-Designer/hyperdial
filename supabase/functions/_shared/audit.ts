/**
 * MISSION-5 TASK-A1: org audit log write path for Edge Functions (service-role client). SQL RPCs
 * write through `private.log_org_action` instead (see `20260927080000_org_audit_log.sql`) -- this
 * module is the other half of the same table's two writers.
 *
 * Deliberately best-effort / fire-and-forget: a logging failure must never fail the real action it
 * describes (a role change, an invite, a GHL reconnect) that already succeeded by the time this is
 * called. Every caller in this repo calls it AFTER its own mutation has already committed, so a
 * swallowed error here only ever costs a missing audit row, never a half-applied action.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export interface AuditLogEntry {
  orgId: string;
  /** null for a system-initiated action (there are none yet, but the column allows it). */
  actorUserId: string | null;
  /** A short, dot-namespaced label, e.g. 'member.role_change', 'invite.create', 'ghl.connect'.
   *  Documented alongside the table in `.brain/domains/auth.md` -- add new ones there too. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

export async function logOrgAction(supabase: SupabaseClient, entry: AuditLogEntry): Promise<void> {
  try {
    const { error } = await supabase.from('org_audit_log').insert({
      org_id: entry.orgId,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
    });
    if (error) {
      console.error('[audit] logOrgAction insert failed', entry.action, error.message);
    }
  } catch (err) {
    console.error('[audit] logOrgAction threw', entry.action, err);
  }
}
