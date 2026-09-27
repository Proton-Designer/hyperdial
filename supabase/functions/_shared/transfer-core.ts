/**
 * TASK-T4 (Mission 4): warm/cold transfer + hold (AUD-6 + NEW). See the migration's own header
 * (20260926070002) for the full "why conference-native actions, never `transfer`" design
 * rationale and the exact hold/side-conference mechanics -- this file is the orchestration layer
 * (validation, the Telnyx calls, the call_transfers/call_legs bookkeeping) so it can be
 * deno-tested with a fake supabase + fake TelnyxClient, same "pure/testable core, thin HTTP
 * shell" split as coaching-core.ts/billing-core.ts/dialer-engine.ts.
 *
 * The dialed TARGET leg is tracked ONLY on `call_transfers.target_call_control_id`, never given
 * a `call_legs` row -- the same "new real-time participant, dedicated table, not a third
 * `call_legs.kind`" move TASK-T3's coaching leg made, for the identical reason (LANE-eng2.md's
 * own documented history of kind-agnostic dial-loop code breaking on a new leg shape).
 *
 * State machine (`call_transfers.status`): dialing -> connected (warm only, once the target
 * answers and the agent is talking to them) -> completed | cancelled, or dialing -> failed
 * (target never answered) | connected -> failed (target hung up mid-conversation, or the
 * sweeper's own staleness reap). A COLD transfer skips 'connected' entirely -- the prospect moves
 * straight to the target the instant it answers, dialing -> completed in one step.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { parsePhoneNumberFromString } from 'npm:libphonenumber-js';
import type { TelnyxClient } from './telnyx-client.ts';
import { agentSipUri } from './dialer-engine.ts';
import { encodeTransferTargetClientState } from './client-state.ts';
import { webhookUrlForOrg } from './telnyx-provision.ts';
import { checkSpendGate } from './spend-gate.ts';

export type TransferType = 'cold' | 'warm';
export type TransferTargetKind = 'member' | 'external';

export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

// Ring timeout for the transfer target -- shorter than a normal contact dial (CONTACT_DIAL_TIME_
// LIMIT_SECS' own 25s-ish ring window doesn't apply here at all, this is a fresh constant for a
// fresh purpose): a teammate/E.164 destination the intern is actively waiting on, similar in
// spirit to the agent leg's own AGENT_DIAL_TIMEOUT_SECS reasoning but not borrowed from it (that
// constant is about a WebRTC tab's own answer latency, unrelated to why a transfer target rings).
const TRANSFER_DIAL_TIMEOUT_SECS = 30;
const TRANSFER_DIAL_TIME_LIMIT_SECS = 14400;

function webhookBaseUrl(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-webhook`;
}

interface SessionRow {
  id: string;
  org_id: string;
  agent_id: string;
  state: string;
  conference_id: string | null;
  agent_leg_id: string | null;
  active_leg_id: string | null;
}

interface LegRow {
  id: string;
  call_control_id: string;
  kind: string;
  state: string;
  held_at: string | null;
  contact_id: string | null;
}

interface CallTransferRow {
  id: string;
  org_id: string;
  session_id: string;
  contact_leg_id: string;
  type: TransferType;
  target_kind: TransferTargetKind;
  target_user_id: string | null;
  target_number: string | null;
  target_call_control_id: string | null;
  side_conference_id: string | null;
  status: string;
}

async function loadSession(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<SessionRow | null> {
  const { data } = await supabase
    .from('dial_sessions')
    .select('id, org_id, agent_id, state, conference_id, agent_leg_id, active_leg_id')
    .eq('id', sessionId)
    .eq('org_id', orgId)
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

async function loadLegById(supabase: SupabaseClient, legId: string): Promise<LegRow | null> {
  const { data } = await supabase
    .from('call_legs')
    .select('id, call_control_id, kind, state, held_at, contact_id')
    .eq('id', legId)
    .maybeSingle();
  return (data as LegRow | null) ?? null;
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

/** Any org phone number works as the target dial's caller-id `from` -- same reasoning as
 *  coaching-core.ts's own `anyOrgFromNumber` (a fresh copy here, not imported: that one is a
 *  module-private helper, and this feature's own justification -- "no campaign/legacy caller-ID
 *  tier applies to a transfer dial" -- is independent of coaching's). */
async function anyOrgFromNumber(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data } = await supabase
    .from('user_phone_numbers')
    .select('phone_number')
    .eq('org_id', orgId)
    .limit(1)
    .maybeSingle();
  return (data?.phone_number as string | undefined) ?? null;
}

/** `profiles.first_name`/`last_name` -- the same lookup submit_disposition's own GHL note and
 *  inbound-engine.ts's `enqueueInboundCallNoteJob` already use (`org_members` has no display-
 *  name column at all). */
async function memberDisplayName(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('user_id', userId)
    .maybeSingle();
  const name = [data?.first_name, data?.last_name].filter(Boolean).join(' ').trim();
  return name || null;
}

function callerCanActOnSession(session: SessionRow, role: string, callerId: string): boolean {
  if (role === 'agent') return session.agent_id === callerId;
  return role === 'admin' || role === 'owner';
}

// ---------------------------------------------------------------------------
// Hold / Resume (AUD-6) -- standalone, unrelated to a transfer in progress.
// ---------------------------------------------------------------------------

async function loadOnCallProspectLeg(
  supabase: SupabaseClient,
  orgId: string,
  role: string,
  callerId: string,
  sessionId: string
): Promise<{ session: SessionRow; leg: LegRow } | ActionResult> {
  const session = await loadSession(supabase, orgId, sessionId);
  if (!session) return { status: 404, body: { error: 'Session not found' } };
  if (!callerCanActOnSession(session, role, callerId)) {
    return { status: 403, body: { error: 'Not your session' } };
  }
  if (session.state !== 'on_call' || !session.active_leg_id || !session.conference_id) {
    return { status: 409, body: { error: 'NOT_ON_CALL', code: 'NOT_ON_CALL' } };
  }
  const leg = await loadLegById(supabase, session.active_leg_id);
  if (!leg || leg.kind !== 'contact' || leg.state !== 'claimed') {
    return { status: 409, body: { error: 'NOT_ON_CALL', code: 'NOT_ON_CALL' } };
  }
  return { session, leg };
}

export async function runHoldAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  role: string,
  callerId: string,
  body: { sessionId?: string }
): Promise<ActionResult> {
  if (!body.sessionId) return { status: 400, body: { error: 'sessionId is required' } };
  const resolved = await loadOnCallProspectLeg(supabase, orgId, role, callerId, body.sessionId);
  if ('status' in resolved) return resolved;
  const { session, leg } = resolved;

  if (leg.held_at) return { status: 200, body: { heldAt: leg.held_at } };

  try {
    await client.holdConferenceParticipants(session.conference_id as string, {
      callControlIds: [leg.call_control_id],
    });
  } catch (err) {
    console.error('[transfer-core] hold failed', err);
    return { status: 502, body: { error: 'Failed to hold the call' } };
  }

  const heldAt = new Date().toISOString();
  await supabase.from('call_legs').update({ held_at: heldAt }).eq('id', leg.id);
  return { status: 200, body: { heldAt } };
}

export async function runResumeAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  role: string,
  callerId: string,
  body: { sessionId?: string }
): Promise<ActionResult> {
  if (!body.sessionId) return { status: 400, body: { error: 'sessionId is required' } };
  const resolved = await loadOnCallProspectLeg(supabase, orgId, role, callerId, body.sessionId);
  if ('status' in resolved) return resolved;
  const { session, leg } = resolved;

  if (!leg.held_at) return { status: 200, body: { heldAt: null } };

  try {
    await client.unholdConferenceParticipants(session.conference_id as string, {
      callControlIds: [leg.call_control_id],
    });
  } catch (err) {
    console.error('[transfer-core] resume failed', err);
    return { status: 502, body: { error: 'Failed to resume the call' } };
  }

  await supabase.from('call_legs').update({ held_at: null }).eq('id', leg.id);
  return { status: 200, body: { heldAt: null } };
}

// ---------------------------------------------------------------------------
// Start transfer (cold or warm)
// ---------------------------------------------------------------------------

function isE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

// ---------------------------------------------------------------------------
// Review fix-forward (eng1, review-eng1.md BLOCKER 2 + lead's dispatch): an external transfer
// target is a free-form number the agent types in -- unlike a contact from an imported/vetted
// list, so it gets its own guard stack, all server-side (the client-side TransferModal hiding
// the option is UX only, never trusted). Member (internal) transfers skip all of this by design
// (item e of the dispatch) -- a teammate is already an org_members row, not a free-form number.
// ---------------------------------------------------------------------------

/** Max external transfers a single agent may INITIATE per rolling hour, DB-counted from
 *  call_transfers (never in-memory -- a fresh Edge Function invocation has no memory to count
 *  in). Deliberately generous (10/hr is far above any legitimate warm/cold handoff rate) --
 *  this exists to bound the "start -> cancel -> restart" abuse case eng1's review found, not to
 *  throttle normal use. */
const EXTERNAL_TRANSFER_RATE_LIMIT_PER_HOUR = 10;

/** NANP N11 codes (211/311/411/511/611/711/811/911) are service codes, never real subscriber
 *  numbers -- listed explicitly per the dispatch even though `parsePhoneNumberFromString`'s own
 *  `isValid()` already rejects most of these as invalid NANP area codes; kept as a named,
 *  self-documenting check rather than relying solely on libphonenumber's metadata not changing
 *  underneath this later. */
const N11_AREA_CODES: ReadonlySet<string> = new Set([
  '211',
  '311',
  '411',
  '511',
  '611',
  '711',
  '811',
  '911',
]);

/** Returns a user-facing rejection reason, or null when the number is an allowed external
 *  transfer target. NANP only (matches the dispatch's "+1, a valid 10-digit NPA-NXX"): a bare
 *  10-digit national number is assumed US per `parsePhoneNumberFromString`'s own
 *  `defaultCountry` argument, same convention `phone-normalize.ts` already uses -- not imported
 *  from there since that module is shared with CSV/GHL contact import and has nothing to do
 *  with this feature's own premium/toll rejection list.
 *  Premium/toll rejection: NPA 900 (the classic "900 number") and NXX 976 (the older regional
 *  "976 pay-per-call" exchange code, which can appear under ANY area code, not just 900) are
 *  both real, valid-format NANP numbers -- `isValid()` alone would accept them. `getType()` is
 *  also checked for 'PREMIUM_RATE' as a second signal, but the explicit NPA/NXX checks are the
 *  ones actually doing the work: libphonenumber-js's metadata tracks 900 as premium-rate but
 *  does NOT universally flag every area code's own local 976 exchange as such. Toll-FREE
 *  numbers (800/888/877/866/855/844/833) are deliberately NOT rejected -- "premium/toll" in the
 *  dispatch means pay-per-call premium numbers, not toll-free ones, which are ordinary business
 *  lines an agent might legitimately warm-transfer to. */
function externalTransferRejectionReason(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw, 'US');
  if (!parsed || !parsed.isValid()) {
    return 'That number is not a valid phone number.';
  }
  if (parsed.country !== 'US' && parsed.country !== 'CA') {
    return 'External transfers are limited to US/Canada (NANP) numbers.';
  }
  const national = parsed.nationalNumber;
  if (national.length !== 10) {
    return 'External transfers are limited to US/Canada (NANP) numbers.';
  }
  const npa = national.slice(0, 3);
  const nxx = national.slice(3, 6);
  if (
    npa === '900' ||
    nxx === '976' ||
    N11_AREA_CODES.has(npa) ||
    parsed.getType() === 'PREMIUM_RATE'
  ) {
    return 'This number looks like a premium-rate number and cannot be used as a transfer target.';
  }
  return null;
}

async function isNumberOnOrgDnc(
  supabase: SupabaseClient,
  orgId: string,
  e164: string
): Promise<boolean> {
  const { data } = await supabase
    .from('dnc_numbers')
    .select('e164')
    .eq('org_id', orgId)
    .eq('e164', e164)
    .maybeSingle();
  return data != null;
}

async function getAllowExternalTransfers(
  supabase: SupabaseClient,
  orgId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('org_transfer_settings')
    .select('allow_external_transfers')
    .eq('org_id', orgId)
    .maybeSingle();
  return Boolean(data?.allow_external_transfers);
}

async function externalTransferRateLimited(
  supabase: SupabaseClient,
  orgId: string,
  callerId: string
): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('call_transfers')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('initiated_by', callerId)
    .eq('target_kind', 'external')
    .gte('created_at', oneHourAgo);
  return (count ?? 0) >= EXTERNAL_TRANSFER_RATE_LIMIT_PER_HOUR;
}

/** Runs every external-target guard in order, cheapest/no-I-O first. Returns an ActionResult to
 *  return immediately on rejection, or null to proceed. Called BEFORE the `call_transfers`
 *  insert/dial -- a rejected external target never creates a row or reaches Telnyx at all. */
async function checkExternalTransferAllowed(
  supabase: SupabaseClient,
  orgId: string,
  callerId: string,
  targetNumber: string
): Promise<ActionResult | null> {
  const rejection = externalTransferRejectionReason(targetNumber);
  if (rejection) {
    return { status: 400, body: { error: rejection, code: 'EXTERNAL_TRANSFER_NUMBER_REJECTED' } };
  }
  if (!(await getAllowExternalTransfers(supabase, orgId))) {
    return {
      status: 403,
      body: {
        error:
          'External-number transfers are disabled for this org. Ask an owner or admin to enable them in Settings.',
        code: 'EXTERNAL_TRANSFERS_DISABLED',
      },
    };
  }
  if (await isNumberOnOrgDnc(supabase, orgId, targetNumber)) {
    return {
      status: 400,
      body: {
        error: "This number is on your org's do-not-call list.",
        code: 'EXTERNAL_TRANSFER_NUMBER_REJECTED',
      },
    };
  }
  // Same gate contact dialing itself uses (dialer-session-start/index.ts) -- reused, not
  // reimplemented, so "over spend cap" means the same thing everywhere in this codebase.
  const spendGate = await checkSpendGate(supabase, orgId);
  if (spendGate.blocked) {
    return { status: 400, body: { error: spendGate.message, code: spendGate.code } };
  }
  if (await externalTransferRateLimited(supabase, orgId, callerId)) {
    return {
      status: 429,
      body: {
        error: 'Too many external transfers in the last hour. Try again later.',
        code: 'EXTERNAL_TRANSFER_RATE_LIMIT',
      },
    };
  }
  return null;
}

export async function runStartTransferAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  callControlAppId: string,
  credentialConnectionId: string | null,
  orgId: string,
  role: string,
  callerId: string,
  body: {
    sessionId?: string;
    type?: string;
    targetKind?: string;
    targetUserId?: string;
    targetNumber?: string;
  }
): Promise<ActionResult> {
  if (body.type !== 'cold' && body.type !== 'warm') {
    return { status: 400, body: { error: 'type must be "cold" or "warm"' } };
  }
  if (body.targetKind !== 'member' && body.targetKind !== 'external') {
    return { status: 400, body: { error: 'targetKind must be "member" or "external"' } };
  }
  if (body.targetKind === 'member' && !body.targetUserId) {
    return { status: 400, body: { error: 'targetUserId is required for a member target' } };
  }
  if (body.targetKind === 'external' && (!body.targetNumber || !isE164(body.targetNumber))) {
    return { status: 400, body: { error: 'targetNumber must be a valid E.164 number' } };
  }
  if (!body.sessionId) return { status: 400, body: { error: 'sessionId is required' } };

  const type = body.type as TransferType;
  const targetKind = body.targetKind as TransferTargetKind;

  if (targetKind === 'external') {
    const rejection = await checkExternalTransferAllowed(
      supabase,
      orgId,
      callerId,
      body.targetNumber as string
    );
    if (rejection) return rejection;
  }

  const resolved = await loadOnCallProspectLeg(supabase, orgId, role, callerId, body.sessionId);
  if ('status' in resolved) return resolved;
  const { session, leg: prospectLeg } = resolved;

  let to: string;
  if (targetKind === 'member') {
    const { data: member } = await supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('user_id', body.targetUserId as string)
      .eq('status', 'active')
      .maybeSingle();
    if (!member) return { status: 404, body: { error: 'Target member not found in this org' } };
    try {
      to = await agentSipUri(
        supabase,
        client,
        orgId,
        body.targetUserId as string,
        credentialConnectionId
      );
    } catch (err) {
      console.error('[transfer-core] agentSipUri failed', err);
      return { status: 502, body: { error: "Failed to resolve the target teammate's line" } };
    }
  } else {
    to = body.targetNumber as string;
  }

  const fromNumber = await anyOrgFromNumber(supabase, orgId);
  if (!fromNumber) {
    return { status: 400, body: { error: 'Your org has no phone number yet.' } };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('call_transfers')
    .insert({
      org_id: orgId,
      session_id: session.id,
      contact_leg_id: prospectLeg.id,
      type,
      target_kind: targetKind,
      target_user_id: targetKind === 'member' ? body.targetUserId : null,
      target_number: targetKind === 'external' ? body.targetNumber : null,
      initiated_by: callerId,
    })
    .select('id')
    .single();
  if (insertError) {
    // 23505: call_transfers_one_active_per_session -- TOCTOU close, same coaching_sessions shape.
    if ((insertError as { code?: string }).code === '23505') {
      return { status: 409, body: { error: 'TRANSFER_IN_PROGRESS', code: 'TRANSFER_IN_PROGRESS' } };
    }
    console.error('[transfer-core] call_transfers insert failed', insertError);
    return { status: 500, body: { error: 'Failed to start the transfer' } };
  }
  const transferId = (inserted as { id: string }).id;

  try {
    const { callControlId } = await client.dial({
      connectionId: callControlAppId,
      to,
      from: fromNumber,
      webhookUrl: webhookUrlForOrg(webhookBaseUrl(), orgId),
      clientState: encodeTransferTargetClientState({ org: orgId, transfer: transferId }),
      timeoutSecs: TRANSFER_DIAL_TIMEOUT_SECS,
      timeLimitSecs: TRANSFER_DIAL_TIME_LIMIT_SECS,
      amdMode: 'off',
    });
    // Same-status field-only update (same established shape as ensureAgentConference's own
    // conference_id persist) -- just records the leg id, doesn't change status.
    await supabase.rpc('transition_call_transfer', {
      p_transfer: transferId,
      p_org: orgId,
      p_expected_statuses: ['dialing'],
      p_new_status: 'dialing',
      p_fields: { target_call_control_id: callControlId },
    });
  } catch (err) {
    console.error('[transfer-core] dial failed', err);
    await supabase.rpc('transition_call_transfer', {
      p_transfer: transferId,
      p_org: orgId,
      p_expected_statuses: ['dialing'],
      p_new_status: 'failed',
      p_fields: { ended_at: new Date().toISOString(), ended_reason: 'dial_failed' },
    });
    return { status: 502, body: { error: 'Failed to reach the transfer target' } };
  }

  return { status: 200, body: { transferId, status: 'dialing' } };
}

// ---------------------------------------------------------------------------
// Shared warm-transfer unwind (Cancel action AND the sweeper's own 'connected' reap use this).
// ---------------------------------------------------------------------------

/** Best-effort: every step is independently try/caught so a partial failure never prevents the
 *  rest of the unwind from being attempted -- this runs in exactly the situations ("cancel",
 *  "stale reap") where the caller is already recovering from an imperfect state, not extending
 *  a happy path. */
export async function unwindWarmTransferToMain(
  client: TelnyxClient,
  args: {
    mainConferenceId: string;
    sideConferenceId: string | null;
    agentCallControlId: string | null;
    prospectCallControlId: string;
  }
): Promise<void> {
  if (args.sideConferenceId && args.agentCallControlId) {
    try {
      await client.leaveConference(args.sideConferenceId, args.agentCallControlId);
    } catch (err) {
      console.warn('[transfer-core] unwind: agent leaveConference(side) failed', err);
    }
  }
  if (args.agentCallControlId) {
    try {
      await client.joinConference(args.mainConferenceId, {
        callControlId: args.agentCallControlId,
      });
    } catch (err) {
      console.warn('[transfer-core] unwind: agent joinConference(main) failed', err);
    }
  }
  try {
    await client.unholdConferenceParticipants(args.mainConferenceId, {
      callControlIds: [args.prospectCallControlId],
    });
  } catch (err) {
    console.warn('[transfer-core] unwind: unhold prospect failed', err);
  }
}

/**
 * Review fix-forward (eng1, review-eng1.md SHOULD): when the agent hangs up (or the customer
 * leg ends) while a transfer is 'dialing' or 'connected', cancel it right away instead of
 * leaving it for `reap_stale_call_transfers`' own 5-minute/2-hour timeouts. Same logic
 * `runCancelTransferAction` runs for a user-initiated Cancel, minus the role/ownership check
 * (this is called from trusted engine code -- `endLiveCall`, and the contact-leg-ended webhook
 * branch in dialer-engine.ts -- which has already resolved the session, not from an HTTP body).
 * Best-effort and never throws, same convention as `unwindWarmTransferToMain` itself: this runs
 * exactly in the two places ("the agent just hung up", "the customer leg just ended") where the
 * caller is already tearing the call down, never on a happy path.
 */
export async function cancelInFlightTransferForSession(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  sessionId: string,
  reason: string
): Promise<void> {
  const { data } = await supabase
    .from('call_transfers')
    .select(
      'id, org_id, session_id, contact_leg_id, type, target_kind, target_user_id, target_number, target_call_control_id, side_conference_id, status'
    )
    .eq('session_id', sessionId)
    .in('status', ['dialing', 'connected'])
    .maybeSingle();
  if (!data) return;
  const row = data as CallTransferRow;

  if (row.target_call_control_id) {
    try {
      await client.hangup(row.target_call_control_id);
    } catch (err) {
      console.warn('[transfer-core] cancelInFlightTransferForSession: target hangup failed', err);
    }
  }
  if (row.status === 'connected') {
    const session = await loadSession(supabase, orgId, sessionId);
    const prospectLeg = await loadLegById(supabase, row.contact_leg_id);
    if (session?.conference_id && prospectLeg) {
      const agentCallControlId = await agentLegCallControlId(supabase, session.agent_leg_id);
      await unwindWarmTransferToMain(client, {
        mainConferenceId: session.conference_id,
        sideConferenceId: row.side_conference_id,
        agentCallControlId,
        prospectCallControlId: prospectLeg.call_control_id,
      });
      await supabase.from('call_legs').update({ held_at: null }).eq('id', prospectLeg.id);
    }
  }
  await supabase.rpc('transition_call_transfer', {
    p_transfer: row.id,
    p_org: orgId,
    p_expected_statuses: ['dialing', 'connected'],
    p_new_status: 'cancelled',
    p_fields: { ended_at: new Date().toISOString(), ended_reason: reason },
  });
}

// ---------------------------------------------------------------------------
// Complete / Cancel (warm transfer only)
// ---------------------------------------------------------------------------

async function loadConnectedWarmTransfer(
  supabase: SupabaseClient,
  orgId: string,
  transferId: string
): Promise<CallTransferRow | ActionResult> {
  const { data } = await supabase
    .from('call_transfers')
    .select(
      'id, org_id, session_id, contact_leg_id, type, target_kind, target_user_id, target_number, target_call_control_id, side_conference_id, status'
    )
    .eq('id', transferId)
    .eq('org_id', orgId)
    .maybeSingle();
  const row = data as CallTransferRow | null;
  if (!row) return { status: 404, body: { error: 'Transfer not found' } };
  if (row.type !== 'warm' || row.status !== 'connected') {
    return { status: 409, body: { error: 'TRANSFER_NOT_ACTIVE', code: 'TRANSFER_NOT_ACTIVE' } };
  }
  return row;
}

/** `transferred_to`: an org member's user id, or an E.164 number -- matches `Disposition`'s own
 *  disclosed "opaque reference" shape used elsewhere in this schema (crm_sync_jobs.call_leg_id's
 *  own header comment), not a FK -- a member and an external number are never the same column
 *  type, and the UI/analytics only ever need to DISPLAY it, never join through it. */
function transferredToValue(row: CallTransferRow): string {
  return row.target_kind === 'member'
    ? (row.target_user_id as string)
    : (row.target_number as string);
}

async function buildTransferNoteBody(
  supabase: SupabaseClient,
  row: CallTransferRow
): Promise<string> {
  const destination =
    row.target_kind === 'member'
      ? ((await memberDisplayName(supabase, row.target_user_id as string)) ?? 'a teammate')
      : (row.target_number as string);
  const kindLabel = row.type === 'warm' ? 'Warm transfer' : 'Cold transfer';
  return `${kindLabel} to ${destination}`;
}

/** Enqueues the GHL note via the existing outbox (`enqueue_crm_job`) -- payload contract fixed
 *  by the lead: `{note_body, transfer_type, call_leg_id}`. eng1's own 'transfer_note' processing
 *  branch in ghl-sync-worker.ts (out of this lane's file ownership, committed separately) posts
 *  `note_body` as a GHL contact note. An org with no CONNECTED GHL integration gets no row at
 *  all (enqueue_crm_job's own existing no-op). */
async function enqueueTransferNote(
  supabase: SupabaseClient,
  orgId: string,
  row: CallTransferRow
): Promise<void> {
  const leg = await loadLegById(supabase, row.contact_leg_id);
  const noteBody = await buildTransferNoteBody(supabase, row);
  await supabase.rpc('enqueue_crm_job', {
    p_org: orgId,
    p_kind: 'transfer_note',
    p_contact_id: leg?.contact_id ?? null,
    p_call_leg_id: row.contact_leg_id,
    p_payload: { note_body: noteBody, transfer_type: row.type, call_leg_id: row.contact_leg_id },
  });
}

/** Marks the prospect leg transferred and ends the ORIGINATING dial session (the intern's own
 *  call with this contact is over either way -- cold hands off immediately, warm hands off once
 *  "Complete transfer" is clicked). Shared by both the cold-transfer completion path
 *  (`processTelnyxTransferEvent`) and `runCompleteTransferAction`. */
async function finalizeHandoff(
  supabase: SupabaseClient,
  session: SessionRow,
  row: CallTransferRow
): Promise<void> {
  await supabase
    .from('call_legs')
    .update({
      held_at: null,
      transferred_to: transferredToValue(row),
      transfer_type: row.type,
    })
    .eq('id', row.contact_leg_id);
  await enqueueTransferNote(supabase, row.org_id, row);
  // Idempotent: transition_session's own expected_states check makes this a safe no-op if the
  // session already left on_call for some other reason (a race, a redelivered event).
  await supabase.rpc('transition_session', {
    p_session: session.id,
    p_expected_states: ['on_call'],
    p_new_state: 'wrap_up',
    p_fields: { active_leg_id: null },
  });
}

export async function runCompleteTransferAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  role: string,
  callerId: string,
  body: { transferId?: string }
): Promise<ActionResult> {
  if (!body.transferId) return { status: 400, body: { error: 'transferId is required' } };
  const resolved = await loadConnectedWarmTransfer(supabase, orgId, body.transferId);
  if ('body' in resolved) return resolved;
  const row = resolved;

  const session = await loadSession(supabase, orgId, row.session_id);
  if (!session || !session.conference_id || !row.side_conference_id) {
    return { status: 409, body: { error: 'Transfer state is inconsistent' } };
  }
  if (!callerCanActOnSession(session, role, callerId)) {
    return { status: 403, body: { error: 'Not your session' } };
  }
  const prospectLeg = await loadLegById(supabase, row.contact_leg_id);
  if (!prospectLeg) return { status: 409, body: { error: 'Prospect leg not found' } };
  const agentCallControlId = await agentLegCallControlId(supabase, session.agent_leg_id);

  try {
    await client.leaveConference(session.conference_id, prospectLeg.call_control_id);
    await client.joinConference(row.side_conference_id, {
      callControlId: prospectLeg.call_control_id,
    });
    if (agentCallControlId) {
      await client.leaveConference(row.side_conference_id, agentCallControlId);
      await client.joinConference(session.conference_id, { callControlId: agentCallControlId });
    }
  } catch (err) {
    console.error('[transfer-core] complete transfer failed', err);
    return { status: 502, body: { error: 'Failed to complete the transfer' } };
  }

  await finalizeHandoff(supabase, session, row);
  await supabase.rpc('transition_call_transfer', {
    p_transfer: row.id,
    p_org: orgId,
    p_expected_statuses: ['connected'],
    p_new_status: 'completed',
    p_fields: { ended_at: new Date().toISOString() },
  });
  return { status: 200, body: { status: 'completed' } };
}

export async function runCancelTransferAction(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  role: string,
  callerId: string,
  body: { transferId?: string }
): Promise<ActionResult> {
  if (!body.transferId) return { status: 400, body: { error: 'transferId is required' } };
  const resolved = await loadConnectedWarmTransfer(supabase, orgId, body.transferId);
  if ('body' in resolved) return resolved;
  const row = resolved;

  const session = await loadSession(supabase, orgId, row.session_id);
  if (!session || !session.conference_id) {
    return { status: 409, body: { error: 'Transfer state is inconsistent' } };
  }
  if (!callerCanActOnSession(session, role, callerId)) {
    return { status: 403, body: { error: 'Not your session' } };
  }
  const prospectLeg = await loadLegById(supabase, row.contact_leg_id);
  if (!prospectLeg) return { status: 409, body: { error: 'Prospect leg not found' } };
  const agentCallControlId = await agentLegCallControlId(supabase, session.agent_leg_id);

  if (row.target_call_control_id) {
    try {
      await client.hangup(row.target_call_control_id);
    } catch (err) {
      console.warn('[transfer-core] cancel: target hangup failed', err);
    }
  }
  await unwindWarmTransferToMain(client, {
    mainConferenceId: session.conference_id,
    sideConferenceId: row.side_conference_id,
    agentCallControlId,
    prospectCallControlId: prospectLeg.call_control_id,
  });
  await supabase.from('call_legs').update({ held_at: null }).eq('id', prospectLeg.id);

  await supabase.rpc('transition_call_transfer', {
    p_transfer: row.id,
    p_org: orgId,
    p_expected_statuses: ['connected'],
    p_new_status: 'cancelled',
    p_fields: { ended_at: new Date().toISOString() },
  });
  return { status: 200, body: { status: 'cancelled' } };
}

// ---------------------------------------------------------------------------
// Target leg webhook processing
// ---------------------------------------------------------------------------

export async function processTelnyxTransferEvent(
  supabase: SupabaseClient,
  client: TelnyxClient,
  args: { orgId: string; eventType: string; callControlId: string; transferId: string }
): Promise<void> {
  const { data: rowData, error } = await supabase
    .from('call_transfers')
    .select(
      'id, org_id, session_id, contact_leg_id, type, target_kind, target_user_id, target_number, target_call_control_id, side_conference_id, status'
    )
    .eq('id', args.transferId)
    .eq('org_id', args.orgId)
    .maybeSingle();
  if (error || !rowData) {
    console.error(
      '[transfer-core] webhook event for unknown/cross-org transfer row',
      args.transferId,
      error?.message
    );
    return;
  }
  const row = rowData as CallTransferRow;
  if (row.status === 'completed' || row.status === 'cancelled' || row.status === 'failed') return;

  if (args.eventType === 'call.hangup') {
    if (row.status === 'dialing') {
      // Never answered -- prospect/agent were never touched, nothing to unwind.
      await supabase.rpc('transition_call_transfer', {
        p_transfer: row.id,
        p_org: args.orgId,
        p_expected_statuses: ['dialing'],
        p_new_status: 'failed',
        p_fields: { ended_at: new Date().toISOString(), ended_reason: 'target_no_answer' },
      });
      return;
    }
    // 'connected' (warm only -- cold never reaches 'connected'): the target hung up mid-call.
    const session = await loadSession(supabase, args.orgId, row.session_id);
    const prospectLeg = await loadLegById(supabase, row.contact_leg_id);
    if (session?.conference_id && prospectLeg) {
      const agentCallControlId = await agentLegCallControlId(supabase, session.agent_leg_id);
      await unwindWarmTransferToMain(client, {
        mainConferenceId: session.conference_id,
        sideConferenceId: row.side_conference_id,
        agentCallControlId,
        prospectCallControlId: prospectLeg.call_control_id,
      });
      await supabase.from('call_legs').update({ held_at: null }).eq('id', prospectLeg.id);
    }
    await supabase.rpc('transition_call_transfer', {
      p_transfer: row.id,
      p_org: args.orgId,
      p_expected_statuses: ['connected'],
      p_new_status: 'failed',
      p_fields: { ended_at: new Date().toISOString(), ended_reason: 'target_hangup' },
    });
    return;
  }

  if (args.eventType !== 'call.answered' || row.status !== 'dialing') return;

  const session = await loadSession(supabase, args.orgId, row.session_id);
  const prospectLeg = await loadLegById(supabase, row.contact_leg_id);
  const failAndHangup = async (reason: string) => {
    await supabase.rpc('transition_call_transfer', {
      p_transfer: row.id,
      p_org: args.orgId,
      p_expected_statuses: ['dialing'],
      p_new_status: 'failed',
      p_fields: { ended_at: new Date().toISOString(), ended_reason: reason },
    });
    try {
      await client.hangup(args.callControlId);
    } catch (err) {
      console.warn('[transfer-core] hangup-after-fail failed', err);
    }
  };
  if (!session?.conference_id || !prospectLeg) {
    await failAndHangup('target_ended');
    return;
  }

  let sideConferenceId: string | null;
  try {
    const conference = await client.createConference({
      callControlId: args.callControlId,
      name: `hyperdial-transfer-${row.id}`,
    });
    sideConferenceId = conference.id;
  } catch (err) {
    console.error('[transfer-core] side conference create failed', err);
    await failAndHangup('error');
    return;
  }
  if (!sideConferenceId) {
    await failAndHangup('error');
    return;
  }

  try {
    if (row.type === 'cold') {
      await client.leaveConference(session.conference_id, prospectLeg.call_control_id);
      await client.joinConference(sideConferenceId, { callControlId: prospectLeg.call_control_id });
      const applied = await supabase.rpc('transition_call_transfer', {
        p_transfer: row.id,
        p_org: args.orgId,
        p_expected_statuses: ['dialing'],
        p_new_status: 'completed',
        p_fields: { side_conference_id: sideConferenceId, ended_at: new Date().toISOString() },
      });
      if (applied.data) await finalizeHandoff(supabase, session, row);
    } else {
      await client.holdConferenceParticipants(session.conference_id, {
        callControlIds: [prospectLeg.call_control_id],
      });
      await supabase
        .from('call_legs')
        .update({ held_at: new Date().toISOString() })
        .eq('id', prospectLeg.id);
      const agentCallControlId = await agentLegCallControlId(supabase, session.agent_leg_id);
      if (agentCallControlId) {
        await client.leaveConference(session.conference_id, agentCallControlId);
        await client.joinConference(sideConferenceId, { callControlId: agentCallControlId });
      }
      await supabase.rpc('transition_call_transfer', {
        p_transfer: row.id,
        p_org: args.orgId,
        p_expected_statuses: ['dialing'],
        p_new_status: 'connected',
        p_fields: { side_conference_id: sideConferenceId },
      });
    }
  } catch (err) {
    console.error('[transfer-core] target-answered orchestration failed', err);
    await failAndHangup('error');
  }
}
