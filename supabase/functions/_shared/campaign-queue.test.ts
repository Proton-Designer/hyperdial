import { assertEquals } from 'jsr:@std/assert@1';
import { planCampaignQueue, ACTIVE_CAMPAIGN_LEAD_STATUSES } from './campaign-queue.ts';

Deno.test('planCampaignQueue: a plain, unencumbered candidate is queued', () => {
  const result = planCampaignQueue({
    candidates: [{ contactId: 'c1', dnc: false }],
    activeElsewhereContactIds: new Set(),
  });
  assertEquals(result, {
    toQueue: ['c1'],
    skippedDnc: 0,
    skippedPaused: 0,
    skippedActiveElsewhere: 0,
  });
});

Deno.test('planCampaignQueue: dnc=true is skipped and counted, never queued', () => {
  const result = planCampaignQueue({
    candidates: [{ contactId: 'c1', dnc: true }],
    activeElsewhereContactIds: new Set(),
  });
  assertEquals(result.toQueue, []);
  assertEquals(result.skippedDnc, 1);
});

Deno.test('planCampaignQueue: paused=true is skipped and counted, never queued', () => {
  const result = planCampaignQueue({
    candidates: [{ contactId: 'c1', dnc: false, paused: true }],
    activeElsewhereContactIds: new Set(),
  });
  assertEquals(result.toQueue, []);
  assertEquals(result.skippedPaused, 1);
});

Deno.test(
  'planCampaignQueue: already active in another campaign is skipped and counted, never queued',
  () => {
    const result = planCampaignQueue({
      candidates: [{ contactId: 'c1', dnc: false }],
      activeElsewhereContactIds: new Set(['c1']),
    });
    assertEquals(result.toQueue, []);
    assertEquals(result.skippedActiveElsewhere, 1);
  }
);

Deno.test(
  'planCampaignQueue: dnc takes priority over paused and active-elsewhere for a contact matching all three',
  () => {
    const result = planCampaignQueue({
      candidates: [{ contactId: 'c1', dnc: true, paused: true }],
      activeElsewhereContactIds: new Set(['c1']),
    });
    assertEquals(result.toQueue, []);
    assertEquals(result, {
      toQueue: [],
      skippedDnc: 1,
      skippedPaused: 0,
      skippedActiveElsewhere: 0,
    });
  }
);

Deno.test(
  'planCampaignQueue: a mixed batch sorts each candidate into exactly the right bucket',
  () => {
    const result = planCampaignQueue({
      candidates: [
        { contactId: 'ok-1', dnc: false },
        { contactId: 'dnc-1', dnc: true },
        { contactId: 'paused-1', dnc: false, paused: true },
        { contactId: 'active-elsewhere-1', dnc: false },
        { contactId: 'ok-2', dnc: false },
      ],
      activeElsewhereContactIds: new Set(['active-elsewhere-1']),
    });
    assertEquals(result.toQueue, ['ok-1', 'ok-2']);
    assertEquals(result.skippedDnc, 1);
    assertEquals(result.skippedPaused, 1);
    assertEquals(result.skippedActiveElsewhere, 1);
  }
);

Deno.test(
  'positive control: the mixed-batch test above would catch a broken planner that queues everything',
  () => {
    // Simulates the bug this function exists to prevent: a planner that ignores dnc/paused/
    // active-elsewhere entirely and just queues every candidate. Proves the assertions above
    // are actually discriminating, not vacuously true.
    const brokenPlan = (candidates: { contactId: string }[]) => candidates.map((c) => c.contactId);
    const candidates = [
      { contactId: 'ok-1', dnc: false },
      { contactId: 'dnc-1', dnc: true },
    ];
    const broken = brokenPlan(candidates);
    const correct = planCampaignQueue({ candidates, activeElsewhereContactIds: new Set() }).toQueue;
    if (JSON.stringify(broken) === JSON.stringify(correct)) {
      throw new Error(
        'positive control is broken: a planner that queues everyone unconditionally produced the same result as planCampaignQueue -- the real assertions above would not have caught that bug'
      );
    }
  }
);

Deno.test('ACTIVE_CAMPAIGN_LEAD_STATUSES matches the audit-derived active set exactly', () => {
  assertEquals([...ACTIVE_CAMPAIGN_LEAD_STATUSES].sort(), ['callback', 'in_flight', 'queued']);
});
