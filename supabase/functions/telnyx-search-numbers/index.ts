/**
 * Search available Telnyx numbers on the org's own BYO Telnyx account (design §3,
 * TASK-P1-06). Any active org member can search (no purchase happens here); the org's
 * key comes from `org_telephony` via `_shared/telnyx-org-context.ts`, never an env var.
 */
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  requireTelnyxOrgRole,
  getSupabaseAdmin,
  getConnectedOrgTelnyxContext,
} from '../_shared/telnyx-org-context.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  const { orgId, error: roleError } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
  if (roleError) return roleError;

  const supabase = getSupabaseAdmin();
  const { client, error: telnyxError } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (telnyxError) return telnyxError;

  const url = new URL(req.url);
  const areaCode = (url.searchParams.get('area_code') || '').trim();
  const countryCode = url.searchParams.get('country_code') || 'US';

  // Telnyx filter: country_code required; optional national_destination_code (area code
  // for US). best_effort: true returns numbers when the strict filter has no results
  // (Telnyx error 10031).
  const filter: Record<string, string> = { country_code: countryCode, best_effort: 'true' };
  if (areaCode && countryCode === 'US') {
    filter.national_destination_code = areaCode;
  }

  try {
    const response = (await client.searchNumbers(filter)) as { data?: unknown[] };
    const list = Array.isArray(response?.data) ? response.data : [];
    const numbers = list.map((n) => {
      const row = n as Record<string, unknown>;
      const cost = row.cost_information as Record<string, unknown> | undefined;
      return {
        phone_number: (row.phone_number as string) || '',
        monthly_cost: cost?.monthly_cost != null ? String(cost.monthly_cost) : undefined,
      };
    });
    return jsonResponse({ numbers });
  } catch (err) {
    console.error('[telnyx-search-numbers] search failed', err);
    const message = err instanceof Error ? err.message : String(err);
    // Telnyx's own "no results for this filter" error code, quoted as it appears in the
    // JSON error body -- NOT a bare `best_effort`/"No numbers found" substring match: our
    // own request-shaping puts `best_effort=true` in the query string, which
    // `telnyxRequest` embeds verbatim in every thrown message's path, so that substring
    // matched (and silently swallowed) unrelated failures like a real 401 auth error.
    const isTelnyxFilter = message.includes('"code":"10031"');
    if (isTelnyxFilter) {
      return jsonResponse({
        numbers: [],
        message:
          'No numbers found for this area. Try a different area code or leave it blank for general search.',
      });
    }
    return jsonResponse({ error: message }, 500);
  }
});
