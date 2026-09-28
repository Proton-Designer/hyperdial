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
import { isManagerScopedToAgent } from './pod-scope.ts';

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

/** MISSION-5 TASK-M5-N1 (call takeover): same lookup as `agentLegCallControlId`, but also
 *  returns the leg's own CURRENT `state` -- `runTakeoverAction` needs it as the exact CAS
 *  `p_expected_states` value for its own `transition_leg` call (same "read fresh, CAS on
 *  whatever it actually is" idiom `handleAgentLegLost` uses in dialer-engine.ts, not a guessed
 *  fixed state). */
async function agentLegRow(
  supabase: SupabaseClient,
  agentLegId: string | null
): Promise<{ callControlId: string; state: string } | null> {
  if (!agentLegId) return null;
  const { data } = await supabase
    .from('call_legs')
    .select('call_control_id, state')
    .eq('id', agentLegId)
    .maybeSingle();
  const row = data as { call_control_id: string; state: string } | null;
  if (!row?.call_control_id) return null;
  return { callControlId: row.call_control_id, state: row.state };
}

/** MISSION-5 TASK-M5-N1 review fix-forward (SHOULD), LEG-scoped as of fix-forward #2 (the lead's
 *  own BLOCKER): true once ANY manager has taken over THIS SPECIFIC contact leg --
 *  `coaching_sessions_one_active_per_target` guarantees at most one row can ever hold a given
 *  `taken_over_leg_id`, but a session can have many legs over its lifetime, and only the one
 *  actually taken over should be excluded. `dialer-session-disposition/index.ts` uses this to
 *  exclude the ORIGINAL agent from dispositioning a leg they no longer have any part in once a
 *  takeover happened, mirroring (but distinct from) that same file's manager-branch lookup, which
 *  additionally scopes to `manager_id = caller` -- this one deliberately does not, since the
 *  question here is just "did a takeover happen on THIS leg," not "did THIS caller do it."
 *
 *  Originally session-scoped only (`target_session_id`, no leg filter) -- that let a takeover on
 *  one leg wrongly block the agent (and wrongly admit the manager) on every LATER leg of the same
 *  session too, once the agent successfully Rejoined and went back to dialing. */
export async function isSessionTakenOver(
  supabase: SupabaseClient,
  targetSessionId: string,
  legId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('coaching_sessions')
    .select('id')
    .eq('target_session_id', targetSessionId)
    .eq('taken_over_leg_id', legId)
    .not('taken_over_at', 'is', null)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

/** MISSION-5 TASK-M5-N1 fix-forward #2: the manager-side mirror of `isSessionTakenOver` above --
 *  true only if THIS manager personally took over THIS SPECIFIC leg (not any leg of the session,
 *  and not a takeover by some OTHER manager). Extracted out of dialer-session-disposition/
 *  index.ts's manager branch (which used to hand-roll this same query inline) so it's exercised
 *  by this file's own deno tests instead of only by code review -- same "compose once, test
 *  once" reasoning `isSessionTakenOver` itself already followed. */
export async function isLegTakenOverByManager(
  supabase: SupabaseClient,
  targetSessionId: string,
  legId: string,
  managerId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('coaching_sessions')
    .select('id')
    .eq('target_session_id', targetSessionId)
    .eq('manager_id', managerId)
    .eq('taken_over_leg_id', legId)
    .not('taken_over_at', 'is', null)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

/** MISSION-5 TASK-M5-B2: "Already being coached by X" needs a human name, not a bare uuid.
 *  Deliberately profiles-only (no auth.users email fallback, unlike team_daily_stats' own
 *  coalesce chain) -- this is a same-org manager-to-manager message, not a roster display, and
 *  an extra admin-API round trip for a name nobody strictly needs is not worth it here. */
async function resolveManagerName(supabase: SupabaseClient, managerId: string): Promise<string> {
  const { data } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('user_id', managerId)
    .maybeSingle();
  const name = [data?.first_name, data?.last_name].filter(Boolean).join(' ').trim();
  return name || 'another manager';
}

/** MISSION-5 TASK-M5-B2 (EC-8): "at most one active coaching session per TARGET call" --
 *  `coaching_sessions_one_active_per_target` is the real guarantee (this pre-check only closes
 *  the common case with a clean, specific message before ever dialing the manager's phone; the
 *  unique index is what the insert's own 23505 handler below falls back to for the TOCTOU race
 *  two managers clicking at once).
 *
 *  MISSION-5 B2 SHOULD follow-up: `callerManagerId` special-cases the caller being the SAME
 *  manager already coaching this target (a double-click/double-tab) -- still blocks the
 *  duplicate, just with a message that doesn't confusingly name the caller themselves as if they
 *  were someone else. */
async function alreadyCoachedError(
  supabase: SupabaseClient,
  targetSessionId: string,
  callerManagerId: string
): Promise<ActionResult | null> {
  const { data: existing } = await supabase
    .from('coaching_sessions')
    .select('manager_id')
    .eq('target_session_id', targetSessionId)
    .in('status', ['starting', 'active'])
    .maybeSingle();
  if (!existing) return null;
  if (existing.manager_id === callerManagerId) {
    return {
      status: 409,
      body: { error: 'You are already coaching this call.', code: 'ALREADY_COACHED' },
    };
  }
  const managerName = await resolveManagerName(supabase, existing.manager_id as string);
  return {
    status: 409,
    body: { error: `Already being coached by ${managerName}`, code: 'ALREADY_COACHED' },
  };
}

export async function runStartCoachingAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  callControlAppId: string,
  credentialConnectionId: string | null,
  orgId: string,
  managerId: string,
  callerRole: string,
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

  // MISSION-5 TASK-M5-B4: a manager (not owner/admin) may only coach an agent inside their own
  // managed pod scope -- fails before ever dialing the manager's own phone, same "fail fast"
  // placement as the whisper-mode agent-leg check below. Owner/admin are unrestricted, unchanged.
  if (callerRole === 'manager') {
    const inScope = await isManagerScopedToAgent(supabase, orgId, managerId, targetUserId);
    if (!inScope) {
      return { status: 403, body: { error: 'That agent is outside your managed pods' } };
    }
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

  // MISSION-5 TASK-M5-B2 (EC-8): a clean, specific message before ever dialing the manager's
  // phone for a target someone else is already coaching. See alreadyCoachedError's own header
  // for why the unique index (not this check) is the real guarantee.
  const alreadyCoached = await alreadyCoachedError(supabase, targetSession.id, managerId);
  if (alreadyCoached) return alreadyCoached;

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
    // 23505: TWO different partial unique indexes can fire here, and they mean different things
    // to the caller -- one active coaching row per MANAGER (the same MANAGER_BUSY case as the
    // check above, just caught after losing a race to a second click/tab instead of before it),
    // or, since MISSION-5 TASK-M5-B2, one active coaching row per TARGET (a second manager's
    // click raced `alreadyCoachedError`'s own pre-check above). Postgres names the violated
    // constraint IN the error message itself -- distinguishing on it is the only way to give the
    // right message without a second round trip guessing which one fired.
    if (insertError?.code === '23505') {
      if (insertError.message?.includes('coaching_sessions_one_active_per_target')) {
        const { data: winner } = await supabase
          .from('coaching_sessions')
          .select('manager_id')
          .eq('target_session_id', targetSession.id)
          .in('status', ['starting', 'active'])
          .maybeSingle();
        const managerName = winner
          ? await resolveManagerName(supabase, winner.manager_id as string)
          : 'another manager';
        return {
          status: 409,
          body: { error: `Already being coached by ${managerName}`, code: 'ALREADY_COACHED' },
        };
      }
      return {
        status: 409,
        body: { error: "You're already coaching another call.", code: 'MANAGER_BUSY' },
      };
    }
    console.error('[coaching-core] pending row insert failed', insertError?.message);
    return { status: 500, body: { error: 'Failed to record the coaching attempt' } };
  }
  const coachingId = pendingRow.id as string;

  // MISSION-5 TASK-M5-B2: "raise hand" auto-clears the moment a manager actually starts
  // coaching this target -- best-effort, never blocks the real coaching attempt over a failed
  // bookkeeping write.
  await supabase.from('dial_sessions').update({ raised_hand_at: null }).eq('id', targetSession.id);

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
 * MISSION-5 TASK-M5-N1 (deferred backlog item): supervisor call takeover. Converts an ALREADY
 * active coaching attempt (listen/whisper/barge, T3/B2) into a takeover -- the supervisor's own
 * conference role is promoted to `barge` (if it wasn't already), then the AGENT's own leg leaves
 * the conference (`leaveConference`) and hangs up (`hangup`) -- see audit/M5-N1/api-evidence.md
 * for why it's those two Telnyx commands, not one ("leave" only parks the leg, it doesn't end the
 * call -- an unhung-up parked leg would be exactly the "orphaned batch leg" the task's own
 * requirements forbid).
 *
 * Authorization is entirely "are you the manager already coaching this call" -- there is no
 * separate takeover-specific role/pod-scope grant to check beyond re-confirming the SAME pod
 * scope `runStartCoachingAction` already checked at coaching-start time (re-checked here too,
 * defense in depth, in case the agent's pod changed mid-call -- same standing rule every other
 * B4 remote action already follows). Owner/admin need no pod check, same as everywhere else.
 *
 * DB-side session/leg detach happens BEFORE any Telnyx command -- see this file's own module
 * header note (TODO: none needed, see audit/M5-N1/notes.md) for why: clearing
 * `dial_sessions.agent_leg_id` before issuing `leaveConference`/`hangup` means that by the time
 * Telnyx's real `call.hangup` webhook for the agent leg eventually arrives,
 * `processAgentLegEvent`'s OWN existing stale-leg guard (`leg.id !== session.agent_leg_id`,
 * dialer-engine.ts:1663) already treats it as stale and no-ops -- the generic "agent leg lost ->
 * paused_agent_lost" cascade never runs a second time on top of this function's own clean
 * transition. Zero changes to dialer-engine.ts.
 */
export async function runTakeoverAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  managerId: string,
  callerRole: string,
  body: Record<string, unknown>
): Promise<ActionResult> {
  const coachingId = typeof body.coachingId === 'string' ? body.coachingId : '';
  if (!coachingId) return { status: 400, body: { error: 'coachingId is required.' } };

  const { data: row, error: rowError } = await supabase
    .from('coaching_sessions')
    .select(
      'id, target_session_id, target_user_id, manager_id, manager_call_control_id, mode, status, taken_over_at'
    )
    .eq('id', coachingId)
    .eq('org_id', orgId)
    .eq('manager_id', managerId)
    .maybeSingle();
  if (rowError) {
    console.error('[coaching-core] takeover row lookup failed', rowError.message);
    return { status: 500, body: { error: 'Failed to look up the coaching attempt' } };
  }
  if (!row) return { status: 404, body: { error: 'Coaching attempt not found.' } };
  if (row.status !== 'active' || !row.manager_call_control_id) {
    return {
      status: 409,
      body: { error: 'This coaching attempt is not connected yet.', code: 'NOT_ACTIVE' },
    };
  }
  if (row.taken_over_at) {
    return {
      status: 409,
      body: { error: 'You already took over this call.', code: 'ALREADY_TAKEN_OVER' },
    };
  }

  if (callerRole === 'manager') {
    const inScope = await isManagerScopedToAgent(
      supabase,
      orgId,
      managerId,
      row.target_user_id as string
    );
    if (!inScope) {
      return { status: 403, body: { error: 'That agent is outside your managed pods' } };
    }
  }

  const { data: settings } = await supabase
    .from('org_call_takeover_settings')
    .select('enabled')
    .eq('org_id', orgId)
    .maybeSingle();
  if (!settings?.enabled) {
    return {
      status: 403,
      body: { error: 'Call takeover is not enabled for your org.', code: 'TAKEOVER_DISABLED' },
    };
  }

  // Re-read the target session FRESH (same "pin by the row's own target_session_id, don't
  // re-derive by agent_id" reasoning runSwitchCoachingModeAction's own comment already gives).
  // N1 fix-forward #2: `active_leg_id` is now selected too -- it's the CONTACT leg the agent was
  // actually on at takeover time (the one that gets dispositioned), and the claim below records
  // it as `taken_over_leg_id` BEFORE the transition_session call clears it to null.
  const { data: targetSession } = await supabase
    .from('dial_sessions')
    .select('id, state, conference_id, agent_leg_id, active_leg_id')
    .eq('id', row.target_session_id)
    .maybeSingle();
  if (!targetSession || targetSession.state !== 'on_call' || !targetSession.conference_id) {
    return {
      status: 409,
      body: { error: 'This member is no longer on a call.', code: 'TARGET_NOT_ON_CALL' },
    };
  }

  const agentLeg = await agentLegRow(supabase, targetSession.agent_leg_id as string | null);
  if (!agentLeg) {
    return {
      status: 409,
      body: { error: 'This member is no longer on a call.', code: 'TARGET_NOT_ON_CALL' },
    };
  }

  // The race-guard: "two clicks land at once" (a double-click/double-tab, since only ONE manager
  // can ever hold this row at all -- coaching_sessions_one_active_per_target) reduces to two
  // concurrent claims on this SAME row. Whichever request's conditional UPDATE actually matches a
  // row wins; the other gets null back and a clean rejection before ever touching Telnyx.
  // N1 fix-forward #2: `taken_over_leg_id` is claimed in the SAME update as `taken_over_at` --
  // this is the leg every later leg-scoped check (isSessionTakenOver, the manager-branch lookup
  // in dialer-session-disposition/index.ts) keys on, so it must land atomically with the claim
  // itself, not in a separate write that could theoretically be skipped/lost.
  const { data: claimed } = await supabase
    .from('coaching_sessions')
    .update({
      taken_over_at: new Date().toISOString(),
      mode: 'barge',
      taken_over_leg_id: targetSession.active_leg_id as string | null,
    })
    .eq('id', coachingId)
    .eq('status', 'active')
    .is('taken_over_at', null)
    .select('id')
    .maybeSingle();
  if (!claimed) {
    return {
      status: 409,
      body: { error: 'You already took over this call.', code: 'ALREADY_TAKEN_OVER' },
    };
  }

  // DB-side detach BEFORE any Telnyx command -- see this function's own header for why the
  // ordering matters. `['on_call', 'paused_agent_lost']` covers both "the normal case" and "the
  // agent's own leg hung up at almost the same moment and the generic cascade already landed the
  // session in paused_agent_lost" -- either way this overwrites it with the clean takeover state.
  //
  // BOTH results are checked (eng1 review, BLOCKER 1): either CAS can miss independently of the
  // other -- e.g. the prospect hangs up and the session is already `wrap_up` by the time
  // `transition_session` runs (that CAS misses, `transition_leg` can still match), or the agent's
  // own leg already ended via the generic cascade (`transition_leg`'s CAS misses against the
  // OLD `agentLeg.state` read above, while `transition_session`'s CAS still matches since
  // `paused_agent_lost` is one of its own expected states). A silent miss here previously still
  // fired the Telnyx commands and returned 200 -- exactly the bug `agent_leg_conference_created`'s
  // own `persisted` check (dialer-engine.ts) already exists to avoid elsewhere in this codebase.
  const { data: legTransitioned } = await supabase.rpc('transition_leg', {
    p_call_control_id: agentLeg.callControlId,
    p_expected_states: [agentLeg.state],
    p_new_state: 'ended',
    p_fields: { hangup_cause: 'supervisor_takeover', ended_at: new Date().toISOString() },
  });
  const { data: sessionTransitioned } = await supabase.rpc('transition_session', {
    p_session: targetSession.id,
    p_expected_states: ['on_call', 'paused_agent_lost'],
    p_new_state: 'paused',
    p_fields: {
      pause_reason: 'call_taken_over_by_manager',
      taken_over_by_manager_id: managerId,
      agent_leg_id: null,
      active_leg_id: null,
      conference_id: null,
      paused_agent_lost_from: null,
    },
  });

  if (!legTransitioned || !sessionTransitioned) {
    // N1 fix-forward #2 (eng1 re-verify residual SHOULD): transition_leg can succeed while
    // transition_session misses (the prospect hangs up and the session is already `wrap_up` by
    // the time transition_session runs) -- that leaves the agent's real call_legs row falsely
    // marked `state: 'ended', hangup_cause: 'supervisor_takeover'` even though no Telnyx command
    // was ever actually issued to end it. Revert that CAS too, back to the exact pre-takeover
    // state this function itself read at the top (`agentLeg.state`), so no false historical
    // record survives a takeover that never actually completed.
    if (legTransitioned && !sessionTransitioned) {
      await supabase.rpc('transition_leg', {
        p_call_control_id: agentLeg.callControlId,
        p_expected_states: ['ended'],
        p_new_state: agentLeg.state,
        p_fields: { hangup_cause: null, ended_at: null },
      });
    }
    // Never issue a single Telnyx command against a DB state that didn't actually land --
    // release the coaching claim (clear taken_over_at/mode/taken_over_leg_id back to what they
    // were) so the row stays a normal, still-`active` coaching attempt: closeable by the reaper
    // if it's since gone stale, or retriable by the manager if the target is genuinely still
    // reachable.
    await supabase
      .from('coaching_sessions')
      .update({ taken_over_at: null, mode: row.mode, taken_over_leg_id: null })
      .eq('id', coachingId);
    return {
      status: 409,
      body: { error: 'This member is no longer on a call.', code: 'TARGET_NOT_ON_CALL' },
    };
  }

  // Telnyx commands last, now that the DB already reflects the final state regardless of how
  // any of these three turn out -- all three are best-effort from here (a taken-over call whose
  // agent leg was somehow already gone, or a role-promotion that fails, still leaves the org's
  // own data in a consistent, recoverable state; see audit/M5-N1/notes.md's edge-case table).
  let roleUpdateFailed = false;
  if (row.mode !== 'barge') {
    try {
      await client.updateConferenceSupervisorRole(targetSession.conference_id as string, {
        callControlId: row.manager_call_control_id as string,
        supervisorRole: 'barge',
      });
    } catch (err) {
      console.error('[coaching-core] takeover role promotion failed', err);
      roleUpdateFailed = true;
    }
  }

  try {
    await client.leaveConference(targetSession.conference_id as string, agentLeg.callControlId);
  } catch (err) {
    console.warn('[coaching-core] takeover leaveConference failed', err);
  }
  try {
    await client.hangup(agentLeg.callControlId);
  } catch (err) {
    console.warn('[coaching-core] takeover hangup failed', err);
  }

  await logOrgAction(supabase, {
    orgId,
    actorUserId: managerId,
    action: 'session.call_takeover',
    targetType: 'dial_session',
    targetId: targetSession.id,
    details: { agentId: row.target_user_id, coachingId, previousMode: row.mode },
  });

  return { status: 200, body: { ok: true, roleUpdateFailed } };
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

/** MISSION-5 TASK-M5-B2 (EC-8: "coaching ends cleanly if ... the coach is disabled/removed"):
 *  called from org-members/index.ts's cascadeOffboard. Ends every 'starting'/'active' coaching
 *  row for this manager -- best-effort Telnyx hangup per row (mirrors
 *  hangUpReapedCoachingSessions' own "our bookkeeping already reads ended regardless" shape),
 *  never throws. A manager being disabled/removed almost never has a live coaching leg (the
 *  common case is zero rows here), so this is cheap in the overwhelmingly common case too. */
export async function endActiveCoachingSessionsForManager(
  supabase: SupabaseClient,
  client: TelnyxClient | null,
  managerId: string,
  reason: string
): Promise<number> {
  const { data: rows } = await supabase
    .from('coaching_sessions')
    .select('id, manager_call_control_id')
    .eq('manager_id', managerId)
    .in('status', ['starting', 'active']);
  const active = (rows ?? []) as { id: string; manager_call_control_id: string | null }[];
  if (active.length === 0) return 0;

  await supabase
    .from('coaching_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString(), ended_reason: reason })
    .in(
      'id',
      active.map((r) => r.id)
    );

  if (client) {
    for (const row of active) {
      if (!row.manager_call_control_id) continue;
      try {
        await client.hangup(row.manager_call_control_id);
      } catch (err) {
        console.warn('[coaching-core] endActiveCoachingSessionsForManager hangup failed', err);
      }
    }
  }
  return active.length;
}

/** MISSION-5 TASK-M5-B2 (EC-8: "coaching ends cleanly if the target call is transferred"): called
 *  from transfer-core.ts's runCompleteTransferAction right after a transfer finalizes. Closes a
 *  real gap the 60s sweeper (reap_stale_coaching_sessions) cannot catch on its own: a transfer
 *  moves the CUSTOMER out of `dial_sessions.conference_id` into a side conference (or a fully
 *  external destination), but `dial_sessions.state` stays 'on_call' throughout -- the sweeper's
 *  own staleness condition (`ds.state <> 'on_call'`) never fires, so an active coaching session
 *  on a transferred call would otherwise linger for up to COACHING_HARD_CAP_SECONDS (2 hours). At
 *  most one active row per target (EC-8's own unique index), so this is always 0 or 1 row. */
export async function endActiveCoachingForTargetSession(
  supabase: SupabaseClient,
  client: TelnyxClient | null,
  targetSessionId: string,
  reason: string
): Promise<boolean> {
  const { data: row } = await supabase
    .from('coaching_sessions')
    .select('id, manager_call_control_id')
    .eq('target_session_id', targetSessionId)
    .in('status', ['starting', 'active'])
    .maybeSingle();
  if (!row) return false;

  await supabase
    .from('coaching_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString(), ended_reason: reason })
    .eq('id', row.id as string);

  if (client && row.manager_call_control_id) {
    try {
      await client.hangup(row.manager_call_control_id as string);
    } catch (err) {
      console.warn('[coaching-core] endActiveCoachingForTargetSession hangup failed', err);
    }
  }
  return true;
}
