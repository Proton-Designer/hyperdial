/**
 * Pure logic for call recording (TASK-F-T2, REC-1..6): parses Telnyx's real
 * `call.recording.saved`/`call.recording.error` webhook payloads (verified against
 * spec3.json's `CallRecordingSaved`/webhook-events.json -- NOT the task doc's original
 * assumptions, which named fields that don't exist on this event; see decisions.md), computes
 * the storage path/duration, and gates whether recording should start at all. Split from
 * `dialer-engine.ts` (which does the actual I/O: the Telnyx command, the fetch+Storage upload,
 * the DB writes) so this is `deno test`-able with zero mocking -- same split as
 * `campaign-queue-io.ts`/`dialer-sweeper-core.ts`.
 */

/** `org_recording_settings` has no row for an org until the seed trigger runs (or for an org
 *  created before this table existed) -- a missing row must mean the column's own `default
 *  true`, never "disabled", so an org that never touched this setting keeps recording. */
export function isRecordingEnabled(settingsRow: { recording_enabled: boolean } | null): boolean {
  return settingsRow?.recording_enabled !== false;
}

export type AnnounceRecordingMode = 'never' | 'all' | 'all_party_consent_states';

/** MISSION-4 TASK-T8: pure decision for whether a recording-consent notice should be spoken to
 *  the prospect at bridge time. A missing settings row means the column's own `default 'never'`
 *  (org never touched this setting -- unchanged behaviour, same "missing row = default" contract
 *  as `isRecordingEnabled` above). `contactState` is the best-effort area-code-derived state
 *  (`_shared/area-code-state.ts`); null (unmapped area code, or no phone number at all) can never
 *  match a configured state, so `'all_party_consent_states'` mode safely does nothing for it
 *  rather than guessing. */
export function shouldAnnounceRecordingConsent(
  settingsRow: {
    announce_recording_mode: AnnounceRecordingMode;
    all_party_consent_states: string[];
  } | null,
  contactState: string | null
): boolean {
  const mode = settingsRow?.announce_recording_mode ?? 'never';
  if (mode === 'never') return false;
  if (mode === 'all') return true;
  return (
    contactState != null && (settingsRow?.all_party_consent_states ?? []).includes(contactState)
  );
}

export interface ParsedRecordingSaved {
  mp3Url: string | null;
  telnyxCallLegId: string | null;
  durationSeconds: number | null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `call.recording.saved`'s real payload (spec3.json's `CallRecordingSaved.payload`) has no
 *  `recording_id`/`duration_millis`/`call_control_id` field at all -- only `call_leg_id`
 *  (Telnyx's own per-leg UUID, kept for a possible later `GET /recordings?filter[call_leg_id]=`
 *  re-query, NOT a "recording id"), `recording_started_at`/`recording_ended_at` (duration is
 *  derived from these two), and `recording_urls.{mp3,wav}` (valid 10 minutes per the docs). */
export function parseRecordingSavedPayload(payload: Record<string, unknown>): ParsedRecordingSaved {
  const recordingUrls = (payload.recording_urls ?? {}) as Record<string, unknown>;
  const mp3Url = asOptionalString(recordingUrls.mp3);
  const telnyxCallLegId = asOptionalString(payload.call_leg_id);

  const startedAt = asOptionalString(payload.recording_started_at);
  const endedAt = asOptionalString(payload.recording_ended_at);
  let durationSeconds: number | null = null;
  if (startedAt && endedAt) {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      durationSeconds = Math.max(0, Math.round((end - start) / 1000));
    }
  }

  return { mp3Url, telnyxCallLegId, durationSeconds };
}

/** `call.recording.error`'s payload (spec3.json's `CallRecordingError`): connection_id/
 *  call_leg_id/call_session_id/client_state/reason. Only `reason` matters here -- the leg is
 *  identified via client_state at the caller (dialer-engine.ts), same as the saved event. */
export function parseRecordingErrorPayload(payload: Record<string, unknown>): { reason: string } {
  return { reason: asOptionalString(payload.reason) ?? 'unknown' };
}

/** REC-3: the PDF says `{user_id}`; we use org then leg (`{org_id}/{call_leg_id}.mp3`) --
 *  our own `call_legs.id`, never Telnyx's `call_leg_id` -- a user has no fixed 1:1 relationship
 *  to a recording (an org's calls are made by whichever agent is on shift), and org+leg is
 *  already how every other org-scoped resource in this schema is addressed. See decisions.md. */
export function recordingStoragePath(orgId: string, callLegId: string): string {
  return `${orgId}/${callLegId}.mp3`;
}

export interface RecordingAccessContext {
  role: 'owner' | 'admin' | 'agent';
  callerUserId: string;
  legOrgId: string;
  callerOrgId: string;
  /** `dial_sessions.agent_id` for the leg's own session -- null if the session lookup itself
   *  failed, which must never be treated as "no restriction". */
  sessionAgentId: string | null;
}

/** REC-4's auth matrix, as a pure predicate (recording-url/index.ts's only decision point):
 *  owner/admin see any leg in their own org; an agent only a leg whose session is their own.
 *  Mirrors call_legs' own RLS exactly (20260924000700_dialer_schema.sql's "owner or admin can
 *  view all call_legs" / "agent can view own call_legs" policies) -- this function does the
 *  same check in TS because recording-url uses the service-role client (RLS never applies). */
export function canAccessRecording(ctx: RecordingAccessContext): boolean {
  if (ctx.legOrgId !== ctx.callerOrgId) return false;
  if (ctx.role === 'owner' || ctx.role === 'admin') return true;
  return ctx.sessionAgentId !== null && ctx.sessionAgentId === ctx.callerUserId;
}

export type RecordingRetentionCandidate = { id: string; recording_saved_at: string | null };

/** REC-6: 90-day retention, anchored on when the RECORDING was actually saved
 *  (`recording_saved_at`), not the leg's `created_at` -- a leg can be created well before its
 *  recording is confirmed saved (AMD/ringing time, or a delayed webhook), so anchoring on leg
 *  creation would delete recordings slightly early. */
export function isPastRetention(
  candidate: RecordingRetentionCandidate,
  now: Date,
  retentionDays = 90
): boolean {
  if (!candidate.recording_saved_at) return false;
  const savedAt = new Date(candidate.recording_saved_at).getTime();
  if (Number.isNaN(savedAt)) return false;
  return now.getTime() - savedAt >= retentionDays * 24 * 60 * 60 * 1000;
}
