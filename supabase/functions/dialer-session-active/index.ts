import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';

/** Returns the current user's active parallel dialer session (if any) in this org, so the
 *  UI can restore itself when opening the Dialer tab. "Active" = any non-terminal state. */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const {
    user,
    orgId,
    error: authError,
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: row, error } = await supabase
      .from('dial_sessions')
      .select('id, campaign_id, state')
      .eq('org_id', orgId)
      .eq('agent_id', user.id)
      .in('state', [
        'ready_pending',
        'ready',
        'dialing',
        'connecting',
        'on_call',
        'wrap_up',
        'paused',
      ])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!row) {
      return new Response(JSON.stringify({ session: null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        session: { sessionId: row.id, campaignId: row.campaign_id, state: row.state },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('dialer-session-active error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
