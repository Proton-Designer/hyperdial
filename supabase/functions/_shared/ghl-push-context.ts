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
  /** TASK-G11: the calling intern's display name (profiles first + last), null if unknown. */
  callerName: string | null;
  /** TASK-G11/G18: the imported list's name the call came from (lead, then contact), else the dial session's campaign name. */
  leadList: string | null;
}

const NO_CONTEXT: CallLegPushContext = {
  lastCallAt: null,
  callAttempts: null,
  callerGhlUserId: null,
  callerName: null,
  leadList: null,
};

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
  if (!callLegId) return { ...NO_CONTEXT };
  const { data: leg } = await supabase
    .from('call_legs')
    .select('dispositioned_at, ended_at, created_at, lead_id, session_id, contact_id')
    .eq('id', callLegId)
    .maybeSingle();
  if (!leg) return { ...NO_CONTEXT };
  // TASK-G11 (G03 review SHOULD): ended_at is written by the same transition_leg call that sets the
  // outcome (dialer-engine.ts), i.e. before apply_leg_outcome enqueues the tag job, so it is not
  // expected to be null here; created_at is a last-resort fallback so the field is never silently skipped.
  const lastCallAt =
    (leg.ended_at as string | null) ??
    (leg.dispositioned_at as string | null) ??
    (leg.created_at as string | null);
  const session = await resolveSessionContext(supabase, orgId, leg.session_id);
  const { callerGhlUserId, callerName } = session;
  // TASK-G18: lead_list = the imported list's name -- the lead's own (campaign_leads.list_name), else the
  // list the contact was first imported with (contacts.import_list), else the session's campaign name.
  let lead: { attempts?: number | null; list_name?: string | null } | null = null;
  if (leg.lead_id) {
    const { data } = await supabase
      .from('campaign_leads')
      .select('attempts, list_name')
      .eq('id', leg.lead_id)
      .maybeSingle();
    lead = data;
  }
  let importList: string | null = null;
  if (!lead?.list_name && leg.contact_id) {
    const { data: contact } = await supabase
      .from('contacts')
      .select('import_list')
      .eq('id', leg.contact_id)
      .eq('org_id', orgId)
      .maybeSingle();
    importList = (contact?.import_list as string | null | undefined) || null;
  }
  const leadList = (lead?.list_name as string | null | undefined) || importList || session.leadList;
  return {
    lastCallAt,
    callAttempts: (lead?.attempts as number | undefined) ?? null,
    callerGhlUserId,
    callerName,
    leadList,
  };
}

export interface SessionPushContext {
  callerGhlUserId: string | null;
  callerName: string | null;
  leadList: string | null;
}

/** TASK-G02/G11: everything the dial session of a leg tells us -- the calling intern = the session's
 *  agent (not `dispositioned_by`, which can be an admin submitting on the agent's behalf): their
 *  `org_members.ghl_user_id` and display name, and the session's campaign name as the lead list.
 *  Each part is null when it cannot be resolved (no session, agent without a GHL user, ...). */
export async function resolveSessionContext(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string | null
): Promise<SessionPushContext> {
  const none: SessionPushContext = { callerGhlUserId: null, callerName: null, leadList: null };
  if (!sessionId) return none;
  const { data: session } = await supabase
    .from('dial_sessions')
    .select('agent_id, campaign_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session) return none;
  const out = { ...none };
  if (session.agent_id) {
    const { data: member } = await supabase
      .from('org_members')
      .select('ghl_user_id')
      .eq('org_id', orgId)
      .eq('user_id', session.agent_id)
      .maybeSingle();
    out.callerGhlUserId = (member?.ghl_user_id as string | null | undefined) ?? null;
    const { data: profile } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('user_id', session.agent_id)
      .maybeSingle();
    const name = [profile?.first_name, profile?.last_name]
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      .join(' ')
      .trim();
    out.callerName = name || null;
  }
  if (session.campaign_id) {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('name')
      .eq('id', session.campaign_id)
      .maybeSingle();
    out.leadList = (campaign?.name as string | null | undefined) || null;
  }
  return out;
}

/** TASK-G02: kept for its own callers/tests; delegates to resolveSessionContext. */
export async function resolveCallerGhlUserId(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string | null
): Promise<string | null> {
  return (await resolveSessionContext(supabase, orgId, sessionId)).callerGhlUserId;
}
