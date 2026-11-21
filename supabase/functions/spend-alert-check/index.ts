/**
 * TASK-SP: hourly low-balance alert. Triggered by pg_cron/pg_net
 * (`private.trigger_spend_alert_check`, `20260925080200_spend_cap_balance_alert.sql`) with a
 * shared secret header, not a user JWT -- same shape as recording-retention/dialer-sweeper/
 * ghl-sync-worker.
 *
 * Email: skipped entirely -- grepped this whole project for an SMTP/email-sending integration
 * (Resend, SendGrid, Postmark, nodemailer, raw SMTP) and found none; the task's own spec says
 * "Email only if SMTP/email is already configured in the project. Don't add a provider." In-app
 * notification + the Settings/Dashboard banners (Team.tsx-adjacent UI, not this function) are
 * the only alert surfaces this task builds.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getOrgSpendSnapshot } from '../_shared/spend-gate.ts';
import { isBelowMinBalance, isAlertDue } from '../_shared/spend-estimate.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** Same constant-time comparison as recording-retention/dialer-sweeper/ghl-sync-worker. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

async function notifyOwnersAndAdmins(
  supabase: SupabaseClient,
  orgId: string,
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
      type: 'low_balance_alert',
      title,
      body,
    }))
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('SPEND_ALERT_SECRET');
  const providedSecret = req.headers.get('X-Cron-Secret');
  // Fail closed: an unset expectedSecret never means "allow everything" (known-issues #0's
  // telnyx-webhook lesson, applied the same way every other cron-worker function already does).
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = getSupabaseAdmin();

  const { data: connectedOrgs, error: orgsError } = await supabase
    .from('org_telephony')
    .select('org_id')
    .eq('status', 'connected');
  if (orgsError) {
    console.error('[spend-alert-check] failed to list connected orgs', orgsError.message);
    return jsonResponse({ error: orgsError.message }, 500);
  }

  let checked = 0;
  let alerted = 0;
  let skippedNoSnapshot = 0;

  for (const row of connectedOrgs ?? []) {
    const orgId = row.org_id as string;
    checked++;

    const snapshot = await getOrgSpendSnapshot(supabase, orgId);
    if (!snapshot.ok) {
      // Same fail-open philosophy as the dialing/purchase gate: an org we can't currently read
      // a balance for just doesn't get an alert this hour, not an error that stops the loop.
      console.warn(`[spend-alert-check] org ${orgId}: ${snapshot.reason}`);
      skippedNoSnapshot++;
      continue;
    }

    if (!isBelowMinBalance(snapshot.availableCreditUsd, snapshot.settings.low_balance_alert_usd)) {
      continue;
    }

    const lastAlertAt = snapshot.settings.last_low_balance_alert_at
      ? new Date(snapshot.settings.last_low_balance_alert_at)
      : null;
    if (!isAlertDue(lastAlertAt, new Date())) {
      continue; // already alerted this org within the last 12h
    }

    await notifyOwnersAndAdmins(
      supabase,
      orgId,
      'Telnyx balance is low',
      `Your available balance is $${snapshot.availableCreditUsd.toFixed(2)}, below your alert threshold of $${snapshot.settings.low_balance_alert_usd.toFixed(2)}. Add funds in your Telnyx account.`
    );

    const { error: updateError } = await supabase
      .from('org_spend_settings')
      .update({ last_low_balance_alert_at: new Date().toISOString() })
      .eq('org_id', orgId);
    if (updateError) {
      console.error(
        `[spend-alert-check] org ${orgId}: failed to record alert timestamp`,
        updateError.message
      );
      continue; // alert was sent; dedupe write failing just risks a duplicate next hour, not silence
    }

    alerted++;
  }

  return jsonResponse({ checked, alerted, skippedNoSnapshot });
});
