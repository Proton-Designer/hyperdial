import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';

/** Returns the current user's active parallel dialer session (if any) in this org, so the
 *  UI can restore itself when opening the Dialer tab. "Active" = any non-terminal state --
 *  the same set dialer-session-start's 409 check and dial_sessions_one_active_per_agent use.
 *  `paused_agent_lost` used to be missing here, so a session whose line had dropped was
 *  invisible on page open: the Dialer showed "Start a session", Start hit the 409, and the
 *  intern got an "A session is already active" banner for a session they couldn't see.
 *  `stateSince` (when the session entered its current state) lets the Dialer tell a line that
 *  just dropped (a refresh -- reconnect it) from a leftover one (close it quietly). */
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
      .select('id, campaign_id, state, updated_at')
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
        'paused_agent_lost',
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

    // agent_state_events keeps one open row (ended_at null) per agent for the current state.
    const { data: openEvent } = await supabase
      .from('agent_state_events')
      .select('started_at')
      .eq('session_id', row.id)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return new Response(
      JSON.stringify({
        session: {
          sessionId: row.id,
          campaignId: row.campaign_id,
          state: row.state,
          stateSince: openEvent?.started_at ?? row.updated_at,
        },
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
