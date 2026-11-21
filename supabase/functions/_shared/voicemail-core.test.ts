import { assertEquals } from 'jsr:@std/assert@1';
import {
  amdModeSupportsVoicemailDrop,
  MAX_VOICEMAIL_DROP_UPLOAD_BYTES,
  shouldAttemptVoicemailDrop,
  voicemailAudioExtensionForContentType,
  voicemailDropStoragePath,
  VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS,
  VOICEMAIL_DROP_SWEEP_TIMEOUT_SECONDS,
} from './voicemail-core.ts';

// ---------------------------------------------------------------------------
// shouldAttemptVoicemailDrop (VMD-4)
// ---------------------------------------------------------------------------

Deno.test('shouldAttemptVoicemailDrop: never -> always false, regardless of attempt count', () => {
  assertEquals(shouldAttemptVoicemailDrop('never', 0), false);
  assertEquals(shouldAttemptVoicemailDrop('never', 5), false);
});

Deno.test('shouldAttemptVoicemailDrop: every_attempt -> always true', () => {
  assertEquals(shouldAttemptVoicemailDrop('every_attempt', 0), true);
  assertEquals(shouldAttemptVoicemailDrop('every_attempt', 5), true);
});

Deno.test('shouldAttemptVoicemailDrop: first_attempt -> true only when attemptsSoFar is 0', () => {
  assertEquals(shouldAttemptVoicemailDrop('first_attempt', 0), true);
  assertEquals(shouldAttemptVoicemailDrop('first_attempt', 1), false);
  assertEquals(shouldAttemptVoicemailDrop('first_attempt', 5), false);
});

// ---------------------------------------------------------------------------
// amdModeSupportsVoicemailDrop (BUG-7 vendor constraint)
// ---------------------------------------------------------------------------

Deno.test(
  'amdModeSupportsVoicemailDrop: only detect_words and premium ever get a greeting-ended signal',
  () => {
    assertEquals(amdModeSupportsVoicemailDrop('off'), false);
    assertEquals(amdModeSupportsVoicemailDrop('detect'), false);
    assertEquals(amdModeSupportsVoicemailDrop('detect_words'), true);
    assertEquals(amdModeSupportsVoicemailDrop('premium'), true);
  }
);

// ---------------------------------------------------------------------------
// voicemailAudioExtensionForContentType (VMD-1 upload validation)
// ---------------------------------------------------------------------------

Deno.test('voicemailAudioExtensionForContentType: recognizes real mp3/wav content types', () => {
  assertEquals(voicemailAudioExtensionForContentType('audio/mpeg'), 'mp3');
  assertEquals(voicemailAudioExtensionForContentType('audio/mp3'), 'mp3');
  assertEquals(voicemailAudioExtensionForContentType('audio/wav'), 'wav');
  assertEquals(voicemailAudioExtensionForContentType('audio/wave'), 'wav');
  assertEquals(voicemailAudioExtensionForContentType('audio/x-wav'), 'wav');
});

Deno.test(
  'voicemailAudioExtensionForContentType: is case-insensitive and ignores a charset parameter',
  () => {
    assertEquals(voicemailAudioExtensionForContentType('AUDIO/MPEG'), 'mp3');
    assertEquals(voicemailAudioExtensionForContentType('audio/wav; charset=binary'), 'wav');
  }
);

Deno.test('voicemailAudioExtensionForContentType: rejects anything else -> null', () => {
  assertEquals(voicemailAudioExtensionForContentType('audio/ogg'), null);
  assertEquals(voicemailAudioExtensionForContentType('video/mp4'), null);
  assertEquals(voicemailAudioExtensionForContentType(''), null);
});

Deno.test('MAX_VOICEMAIL_DROP_UPLOAD_BYTES: is exactly 5MB, per VMD-1', () => {
  assertEquals(MAX_VOICEMAIL_DROP_UPLOAD_BYTES, 5 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// voicemailDropStoragePath (VMD-1)
// ---------------------------------------------------------------------------

Deno.test('voicemailDropStoragePath: per-user path, extension matches the real upload type', () => {
  assertEquals(voicemailDropStoragePath('org-1', 'user-1', 'mp3'), 'org-1/user-1.mp3');
  assertEquals(voicemailDropStoragePath('org-1', 'user-1', 'wav'), 'org-1/user-1.wav');
});

Deno.test('voicemailDropStoragePath: null userId -> the org-default row', () => {
  assertEquals(voicemailDropStoragePath('org-1', null, 'mp3'), 'org-1/org-default.mp3');
});

// ---------------------------------------------------------------------------
// Constants -- pinned so a future accidental edit shows up as a failing assertion, not a silent
// behavior drift (same discipline as CONTACT_DIAL_TIME_LIMIT_SECS elsewhere in this codebase).
// ---------------------------------------------------------------------------

Deno.test('VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS: 15 minutes, per the task spec', () => {
  assertEquals(VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS, 900);
});

Deno.test('VOICEMAIL_DROP_SWEEP_TIMEOUT_SECONDS: ~90s, per the task spec', () => {
  assertEquals(VOICEMAIL_DROP_SWEEP_TIMEOUT_SECONDS, 90);
});
