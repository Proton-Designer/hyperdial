// TASK-S03: POST { email } -> { contacts: { id, name, email }[] } through the org's own GHL connection
// (org_integrations + get_org_ghl_token, same as ghl-sync-worker). Uses GET /contacts/?locationId&query
// (documented params; the POST /contacts/search body is undocumented in the raw spec) and keeps exact
// email matches only. audit/S03/api-evidence.md.
import { createGhlClient } from '../_shared/ghl-client.ts';
import {
  handleAdminPost,
  jsonResponse,
  rpcErrorResponse,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { findContactsByEmail, parseEmailBody } from '../_shared/shifts-admin.ts';

Deno.serve((req) =>
  handleAdminPost(req, 'admin-ghl-find-contact', async (ctx, body) => {
    const parsed = parseEmailBody(body);
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const { data: integration } = await ctx.supabase
      .from('org_integrations')
      .select('status, location_id')
      .eq('org_id', ctx.orgId)
      .eq('provider', 'ghl')
      .maybeSingle();
    if (!integration || integration.status !== 'connected' || !integration.location_id) {
      return shiftsError('ghl_not_connected');
    }
    const { data: token, error: tokenError } = await ctx.supabase.rpc('get_org_ghl_token', {
      p_org: ctx.orgId,
    });
    if (tokenError) return rpcErrorResponse(tokenError, 'get_org_ghl_token');
    if (!token) return shiftsError('ghl_not_connected');
    const client = createGhlClient(token as string, {
      apiBase: Deno.env.get('GHL_API_BASE') || undefined,
    });
    try {
      const contacts = await findContactsByEmail(
        client,
        integration.location_id as string,
        parsed.value
      );
      return jsonResponse(200, { contacts });
    } catch (e) {
      console.error('admin-ghl-find-contact: GHL search failed:', String(e));
      return shiftsError('ghl_error');
    }
  })
);
