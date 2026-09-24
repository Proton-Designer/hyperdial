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
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { createGhlClient, type GhlClient } from '../_shared/ghl-client.ts';
import {
  processContactUpsertJob,
  processDispositionJob,
  type ContactFields,
  type DispositionPayload,
  type JobProgress,
} from '../_shared/ghl-sync-worker.ts';

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

interface CrmSyncJobRow {
  id: string;
  org_id: string;
  provider: string;
  kind: 'disposition' | 'contact_upsert';
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
}

async function resolveOrgGhlContext(
  supabase: SupabaseClient,
  orgId: string
): Promise<OrgGhlContext | null> {
  const { data: integration } = await supabase
    .from('org_integrations')
    .select('status, location_id')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (!integration || integration.status !== 'connected' || !integration.location_id) {
    return null;
  }
  const { data: token } = await supabase.rpc('get_org_ghl_token', { p_org: orgId });
  if (!token) return null;
  return {
    client: createGhlClient(token as string, {
      apiBase: Deno.env.get('GHL_API_BASE') || undefined,
    }),
    locationId: integration.location_id as string,
  };
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

  const result =
    job.kind === 'disposition'
      ? await processDispositionJob({
          client: ctx.client,
          locationId: ctx.locationId,
          ghlContactId: contact.ghlContactId,
          contactFields: contact.fields,
          payload: job.payload as unknown as DispositionPayload,
          progress: job.progress ?? {},
        })
      : await processContactUpsertJob({
          client: ctx.client,
          locationId: ctx.locationId,
          ghlContactId: contact.ghlContactId,
          contactFields: contact.fields,
        });

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
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
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
