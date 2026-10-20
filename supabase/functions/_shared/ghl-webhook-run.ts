/**
 * TASK-G30: request handling for `ghl-webhook`, with all I/O injected (Supabase client, GHL client
 * factory) so the whole auth / dedupe / trigger matrix is `deno test`-able. See ghl-webhook.ts for the
 * two authentication modes and audit/G26/webhook-design.md for the design.
 *
 * The webhook is only a TRIGGER. Nothing in the payload except the ids is used: the contact is re-read
 * from GHL and run through the same decideReconcile + apply_ghl_reconcile + apply_ghl_owner_routing path
 * as the 5-minute sweep. An unauthenticated or forged request therefore never changes data, and a
 * replayed one is harmless (idempotent, plus a short body-hash dedupe).
 *
 * Response codes: 401 bad/missing auth (GHL retries are harmless), 413 too large, 400 unparsable body after
 * valid auth, 409 ambiguous location, 503 transient failure we want GHL to retry, 200 for everything handled,
 * ignored or dropped (a dropped event is picked up by the sweep).
 */
import type { GhlClient } from './ghl-client.ts';
import { decideReconcile, isTransientReadError, type ReconcileConfig } from './ghl-reconcile.ts';
import { DEFAULT_GHL_DNC_TAGS, DEFAULT_GHL_PAUSED_TAGS } from './ghl-import.ts';
import {
  GHL_LEGACY_SIGNATURE_HEADER,
  GHL_SECRET_HEADER,
  GHL_SIGNATURE_HEADER,
  MAX_WEBHOOK_BODY_BYTES,
  SUPPORTED_GHL_EVENT_TYPES,
  isWellFormedWebhookSecret,
  parseGhlWebhookEvent,
  sha256Hex,
  verifyGhlSignature,
  type GhlWebhookEvent,
} from './ghl-webhook.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

/** A body hash seen within this many minutes is a duplicate delivery. */
export const WEBHOOK_DEDUPE_MINUTES = 10;
/** Accepted (non-duplicate) events per org per minute; the rest are dropped and left to the sweep. */
export const WEBHOOK_RATE_PER_MINUTE = 60;

export interface WebhookDeps {
  supabase: SupabaseAny;
  makeClient: (token: string) => GhlClient;
  /** SPKI base64 override for GHL's key (GHL_WEBHOOK_PUBLIC_KEY). */
  publicKeySpkiB64?: string | null;
  /** GHL_WEBHOOK_SIGNED_PAYLOAD=json switches the signature check to the re-serialised body. */
  signedPayload?: 'raw' | 'json';
}

export interface WebhookRequest {
  method: string;
  headers: Headers;
  rawBody: string;
  /** Content-Length header value, if any (checked before the body is trusted to be small). */
  contentLength?: number | null;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

interface OrgRow {
  org_id: string;
  location_id: string | null;
  ghl_reconcile_enabled: boolean | null;
  ghl_dnc_tags: string[] | null;
  ghl_paused_tags: string[] | null;
  ghl_exclude_tags: string[] | null;
  ghl_exclude_stage_ids: string[] | null;
}

const ORG_COLUMNS =
  'org_id, location_id, ghl_reconcile_enabled, ghl_dnc_tags, ghl_paused_tags, ghl_exclude_tags, ghl_exclude_stage_ids';

const res = (status: number, body: Record<string, unknown>): WebhookResponse => ({ status, body });
const ignored = (reason: string) => res(200, { ok: true, ignored: reason });

export type ContactOutcome =
  | { outcome: 'unlinked' }
  | { outcome: 'no_change' }
  | {
      outcome: 'applied';
      action: string;
      reason: string;
      applied: Record<string, number> | null;
      ownerRouting: Record<string, number> | null;
    };

/** Re-reads one linked contact from GHL and applies the same decisions as the sweep. Throws on a GHL read /
 *  apply failure (the caller classifies it with isTransientReadError). */
export async function reconcileWebhookContact(
  supabase: SupabaseAny,
  client: GhlClient,
  org: OrgRow,
  ghlContactId: string
): Promise<ContactOutcome> {
  const { data: ours, error: lookupError } = await supabase
    .from('contacts')
    .select('id')
    .eq('org_id', org.org_id)
    .eq('ghl_contact_id', ghlContactId)
    .maybeSingle();
  if (lookupError) throw new Error(`contact lookup failed: ${lookupError.message}`);
  if (!ours) return { outcome: 'unlinked' };

  const gc = await client.getContact(ghlContactId);

  // stage membership of THIS contact (one opportunity search filtered by contact), only when stages are configured
  const stageIds = org.ghl_exclude_stage_ids ?? [];
  const excludeStageContactIds = new Set<string>();
  if (stageIds.length > 0 && org.location_id) {
    try {
      const opps = await client.searchOpportunities({
        locationId: org.location_id,
        contactId: ghlContactId,
        limit: 100,
      });
      if (
        opps.opportunities.some(
          (o) => o.contactId === ghlContactId && stageIds.includes(o.pipelineStageId)
        )
      ) {
        excludeStageContactIds.add(gc.id);
      }
    } catch (err) {
      // not fatal: the dnc / tag decision still applies, the sweep covers the stage rule
      console.warn('[ghl-webhook] stage lookup failed', err);
    }
  }
  const cfg: ReconcileConfig = {
    dncTags: org.ghl_dnc_tags ?? DEFAULT_GHL_DNC_TAGS,
    pausedTags: org.ghl_paused_tags ?? DEFAULT_GHL_PAUSED_TAGS,
    excludeTags: org.ghl_exclude_tags ?? [],
    excludeStageContactIds,
  };
  const decision = decideReconcile(gc, cfg);

  let applied: Record<string, number> | null = null;
  if (decision) {
    const { data, error } = await supabase.rpc('apply_ghl_reconcile', {
      p_org: org.org_id,
      p_items: [{ contact_id: ours.id, action: decision.action, reason: decision.reason }],
    });
    if (error) throw new Error(`apply_ghl_reconcile failed: ${error.message}`);
    applied = (data ?? {}) as Record<string, number>;
  }
  let ownerRouting: Record<string, number> | null = null;
  if (typeof gc.assignedTo === 'string' && gc.assignedTo.trim() !== '') {
    const { data, error } = await supabase.rpc('apply_ghl_owner_routing', {
      p_org: org.org_id,
      p_items: [{ contact_id: ours.id, ghl_user_id: gc.assignedTo }],
    });
    if (error) throw new Error(`apply_ghl_owner_routing failed: ${error.message}`);
    ownerRouting = (data ?? {}) as Record<string, number>;
  }
  if (!decision && !ownerRouting) return { outcome: 'no_change' };
  return {
    outcome: 'applied',
    action: decision?.action ?? 'owner',
    reason: decision?.reason ?? 'owner',
    applied,
    ownerRouting,
  };
}

async function orgByLocation(
  supabase: SupabaseAny,
  locationId: string
): Promise<{ rows: OrgRow[] } | { error: string }> {
  const { data, error } = await supabase
    .from('org_integrations')
    .select(ORG_COLUMNS)
    .eq('provider', 'ghl')
    .eq('status', 'connected')
    .eq('location_id', locationId)
    .limit(2);
  if (error) return { error: error.message };
  return { rows: (data ?? []) as OrgRow[] };
}

async function orgBySecret(
  supabase: SupabaseAny,
  secretHash: string
): Promise<{ row: OrgRow | null } | { error: string }> {
  const { data: state, error } = await supabase
    .from('ghl_webhook_state')
    .select('org_id')
    .eq('secret_hash', secretHash)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!state) return { row: null };
  const { data, error: orgError } = await supabase
    .from('org_integrations')
    .select(ORG_COLUMNS)
    .eq('provider', 'ghl')
    .eq('status', 'connected')
    .eq('org_id', state.org_id)
    .maybeSingle();
  if (orgError) return { error: orgError.message };
  return { row: (data ?? null) as OrgRow | null };
}

export async function handleGhlWebhook(
  deps: WebhookDeps,
  req: WebhookRequest
): Promise<WebhookResponse> {
  if (req.method !== 'POST') return res(405, { error: 'Method not allowed' });
  if (
    (req.contentLength != null && req.contentLength > MAX_WEBHOOK_BODY_BYTES) ||
    new TextEncoder().encode(req.rawBody).length > MAX_WEBHOOK_BODY_BYTES
  ) {
    return res(413, { error: 'Payload too large' });
  }
  const { supabase } = deps;
  const signature = req.headers.get(GHL_SIGNATURE_HEADER);
  const secret = req.headers.get(GHL_SECRET_HEADER);

  // ---- 1. authenticate (nothing below runs on a failure) -----------------------------------------
  let mode: 'signature' | 'secret';
  let secretHash: string | null = null;
  if (signature) {
    const v = await verifyGhlSignature({
      rawBody: req.rawBody,
      signatureB64: signature,
      publicKeySpkiB64: deps.publicKeySpkiB64,
      signedPayload: deps.signedPayload,
    });
    if (!v.ok) {
      console.warn(`[ghl-webhook] signature rejected: ${v.reason}`);
      return res(401, { error: 'Unauthorized' });
    }
    mode = 'signature';
  } else if (secret) {
    if (!isWellFormedWebhookSecret(secret)) return res(401, { error: 'Unauthorized' });
    secretHash = await sha256Hex(secret);
    mode = 'secret';
  } else {
    if (req.headers.get(GHL_LEGACY_SIGNATURE_HEADER)) {
      console.warn('[ghl-webhook] only the deprecated X-WH-Signature header was sent: rejected');
    }
    return res(401, { error: 'Unauthorized' });
  }

  // ---- 2. payload + organisation ------------------------------------------------------------------
  const parsed = parseGhlWebhookEvent(req.rawBody);
  if (!parsed.ok) return res(400, { error: 'Invalid payload' });
  const event: GhlWebhookEvent = parsed.event;

  let org: OrgRow | null = null;
  if (mode === 'secret') {
    const found = await orgBySecret(supabase, secretHash!);
    if ('error' in found) {
      console.error('[ghl-webhook] secret lookup failed', found.error);
      return res(503, { error: 'Temporary failure' });
    }
    if (!found.row) {
      console.warn('[ghl-webhook] unknown secret');
      return res(401, { error: 'Unauthorized' });
    }
    org = found.row;
    // a workflow body may name its location; if it does it must be this org's
    if (event.locationId && event.locationId !== org.location_id) {
      return ignored('location_mismatch');
    }
  } else {
    if (!event.locationId) return ignored('no_location');
    const found = await orgByLocation(supabase, event.locationId);
    if ('error' in found) {
      console.error('[ghl-webhook] location lookup failed', found.error);
      return res(503, { error: 'Temporary failure' });
    }
    if (found.rows.length === 0) return ignored('unknown_location');
    if (found.rows.length > 1) {
      console.error(
        `[ghl-webhook] ambiguous location ${event.locationId}: more than one connected org`
      );
      return res(409, { error: 'Ambiguous location' });
    }
    org = found.rows[0];
    if (event.type === null || !SUPPORTED_GHL_EVENT_TYPES.has(event.type)) {
      return ignored('unsupported_event');
    }
  }

  // ---- 3. gates (cheap, before any GHL call) -------------------------------------------------------
  if (org.ghl_reconcile_enabled !== true) return ignored('reconcile_off');
  if (!event.contactId) return ignored('no_contact');

  // dedupe + rate limit, atomically in the database
  const bodyHash = await sha256Hex(req.rawBody);
  const { data: accept, error: acceptError } = await supabase.rpc('ghl_webhook_accept', {
    p_org: org.org_id,
    p_hash: bodyHash,
    p_event_type: event.type ?? 'workflow',
    p_dedupe_minutes: WEBHOOK_DEDUPE_MINUTES,
    p_rate_per_minute: WEBHOOK_RATE_PER_MINUTE,
  });
  if (acceptError) {
    console.error('[ghl-webhook] accept failed', acceptError.message);
    return res(503, { error: 'Temporary failure' });
  }
  if (accept === 'duplicate') return ignored('duplicate');
  if (accept === 'rate_limited') return ignored('rate_limited');

  // ---- 4. trigger: re-read from GHL and apply ------------------------------------------------------
  const forget = () => supabase.rpc('ghl_webhook_forget', { p_org: org!.org_id, p_hash: bodyHash });
  try {
    const { data: token } = await supabase.rpc('get_org_ghl_token', { p_org: org.org_id });
    if (!token) return ignored('no_token');
    const out = await reconcileWebhookContact(
      supabase,
      deps.makeClient(token as string),
      org,
      event.contactId
    );
    return res(200, { ok: true, ...out });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ghl-webhook] org ${org.org_id} contact ${event.contactId}: ${message}`);
    if (isTransientReadError(err)) {
      // let GHL retry this delivery: it must not count as a duplicate
      await forget();
      return res(503, { error: 'Temporary failure' });
    }
    return ignored('contact_unreadable');
  }
}
