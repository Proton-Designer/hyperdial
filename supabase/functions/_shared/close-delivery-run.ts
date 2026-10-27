/**
 * TASK-H03: claims-then-delivers orchestration shared by log-contact-close (immediate attempt for one
 * close) and close-delivery-worker (cron retry sweep). I/O only through the injected service-role client.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  buildClosePayload,
  deliverClose,
  nextDeliveryState,
  type CloseRow,
  type DeliveryOutcome,
} from './close-delivery.ts';

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'not_configured';

async function agentName(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('user_id', userId)
    .maybeSingle();
  const name = [data?.first_name, data?.last_name]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' ')
    .trim();
  return name || null;
}

/** Delivers one already-claimed row and records the result. Returns the row's new status. */
export async function deliverClaimedClose(
  supabase: SupabaseClient,
  close: CloseRow,
  fetchImpl?: typeof fetch,
  now: number = Date.now()
): Promise<DeliveryStatus> {
  const { data: hook } = await supabase
    .from('org_close_webhook')
    .select('url, secret, enabled')
    .eq('org_id', close.org_id)
    .maybeSingle();

  let outcome: DeliveryOutcome;
  if (!hook || !hook.enabled || !hook.url) {
    // Webhook was switched off or removed after the close: stop retrying, keep the row visible as not_configured.
    outcome = { kind: 'permanent', error: 'closes webhook is not configured or is disabled' };
  } else {
    const payload = buildClosePayload(close, {
      id: close.closed_by,
      name: await agentName(supabase, close.closed_by),
    });
    outcome = await deliverClose({
      url: hook.url as string,
      secret: (hook.secret as string | null) ?? null,
      payload,
      fetchImpl,
      now: () => now,
    });
  }

  const next = nextDeliveryState(outcome, close.delivery_attempts, now);
  const status: DeliveryStatus =
    outcome.kind === 'permanent' && (!hook || !hook.enabled || !hook.url)
      ? 'not_configured'
      : next.status;
  const { error } = await supabase
    .from('contact_closes')
    .update({
      delivery_status: status,
      next_attempt_at: next.nextAttemptAt,
      claimed_at: null,
      last_error: outcome.kind === 'sent' ? null : outcome.error.slice(0, 500),
      delivered_at: outcome.kind === 'sent' ? new Date(now).toISOString() : null,
    })
    .eq('id', close.id);
  if (error) throw new Error(`could not record delivery result: ${error.message}`);
  return status;
}

/** Claims up to `limit` due rows (or exactly `closeId`) and delivers each. */
export async function runCloseDeliveries(
  supabase: SupabaseClient,
  opts: { limit: number; closeId?: string; fetchImpl?: typeof fetch; now?: number }
): Promise<{ claimed: number; sent: number; failed: number; retrying: number }> {
  const { data, error } = await supabase.rpc('claim_contact_closes', {
    p_limit: opts.limit,
    p_close_id: opts.closeId ?? null,
  });
  if (error) throw new Error(`claim_contact_closes failed: ${error.message}`);
  const rows = (data ?? []) as CloseRow[];
  const tally = { claimed: rows.length, sent: 0, failed: 0, retrying: 0 };
  for (const row of rows) {
    try {
      const s = await deliverClaimedClose(supabase, row, opts.fetchImpl, opts.now);
      if (s === 'sent') tally.sent++;
      else if (s === 'pending') tally.retrying++;
      else tally.failed++;
    } catch (err) {
      console.error('[close-delivery] row failed', row.id, err);
      tally.retrying++; // lease expires in 3 min; the sweep picks it up again
    }
  }
  return tally;
}
