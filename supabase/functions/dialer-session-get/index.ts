import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';

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
    role,
    error: authError,
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  try {
    const url = new URL(req.url);
    const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'sessionId query param is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: session, error: sessionError } = await supabase
      .from('dial_sessions')
      .select(
        'id, org_id, campaign_id, agent_id, state, lines, amd_mode, agent_leg_id, active_leg_id, conference_id, started_at, ended_at, updated_at'
      )
      .eq('id', sessionId)
      .maybeSingle();
    if (sessionError) {
      return new Response(JSON.stringify({ error: sessionError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!session || session.org_id !== orgId) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (role === 'agent' && session.agent_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Not your session' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: legs, error: legsError } = await supabase
      .from('call_legs')
      .select(
        'id, kind, state, outcome, contact_id, lead_id, call_control_id, amd_result, hangup_cause, answered_at, claimed_at, ended_at, created_at, ' +
          'contact:contacts(business_name, first_name, last_name, phone_number)'
      )
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
    if (legsError) {
      return new Response(JSON.stringify({ error: legsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ session, legs: legs ?? [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('dialer-session-get error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
