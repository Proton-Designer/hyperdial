/**
 * Pure decision logic for TASK-F-T3 (VMD-1..5): voicemail drop mode gating, drop-file storage
 * path/type resolution, and upload validation limits. No fetch, no DB, no Deno.env -- same split
 * as dialer-core.ts, so the engine (dialer-engine.ts) and the upload Edge Function
 * (voicemail-upload/index.ts) share one tested source of truth instead of each re-implementing
 * these rules.
 *
 * Telnyx details re-verified 2026-09-25 against spec3.json/webhook-events.json:
 * - PlayAudioUrlRequest (`/calls/{id}/actions/playback_start`) has `audio_url` + an explicit
 *   `audio_type` enum (`mp3`|`wav`, default `mp3`) -- so a stored .wav upload's playback command
 *   can (and must) declare `audio_type: 'wav'` rather than relying on a URL file extension
 *   Telnyx might mis-sniff. This is why `voicemailDropStoragePath` below takes an explicit
 *   extension instead of hardcoding `.mp3` for every upload (a literal reading of the task's own
 *   illustrative path example, `{org_id}/{user_id|'org-default'}.mp3`, would silently mislabel a
 *   real .wav upload).
 * - `call.playback.ended`'s real webhook payload DOES carry `call_control_id` (unlike
 *   `call.recording.saved`/`call.machine.*.detection.ended`, which never do) -- see
 *   dialer-engine.ts's header for why that means playback correlation needs no client_state
 *   fallback the way REC-2/REC-3 needed one.
 */

export type VoicemailDropMode = 'first_attempt' | 'every_attempt' | 'never';

/**
 * VMD-4: whether this dial attempt should drop a voicemail if the machine is detected.
 * `attemptsSoFar` is `campaign_leads.attempts` read BEFORE this attempt's own outcome is ever
 * applied (apply_leg_outcome only increments it once the leg ends) -- 0 means this dial IS the
 * lead's first-ever attempt.
 */
export function shouldAttemptVoicemailDrop(
  mode: VoicemailDropMode,
  attemptsSoFar: number
): boolean {
  switch (mode) {
    case 'never':
      return false;
    case 'every_attempt':
      return true;
    case 'first_attempt':
      return attemptsSoFar === 0;
  }
}

/**
 * BUG-7/VMD-2 vendor constraint (not a design choice): Telnyx only emits
 * `call.machine.greeting.ended` for `detect_words`/`detect_beep`/`greeting_end` (standard) or a
 * detected beep (premium) -- plain `detect` NEVER emits it (spec3.json's own field description).
 * A voicemail drop has no reliable "the greeting is over, safe to play now" signal under `detect`
 * or `off` (no AMD result at all), so it is never attempted regardless of the campaign's own
 * voicemail_drop_mode. See decisions.md for the full writeup.
 */
export function amdModeSupportsVoicemailDrop(
  amdMode: 'off' | 'detect' | 'detect_words' | 'premium'
): boolean {
  return amdMode === 'detect_words' || amdMode === 'premium';
}

export type VoicemailAudioExtension = 'mp3' | 'wav';

/** Upload validation (VMD-1): only real mp3/wav content types are accepted. Null means reject. */
export function voicemailAudioExtensionForContentType(
  contentType: string
): VoicemailAudioExtension | null {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return 'mp3';
  if (normalized === 'audio/wav' || normalized === 'audio/wave' || normalized === 'audio/x-wav') {
    return 'wav';
  }
  return null;
}

/** VMD-1: "validates the type and size <= 5MB" -- the upload function's own hard cap. */
export const MAX_VOICEMAIL_DROP_UPLOAD_BYTES = 5 * 1024 * 1024;

/** VMD-1: `{org_id}/{user_id|'org-default'}.<ext>` -- `userId: null` is the org default row. */
export function voicemailDropStoragePath(
  orgId: string,
  userId: string | null,
  ext: VoicemailAudioExtension
): string {
  return `${orgId}/${userId ?? 'org-default'}.${ext}`;
}

/** Playback-time signed URL TTL (task's own "short TTL (e.g. 15 minutes)"). Minted fresh at
 *  greeting-ended time, never at upload time -- see dialer-engine.ts. */
export const VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS = 15 * 60;

/** VMD-5/safety-timeout: how long a `voicemail_dropping` leg may run before the sweeper reaps it
 *  as stuck (dialer-sweeper's own `run_dialer_sweep` SQL owns the actual enforcement -- this
 *  constant documents the value both the migration and the task's own "~90s" spec agree on, and
 *  is asserted against in this module's own test). */
export const VOICEMAIL_DROP_SWEEP_TIMEOUT_SECONDS = 90;
