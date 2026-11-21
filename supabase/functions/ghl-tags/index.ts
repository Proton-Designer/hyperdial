/**
 * TASK-G28: owner/admin tag picker backend for Settings -> GoHighLevel.
 * POST { action: 'list' }            -> { tags: string[] }  the location's existing GHL tags (sorted, case-insensitive)
 * POST { action: 'create', name }    -> { tag: string, created: boolean }  creates the tag in GHL (POST
 *                                       /locations/{locationId}/tags); `created: false` when it already existed.
 * The org always comes from the caller's membership (requireOrgRole), never from the body.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { createGhlClient } from '../_shared/ghl-client.ts';
import {
  createGhlRateLimiter,
  GHL_PULL_RATE_LIMIT_MAX_PER_WINDOW,
  withGhlRateLimit,
} from '../_shared/ghl-rate-limit.ts';
import { getOrgGhlAccess } from '../_shared/ghl-tags-io.ts';
import { cleanTagName, parseTagsBody, sortTagNames } from '../_shared/ghl-tags.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = parseTagsBody(raw);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  try {
    const access = await getOrgGhlAccess(supabase, orgId);
    if (!access) return jsonResponse({ error: 'GoHighLevel is not connected' }, 400);
    const client = withGhlRateLimit(
      createGhlClient(access.token, { apiBase: Deno.env.get('GHL_API_BASE') || undefined }),
      createGhlRateLimiter({ maxPerWindow: GHL_PULL_RATE_LIMIT_MAX_PER_WINDOW })
    );

    if (parsed.value.action === 'list') {
      const tags = await client.listTags(access.locationId);
      return jsonResponse({ tags: sortTagNames(tags.map((t) => t.name)) });
    }

    const name = cleanTagName(parsed.value.name)!;
    const existing = (await client.listTags(access.locationId)).find(
      (t) => t.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (existing) return jsonResponse({ tag: existing.name, created: false });
    const tag = await client.createTag(access.locationId, name);
    await logOrgAction(supabase, {
      orgId,
      actorUserId: user.id,
      action: 'ghl.create_tag',
      targetType: 'org_integrations',
      targetId: orgId,
      details: { tag: tag.name },
    });
    return jsonResponse({ tag: tag.name, created: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ghl-tags] failed', message);
    // GHL's own 401/403 (token scope) is surfaced as 502 with the reason, never as our own auth failure
    return jsonResponse({ error: `GHL request failed: ${message}` }, 502);
  }
});
