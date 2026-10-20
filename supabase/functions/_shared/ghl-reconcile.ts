/**
 * TASK-G08 (spec section 4): GHL -> HyperDial reconcile. Pure decision logic plus the per-org run,
 * with I/O only through an injected GhlClient and Supabase client (same split as ghl-pull-run.ts),
 * so it is `deno test`-able without a network or database.
 *
 * Per org per tick: claim a bounded batch of queued/callback leads' linked contacts
 * (`claim_ghl_reconcile_batch`, oldest-checked first), read each from GHL (`GET /contacts/{id}`),
 * decide, and apply all decisions in one `apply_ghl_reconcile` RPC. Contacts sitting in an
 * org-configured "signed up / active" pipeline stage are found with one opportunity search per
 * stage instead of one read per contact.
 */
import type { GhlClient, GhlContact } from './ghl-client.ts';
import { DEFAULT_GHL_DNC_TAGS, DEFAULT_GHL_PAUSED_TAGS } from './ghl-import.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

export type ReconcileAction = 'dnc' | 'exclude' | 'paused';

export interface ReconcileDecision {
  action: ReconcileAction;
  reason: string;
}

export interface ReconcileConfig {
  dncTags: string[];
  pausedTags: string[];
  /** "signed up / active conversation" tags (org_integrations.ghl_exclude_tags). */
  excludeTags: string[];
  /** GHL contact ids sitting in an org-configured exclude stage. */
  excludeStageContactIds: ReadonlySet<string>;
}

const norm = (t: string) => t.trim().toLowerCase();

function firstMatch(tags: string[], wanted: string[]): string | undefined {
  const set = new Set(wanted.map(norm));
  return tags.find((t) => set.has(norm(t)));
}

/** A call-blocking DND: the blanket `dnd` flag, or the Call channel set to active/permanent
 *  (raw spec: GetContectByIdSchema.dnd boolean; DndSettingsSchema.Call -> DndSettingSchema.status
 *  enum active|inactive|permanent). Other channels (SMS/Email/...) do not block a phone call. */
export function ghlBlocksCalls(c: GhlContact): boolean {
  if (c.dnd === true) return true;
  const call = (c as { dndSettings?: { Call?: { status?: string } } }).dndSettings?.Call?.status;
  return call === 'active' || call === 'permanent';
}

/** Precedence: dnc > exclude (signed up / active) > paused. null = leave the lead alone. */
export function decideReconcile(c: GhlContact, cfg: ReconcileConfig): ReconcileDecision | null {
  const tags = Array.isArray(c.tags)
    ? c.tags.filter((t): t is string => typeof t === 'string')
    : [];
  if (ghlBlocksCalls(c)) return { action: 'dnc', reason: 'dnd' };
  const dncTag = firstMatch(tags, cfg.dncTags);
  if (dncTag !== undefined) return { action: 'dnc', reason: `tag ${dncTag}` };
  const exTag = firstMatch(tags, cfg.excludeTags);
  if (exTag !== undefined) return { action: 'exclude', reason: `tag ${exTag}` };
  if (cfg.excludeStageContactIds.has(c.id)) return { action: 'exclude', reason: 'stage' };
  const pausedTag = firstMatch(tags, cfg.pausedTags);
  if (pausedTag !== undefined) return { action: 'paused', reason: `tag ${pausedTag}` };
  return null;
}

/** Permanent per-contact GHL read failures (the contact is gone / the request can never succeed). Anything else
 *  -- 429, 5xx, 401/403 (token), timeouts, network errors -- is transient. ghlRequest's message is
 *  `GHL API GET /path failed (<status>): ...`. */
export function isTransientReadError(err: unknown): boolean {
  const m = /\((\d{3})\)/.exec(err instanceof Error ? err.message : String(err));
  if (!m) return true;
  return ![400, 404, 410, 422].includes(Number(m[1]));
}

/** At most this many transient-error contacts are handed back per tick unless most of the tick failed
 *  (a GHL outage, not a bad contact): a contact that keeps erroring can then hold at most this many slots. */
export function transientReleaseCap(batchSize: number): number {
  return Math.max(10, Math.floor(batchSize / 4));
}

const STAGE_PAGE_LIMIT = 100;
const STAGE_MAX_PAGES = 10;

/** GHL contact ids that have an opportunity in `pipelineStageId` (bounded page loop, same cursor
 *  shape as ghl-pull-run.ts's stage fetch but ids only -- no per-contact detail read). */
export async function fetchContactIdsInStage(
  client: GhlClient,
  args: { locationId: string; pipelineStageId: string }
): Promise<Set<string>> {
  const ids = new Set<string>();
  let startAfterId: string | undefined;
  let startAfter: number | undefined;
  for (let page = 0; page < STAGE_MAX_PAGES; page++) {
    const res = await client.searchOpportunities({
      locationId: args.locationId,
      pipelineStageId: args.pipelineStageId,
      limit: STAGE_PAGE_LIMIT,
      startAfterId,
      startAfter,
    });
    for (const o of res.opportunities) if (o.contactId) ids.add(o.contactId);
    if (res.opportunities.length < STAGE_PAGE_LIMIT) break;
    const last = res.opportunities[res.opportunities.length - 1];
    const ms = last.updatedAt ? Date.parse(last.updatedAt) : NaN;
    if (!last.id || Number.isNaN(ms)) break;
    startAfterId = last.id;
    startAfter = ms;
  }
  return ids;
}

export interface ReconcileOrgArgs {
  orgId: string;
  locationId: string;
  dncTags: string[] | null;
  pausedTags: string[] | null;
  excludeTags: string[] | null;
  excludeStageIds: string[] | null;
  batchSize: number;
  /** G16: absolute epoch ms; the per-contact read loop stops once passed (decisions so far still apply). */
  deadlineMs?: number;
}

export interface ReconcileOrgResult {
  claimed: number;
  /** G19: claimed contacts whose lease stamp was handed back (unread at the deadline / apply failed). */
  released: number;
  checked: number;
  readErrors: number;
  stageErrors: number;
  /** G16: true when the deadline cut the read loop short. */
  deadlineHit: boolean;
  decisions: { dnc: number; exclude: number; paused: number };
  applied: Record<string, number> | null;
  /** G15: counts from apply_ghl_owner_routing (null when no read carried an owner). */
  ownerRouting: Record<string, number> | null;
}

interface ClaimedRow {
  contact_id: string;
  ghl_contact_id: string;
  prev_reconciled_at?: string | null;
}

const chunks = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

export async function reconcileOrg(
  supabase: SupabaseAny,
  client: GhlClient,
  args: ReconcileOrgArgs
): Promise<ReconcileOrgResult> {
  const result: ReconcileOrgResult = {
    claimed: 0,
    released: 0,
    checked: 0,
    readErrors: 0,
    stageErrors: 0,
    deadlineHit: false,
    decisions: { dnc: 0, exclude: 0, paused: 0 },
    applied: null,
    ownerRouting: null,
  };

  // 1. stage membership: one search per configured stage, a failed stage is skipped (not fatal)
  const excludeStageContactIds = new Set<string>();
  for (const stageId of args.excludeStageIds ?? []) {
    try {
      const ids = await fetchContactIdsInStage(client, {
        locationId: args.locationId,
        pipelineStageId: stageId,
      });
      for (const id of ids) excludeStageContactIds.add(id);
    } catch (err) {
      result.stageErrors++;
      console.warn(`[ghl-reconcile] stage ${stageId} fetch failed for org ${args.orgId}`, err);
    }
  }

  const cfg: ReconcileConfig = {
    dncTags: args.dncTags ?? DEFAULT_GHL_DNC_TAGS,
    pausedTags: args.pausedTags ?? DEFAULT_GHL_PAUSED_TAGS,
    excludeTags: args.excludeTags ?? [],
    excludeStageContactIds,
  };

  const items: { contact_id: string; action: ReconcileAction; reason: string }[] = [];
  const decided = new Set<string>();
  const owners: { contact_id: string; ghl_user_id: string }[] = [];

  // 2. stage matches among OUR linked contacts that still have a queued/callback lead (no per-contact GHL read)
  if (excludeStageContactIds.size > 0) {
    for (const batch of chunks([...excludeStageContactIds], 200)) {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, ghl_contact_id, campaign_leads!inner(id)')
        .eq('org_id', args.orgId)
        .in('ghl_contact_id', batch)
        .in('campaign_leads.status', ['queued', 'callback']);
      if (error) throw new Error(`contacts by ghl id failed: ${error.message}`);
      for (const row of (data ?? []) as { id: string; ghl_contact_id: string }[]) {
        items.push({ contact_id: row.id, action: 'exclude', reason: 'stage' });
        decided.add(row.id);
        result.decisions.exclude++;
      }
    }
  }

  // 3. bounded batch of the oldest-checked linked contacts, one GHL read each. The claim stamps
  // ghl_reconciled_at BEFORE the reads, so (G19) never claim with no time left, and hand the stamp
  // back for every contact we did not read -- an unread contact must not look freshly checked.
  const batch: ClaimedRow[] = [];
  if (args.deadlineMs !== undefined && Date.now() > args.deadlineMs) {
    result.deadlineHit = true;
  } else {
    const { data: claimed, error: claimError } = await supabase.rpc('claim_ghl_reconcile_batch', {
      p_org: args.orgId,
      p_limit: args.batchSize,
    });
    if (claimError) throw new Error(`claim_ghl_reconcile_batch failed: ${claimError.message}`);
    batch.push(...((claimed ?? []) as ClaimedRow[]));
  }
  result.claimed = batch.length;

  const release = async (rows: ClaimedRow[]) => {
    if (rows.length === 0) return;
    result.released += rows.length;
    for (const part of chunks(rows, 200)) {
      const { error } = await supabase.rpc('release_ghl_reconcile_leases', {
        p_org: args.orgId,
        p_items: part.map((r) => ({
          contact_id: r.contact_id,
          prev_reconciled_at: r.prev_reconciled_at ?? null,
        })),
      });
      if (error) console.warn(`[ghl-reconcile] lease release failed: ${error.message}`);
    }
  };

  const transientErrors: ClaimedRow[] = [];
  for (let i = 0; i < batch.length; i++) {
    const row = batch[i];
    if (args.deadlineMs !== undefined && Date.now() > args.deadlineMs) {
      result.deadlineHit = true;
      await release(batch.slice(i));
      break;
    }
    try {
      const gc = await client.getContact(row.ghl_contact_id);
      result.checked++;
      // G15: reuse this read for owner routing (callbacks go back to the GHL owner's intern)
      if (typeof gc.assignedTo === 'string' && gc.assignedTo.trim() !== '') {
        owners.push({ contact_id: row.contact_id, ghl_user_id: gc.assignedTo });
      }
      const d = decideReconcile(gc, cfg);
      // a stage match was already queued in step 2; a DNC/paused read of the same contact still counts
      if (d && !(decided.has(row.contact_id) && d.action === 'exclude')) {
        items.push({ contact_id: row.contact_id, action: d.action, reason: d.reason });
        result.decisions[d.action]++;
      }
    } catch (err) {
      // permanent (deleted contact, bad request): keep the lease stamp so it cannot starve the queue.
      // transient (429/5xx/network/token): handed back after the loop (TASK-G25 / G23 F4).
      result.readErrors++;
      if (isTransientReadError(err)) transientErrors.push(row);
      console.warn(`[ghl-reconcile] read ${row.ghl_contact_id} failed`, err);
    }
  }

  // G25 / G23 F4: transient read failures must not cost the contact a whole rotation. Hand back the stamp
  // of all of them when most of the tick failed (outage), else at most transientReleaseCap(batch) of them.
  if (transientErrors.length > 0) {
    const attempted = result.checked + result.readErrors;
    const outage = transientErrors.length * 2 >= attempted;
    await release(
      outage ? transientErrors : transientErrors.slice(0, transientReleaseCap(args.batchSize))
    );
  }

  // 4. apply atomically (chunked). If a chunk fails, the decisions read this tick are lost, so hand
  // the stamps back for the whole batch (applied contacts are no longer claimable anyway).
  if (items.length > 0) {
    const applied: Record<string, number> = {};
    try {
      for (const part of chunks(items, 200)) {
        const { data, error } = await supabase.rpc('apply_ghl_reconcile', {
          p_org: args.orgId,
          p_items: part,
        });
        if (error) throw new Error(`apply_ghl_reconcile failed: ${error.message}`);
        for (const [k, v] of Object.entries((data ?? {}) as Record<string, number>)) {
          applied[k] = (applied[k] ?? 0) + v;
        }
      }
    } catch (err) {
      await release(batch);
      throw err;
    }
    result.applied = applied;
  }

  // 5. owner routing (after the decisions, so a lead just moved off 'callback' is not re-assigned)
  if (owners.length > 0) {
    const routed: Record<string, number> = {};
    for (const part of chunks(owners, 200)) {
      const { data, error } = await supabase.rpc('apply_ghl_owner_routing', {
        p_org: args.orgId,
        p_items: part,
      });
      if (error) throw new Error(`apply_ghl_owner_routing failed: ${error.message}`);
      for (const [k, v] of Object.entries((data ?? {}) as Record<string, number>)) {
        routed[k] = (routed[k] ?? 0) + v;
      }
    }
    result.ownerRouting = routed;
  }
  return result;
}
