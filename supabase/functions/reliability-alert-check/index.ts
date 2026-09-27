/**
 * TASK-T10 (Mission 4, SEC-7 rest): stuck dial session + webhook error spike alerts. Triggered by
 * pg_cron/pg_net (`private.trigger_reliability_alert_check`,
 * `20260926080400_reliability_alerts.sql`) with a shared secret header, not a user JWT -- same
 * shape as spend-alert-check/recording-retention/dialer-sweeper/ghl-sync-worker.
 *
 * Both alert types are per-org opt-in (`org_reliability_alert_settings`, false/false by default)
 * -- `check_stuck_dial_sessions`/`check_webhook_error_spikes` (SQL) only ever return rows for an
 * org that has the matching flag enabled, so a fresh/default org never gets an alert at all. Both
 * RPCs also flip their own dedup marker atomically in the same statement they read from, so two
 * overlapping cron runs can never double-alert on the same stuck spell/spike.
 *
 * Delivery: the existing generic `notifications` table (TASK-SP's own `low_balance_alert` shape,
 * already rendered by the bell in TopNavigation.tsx) -- no new UI surface needed for this task.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  resolveAlertRecipients,
  filterByNotificationPreference,
  type SupervisorAlertType,
} from '../_shared/pod-scope.ts';

// Documented in the migration's own header -- repeated here since these are the actual values
// used. Stuck: 20 minutes, deliberately much longer than the sweeper's own reap windows (60s/
// 300s) so ordinary dial-loop staleness never false-positives. Spike: 5+ failures for the SAME
// org within 15 minutes -- one stray error is normal noise, 5 in 15 minutes for one org points at
// something systemically broken for that org specifically.
const STUCK_SESSION_AFTER_SECONDS = 20 * 60;
const WEBHOOK_ERROR_WINDOW_SECONDS = 15 * 60;
const WEBHOOK_ERROR_THRESHOLD = 5;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** Same constant-time comparison as spend-alert-check/recording-retention/dialer-sweeper. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

/** Mirrors spend-alert-check's own `notifyOwnersAndAdmins` verbatim -- a second, small usage of
 *  the same "fan out one notifications row per active owner/admin" shape; not yet worth
 *  extracting to `_shared` for two call sites. */
async function notifyOwnersAndAdmins(
  supabase: SupabaseClient,
  orgId: string,
  type: string,
  title: string,
  body: string
): Promise<void> {
  const { data: members, error } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .in('role', ['owner', 'admin']);
  if (error || !members?.length) return;

  await supabase.from('notifications').insert(
    members.map((m: { user_id: string }) => ({
      org_id: orgId,
      user_id: m.user_id,
      type,
      title,
      body,
    }))
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('RELIABILITY_ALERT_SECRET');
  const providedSecret = req.headers.get('X-Cron-Secret');
  // Fail closed: an unset expectedSecret never means "allow everything" (known-issues #0's
  // telnyx-webhook lesson, applied the same way every other cron-worker function already does).
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = getSupabaseAdmin();

  const { data: stuckRows, error: stuckError } = await supabase.rpc('check_stuck_dial_sessions', {
    p_stuck_after_seconds: STUCK_SESSION_AFTER_SECONDS,
  });
  if (stuckError) {
    console.error('[reliability-alert-check] check_stuck_dial_sessions failed', stuckError.message);
  }
  let stuckAlerted = 0;
  for (const row of (stuckRows ?? []) as Array<{
    session_id: string;
    org_id: string;
    agent_id: string;
    state: string;
  }>) {
    await notifyOwnersAndAdmins(
      supabase,
      row.org_id,
      'stuck_dial_session',
      'A dial session looks stuck',
      `A dial session has shown no progress for over ${STUCK_SESSION_AFTER_SECONDS / 60} minutes ` +
        `while in state "${row.state}". Session ${row.session_id}.`
    );
    stuckAlerted++;
  }

  const { data: spikeRows, error: spikeError } = await supabase.rpc('check_webhook_error_spikes', {
    p_window_seconds: WEBHOOK_ERROR_WINDOW_SECONDS,
    p_threshold: WEBHOOK_ERROR_THRESHOLD,
  });
  if (spikeError) {
    console.error(
      '[reliability-alert-check] check_webhook_error_spikes failed',
      spikeError.message
    );
  }
  let spikeAlerted = 0;
  for (const row of (spikeRows ?? []) as Array<{ org_id: string; error_count: number }>) {
    await notifyOwnersAndAdmins(
      supabase,
      row.org_id,
      'webhook_error_spike',
      'Telnyx webhook processing errors are spiking',
      `${row.error_count} webhook processing failures in the last ${WEBHOOK_ERROR_WINDOW_SECONDS / 60} minutes. ` +
        `Calls may not be advancing correctly -- check the telnyx-webhook function logs.`
    );
    spikeAlerted++;
  }

  const supervisorAlerted = await runSupervisorAlerts(supabase);

  return jsonResponse({ stuckAlerted, spikeAlerted, supervisorAlerted });
});

// MISSION-5 TASK-M5-B4: per-agent supervisor alerts (wrap-up/paused/call too long, zero connects)
// -- same "SQL decides + flips its own dedup marker, TS resolves recipients + delivers" split as
// the stuck-session/webhook-spike alerts above, generalized to per-org EDITABLE thresholds
// (org_supervisor_alert_settings) instead of this file's own hardcoded constants, and to a
// per-agent recipient set (owner/admin + that agent's own pod-scoped manager, TASK-M5-A5) instead
// of a flat "every owner/admin" fan-out -- see pod-scope.ts's own header for why that lives there.
const SUPERVISOR_ALERT_COPY: Record<
  SupervisorAlertType,
  { title: string; body: (agentName: string, minutes: number) => string }
> = {
  wrap_up_stuck: {
    title: 'An agent has been in wrap-up too long',
    body: (name, minutes) => `${name} has been in wrap-up for over ${minutes} minutes.`,
  },
  paused_stuck: {
    title: 'An agent has been paused too long',
    body: (name, minutes) => `${name} has been paused for over ${minutes} minutes.`,
  },
  call_stuck: {
    title: 'An agent has been on a call too long',
    body: (name, minutes) => `${name} has been on a call for over ${minutes} minutes.`,
  },
  zero_connects: {
    title: 'An agent has had zero connects while dialing',
    body: (name, minutes) =>
      `${name} has been dialing for over ${minutes} minutes with no connects.`,
  },
};

async function agentDisplayName(supabase: SupabaseClient, agentId: string): Promise<string> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('user_id', agentId)
    .maybeSingle();
  return [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim() || 'An agent';
}

async function runSupervisorAlerts(supabase: SupabaseClient): Promise<number> {
  const { data: rows, error } = await supabase.rpc('check_supervisor_alerts');
  if (error) {
    console.error('[reliability-alert-check] check_supervisor_alerts failed', error.message);
    return 0;
  }

  let alerted = 0;
  for (const row of (rows ?? []) as Array<{
    org_id: string;
    agent_id: string;
    session_id: string;
    condition: SupervisorAlertType;
    threshold_minutes: number;
  }>) {
    const copy = SUPERVISOR_ALERT_COPY[row.condition];
    if (!copy) continue; // defensive: an unrecognized condition string never blocks the others

    const allRecipients = await resolveAlertRecipients(supabase, row.org_id, row.agent_id);
    const recipients = await filterByNotificationPreference(
      supabase,
      row.org_id,
      allRecipients,
      row.condition
    );
    if (recipients.length === 0) continue;

    const agentName = await agentDisplayName(supabase, row.agent_id);
    await supabase.from('notifications').insert(
      recipients.map((userId) => ({
        org_id: row.org_id,
        user_id: userId,
        type: `supervisor_alert.${row.condition}`,
        title: copy.title,
        body: copy.body(agentName, row.threshold_minutes),
        // No `action` field (unlike raise-hand's payload): only 'call_stuck' is actually
        // coachable (on_call) -- the other three conditions aren't, so asserting a fixed action
        // here would be wrong for 3 of 4 conditions. Nothing reads this field yet either way.
        data: { targetUserId: row.agent_id, targetSessionId: row.session_id },
      }))
    );
    alerted++;
  }
  return alerted;
}
