/**
 * TASK-T3 (Mission 4): live coaching -- listen / whisper / barge. The actual orchestration
 * (validation, the Telnyx dial/join/update calls, the coaching_sessions audit rows) lives here so
 * it can be deno-tested with a fake supabase + fake TelnyxClient -- same "pure/testable core,
 * thin HTTP shell" split as billing-core.ts/dialer-engine.ts.
 *
 * Mechanism (verified against spec3.json, 2026-09-26 -- curl + python parse, WebFetch truncates
 * this spec): a coaching attempt dials the MANAGER's own WebRTC credential (agentSipUri, reused
 * unchanged from dialer-engine.ts -- it was never agent-specific despite the name) into the
 * TARGET session's already-live conference via `POST /conferences/{id}/actions/join` with
 * `supervisor_role`. Telnyx's own enum is `barge|monitor|none|whisper`; this feature's three
 * user-facing modes map onto it as `listen -> monitor` (muted, hears everyone), `whisper ->
 * whisper` (only `whisper_call_control_ids` -- the AGENT's own leg -- can hear the manager), and
 * `barge -> barge` (a normal, audible-to-everyone participant). Switching mode mid-call uses the
 * DIFFERENT `POST /conferences/{id}/actions/update` command (verified: the participant PATCH
 * endpoint has no `supervisor_role` field at all -- only `/actions/update` can change it without
 * leaving and rejoining).
 *
 * Deliberately keeps the manager's coaching leg OUT of `call_legs` entirely -- see the migration
 * header (20260926070000) for why a third `kind` value there is a real, previously-hit risk in
 * this codebase, not a hypothetical one. `coaching_sessions.manager_call_control_id` is this
 * leg's only record.
 *
 * Ending a coaching attempt is NOT a server action at all: the coaching leg lives on the SAME
 * WebRTC client (`useTelnyxCall.ts`) the manager's own dialing already uses ("reuse Dialer's
 * single client" -- the task's own instruction), so the browser's existing `hangup()` already
 * ends it -- a real Telnyx `call.hangup` for that leg, which `processTelnyxCoachingEvent` below
 * finalizes the row from. No separate "end" action/endpoint exists; `runStartCoachingAction` and
 * `runSwitchCoachingModeAction` are the only two.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { TelnyxClient } from './telnyx-client.ts';
import { agentSipUri } from './dialer-engine.ts';
import { encodeCoachingClientState, type CoachingMode } from './client-state.ts';
import { webhookUrlForOrg } from './telnyx-provision.ts';
import { logOrgAction } from './audit.ts';

export type { CoachingMode };
const COACHING_MODES: CoachingMode[] = ['listen', 'whisper', 'barge'];

/** See this file's own header for the verified spec3.json mapping. */
function toSupervisorRole(mode: CoachingMode): 'monitor' | 'whisper' | 'barge' {
  return mode === 'listen' ? 'monitor' : mode;
}

export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

// Telnyx default/max for CallRequest.time_limit_secs (verified spec3.json, same constant value
// as dialer-engine.ts's AGENT_DIAL_TIME_LIMIT_SECS -- duplicated rather than imported: that
// constant is exported for an unrelated reason (agent-leg dialing), and this module's own
// coaching-specific timeout deserves its own name rather than borrowing an agent-leg one that
// could change for agent-leg reasons this feature has no stake in).
const COACHING_DIAL_TIME_LIMIT_SECS = 14400;
// Shorter than the agent leg's 45s (AGENT_DIAL_TIMEOUT_SECS) -- a manager clicking Listen is
// actively waiting on their own screen for it to connect, not waiting on a background process.
const COACHING_DIAL_TIMEOUT_SECS = 20;

function webhookBaseUrl(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-webhook`;
}

interface TargetSessionRow {
  id: string;
  state: string;
  conference_id: string | null;
  agent_leg_id: string | null;
}

async function loadCurrentSessionForAgent(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string
): Promise<TargetSessionRow | null> {
  const { data } = await supabase
    .from('dial_sessions')
    .select('id, state, conference_id, agent_leg_id')
    .eq('org_id', orgId)
    .eq('agent_id', agentId)
    .not('state', 'in', '("stopped","completed")')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as TargetSessionRow | null) ?? null;
}

/** Any org phone number works as the manager leg's caller-id `from` -- unlike a contact/agent
 *  dial, a coaching leg never rings a real PSTN destination (the `to` is always a `sip:` URI), so
 *  there is no campaign/legacy caller-ID tier to resolve here the way agentDialFromNumber does. */
async function anyOrgFromNumber(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data } = await supabase
    .from('user_phone_numbers')
    .select('phone_number')
    .eq('org_id', orgId)
    .limit(1)
    .maybeSingle();
  return (data?.phone_number as string | undefined) ?? null;
}

async function agentLegCallControlId(
  supabase: SupabaseClient,
  agentLegId: string | null
): Promise<string | null> {
  if (!agentLegId) return null;
  const { data } = await supabase
    .from('call_legs')
    .select('call_control_id')
    .eq('id', agentLegId)
    .maybeSingle();
  return (data?.call_control_id as string | undefined) ?? null;
}

export async function runStartCoachingAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  callControlAppId: string,
  credentialConnectionId: string | null,
  orgId: string,
  managerId: string,
  body: Record<string, unknown>
): Promise<ActionResult> {
  const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId : '';
  const mode = body.mode;
  if (!targetUserId) return { status: 400, body: { error: 'targetUserId is required.' } };
  if (typeof mode !== 'string' || !COACHING_MODES.includes(mode as CoachingMode)) {
    return { status: 400, body: { error: "mode must be one of 'listen', 'whisper', 'barge'." } };
  }
  if (targetUserId === managerId) {
    return { status: 400, body: { error: 'You cannot coach your own session.' } };
  }

  // Busy check: useTelnyxCall.ts has exactly one active-call slot (activeCallRef) -- a manager
  // who is ALSO an agent and currently on their own call cannot take a second inbound leg on the
  // same client without colliding with it. The partial unique index on coaching_sessions closes
  // the remaining TOCTOU window (two clicks racing this same check) -- see its own insert below.
  const managerSession = await loadCurrentSessionForAgent(supabase, orgId, managerId);
  if (managerSession && managerSession.state === 'on_call') {
    return {
      status: 409,
      body: { error: "You're on a call yourself -- end it before coaching.", code: 'MANAGER_BUSY' },
    };
  }

  const targetSession = await loadCurrentSessionForAgent(supabase, orgId, targetUserId);
  if (!targetSession || targetSession.state !== 'on_call' || !targetSession.conference_id) {
    return {
      status: 409,
      body: { error: 'This member is not currently on a call.', code: 'TARGET_NOT_ON_CALL' },
    };
  }

  // Fail fast for whisper mode: no agent leg on record means processTelnyxCoachingEvent would
  // just hang the manager's leg back up the instant it answers (endAsStale, its own header) --
  // better to never even ring the manager's phone for a mode this target can't support right now.
  if (mode === 'whisper') {
    const agentCallControlId = await agentLegCallControlId(supabase, targetSession.agent_leg_id);
    if (!agentCallControlId) {
      return {
        status: 409,
        body: { error: 'This member is not currently on a call.', code: 'TARGET_NOT_ON_CALL' },
      };
    }
  }

  const { data: pendingRow, error: insertError } = await supabase
    .from('coaching_sessions')
    .insert({
      org_id: orgId,
      target_session_id: targetSession.id,
      target_user_id: targetUserId,
      manager_id: managerId,
      mode,
      status: 'starting',
    })
    .select('id')
    .single();
  if (insertError || !pendingRow) {
    // 23505: the partial unique index (one active coaching row per manager) -- the same
    // MANAGER_BUSY case as the check above, just caught after losing a race to a second click/
    // tab instead of before it.
    if (insertError?.code === '23505') {
      return {
        status: 409,
        body: { error: "You're already coaching another call.", code: 'MANAGER_BUSY' },
      };
    }
    console.error('[coaching-core] pending row insert failed', insertError?.message);
    return { status: 500, body: { error: 'Failed to record the coaching attempt' } };
  }
  const coachingId = pendingRow.id as string;

  const fromNumber = await anyOrgFromNumber(supabase, orgId);
  if (!fromNumber) {
    await supabase
      .from('coaching_sessions')
      .update({ status: 'ended', ended_at: new Date().toISOString(), ended_reason: 'error' })
      .eq('id', coachingId);
    return { status: 400, body: { error: 'Your org has no phone number yet.' } };
  }

  try {
    const sipUri = await agentSipUri(supabase, client, orgId, managerId, credentialConnectionId);
    const { callControlId } = await client.dial({
      connectionId: callControlAppId,
      to: sipUri,
      from: fromNumber,
      webhookUrl: webhookUrlForOrg(webhookBaseUrl(), orgId),
      clientState: encodeCoachingClientState({
        org: orgId,
        coaching: coachingId,
        mode: mode as CoachingMode,
        targetSession: targetSession.id,
      }),
      timeoutSecs: COACHING_DIAL_TIMEOUT_SECS,
      timeLimitSecs: COACHING_DIAL_TIME_LIMIT_SECS,
      amdMode: 'off',
    });
    await supabase
      .from('coaching_sessions')
      .update({ manager_call_control_id: callControlId })
      .eq('id', coachingId);
  } catch (err) {
    console.error('[coaching-core] dial failed', err);
    await supabase
      .from('coaching_sessions')
      .update({ status: 'ended', ended_at: new Date().toISOString(), ended_reason: 'error' })
      .eq('id', coachingId);
    return { status: 502, body: { error: 'Failed to reach your phone line. Please try again.' } };
  }

  // TASK-A1: logged at the manager's own dial attempt, not at the later call.answered join --
  // this is the point the manager took the action, regardless of whether the target's leg is
  // still there by the time the manager's own phone actually answers.
  await logOrgAction(supabase, {
    orgId,
    actorUserId: managerId,
    action: 'coaching.start',
    targetType: 'dial_session',
    targetId: targetSession.id,
    details: { targetUserId, mode },
  });

  return { status: 200, body: { coachingId, mode } };
}

export async function runSwitchCoachingModeAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  managerId: string,
  body: Record<string, unknown>
): Promise<ActionResult> {
  const coachingId = typeof body.coachingId === 'string' ? body.coachingId : '';
  const mode = body.mode;
  if (!coachingId) return { status: 400, body: { error: 'coachingId is required.' } };
  if (typeof mode !== 'string' || !COACHING_MODES.includes(mode as CoachingMode)) {
    return { status: 400, body: { error: "mode must be one of 'listen', 'whisper', 'barge'." } };
  }

  const { data: row, error: rowError } = await supabase
    .from('coaching_sessions')
    .select('id, target_session_id, manager_call_control_id, status')
    .eq('id', coachingId)
    .eq('org_id', orgId)
    .eq('manager_id', managerId)
    .maybeSingle();
  if (rowError) {
    console.error('[coaching-core] switch_mode row lookup failed', rowError.message);
    return { status: 500, body: { error: 'Failed to look up the coaching attempt' } };
  }
  if (!row) return { status: 404, body: { error: 'Coaching attempt not found.' } };
  if (row.status !== 'active' || !row.manager_call_control_id) {
    return {
      status: 409,
      body: { error: 'This coaching attempt is not connected yet.', code: 'NOT_ACTIVE' },
    };
  }

  // Re-read the target session FRESH by its own id (not loadCurrentSessionForAgent, which
  // filters by agent_id -- this row already pins the exact session_id, and re-deriving
  // "current" by agent could, in principle, find a DIFFERENT newer session for the same agent).
  const { data: freshTarget } = await supabase
    .from('dial_sessions')
    .select('id, state, conference_id, agent_leg_id')
    .eq('id', row.target_session_id)
    .maybeSingle();

  if (!freshTarget || freshTarget.state !== 'on_call' || !freshTarget.conference_id) {
    await supabase
      .from('coaching_sessions')
      .update({ status: 'ended', ended_at: new Date().toISOString(), ended_reason: 'target_ended' })
      .eq('id', coachingId)
      .neq('status', 'ended');
    try {
      await client.hangup(row.manager_call_control_id as string);
    } catch (err) {
      console.warn('[coaching-core] hangup after target_ended (switch_mode) failed', err);
    }
    return {
      status: 409,
      body: { error: 'This member is no longer on a call.', code: 'TARGET_NOT_ON_CALL' },
    };
  }

  let whisperCallControlIds: string[] | undefined;
  if (mode === 'whisper') {
    const agentCallControlId = await agentLegCallControlId(supabase, freshTarget.agent_leg_id);
    if (!agentCallControlId) {
      return {
        status: 409,
        body: { error: 'This member is no longer on a call.', code: 'TARGET_NOT_ON_CALL' },
      };
    }
    whisperCallControlIds = [agentCallControlId];
  }

  try {
    await client.updateConferenceSupervisorRole(freshTarget.conference_id as string, {
      callControlId: row.manager_call_control_id as string,
      supervisorRole: toSupervisorRole(mode as CoachingMode),
      whisperCallControlIds,
    });
  } catch (err) {
    console.error('[coaching-core] updateConferenceSupervisorRole failed', err);
    return { status: 502, body: { error: 'Failed to switch coaching mode. Please try again.' } };
  }

  await supabase.from('coaching_sessions').update({ mode }).eq('id', coachingId);
  return { status: 200, body: { coachingId, mode } };
}

/**
 * Dispatched from `telnyx-webhook/index.ts` for any `call.*` event whose client_state decodes as
 * `CoachingClientState` -- mirrors `processTelnyxDialerEvent`/`processTelnyxInboundEvent`'s own
 * shape but is intentionally much smaller: a coaching leg only ever needs `call.answered` (join
 * the target conference) and `call.hangup` (finalize the row) handled at all.
 */
export async function processTelnyxCoachingEvent(
  supabase: SupabaseClient,
  client: TelnyxClient,
  args: { orgId: string; eventType: string; callControlId: string; coachingId: string }
): Promise<void> {
  const { data: row, error } = await supabase
    .from('coaching_sessions')
    .select('id, target_session_id, manager_id, mode, status')
    .eq('id', args.coachingId)
    .eq('org_id', args.orgId)
    .maybeSingle();
  if (error || !row) {
    console.error(
      '[coaching-core] webhook event for unknown/cross-org coaching row',
      args.coachingId,
      error?.message
    );
    return;
  }
  if (row.status === 'ended') return; // already finalized -- nothing left to do

  if (args.eventType === 'call.hangup') {
    await supabase
      .from('coaching_sessions')
      .update({
        status: 'ended',
        ended_at: new Date().toISOString(),
        ended_reason: 'manager_hangup',
      })
      .eq('id', row.id)
      .neq('status', 'ended');
    await logOrgAction(supabase, {
      orgId: args.orgId,
      actorUserId: row.manager_id as string,
      action: 'coaching.end',
      targetType: 'dial_session',
      targetId: row.target_session_id as string,
      details: { mode: row.mode, reason: 'manager_hangup' },
    });
    return;
  }

  if (args.eventType !== 'call.answered') return; // nothing else is interesting for this leg

  const endAsStale = async (reason: string) => {
    await supabase
      .from('coaching_sessions')
      .update({ status: 'ended', ended_at: new Date().toISOString(), ended_reason: reason })
      .eq('id', row.id)
      .neq('status', 'ended');
    try {
      await client.hangup(args.callControlId);
    } catch (err) {
      console.warn('[coaching-core] hangup-after-stale failed', err);
    }
  };

  const { data: targetSession } = await supabase
    .from('dial_sessions')
    .select('state, conference_id, agent_leg_id')
    .eq('id', row.target_session_id)
    .maybeSingle();
  if (!targetSession || targetSession.state !== 'on_call' || !targetSession.conference_id) {
    await endAsStale('target_ended');
    return;
  }

  let whisperCallControlIds: string[] | undefined;
  if (row.mode === 'whisper') {
    const agentCallControlId = await agentLegCallControlId(
      supabase,
      targetSession.agent_leg_id as string | null
    );
    if (!agentCallControlId) {
      await endAsStale('target_ended');
      return;
    }
    whisperCallControlIds = [agentCallControlId];
  }

  try {
    await client.joinConference(targetSession.conference_id as string, {
      callControlId: args.callControlId,
      supervisorRole: toSupervisorRole(row.mode as CoachingMode),
      whisperCallControlIds,
      endConferenceOnExit: false,
    });
  } catch (err) {
    console.error('[coaching-core] join target conference failed', err);
    await endAsStale('error');
    return;
  }

  await supabase
    .from('coaching_sessions')
    .update({
      status: 'active',
      joined_at: new Date().toISOString(),
      manager_call_control_id: args.callControlId,
    })
    .eq('id', row.id)
    .eq('status', 'starting');
}
