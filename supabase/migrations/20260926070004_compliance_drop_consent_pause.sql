-- MISSION-4 TASK-T8 (compliance): drop-rate tracking, recording consent notice by state,
-- pause/resume recording, QUE-2 gatekeeper retry delay. Timestamp 070004, next free in eng2's
-- own range (070000=T3, 070001=T3 fix, 070002=T4+fix-forward, 070003=T6).
--
-- Scope notes (what already existed vs. what's new here -- verified by reading the code, not
-- assumed):
--   - "Record a drop per leg" and "queue them first for the next batch" were ALREADY DONE
--     (20260925050000_voicemail_drop.sql's apply_leg_outcome: dropped/abandoned sets
--     `priority_requeue = true` and `next_attempt_at = now()`, attempts NOT incremented). "Play a
--     short message to a dropped human" was ALSO already done (dialer-engine.ts's
--     `sendAbandonMessage`, gated on `campaigns.abandon_message_enabled`, default true). This
--     migration only adds the missing piece: a per-campaign 30-day drop-rate METRIC for Campaign
--     analytics (`campaign_drop_rate_summary` below) -- the UI's own 3% guideline warning is a
--     pure display concern, added in Analytics.tsx, no new SQL needed for it.
--   - Recording consent notice, recording pause/resume, and the gatekeeper retry delay are all
--     genuinely new.

-- =================================================================================================
-- 1. Recording consent: org_recording_settings gains an announce mode + an editable default list
--    of all-party-consent states. A dedicated small-table widen (additive columns only), same
--    table `org_transfer_settings`/T4-fix-forward already showed the pattern for. No RLS change
--    needed -- the existing member-read/owner-admin-write policies (20260925040000) already cover
--    every column on this table, new ones included.
-- =================================================================================================

alter table public.org_recording_settings
  add column announce_recording_mode text not null default 'never'
    check (announce_recording_mode in ('never', 'all', 'all_party_consent_states')),
  add column all_party_consent_states text[] not null default array[
    'CA', 'CT', 'FL', 'IL', 'MD', 'MA', 'MT', 'NH', 'PA', 'WA', 'NV', 'OR', 'DE', 'MI'
  ];

comment on column public.org_recording_settings.announce_recording_mode is
  'MISSION-4 TASK-T8: whether a consent notice is spoken to the prospect at bridge time. "never"
   (default, unchanged behaviour) / "all" (every recorded call) / "all_party_consent_states" (only
   when the contact''s area-code-derived state, see _shared/area-code-state.ts, is in
   all_party_consent_states). Only consulted when recording_enabled is also true -- an org with
   recording off has nothing to announce.';

comment on column public.org_recording_settings.all_party_consent_states is
  'MISSION-4 TASK-T8: editable per-org. Seeded with a common reference list of US all-party (or
   otherwise two-party) consent states -- NOT LEGAL ADVICE, and deliberately editable: an org with
   real compliance exposure must verify this list for itself. Best-effort area-code-to-state
   mapping (_shared/area-code-state.ts) backs the actual per-call decision, same "best-effort, not
   authoritative" caveat as the existing area-code-to-timezone table.';

-- =================================================================================================
-- 2. Recording pause/resume: call_legs gains a 'paused' recording_status value + a record of the
--    paused spans (REC's own "the recording's metadata notes the paused spans" ask). One open span
--    tracked via `recording_paused_at` (null when not currently paused); resuming closes it into
--    `recording_paused_spans` (append-only jsonb array of {paused_at, resumed_at}).
-- =================================================================================================

alter table public.call_legs drop constraint call_legs_recording_status_check;
alter table public.call_legs add constraint call_legs_recording_status_check
  check (recording_status in (
    'recording', 'paused', 'saved', 'download_failed', 'recording_failed', 'deleted'
  ));

alter table public.call_legs
  add column recording_paused_at timestamptz,
  add column recording_paused_spans jsonb not null default '[]'::jsonb;

comment on column public.call_legs.recording_paused_spans is
  'MISSION-4 TASK-T8: append-only history of {paused_at, resumed_at} spans while this leg''s
   recording was paused (dialer-session-recording, action=resume, appends the just-closed span).
   `recording_paused_at` alone is the CURRENTLY open span, if any (null once resumed/appended).';

-- =================================================================================================
-- 3. QUE-2: gatekeeper gets its own shorter retry delay than the 4-day no_answer/voicemail
--    cadence. Known limitation, not fixed here (documented in known-issues.md instead of widening
--    the blast radius of this already-high-risk task by re-touching apply_leg_outcome/
--    submit_disposition): every 'retry' campaign_retry_rules row is scheduled via
--    `private.rotated_retry_schedule`, which ALWAYS rotates the time block and ALWAYS floors to
--    at least 1 day out (`greatest(1, delay_minutes / 1440)`) regardless of `rotate_block`'s own
--    value -- the "rotate_block=false means a flat now()+delay_minutes offset" behaviour that
--    column's own comment (20260925030000) describes was never actually implemented by either
--    caller. So the shortest a 'retry' rule can genuinely land is "tomorrow, in a different time
--    block" -- which is still correctly SHORTER than no_answer/voicemail's 4 days, so that's what
--    this seeds: delay_minutes=1440 (any value 1..2879 floors to the identical "1 day out"
--    outcome under the current code; 1440 is used here so the stored number itself still reads as
--    "1 day" for a future reader, not because the exact value changes today's behaviour).
-- =================================================================================================

create or replace function private.seed_default_campaign_retry_rules(p_campaign uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.campaign_retry_rules (campaign_id, disposition_key, action, delay_minutes, rotate_block)
  values
    (p_campaign, 'no_answer', 'retry', 5760, true),
    (p_campaign, 'voicemail', 'retry', 5760, true),
    (p_campaign, 'voicemail_left', 'retry', 5760, true),
    -- MISSION-4 TASK-T8 (QUE-2): shorter than the 4-day default above -- see this migration's own
    -- header for why 1440 (not some smaller value) is what actually produces a shorter delay
    -- under the current rotated_retry_schedule.
    (p_campaign, 'gatekeeper', 'retry', 1440, true),
    (p_campaign, 'callback', 'exact_time', null, false),
    (p_campaign, 'interested', 'out', null, false),
    (p_campaign, 'not_interested', 'out', null, false),
    (p_campaign, 'wrong_number', 'out', null, false),
    (p_campaign, 'dnc', 'out', null, false)
  on conflict (campaign_id, disposition_key) do nothing;
$$;

-- Backfill: only rows still at the OLD seeded default (5760/retry/rotate_block=true) -- an org
-- that already customized its own gatekeeper rule (any other value) is left alone, same
-- "don't clobber a manual override" discipline as every other backfill in this codebase.
update public.campaign_retry_rules
set delay_minutes = 1440, updated_at = now()
where disposition_key = 'gatekeeper'
  and action = 'retry'
  and rotate_block = true
  and delay_minutes = 5760;

-- =================================================================================================
-- 4. Drop-rate tracking: the one genuinely missing piece of REQ-1 (see this migration's own
--    header) -- a per-campaign, N-day drop-rate metric for Campaign analytics. Same
--    security/scoping shape as eng1's `funnel_summary` (20260926080300, applied) -- deliberately
--    NOT editing that file (append-only) or that function; this is a new, additive function.
--    "Drop rate" = dropped+abandoned as a fraction of human answers (connected+dropped+abandoned)
--    -- exactly REQ-1's own wording, "a human answered but was hung up".
-- =================================================================================================

create function public.campaign_drop_rate_summary(
  p_org uuid, p_campaign_id uuid, p_start timestamptz, p_end timestamptz
)
returns table (dials integer, human_answers integer, dropped integer, drop_rate_pct numeric)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_is_admin boolean;
begin
  if not private.is_org_member(p_org) then
    return;
  end if;
  v_is_admin := private.has_org_role(p_org, array['owner', 'admin']);

  return query
  select
    count(*)::integer as dials,
    count(*) filter (where cl.outcome in ('connected', 'dropped', 'abandoned'))::integer
      as human_answers,
    count(*) filter (where cl.outcome in ('dropped', 'abandoned'))::integer as dropped,
    case
      when count(*) filter (where cl.outcome in ('connected', 'dropped', 'abandoned')) > 0
      then round(
        100.0 * count(*) filter (where cl.outcome in ('dropped', 'abandoned'))
          / count(*) filter (where cl.outcome in ('connected', 'dropped', 'abandoned')),
        1
      )
      else 0
    end as drop_rate_pct
  from public.call_legs cl
  join public.dial_sessions ds on ds.id = cl.session_id
  where cl.org_id = p_org
    and cl.kind = 'contact'
    and cl.created_at >= p_start
    and cl.created_at < p_end
    and (p_campaign_id is null or cl.campaign_id = p_campaign_id)
    and (v_is_admin or ds.agent_id = auth.uid());
end;
$$;

revoke all on function public.campaign_drop_rate_summary(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.campaign_drop_rate_summary(uuid, uuid, timestamptz, timestamptz) to authenticated;
