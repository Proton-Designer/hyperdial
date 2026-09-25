/**
 * Shared campaign-queueing plan (TASK-L3, audit DSP-6/QUE-7 import-side + QUE-8): whether a
 * contact being imported (CSV or GHL) may actually be queued onto a campaign. Pure/network-free
 * so it's `deno test`-able -- same split as `_shared/ghl-import.ts`'s `planGhlImport`. Both
 * `contacts-import` and `ghl-import`'s edge functions fetch the inputs (DNC, GHL tags, existing
 * active-elsewhere campaign_leads rows) and call this; neither duplicates the skip logic itself.
 */

/** Matches campaign_leads_status_check's non-terminal statuses (20260924000700_dialer_schema.sql)
 * -- 'callback' is included because apply_leg_outcome's own candidate-selection SQL still treats
 * a callback row as dialable by its assigned agent, not a terminal state. Mirrors
 * 20260925000200_campaign_leads_one_active.sql's index WHERE clause; keep the two in sync. */
export const ACTIVE_CAMPAIGN_LEAD_STATUSES = ['queued', 'in_flight', 'callback'] as const;

export interface CampaignQueueCandidate {
  contactId: string;
  dnc: boolean;
  /** GHL-only: true when the contact carries the `dialer:paused` tag. Always false/omitted for
   *  CSV import, which has no tag concept. */
  paused?: boolean;
}

export interface PlanCampaignQueueArgs {
  candidates: CampaignQueueCandidate[];
  /** Contact ids that already have an ACTIVE campaign_leads row (see
   *  ACTIVE_CAMPAIGN_LEAD_STATUSES) in a campaign OTHER than the one being queued into right now
   *  -- pre-fetched by the caller with a single query, not looked up per-candidate here. */
  activeElsewhereContactIds: ReadonlySet<string>;
}

export interface PlanCampaignQueueResult {
  /** Contact ids safe to upsert into campaign_leads for the target campaign. */
  toQueue: string[];
  skippedDnc: number;
  skippedPaused: number;
  skippedActiveElsewhere: number;
}

/** DNC is checked before "paused" before "active elsewhere" -- order only matters for which
 * single counter a contact that somehow matches more than one condition lands in, and DNC is the
 * legally/product-critical one, so it takes priority. */
export function planCampaignQueue(args: PlanCampaignQueueArgs): PlanCampaignQueueResult {
  const toQueue: string[] = [];
  let skippedDnc = 0;
  let skippedPaused = 0;
  let skippedActiveElsewhere = 0;

  for (const c of args.candidates) {
    if (c.dnc) {
      skippedDnc++;
      continue;
    }
    if (c.paused) {
      skippedPaused++;
      continue;
    }
    if (args.activeElsewhereContactIds.has(c.contactId)) {
      skippedActiveElsewhere++;
      continue;
    }
    toQueue.push(c.contactId);
  }

  return { toQueue, skippedDnc, skippedPaused, skippedActiveElsewhere };
}
