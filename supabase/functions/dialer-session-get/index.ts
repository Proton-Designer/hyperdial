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
        'id, org_id, campaign_id, agent_id, state, lines, amd_mode, agent_leg_id, active_leg_id, conference_id, started_at, ended_at, updated_at, pause_reason, raised_hand_at'
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
        'id, kind, state, outcome, contact_id, lead_id, call_control_id, amd_result, hangup_cause, answered_at, claimed_at, ended_at, created_at, dispositioned_at, held_at, transferred_to, transfer_type, recording_status, ' +
          // TASK-T5 (CRD-1): widened for the connected-call card's business-details panel --
          // license_number/service_zips/tier live inside ghl_custom_fields (keyed by our own
          // target-key names, not a GHL field id -- see ghl-import.ts's own enrichment code),
          // read client-side, no server-side unpacking needed.
          'contact:contacts(id, business_name, first_name, last_name, phone_number, rating, review_count, website, owner_contact, ghl_custom_fields)'
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

    // TASK-T4: at most one row can ever match (call_transfers_one_active_per_session), so this
    // drives the UI's warm-transfer control panel (Complete/Cancel) directly -- 'dialing'/
    // 'connected' are the only two live states, everything else (completed/cancelled/failed) is
    // history, not something the UI needs to poll for.
    const { data: activeTransfer, error: transferError } = await supabase
      .from('call_transfers')
      .select('id, type, target_kind, target_user_id, target_number, status')
      .eq('session_id', sessionId)
      .in('status', ['dialing', 'connected'])
      .maybeSingle();
    if (transferError) {
      return new Response(JSON.stringify({ error: transferError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // TASK-T5 (CRD-3 + CRD-5): one batched query for the WHOLE current batch's history, not one
    // per card -- the same "pre-loaded the moment the batch fires" shape CRD-1's own contact join
    // already gets for free. A leg still in progress (kind='contact', state anything but 'ended')
    // is naturally excluded by the state filter, so there's no need to also exclude the current
    // in-batch leg ids explicitly.
    const contactIds = Array.from(
      new Set((legs ?? []).map((l) => l.contact_id).filter((id): id is string => Boolean(id)))
    );
    const history: Record<
      string,
      Array<{
        legId: string;
        createdAt: string;
        outcome: string | null;
        dispositionLabel: string | null;
        durationSeconds: number | null;
        notes: string | null;
        isVoicemail: boolean;
        hasRecording: boolean;
        callbackAt: string | null;
      }>
    > = {};
    if (contactIds.length > 0) {
      const { data: historyRows, error: historyError } = await supabase
        .from('call_legs')
        .select(
          'id, contact_id, created_at, outcome, duration_seconds, notes, callback_at, recording_status, recording_path, ' +
            'disposition:dispositions(label)'
        )
        .eq('org_id', orgId)
        .eq('kind', 'contact')
        .eq('state', 'ended')
        .in('contact_id', contactIds)
        .order('created_at', { ascending: false });
      if (historyError) {
        return new Response(JSON.stringify({ error: historyError.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // Cap at 3 most-recent attempts per contact -- same "last 3" convention DSP-9's own
      // contact_disposition_history function already established for this exact kind of strip.
      for (const row of (historyRows ?? []) as Array<{
        id: string;
        contact_id: string;
        created_at: string;
        outcome: string | null;
        duration_seconds: number | null;
        notes: string | null;
        callback_at: string | null;
        recording_status: string | null;
        recording_path: string | null;
        disposition: { label: string } | { label: string }[] | null;
      }>) {
        const bucket = (history[row.contact_id] ??= []);
        if (bucket.length >= 3) continue;
        const disposition = Array.isArray(row.disposition) ? row.disposition[0] : row.disposition;
        bucket.push({
          legId: row.id,
          createdAt: row.created_at,
          outcome: row.outcome,
          dispositionLabel: disposition?.label ?? null,
          durationSeconds: row.duration_seconds,
          notes: row.notes,
          isVoicemail: row.outcome === 'voicemail_left',
          hasRecording: row.recording_status === 'saved' && Boolean(row.recording_path),
          callbackAt: row.callback_at,
        });
      }
    }

    // TASK-T5 (CRD-4, card-side): the campaign's own script/objection sheet (T5a,
    // 20260926080200) -- same 3s poll already satisfies "live refetch on change."
    let campaignScript: { scriptText: string | null; objectionSheetText: string | null } | null =
      null;
    if (session.campaign_id) {
      const { data: campaign, error: campaignError } = await supabase
        .from('campaigns')
        .select('script_text, objection_sheet_text')
        .eq('id', session.campaign_id)
        .maybeSingle();
      if (campaignError) {
        return new Response(JSON.stringify({ error: campaignError.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      campaignScript = campaign
        ? { scriptText: campaign.script_text, objectionSheetText: campaign.objection_sheet_text }
        : null;
    }

    return new Response(
      JSON.stringify({
        session,
        legs: legs ?? [],
        inboundCall: inboundCall ?? null,
        coachingMode,
        activeTransfer: activeTransfer ?? null,
        history,
        campaignScript,
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
