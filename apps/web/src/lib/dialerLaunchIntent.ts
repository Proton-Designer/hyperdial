/**
 * TASK-L7: a same-tab, in-memory handoff so CampaignManageModal's "Start Session" button can
 * tell the Dialer which campaign to start without threading a new prop through MainApp.tsx (out
 * of this lane) or reintroducing a second place that calls `startDialerSession`/registers a
 * WebRTC client -- the whole point of this task's redesign is that ONLY the Dialer does either
 * of those things now. Module-level (not React state) because the two components never share a
 * tree; a page reload losing the pending intent is fine -- "preselect" is a convenience, not a
 * correctness requirement, and a reload has no session to preselect into.
 */
let pendingCampaignId: string | null = null;

export function setPendingStartCampaignId(id: string): void {
  pendingCampaignId = id;
}

export function consumePendingStartCampaignId(): string | null {
  const id = pendingCampaignId;
  pendingCampaignId = null;
  return id;
}

/**
 * TASK-M5-G6: same shape, for the Inbox's "Call back" action -- prefills and triggers
 * ManualDialPanel's existing manual-dial path (Dialer.tsx's `onDial`, wired at line ~1075)
 * instead of building a second dial-triggering path.
 */
let pendingManualDialNumber: string | null = null;

export function setPendingManualDialNumber(e164: string): void {
  pendingManualDialNumber = e164;
}

export function consumePendingManualDialNumber(): string | null {
  const number = pendingManualDialNumber;
  pendingManualDialNumber = null;
  return number;
}
