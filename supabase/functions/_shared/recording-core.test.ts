import { assertEquals } from 'jsr:@std/assert@1';
import {
  isRecordingEnabled,
  parseRecordingSavedPayload,
  parseRecordingErrorPayload,
  recordingStoragePath,
  isPastRetention,
  canAccessRecording,
} from './recording-core.ts';

Deno.test('isRecordingEnabled: no row (never configured) defaults to enabled', () => {
  assertEquals(isRecordingEnabled(null), true);
});

Deno.test('isRecordingEnabled: explicit true/false rows are respected', () => {
  assertEquals(isRecordingEnabled({ recording_enabled: true }), true);
  assertEquals(isRecordingEnabled({ recording_enabled: false }), false);
});

Deno.test('parseRecordingSavedPayload: full real-shaped payload (spec3.json example)', () => {
  const result = parseRecordingSavedPayload({
    connection_id: '7267xxxxxxxxxxxxxx',
    call_leg_id: '428c31b6-7af4-4bcb-b7f5-5013ef9657c1',
    call_session_id: '428c31b6-abf3-3bc1-b7f4-5013ef9657c1',
    client_state: 'eyJvcmciOiJvIn0=',
    recording_started_at: '2018-02-02T22:20:27.521992Z',
    recording_ended_at: '2018-02-02T22:25:27.521992Z',
    channels: 'dual',
    recording_urls: { mp3: 'http://example.com/recording.mp3', wav: null },
  });
  assertEquals(result, {
    mp3Url: 'http://example.com/recording.mp3',
    telnyxCallLegId: '428c31b6-7af4-4bcb-b7f5-5013ef9657c1',
    durationSeconds: 300,
  });
});

Deno.test(
  'parseRecordingSavedPayload: no call_control_id/recording_id in the real payload -- never assumed present',
  () => {
    // Positive control for the "task doc assumed fields that don't exist" finding: a payload
    // that has call_control_id/recording_id (the OLD assumption) but not call_leg_id must not
    // produce a telnyxCallLegId from the wrong field.
    const result = parseRecordingSavedPayload({
      call_control_id: 'v3:abc',
      recording_id: 'some-uuid',
      recording_urls: { mp3: 'http://example.com/r.mp3' },
    });
    assertEquals(result.telnyxCallLegId, null);
  }
);

Deno.test('parseRecordingSavedPayload: missing mp3 url', () => {
  const result = parseRecordingSavedPayload({
    recording_urls: { wav: 'http://example.com/r.wav' },
  });
  assertEquals(result.mp3Url, null);
});

Deno.test('parseRecordingSavedPayload: missing recording_urls entirely', () => {
  const result = parseRecordingSavedPayload({});
  assertEquals(result, { mp3Url: null, telnyxCallLegId: null, durationSeconds: null });
});

Deno.test('parseRecordingSavedPayload: malformed timestamps never throw, duration is null', () => {
  const result = parseRecordingSavedPayload({
    recording_started_at: 'not-a-date',
    recording_ended_at: '2018-02-02T22:25:27.521992Z',
  });
  assertEquals(result.durationSeconds, null);
});

Deno.test('parseRecordingErrorPayload: reason present / absent', () => {
  assertEquals(parseRecordingErrorPayload({ reason: 'recording-failed' }), {
    reason: 'recording-failed',
  });
  assertEquals(parseRecordingErrorPayload({}), { reason: 'unknown' });
});

Deno.test('recordingStoragePath: org then leg, never a user id (REC-3 change from the PDF)', () => {
  assertEquals(recordingStoragePath('org-1', 'leg-1'), 'org-1/leg-1.mp3');
});

Deno.test('isPastRetention: no recording_saved_at yet is never past retention', () => {
  assertEquals(isPastRetention({ id: 'x', recording_saved_at: null }, new Date()), false);
});

Deno.test('isPastRetention: exactly 90 days is past (inclusive), 89 days is not', () => {
  const now = new Date('2026-04-01T00:00:00Z');
  const ninetyDaysAgo = new Date('2026-01-01T00:00:00Z').toISOString();
  const eightyNineDaysAgo = new Date('2026-01-02T00:00:00Z').toISOString();
  assertEquals(isPastRetention({ id: 'x', recording_saved_at: ninetyDaysAgo }, now), true);
  assertEquals(isPastRetention({ id: 'y', recording_saved_at: eightyNineDaysAgo }, now), false);
});

// REC-4's auth matrix: own agent / other agent / admin / owner / other org.

Deno.test('canAccessRecording: an agent can access their OWN session leg', () => {
  assertEquals(
    canAccessRecording({
      role: 'agent',
      callerUserId: 'agent-1',
      legOrgId: 'org-1',
      callerOrgId: 'org-1',
      sessionAgentId: 'agent-1',
    }),
    true
  );
});

Deno.test("canAccessRecording: an agent CANNOT access another agent's session leg", () => {
  assertEquals(
    canAccessRecording({
      role: 'agent',
      callerUserId: 'agent-2',
      legOrgId: 'org-1',
      callerOrgId: 'org-1',
      sessionAgentId: 'agent-1',
    }),
    false
  );
});

Deno.test(
  'canAccessRecording: admin sees any leg in their own org, regardless of session agent',
  () => {
    assertEquals(
      canAccessRecording({
        role: 'admin',
        callerUserId: 'admin-1',
        legOrgId: 'org-1',
        callerOrgId: 'org-1',
        sessionAgentId: 'agent-1',
      }),
      true
    );
  }
);

Deno.test('canAccessRecording: owner sees any leg in their own org', () => {
  assertEquals(
    canAccessRecording({
      role: 'owner',
      callerUserId: 'owner-1',
      legOrgId: 'org-1',
      callerOrgId: 'org-1',
      sessionAgentId: 'agent-1',
    }),
    true
  );
});

Deno.test(
  "canAccessRecording: owner/admin from a DIFFERENT org is denied -- never another org's data",
  () => {
    assertEquals(
      canAccessRecording({
        role: 'owner',
        callerUserId: 'owner-1',
        legOrgId: 'org-2',
        callerOrgId: 'org-1',
        sessionAgentId: 'agent-1',
      }),
      false
    );
    assertEquals(
      canAccessRecording({
        role: 'admin',
        callerUserId: 'admin-1',
        legOrgId: 'org-2',
        callerOrgId: 'org-1',
        sessionAgentId: 'agent-1',
      }),
      false
    );
  }
);

Deno.test(
  'canAccessRecording: a failed/missing session lookup (sessionAgentId null) never grants an agent access',
  () => {
    assertEquals(
      canAccessRecording({
        role: 'agent',
        callerUserId: 'agent-1',
        legOrgId: 'org-1',
        callerOrgId: 'org-1',
        sessionAgentId: null,
      }),
      false
    );
  }
);
