/**
 * REC-6 (TASK-F-T2): 90-day recording retention. Triggered daily at 03:17 by pg_cron/pg_net
 * (`private.trigger_recording_retention`, `20260925040000_call_recording.sql`) with a shared
 * secret header, not a user JWT -- same shape as `dialer-sweeper`/`ghl-sync-worker`.
 *
 * Deletion goes through the Storage API (service role), not a raw SQL DELETE FROM
 * storage.objects -- unverified live whether a bare SQL delete of the metadata row alone
 * actually removes the underlying object from the backing store, and this function's own
 * `.remove()` call is Supabase's documented, always-correct way to delete both. A row whose
 * object delete fails is left untouched (recording_path intact) so the next day's run retries
 * it -- never nulled optimistically before the delete is confirmed.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { isPastRetention } from '../_shared/recording-core.ts';

const RETENTION_DAYS = 90;
// Generous but bounded -- this runs once a day, no reason to risk a single invocation timing
// out on an unexpectedly large backlog. Anything left over is picked up by tomorrow's run.
const BATCH_SIZE = 500;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** Same constant-time comparison as dialer-sweeper/ghl-sync-worker's secretsMatch. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

interface RetentionCandidateRow {
  id: string;
  recording_path: string | null;
  recording_saved_at: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('RECORDING_RETENTION_SECRET');
  const providedSecret = req.headers.get('X-Cron-Secret');
  // Fail closed: an unset expectedSecret never means "allow everything" (known-issues #0's
  // telnyx-webhook lesson, applied here the same way dialer-sweeper/ghl-sync-worker already do).
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = getSupabaseAdmin();
  const now = new Date();
  const cutoffIso = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error: queryError } = await supabase
    .from('call_legs')
    .select('id, recording_path, recording_saved_at')
    .not('recording_path', 'is', null)
    .not('recording_saved_at', 'is', null)
    .is('recording_deleted_at', null)
    .lt('recording_saved_at', cutoffIso)
    .order('recording_saved_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (queryError) {
    console.error('[recording-retention] query failed', queryError.message);
    return jsonResponse({ error: queryError.message }, 500);
  }

  let deleted = 0;
  let failed = 0;
  for (const row of (candidates ?? []) as RetentionCandidateRow[]) {
    // Defense in depth: re-check with the same pure predicate the query's own cutoff is meant
    // to express, in case of any clock/timezone drift between this process and Postgres.
    if (
      !row.recording_path ||
      !isPastRetention(
        { id: row.id, recording_saved_at: row.recording_saved_at },
        now,
        RETENTION_DAYS
      )
    ) {
      continue;
    }
    const { error: removeError } = await supabase.storage
      .from('recordings')
      .remove([row.recording_path]);
    if (removeError) {
      failed++;
      console.error('[recording-retention] remove failed', row.id, removeError.message);
      continue;
    }
    const { error: updateError } = await supabase
      .from('call_legs')
      .update({
        recording_status: 'deleted',
        recording_path: null,
        recording_duration_seconds: null,
        recording_telnyx_call_leg_id: null,
        recording_deleted_at: now.toISOString(),
      })
      .eq('id', row.id);
    if (updateError) {
      failed++;
      console.error(
        '[recording-retention] db update failed after storage delete',
        row.id,
        updateError.message
      );
      continue;
    }
    deleted++;
  }

  console.log('[recording-retention] run_done', {
    candidates: candidates?.length ?? 0,
    deleted,
    failed,
  });
  return jsonResponse({ candidates: candidates?.length ?? 0, deleted, failed });
});
