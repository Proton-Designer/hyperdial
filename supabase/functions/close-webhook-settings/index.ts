/**
 * TASK-H03: owner/admin settings for "Log Close" (Settings -> Closes). All actions POST { action, ... }:
 *   get    -> { categories, webhook: { url, enabled, hasSecret, updatedAt }, counts: { pending, failed, sent, notConfigured }, recentFailures }
 *   save   -> { categories?: string[], webhook?: { url: string | null, enabled: boolean, rotateSecret?: boolean, clearSecret?: boolean } }
 *             (the new secret, if one was generated, is returned ONCE as `secret`)
 *   test   -> sends a `ping` event to the saved URL, returns { outcome: 'sent'|'retry'|'permanent', error? }
 *   retry  -> { closeId? } re-queues failed closes (all of the org's, or one) and delivers them now
 * Owner/admin only; the org comes from the caller's membership. org_close_webhook has RLS with no client grant, so
 * this function (service role) is the only reader of the URL/secret.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import { checkWebhookUrlForSave, deliverClose } from '../_shared/close-delivery.ts';
import { runCloseDeliveries } from '../_shared/close-delivery-run.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'sdc_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Trim, drop blanks, case-insensitive de-dupe (first spelling wins), 1..80 chars each, at most 50. */
export function cleanCategories(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string'))
    return 'categories must be a list of text';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw as string[]) {
    const v = item.trim().replace(/\s+/g, ' ');
    if (!v) continue;
    if (v.length > 80) return `"${v.slice(0, 20)}…" is longer than 80 characters`;
    if (seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  if (out.length > 50) return 'at most 50 categories';
  return out;
}

interface Body {
  action?: unknown;
  categories?: unknown;
  webhook?: { url?: unknown; enabled?: unknown; rotateSecret?: unknown; clearSecret?: unknown };
  closeId?: unknown;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;
  const parsed = await readJsonBody<Body>(req);
  if (parsed.errorResponse) return parsed.errorResponse;
  const body = parsed.body;
  const action = body.action;
  if (action !== 'get' && action !== 'save' && action !== 'test' && action !== 'retry') {
    return jsonResponse({ error: "action must be 'get', 'save', 'test' or 'retry'" }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  try {
    let secret: string | undefined;
    let warning: string | undefined;

    if (action === 'save') {
      if (body.categories !== undefined) {
        const cats = cleanCategories(body.categories);
        if (typeof cats === 'string') return jsonResponse({ error: cats }, 400);
        const { error } = await supabase.from('org_close_settings').upsert(
          {
            org_id: orgId,
            service_categories: cats,
            updated_at: new Date().toISOString(),
            updated_by: user.id,
          },
          { onConflict: 'org_id' }
        );
        if (error) throw new Error(error.message);
        await logOrgAction(supabase, {
          orgId,
          actorUserId: user.id,
          action: 'closes.save_categories',
          targetType: 'org_close_settings',
          targetId: orgId,
          details: { count: cats.length },
        });
      }
      const w = body.webhook;
      if (w) {
        const enabled = w.enabled === true;
        const url = typeof w.url === 'string' && w.url.trim() ? w.url.trim() : null;
        if (url) {
          // Name rules + DNS: a private/internal host is refused here (TASK-H08); an unresolvable one saves with a warning.
          const check = await checkWebhookUrlForSave(url);
          if (!check.ok) return jsonResponse({ error: check.error }, 400);
          if (check.warning) warning = check.warning;
        }
        if (enabled && !url)
          return jsonResponse({ error: 'Add a URL before turning the webhook on' }, 400);
        const patch: Record<string, unknown> = {
          org_id: orgId,
          url,
          enabled,
          updated_at: new Date().toISOString(),
          updated_by: user.id,
        };
        if (w.rotateSecret === true) {
          secret = generateSecret();
          patch.secret = secret;
        } else if (w.clearSecret === true) {
          patch.secret = null;
        }
        const { error } = await supabase
          .from('org_close_webhook')
          .upsert(patch, { onConflict: 'org_id' });
        if (error) throw new Error(error.message);
        await logOrgAction(supabase, {
          orgId,
          actorUserId: user.id,
          action: 'closes.save_webhook',
          targetType: 'org_close_webhook',
          targetId: orgId,
          details: {
            enabled,
            host: url ? new URL(url).hostname : null,
            rotatedSecret: w.rotateSecret === true,
          },
        });
      }
    }

    if (action === 'test') {
      const { data: hook } = await supabase
        .from('org_close_webhook')
        .select('url, secret')
        .eq('org_id', orgId)
        .maybeSingle();
      if (!hook?.url) return jsonResponse({ error: 'Save a webhook URL first' }, 400);
      const outcome = await deliverClose({
        url: hook.url as string,
        secret: (hook.secret as string | null) ?? null,
        payload: { event: 'ping', version: 1, sent_at: new Date().toISOString() },
      });
      return jsonResponse({
        outcome: outcome.kind,
        error: outcome.kind === 'sent' ? undefined : outcome.error,
      });
    }

    if (action === 'retry') {
      const closeId = typeof body.closeId === 'string' ? body.closeId : null;
      if (body.closeId !== undefined && (!closeId || !UUID_RE.test(closeId)))
        return jsonResponse({ error: 'closeId is not valid' }, 400);
      let q = supabase
        .from('contact_closes')
        .update({
          delivery_status: 'pending',
          delivery_attempts: 0,
          next_attempt_at: new Date().toISOString(),
          claimed_at: null,
          last_error: null,
        })
        .eq('org_id', orgId)
        .in('delivery_status', ['failed', 'not_configured']);
      if (closeId) q = q.eq('id', closeId);
      const { data: requeued, error } = await q.select('id');
      if (error) throw new Error(error.message);
      let tally = { claimed: 0, sent: 0, failed: 0, retrying: 0 };
      // A few inline (each delivery can take up to ~10 s); the rest are already pending and due, so the 5-minute sweep delivers them.
      for (const r of (requeued ?? []).slice(0, 5)) {
        const t = await runCloseDeliveries(supabase, { limit: 1, closeId: r.id as string });
        tally = {
          claimed: tally.claimed + t.claimed,
          sent: tally.sent + t.sent,
          failed: tally.failed + t.failed,
          retrying: tally.retrying + t.retrying,
        };
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'closes.retry',
        targetType: 'contact_closes',
        targetId: closeId,
        details: { requeued: requeued?.length ?? 0 },
      });
      return jsonResponse({ requeued: requeued?.length ?? 0, ...tally });
    }

    // get / save: report current state
    const [{ data: settings }, { data: hook }, { data: rows }] = await Promise.all([
      supabase
        .from('org_close_settings')
        .select('service_categories')
        .eq('org_id', orgId)
        .maybeSingle(),
      supabase
        .from('org_close_webhook')
        .select('url, enabled, secret, updated_at')
        .eq('org_id', orgId)
        .maybeSingle(),
      supabase
        .from('contact_closes')
        .select('id, delivery_status, last_error, business_name, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    const counts = { pending: 0, failed: 0, sent: 0, notConfigured: 0 };
    for (const r of rows ?? []) {
      const s = r.delivery_status as string;
      if (s === 'pending') counts.pending++;
      else if (s === 'failed') counts.failed++;
      else if (s === 'sent') counts.sent++;
      else counts.notConfigured++;
    }
    return jsonResponse({
      categories: (settings?.service_categories as string[] | undefined) ?? [],
      webhook: {
        url: (hook?.url as string | null) ?? null,
        enabled: hook?.enabled === true,
        hasSecret: Boolean(hook?.secret),
        updatedAt: (hook?.updated_at as string | null) ?? null,
      },
      counts,
      recentFailures: (rows ?? [])
        .filter((r) => r.delivery_status === 'failed')
        .slice(0, 10)
        .map((r) => ({
          id: r.id,
          businessName: r.business_name,
          lastError: r.last_error,
          createdAt: r.created_at,
        })),
      ...(secret ? { secret } : {}),
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    console.error('[close-webhook-settings] failed', err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
