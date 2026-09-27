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
        'id, org_id, campaign_id, agent_id, state, lines, amd_mode, agent_leg_id, active_leg_id, conference_id, started_at, ended_at, updated_at, pause_reason'
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
        'id, kind, state, outcome, contact_id, lead_id, call_control_id, amd_result, hangup_cause, answered_at, claimed_at, ended_at, created_at, dispositioned_at, ' +
          'contact:contacts(business_name, first_name, last_name, phone_number)'
      )
      .eq('session_id', sessionId)
      // TASK-P2-E2 fix-forward: claim_next_leads (migration 20260924001900) now inserts every
      // leg from one refill in a single statement, so several legs can share the exact same
      // `created_at` (stable within one statement) -- `order('id')` as a tie-break keeps this
      // list's order deterministic across repeated polls (display order only; nothing here
      // needs it to match dial priority exactly).
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (legsError) {
      return new Response(JSON.stringify({ error: legsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // TASK-I1: surface the session's CURRENT bridged inbound call (if any), so the Dialer's
    // contact-card area can flag it "Inbound call" during `bridging_session` -- the task's own
    // explicit ask. `dial_session_id` is set once, entering `bridging_session`
    // (inbound-engine.ts's `enterStep`), and never cleared afterward, so it's scoped to
    // `state = 'bridging_session' and ended_at is null` here rather than by presence alone --
    // otherwise a long-past inbound call that once bridged into this same session would show as
    // "Inbound call" forever after the fact.
    const { data: inboundCall, error: inboundError } = await supabase
      .from('inbound_calls')
      .select(
        'id, from_e164, contact_id, state, answered_at, contact:contacts(business_name, first_name, last_name, phone_number)'
      )
      .eq('dial_session_id', sessionId)
      .eq('state', 'bridging_session')
      .is('ended_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (inboundError) {
      return new Response(JSON.stringify({ error: inboundError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // TASK-T3: "Manager listening" indicator -- ONLY for whisper/barge (industry default: a
    // plain 'listen' is silent/invisible to the intern, the task's own explicit ask). Enforced
    // HERE, not just in the UI that reads it -- `coachingMode` can only ever be 'whisper',
    // 'barge', or null, so no client-side filtering could accidentally leak a 'listen' row even
    // if a future screen forgets to filter it out itself.
    const { data: coachingRows, error: coachingError } = await supabase
      .from('coaching_sessions')
      .select('mode')
      .eq('target_session_id', sessionId)
      .eq('status', 'active')
      .in('mode', ['whisper', 'barge']);
    if (coachingError) {
      return new Response(JSON.stringify({ error: coachingError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const coachingMode = coachingRows?.some((r) => r.mode === 'barge')
      ? 'barge'
      : coachingRows?.some((r) => r.mode === 'whisper')
        ? 'whisper'
        : null;

    return new Response(
      JSON.stringify({
        session,
        legs: legs ?? [],
        inboundCall: inboundCall ?? null,
        coachingMode,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    console.error('dialer-session-get error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
