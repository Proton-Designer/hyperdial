/**
 * TASK-G02/G03 (extracted for unit tests, G02 review SHOULD): the push-time lookups the GHL sync
 * worker needs per call leg -- last_call_at, call_attempts, and the calling intern's GHL user id.
 * Split out of `ghl-sync-worker/index.ts` (whose module body starts `Deno.serve`, so it cannot be
 * imported by a test). I/O only through the injected Supabase client.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export interface CallLegPushContext {
  lastCallAt: string | null;
  callAttempts: number | null;
  callerGhlUserId: string | null;
}

/** MISSION-4 TASK-T2 (GHL-11): resolves last_call_at (the leg's own ended_at, falling back to
 *  dispositioned_at -- TASK-G02: the call time, not when the wrap-up form was submitted; never
 *  "now", a retry can run well after the real call) and call_attempts
 *  (`campaign_leads.attempts` for the leg's own lead, null when the leg has no lead_id at all,
 *  e.g. a contact dialed outside any campaign) -- both entirely from EXISTING columns, no
 *  `submit_disposition` change needed. */
export async function resolveDispositionPushTimeContext(
  supabase: SupabaseClient,
  orgId: string,
  callLegId: string | null
): Promise<CallLegPushContext> {
  if (!callLegId) return { lastCallAt: null, callAttempts: null, callerGhlUserId: null };
  const { data: leg } = await supabase
    .from('call_legs')
    .select('dispositioned_at, ended_at, lead_id, session_id')
    .eq('id', callLegId)
    .maybeSingle();
  if (!leg) return { lastCallAt: null, callAttempts: null, callerGhlUserId: null };
  const lastCallAt = (leg.ended_at as string | null) ?? (leg.dispositioned_at as string | null);
  const callerGhlUserId = await resolveCallerGhlUserId(supabase, orgId, leg.session_id);
  if (!leg.lead_id) return { lastCallAt, callAttempts: null, callerGhlUserId };
  const { data: lead } = await supabase
    .from('campaign_leads')
    .select('attempts')
    .eq('id', leg.lead_id)
    .maybeSingle();
  return {
    lastCallAt,
    callAttempts: (lead?.attempts as number | undefined) ?? null,
    callerGhlUserId,
  };
}

/** TASK-G02: the calling intern = the dial session's agent (not `dispositioned_by`, which can be
 *  an admin submitting on the agent's behalf) -> their `org_members.ghl_user_id`. Null when the
 *  leg has no session or the agent has no GHL user mapped. */
export async function resolveCallerGhlUserId(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string | null
): Promise<string | null> {
  if (!sessionId) return null;
  const { data: session } = await supabase
    .from('dial_sessions')
    .select('agent_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session?.agent_id) return null;
  const { data: member } = await supabase
    .from('org_members')
    .select('ghl_user_id')
    .eq('org_id', orgId)
    .eq('user_id', session.agent_id)
    .maybeSingle();
  return (member?.ghl_user_id as string | null | undefined) ?? null;
}
