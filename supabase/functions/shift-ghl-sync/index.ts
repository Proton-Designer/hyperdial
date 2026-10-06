/**
 * TASK-S04: drains `shift_ghl_outbox` to GoHighLevel (appointments, custom fields, notes, tags).
 * Called by cron (X-Cron-Secret, same secret as ghl-sync-worker) and by the shifts edge functions
 * after a write (`nudgeShiftGhlSync`, Authorization: Bearer <service-role key>). Neither is a user
 * JWT, so config.toml sets verify_jwt = false and this function does its own check; it fails
 * closed when neither credential matches.
 *
 * Claims <= 50 due rows (claim_shift_outbox leases them), resolves each org's GHL context once
 * (org_integrations + get_org_ghl_token, exactly like ghl-sync-worker) and hands the rows to
 * `_shared/shift-ghl.ts`, which enforces per-contact id order, retry holds and the 429 stop.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  createGhlRateLimiter,
  GHL_PUSH_RATE_LIMIT_MAX_PER_WINDOW,
} from '../_shared/ghl-rate-limit.ts';
import {
  createShiftGhlHttp,
  fetchContactFieldDefs,
  processOutbox,
  type OutboxRow,
  type RowResult,
  type ShiftForSync,
} from '../_shared/shift-ghl.ts';

const CLAIM_BATCH_SIZE = 50;
const NOT_CONNECTED_DELAY_SECONDS = 600;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

/** Cron secret OR the service-role key as a bearer token. Unset secrets never match. */
function isAuthorized(req: Request): boolean {
  const cronExpected = Deno.env.get('CRM_SYNC_WORKER_SECRET');
  const cronGiven = req.headers.get('X-Cron-Secret');
  if (cronExpected && cronGiven && secretsMatch(cronGiven, cronExpected)) return true;
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const bearer = /^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1];
  return Boolean(svc && bearer && secretsMatch(bearer, svc));
}

interface OrgContext {
  locationId: string;
  token: string;
  timezone: string;
  calendarId: string | null;
  ownerUserId: string | null;
}

async function resolveOrgContext(
  supabase: SupabaseClient,
  orgId: string
): Promise<OrgContext | { error: string }> {
  const { data: integration } = await supabase
    .from('org_integrations')
    .select('status, location_id')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (!integration || integration.status !== 'connected' || !integration.location_id) {
    return { error: 'org has no connected GHL integration' };
  }
  const { data: token } = await supabase.rpc('get_org_ghl_token', { p_org: orgId });
  if (!token) return { error: 'org has no connected GHL integration' };
  const { data: s } = await supabase
    .from('shift_settings')
    .select('timezone, ghl_calendar_id, ghl_owner_user_id')
    .eq('org_id', orgId)
    .maybeSingle();
  return {
    locationId: integration.location_id as string,
    token: token as string,
    timezone: (s?.timezone as string | undefined) ?? 'America/Chicago',
    calendarId: (s?.ghl_calendar_id as string | null | undefined) ?? null,
    ownerUserId: (s?.ghl_owner_user_id as string | null | undefined) ?? null,
  };
}

async function recordResult(supabase: SupabaseClient, r: RowResult): Promise<void> {
  // A failed bookkeeping call leaves the row leased; it is retried after the lease (10 min).
  const check = (name: string, error: { message: string } | null) => {
    if (error) console.error(`[shift-ghl-sync] ${name} failed for row ${r.id}:`, error.message);
  };
  if (r.outcome === 'done') {
    const { error } = await supabase.rpc('complete_shift_outbox', {
      p_id: r.id,
      p_appointment_id: r.appointmentId ?? null,
    });
    check('complete_shift_outbox', error);
  } else if (r.outcome === 'retry' || r.outcome === 'error') {
    const { error } = await supabase.rpc('fail_shift_outbox', {
      p_id: r.id,
      p_error: r.error,
      p_retryable: r.outcome === 'retry',
    });
    check('fail_shift_outbox', error);
  } else {
    const { error } = await supabase.rpc('release_shift_outbox', {
      p_ids: [r.id],
      p_error: r.error ?? null,
      p_delay_seconds: 0,
    });
    check('release_shift_outbox', error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!isAuthorized(req)) return jsonResponse({ error: 'Unauthorized' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const { data: claimed, error: claimError } = await supabase.rpc('claim_shift_outbox', {
    p_n: CLAIM_BATCH_SIZE,
  });
  if (claimError) {
    console.error('[shift-ghl-sync] claim_shift_outbox failed', claimError.message);
    return jsonResponse({ error: claimError.message }, 500);
  }
  const rows = (claimed ?? []) as OutboxRow[];
  const counts = { claimed: rows.length, done: 0, retried: 0, errored: 0, released: 0 };
  if (rows.length === 0) return jsonResponse(counts);

  const byOrg = new Map<string, OutboxRow[]>();
  for (const r of rows) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r]);

  for (const [orgId, orgRows] of byOrg) {
    const ctx = await resolveOrgContext(supabase, orgId);
    if ('error' in ctx) {
      // Not connected (yet): keep the rows pending, try again later, no attempt counted.
      await supabase.rpc('release_shift_outbox', {
        p_ids: orgRows.map((r) => r.id),
        p_error: ctx.error,
        p_delay_seconds: NOT_CONNECTED_DELAY_SECONDS,
      });
      counts.released += orgRows.length;
      continue;
    }
    const userIds = [...new Set(orgRows.map((r) => r.user_id).filter((u): u is string => !!u))];
    const { data: members } = await supabase
      .from('shift_members')
      .select('user_id, ghl_contact_id')
      .eq('org_id', orgId)
      .in('user_id', userIds);
    const contactIds = new Map<string, string | null>(
      (members ?? []).map((m) => [m.user_id as string, (m.ghl_contact_id as string | null) ?? null])
    );
    const limiter = createGhlRateLimiter({ maxPerWindow: GHL_PUSH_RATE_LIMIT_MAX_PER_WINDOW });
    const http = createShiftGhlHttp({
      token: ctx.token,
      apiBase: Deno.env.get('GHL_API_BASE') || undefined,
      throttle: () => limiter.throttle(),
    });
    const results = await processOutbox(orgRows, {
      http,
      locationId: ctx.locationId,
      settings: {
        timezone: ctx.timezone,
        calendarId: ctx.calendarId,
        ownerUserId: ctx.ownerUserId,
      },
      contactIdFor: (u) => (u ? (contactIds.get(u) ?? null) : null),
      loadShift: async (id) => {
        const { data } = await supabase
          .from('shifts')
          .select('id, status, activity, starts_at, ends_at, ghl_appointment_id')
          .eq('id', id)
          .maybeSingle();
        return (data as ShiftForSync | null) ?? null;
      },
      loadFieldDefs: () => fetchContactFieldDefs(http, ctx.locationId),
      record: (r) => recordResult(supabase, r),
    });
    for (const r of results) {
      if (r.outcome === 'done') counts.done++;
      else if (r.outcome === 'retry') counts.retried++;
      else if (r.outcome === 'error') counts.errored++;
      else counts.released++;
    }
  }
  return jsonResponse(counts);
});
