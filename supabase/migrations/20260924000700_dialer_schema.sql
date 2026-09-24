-- Dialer schema (1/2): campaign/contact/lead columns for the new dial engine, plus the new
-- dial_sessions/call_legs/webhook_events tables. See docs/design/stage-1-architecture.md §4.2-4.4,
-- §7 (calling window). RPCs land in the next migration, once these tables exist.
--
-- Legacy dialer_sessions/call_logs are untouched (design says keep them, don't write to them from
-- new code) -- this is a fresh, org-scoped schema alongside them, not a rewrite of them in place.
-- State/outcome/AMD/hangup-cause value sets are the same enums already established in
-- _shared/dialer-core.ts (TASK-P2-E0), so DB and pure-logic agree on the vocabulary.

-- campaigns: dial-engine settings -------------------------------------------------------------

alter table public.campaigns
  add column lines smallint not null default 3 check (lines between 1 and 7),
  add column amd_mode text not null default 'off' check (amd_mode in ('off', 'on')),
  add column caller_id_number_id uuid references public.user_phone_numbers(id) on delete set null,
  add column max_attempts int not null default 3 check (max_attempts > 0),
  add column retry_interval_minutes int not null default 120 check (retry_interval_minutes >= 0),
  add column calling_window_start time not null default '08:00',
  add column calling_window_end time not null default '21:00',
  add column abandon_message_enabled boolean not null default true;

-- caller_id_number_id must belong to the same org as the campaign -- the same class of bug
-- TASK-P1-01/P1-02 fixed for campaign_leads/campaign_agents (a crafted or stale cross-org id would
-- otherwise let a campaign dial out from a number it doesn't own).

create function private.check_campaign_caller_id_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number_org uuid;
begin
  if new.caller_id_number_id is null then
    return new;
  end if;
  select org_id into v_number_org from public.user_phone_numbers where id = new.caller_id_number_id;
  if v_number_org is null or v_number_org <> new.org_id then
    raise exception 'campaigns.caller_id_number_id must belong to the campaign''s own org';
  end if;
  return new;
end;
$$;

create trigger campaigns_check_caller_id_org
  before insert or update on public.campaigns
  for each row execute function private.check_campaign_caller_id_org();

-- contacts: timezone + DNC ---------------------------------------------------------------------

alter table public.contacts
  add column timezone text,
  add column dnc boolean not null default false;

-- campaign_leads: queue-ordering columns + widened status -------------------------------------

alter table public.campaign_leads
  add column attempts int not null default 0,
  add column next_attempt_at timestamptz not null default now(),
  add column last_outcome text,
  add column position bigint,
  add column assigned_agent_id uuid references auth.users(id) on delete set null,
  add column updated_at timestamptz not null default now();

alter table public.campaign_leads drop constraint campaign_leads_status_check;
alter table public.campaign_leads add constraint campaign_leads_status_check
  check (status in ('queued', 'in_flight', 'completed', 'exhausted', 'dnc', 'callback', 'passthrough'));

-- Backfill position from added_at order per campaign (a global chronological counter preserves
-- each campaign's relative import order; cross-campaign values don't need to be comparable since
-- every real query filters by campaign_id first). New rows get the next value from the same
-- sequence, so they never collide with or reorder ahead of already-backfilled rows.

with ordered as (
  select id, row_number() over (order by added_at, id) as rn
  from public.campaign_leads
)
update public.campaign_leads cl
set position = ordered.rn
from ordered
where ordered.id = cl.id;

create sequence public.campaign_leads_position_seq;
select setval('public.campaign_leads_position_seq', coalesce((select max(position) from public.campaign_leads), 0) + 1, false);
alter table public.campaign_leads alter column position set default nextval('public.campaign_leads_position_seq');
alter table public.campaign_leads alter column position set not null;

create index idx_campaign_leads_queue
  on public.campaign_leads(campaign_id, status, attempts, next_attempt_at, position);
create index idx_campaign_leads_callback
  on public.campaign_leads(campaign_id, assigned_agent_id, next_attempt_at)
  where status = 'callback';

-- dial_sessions ---------------------------------------------------------------------------------
-- No client INSERT/UPDATE/DELETE policy anywhere in this file: every write goes through the
-- SECURITY DEFINER RPCs in the next migration (which bypass RLS as their owner) or the service
-- role. An agent SELECTs only their own sessions; owner/admin SELECT the whole org's.

create table public.dial_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  agent_id uuid not null references auth.users(id) on delete cascade,
  state text not null default 'ready_pending' check (state in (
    'ready_pending', 'ready', 'dialing', 'connecting', 'on_call', 'wrap_up',
    'paused', 'paused_agent_lost', 'stopped', 'completed'
  )),
  lines smallint not null default 3 check (lines between 1 and 7),
  amd_mode text not null default 'off' check (amd_mode in ('off', 'on')),
  agent_leg_id uuid,
  active_leg_id uuid,
  conference_id text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);

create index idx_dial_sessions_org_id on public.dial_sessions(org_id);
create index idx_dial_sessions_agent_id on public.dial_sessions(agent_id);
create index idx_dial_sessions_campaign_id on public.dial_sessions(campaign_id);
create index idx_dial_sessions_state on public.dial_sessions(state);

alter table public.dial_sessions enable row level security;

create policy "owner or admin can view all dial_sessions"
  on public.dial_sessions for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

create policy "agent can view own dial_sessions"
  on public.dial_sessions for select
  using (private.has_org_role(org_id, array['agent']) and agent_id = auth.uid());

-- call_legs -------------------------------------------------------------------------------------

create table public.call_legs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid not null references public.dial_sessions(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.campaign_leads(id) on delete set null,
  kind text not null check (kind in ('contact', 'agent')),
  call_control_id text not null unique,
  state text not null default 'initiated' check (state in (
    'initiated', 'ringing', 'answered', 'amd_pending', 'claimed', 'dropped', 'abandoned', 'machine', 'ended'
  )),
  outcome text check (outcome in (
    'no_answer', 'busy', 'machine', 'dropped', 'abandoned', 'failed', 'connected'
  )),
  amd_result text check (amd_result in (
    'human', 'not_sure', 'machine', 'human_residence', 'human_business', 'silence', 'fax_detected'
  )),
  hangup_cause text check (hangup_cause in (
    'call_rejected', 'normal_clearing', 'originator_cancel', 'timeout', 'time_limit',
    'user_busy', 'not_found', 'no_answer', 'unspecified'
  )),
  answered_at timestamptz,
  claimed_at timestamptz,
  ended_at timestamptz,
  duration_seconds int check (duration_seconds >= 0),
  created_at timestamptz not null default now()
);

create index idx_call_legs_org_id on public.call_legs(org_id);
create index idx_call_legs_session_id on public.call_legs(session_id);
create index idx_call_legs_state on public.call_legs(state);
create index idx_call_legs_lead_id on public.call_legs(lead_id);

alter table public.dial_sessions
  add constraint dial_sessions_agent_leg_id_fkey
    foreign key (agent_leg_id) references public.call_legs(id) on delete set null,
  add constraint dial_sessions_active_leg_id_fkey
    foreign key (active_leg_id) references public.call_legs(id) on delete set null;

-- Same "route cross-table checks through a SECURITY DEFINER helper, never an inline subquery on
-- another RLS-protected table" rule as TASK-P1-01's campaign_org_id/contact_org_id.

create function private.dial_session_agent_id(p_session_id uuid)
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select agent_id from public.dial_sessions where id = p_session_id;
$$;

grant execute on function private.dial_session_agent_id(uuid) to authenticated;

alter table public.call_legs enable row level security;

create policy "owner or admin can view all call_legs"
  on public.call_legs for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

create policy "agent can view own call_legs"
  on public.call_legs for select
  using (
    private.has_org_role(org_id, array['agent'])
    and private.dial_session_agent_id(call_legs.session_id) = auth.uid()
  );

-- webhook_events --------------------------------------------------------------------------------
-- Dedupe only. Service role only -- no client policy of any kind, including SELECT: nothing in the
-- UI needs raw webhook events, and there's no reason to expose Telnyx's event ids/types to a client.

create table public.webhook_events (
  org_id uuid not null references public.orgs(id) on delete cascade,
  event_id uuid primary key,
  event_type text not null,
  call_control_id text,
  received_at timestamptz not null default now()
);

create index idx_webhook_events_org_id on public.webhook_events(org_id);

alter table public.webhook_events enable row level security;
