import { assertEquals } from 'jsr:@std/assert@1';
import {
  computeConversationsPerHour,
  isConversation,
  localDayBoundsUtc,
} from './analytics-core.ts';

Deno.test('isConversation: connected + >=30s is a conversation', () => {
  assertEquals(isConversation({ is_connected: true, duration_seconds: 30 }), true);
  assertEquals(isConversation({ is_connected: true, duration_seconds: 31 }), true);
});

Deno.test('isConversation: connected but under 30s is NOT a conversation', () => {
  assertEquals(isConversation({ is_connected: true, duration_seconds: 29 }), false);
  assertEquals(isConversation({ is_connected: true, duration_seconds: 0 }), false);
  assertEquals(isConversation({ is_connected: true, duration_seconds: null }), false);
});

Deno.test('isConversation: not connected is never a conversation, regardless of duration', () => {
  // Positive control for the is_connected gate itself, not just the duration threshold.
  assertEquals(isConversation({ is_connected: false, duration_seconds: 300 }), false);
});

Deno.test('computeConversationsPerHour: divides and rounds to 1 decimal', () => {
  assertEquals(computeConversationsPerHour(5, 2), 2.5);
  assertEquals(computeConversationsPerHour(1, 3), 0.3);
  assertEquals(computeConversationsPerHour(7, 3), 2.3);
});

Deno.test(
  'computeConversationsPerHour: dialing hours below the 0.1 floor renders "-" (null)',
  () => {
    assertEquals(computeConversationsPerHour(2, 0.09), null);
    assertEquals(computeConversationsPerHour(0, 0), null);
  }
);

Deno.test(
  'computeConversationsPerHour: exactly at the 0.1 floor is meaningful, not null (positive control for the boundary)',
  () => {
    assertEquals(computeConversationsPerHour(1, 0.1), 10);
  }
);

Deno.test(
  'computeConversationsPerHour: zero conversations over real dialing hours is 0, not null',
  () => {
    assertEquals(computeConversationsPerHour(0, 2), 0);
  }
);

// MISSION-5 TASK-M5-A4: localDayBoundsUtc replaces dashboard-stats' old hardcoded UTC-midnight
// boundary. Fixed instant (winter -- no DST ambiguity for the America/Chicago case):
// 2026-01-15T12:00:00Z. Positive control for the tz PARAMETER actually mattering: three
// different zones must produce three different boundaries for the exact same instant.
const FIXED_INSTANT = new Date('2026-01-15T12:00:00Z');

Deno.test('localDayBoundsUtc: America/Chicago (CST, UTC-6 in January)', () => {
  const { start, end } = localDayBoundsUtc('America/Chicago', FIXED_INSTANT);
  assertEquals(start.toISOString(), '2026-01-15T06:00:00.000Z');
  assertEquals(end.toISOString(), '2026-01-16T06:00:00.000Z');
});

Deno.test('localDayBoundsUtc: Asia/Tokyo (JST, UTC+9, no DST) -- a different day boundary', () => {
  const { start, end } = localDayBoundsUtc('Asia/Tokyo', FIXED_INSTANT);
  assertEquals(start.toISOString(), '2026-01-14T15:00:00.000Z');
  assertEquals(end.toISOString(), '2026-01-15T15:00:00.000Z');
});

Deno.test('localDayBoundsUtc: UTC itself is midnight-to-midnight with no offset', () => {
  const { start, end } = localDayBoundsUtc('UTC', FIXED_INSTANT);
  assertEquals(start.toISOString(), '2026-01-15T00:00:00.000Z');
  assertEquals(end.toISOString(), '2026-01-16T00:00:00.000Z');
});

Deno.test('localDayBoundsUtc: end is always exactly 24h after start (spans one civil day)', () => {
  const { start, end } = localDayBoundsUtc('America/Chicago', FIXED_INSTANT);
  assertEquals(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
});
