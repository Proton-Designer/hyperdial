/**
 * GHL push outbox worker (TASK-P3-P3, design §6). Triggered every 60s by pg_cron/pg_net
 * (`private.trigger_ghl_sync_worker`, `20260924002000_ghl_push_worker.sql`) with a shared
 * secret header, not a user JWT -- same "not requireOrgRole, does its own check" shape as
 * `ghl-connect`/`ghl-disconnect`, but here the caller is Postgres itself, not a signed-in user.
 *
 * Claims due `crm_sync_jobs` (`claim_crm_sync_jobs`, FOR UPDATE SKIP LOCKED), resolves each
 * job's org's GHL client once per org (not once per job), and dispatches to
 * `_shared/ghl-sync-worker.ts`'s pure per-kind processors. A job that fails partway has its
 * completed steps persisted via `update_crm_sync_job_progress` before `fail_crm_sync_job` runs
 * the exponential backoff, so a retry never redoes a step that already succeeded.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { createGhlClient, type GhlClient } from '../_shared/ghl-client.ts';
import {
  createGhlRateLimiter,
  withGhlRateLimit,
  GHL_PUSH_RATE_LIMIT_MAX_PER_WINDOW,
} from '../_shared/ghl-rate-limit.ts';
import {
  processContactUpsertJob,
  processDispositionJob,
  processDncFlagJob,
  processInboundCallNoteJob,
  processNurtureTagJob,
  processObjectionFieldJob,
  processTagJob,
  processTransferNoteJob,
  type ContactFields,
  type DispositionPayload,
  type DispositionPushTimeContext,
  type GhlPushConfig,
  type InboundCallNotePayload,
  type JobProgress,
  type TransferNotePayload,
} from '../_shared/ghl-sync-worker.ts';
import { resolveDispositionPushTimeContext } from '../_shared/ghl-push-context.ts';

const CLAIM_BATCH_SIZE = 10;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** A plain `===` on the raw secret leaks its length/prefix through response-time differences
 *  (a timing side channel) -- compare bytes in constant time instead (TASK-P3-P3, caught in
 *  review). Different lengths short-circuit to false immediately, which is fine: the secret's
 *  length isn't itself a secret, only its exact content is. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

interface CrmSyncJobRow {
  id: string;
  org_id: string;
  provider: string;
  kind:
    | 'disposition'
    | 'contact_upsert'
    | 'nurture_tag'
    | 'voicemail_tag'
    | 'no_answer_tag'
    | 'inbound_call_note'
    | 'transfer_note'
    | 'dnc_flag'
    | 'objection_field'
    | 'close_tag';
  contact_id: string | null;
  call_leg_id: string | null;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  progress: JobProgress;
}

interface OrgGhlContext {
  client: GhlClient;
  locationId: string;
  /** MISSION-4 TASK-T2 (GHL-11/13): the org's `ghl_field_mapping` reused in its natural stored
   *  direction (target key -> GHL custom-field-definition id) -- push needs no inversion, only
   *  T1's PULL-direction enrichment did. */
  pushConfig: GhlPushConfig;
}

async function resolveOrgGhlContext(
  supabase: SupabaseClient,
  orgId: string
): Promise<OrgGhlContext | null> {
  const { data: integration } = await supabase
    .from('org_integrations')
    .select('status, location_id, ghl_field_mapping')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (!integration || integration.status !== 'connected' || !integration.location_id) {
    return null;
  }
  const { data: token } = await supabase.rpc('get_org_ghl_token', { p_org: orgId });
  if (!token) return null;
  // MISSION-4 TASK-T2 (GHL-2): "respect GHL rate limits ... batching" -- the SAME shared limiter
  // T1 built for the pull path (100 req/10s, verified against GHL's published docs), one
  // instance per org per invocation (this worker already resolves a client once per org, not per
  // job -- CLAIM_BATCH_SIZE below is the "batching" half of GHL-2). A 429 that still slips
  // through is not special-cased here: `fail_crm_sync_job`'s existing exponential-ish backoff
  // (any thrown error -> requeue with a growing delay, dead after 8 attempts) already covers a
  // 429 exactly like any other transient failure -- see decisions.md for why no separate
  // 429-specific retry logic was added.
  const rawClient = createGhlClient(token as string, {
    apiBase: Deno.env.get('GHL_API_BASE') || undefined,
  });
  // TASK-T2 review fix-forward (SHOULD, ghl-rate-limit.ts's own header comment): push's own half
  // of the modeled per-location budget -- ghl-pull-worker/ghl-sync-now share the other half.
  const client = withGhlRateLimit(
    rawClient,
    createGhlRateLimiter({ maxPerWindow: GHL_PUSH_RATE_LIMIT_MAX_PER_WINDOW })
  );
  const pushFieldMapping = (integration.ghl_field_mapping as Record<string, string> | null) ?? {};
  return {
    client,
    locationId: integration.location_id as string,
    pushConfig: { pushFieldMapping },
  };
}

interface DispositionRow {
  ghl_pipeline_id: string | null;
  ghl_pipeline_stage_id: string | null;
}

/** MISSION-4 TASK-T2 (GHL-12): resolves the org-configured outcome -> pipeline/stage move for
 *  ONE disposition key. Looked up at push time (not carried in `submit_disposition`'s own
 *  enqueue-time payload) so an admin can change or add a mapping and have it apply to every
 *  future push of that disposition immediately, without needing that already-live RPC to
 *  change at all. Null (unmapped, or either half missing) is the explicit "no move" case. */
async function resolveStageTarget(
  supabase: SupabaseClient,
  orgId: string,
  dispositionKey: string
): Promise<{ pipelineId: string; pipelineStageId: string } | null> {
  const { data } = await supabase
    .from('dispositions')
    .select('ghl_pipeline_id, ghl_pipeline_stage_id')
    .eq('org_id', orgId)
    .eq('key', dispositionKey)
    .maybeSingle();
  const row = data as DispositionRow | null;
  if (!row?.ghl_pipeline_id || !row?.ghl_pipeline_stage_id) return null;
  return { pipelineId: row.ghl_pipeline_id, pipelineStageId: row.ghl_pipeline_stage_id };
}

/** TASK-G05: the tag the org's DNC disposition applies (`dispositions.ghl_tag` of its active
 *  lead_effect='dnc' disposition), falling back to the seeded default 'DNC'. */
async function resolveDncTag(supabase: SupabaseClient, orgId: string): Promise<string> {
  const { data } = await supabase
    .from('dispositions')
    .select('ghl_tag')
    .eq('org_id', orgId)
    .eq('lead_effect', 'dnc')
    .eq('active', true)
    .not('ghl_tag', 'is', null)
    .order('sort', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.ghl_tag as string | null | undefined) || 'DNC';
}

async function loadContactFields(
  supabase: SupabaseClient,
  contactId: string
): Promise<{ fields: ContactFields; ghlContactId: string | null } | null> {
  const { data } = await supabase
    .from('contacts')
    .select('first_name, last_name, phone_number, ghl_contact_id')
    .eq('id', contactId)
    .maybeSingle();
  if (!data) return null;
  return {
    fields: { firstName: data.first_name, lastName: data.last_name, phone: data.phone_number },
    ghlContactId: data.ghl_contact_id,
  };
}

async function persistGhlContactId(
  supabase: SupabaseClient,
  contactId: string,
  ghlContactId: string
): Promise<void> {
  await supabase
    .from('contacts')
    .update({ ghl_contact_id: ghlContactId, updated_at: new Date().toISOString() })
    .eq('id', contactId)
    .is('ghl_contact_id', null);
}

async function processJob(
  supabase: SupabaseClient,
  job: CrmSyncJobRow,
  ctx: OrgGhlContext
): Promise<void> {
  if (!job.contact_id) {
    await supabase.rpc('fail_crm_sync_job', {
      p_job: job.id,
      p_error: `${job.kind} job is missing contact_id`,
    });
    return;
  }
  const contact = await loadContactFields(supabase, job.contact_id);
  if (!contact) {
    await supabase.rpc('fail_crm_sync_job', {
      p_job: job.id,
      p_error: `contact ${job.contact_id} not found`,
    });
    return;
  }

  let result: Awaited<ReturnType<typeof processDispositionJob>>;
  if (job.kind === 'disposition') {
    const payload = job.payload as unknown as DispositionPayload;
    const [pushTimeContext, stageTarget] = await Promise.all([
      resolveDispositionPushTimeContext(supabase, job.org_id, job.call_leg_id),
      resolveStageTarget(supabase, job.org_id, payload.disposition_key),
    ]);
    result = await processDispositionJob({
      client: ctx.client,
      locationId: ctx.locationId,
      ghlContactId: contact.ghlContactId,
      contactFields: contact.fields,
      payload,
      progress: job.progress ?? {},
      pushConfig: ctx.pushConfig,
      pushTimeContext: { ...pushTimeContext, stageTarget } satisfies DispositionPushTimeContext,
    });
  } else if (job.kind === 'nurture_tag') {
    // TASK-F-T1 (QUE-3): "max attempts -> nurture tag pushed to GHL."
    result = await processNurtureTagJob({
      client: ctx.client,
      locationId: ctx.locationId,
      ghlContactId: contact.ghlContactId,
      contactFields: contact.fields,
      progress: job.progress ?? {},
    });
  } else if (job.kind === 'inbound_call_note') {
    result = await processInboundCallNoteJob({
      client: ctx.client,
      locationId: ctx.locationId,
      ghlContactId: contact.ghlContactId,
      contactFields: contact.fields,
      payload: job.payload as unknown as InboundCallNotePayload,
      progress: job.progress ?? {},
      pushConfig: ctx.pushConfig,
    });
  } else if (
    job.kind === 'voicemail_tag' ||
    job.kind === 'no_answer_tag' ||
    job.kind === 'close_tag'
  ) {
    // TASK-F-T3 (VMD-3, GHL-9 overlap): the counted tag itself was computed at enqueue time
    // (SQL) -- this function only ever pushes whatever payload.ghl_tag says.
    const tag = (job.payload as { ghl_tag?: string }).ghl_tag;
    if (!tag) {
      await supabase.rpc('fail_crm_sync_job', {
        p_job: job.id,
        p_error: `${job.kind} job is missing payload.ghl_tag`,
      });
      return;
    }
    const { lastCallAt, callAttempts, callerName, callerGhlUserId, leadList } =
      await resolveDispositionPushTimeContext(supabase, job.org_id, job.call_leg_id);
    result = await processTagJob({
      client: ctx.client,
      locationId: ctx.locationId,
      ghlContactId: contact.ghlContactId,
      contactFields: contact.fields,
      tag,
      progress: job.progress ?? {},
      pushConfig: ctx.pushConfig,
      pushTimeContext: { lastCallAt, callAttempts, callerName, callerGhlUserId, leadList },
    });
  } else if (job.kind === 'dnc_flag') {
    // TASK-G05: contact became DNC in HyperDial outside the DNC disposition (trigger-enqueued).
    result = await processDncFlagJob({
      client: ctx.client,
      ghlContactId: contact.ghlContactId,
      dncTag: await resolveDncTag(supabase, job.org_id),
      progress: job.progress ?? {},
    });
  } else if (job.kind === 'objection_field') {
    // TASK-G21: late top objection on a re-submitted disposition (field only).
    result = await processObjectionFieldJob({
      client: ctx.client,
      ghlContactId: contact.ghlContactId,
      payload: job.payload as { top_objection?: string | null },
      progress: job.progress ?? {},
      pushConfig: ctx.pushConfig,
    });
  } else if (job.kind === 'transfer_note') {
    // Lead follow-up to TASK-T2's own fix-forward: same missing-required-field shape as the
    // voicemail_tag/no_answer_tag branch above -- fail_crm_sync_job rather than silently
    // upserting-with-no-note (an unknown kind falling through to contact_upsert, just below,
    // would otherwise mask a genuinely malformed transfer_note payload as a "success").
    const payload = job.payload as unknown as TransferNotePayload;
    if (!payload.note_body) {
      await supabase.rpc('fail_crm_sync_job', {
        p_job: job.id,
        p_error: 'transfer_note job is missing payload.note_body',
      });
      return;
    }
    result = await processTransferNoteJob({
      client: ctx.client,
      locationId: ctx.locationId,
      ghlContactId: contact.ghlContactId,
      contactFields: contact.fields,
      payload,
      progress: job.progress ?? {},
    });
  } else {
    result = await processContactUpsertJob({
      client: ctx.client,
      locationId: ctx.locationId,
      ghlContactId: contact.ghlContactId,
      contactFields: contact.fields,
    });
  }

  if (result.resolvedGhlContactId && !contact.ghlContactId) {
    await persistGhlContactId(supabase, job.contact_id, result.resolvedGhlContactId);
  }

  if (result.ok) {
    await supabase.rpc('complete_crm_sync_job', { p_job: job.id });
  } else {
    await supabase.rpc('update_crm_sync_job_progress', {
      p_job: job.id,
      p_progress: result.progress,
    });
    await supabase.rpc('fail_crm_sync_job', {
      p_job: job.id,
      p_error: result.error ?? 'unknown error',
    });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('CRM_SYNC_WORKER_SECRET');
  const providedSecret = req.headers.get('X-Cron-Secret');
  // Fail closed: an unset expectedSecret never means "allow everything" (known-issues #0's
  // lesson from the Telnyx webhook applies here too) -- both must be present and equal.
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = getSupabaseAdmin();

  const { data: claimed, error: claimError } = await supabase.rpc('claim_crm_sync_jobs', {
    p_n: CLAIM_BATCH_SIZE,
  });
  if (claimError) {
    console.error('[ghl-sync-worker] claim_crm_sync_jobs failed', claimError.message);
    return jsonResponse({ error: claimError.message }, 500);
  }
  const jobs = (claimed ?? []) as CrmSyncJobRow[];
  if (jobs.length === 0) {
    return jsonResponse({ claimed: 0, processed: 0 });
  }

  const orgContexts = new Map<string, OrgGhlContext | null>();
  let processed = 0;
  for (const job of jobs) {
    if (!orgContexts.has(job.org_id)) {
      orgContexts.set(job.org_id, await resolveOrgGhlContext(supabase, job.org_id));
    }
    const ctx = orgContexts.get(job.org_id) ?? null;
    if (!ctx) {
      await supabase.rpc('fail_crm_sync_job', {
        p_job: job.id,
        p_error: 'org has no connected GHL integration',
      });
      continue;
    }
    await processJob(supabase, job, ctx);
    processed++;
  }

  return jsonResponse({ claimed: jobs.length, processed });
});
