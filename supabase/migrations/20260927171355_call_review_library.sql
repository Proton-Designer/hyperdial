-- MISSION-5 TASK-M5-B5: call review library -- recordings browser (filter/search), flag for
-- review, timestamped comments, and no-AI scorecards. Owner/admin see everything; a manager is
-- pod-scoped exactly like every other M5 surface (`private.is_agent_in_callers_pod_scope`); an
-- agent sees/comments on only their own calls, never anyone else's.
--
-- Visibility is composed ONCE here (`private.can_view_call_leg`) and reused by every new table's
-- RLS below, rather than re-derived per table -- the exact failure mode `org_broadcasts`' own
-- fix-forward (this same session, `20260927164816`) just proved: writing the same "owner/admin +
-- manager-pod-scope + agent-self" composition by hand more than once is how one copy quietly
-- drifts from the others.
--
-- Recording storage/signed URLs are eng2's lane (recording-url/index.ts, recording-core.ts) --
-- this migration does not touch Storage or the Telnyx recording pipeline at all, only adds a
-- role check widening to the EXISTING signed-URL minting function (see that file's own diff,
-- committed alongside this migration) so a manager can also play a recording their pod scope
-- covers.

-- =================================================================================================
-- 1. private.can_view_call_leg: the one shared visibility check every table below composes.
--    Deliberately built from the TWO existing helpers (is_agent_in_callers_pod_scope already
--    covers owner/admin unconditionally, see its own header) rather than re-checking has_org_role
--    itself -- one true definition, not a fourth hand-written copy of the same OR-chain.
-- =================================================================================================

create function private.can_view_call_leg(p_leg_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    coalesce(
      private.is_agent_in_callers_pod_scope(cl.org_id, private.dial_session_agent_id(cl.session_id))
      or private.dial_session_agent_id(cl.session_id) = auth.uid(),
      false
    )
  from public.call_legs cl
  where cl.id = p_leg_id;
$$;

revoke all on function private.can_view_call_leg(uuid) from public, anon;
grant execute on function private.can_view_call_leg(uuid) to authenticated;

-- =================================================================================================
-- 2. call_legs: additive manager pod-scope SELECT policy. The two existing policies (owner/admin
--    see all; agent sees own) are untouched -- this is a THIRD, ORed-in permissive policy, same
--    "widen by adding, never by editing an existing policy" convention as org_pods/org_goals.
--    Without this, a manager cannot see call_legs at all today (it predates the manager role).
-- =================================================================================================

create policy "manager can view pod-scoped call_legs"
  on public.call_legs for select
  using (
    private.has_org_role(org_id, array['manager'])
    and private.is_agent_in_callers_pod_scope(org_id, private.dial_session_agent_id(call_legs.session_id))
  );

-- =================================================================================================
-- 3. recording_flags: one row per call leg (upsert semantics -- re-flagging overwrites the
--    reason/flagger, unflagging deletes the row). Anyone who can VIEW a call leg may flag/unflag
--    it, including an agent flagging their own call for their manager's attention -- the task's
--    own wording ("agent or manager") is illustrative of who actually uses this, not a role
--    exclusion; owner/admin already have equal-or-greater access everywhere else in this app.
-- =================================================================================================

create table public.recording_flags (
  call_leg_id uuid primary key references public.call_legs(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  flagged_by uuid references auth.users(id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now()
);

create index recording_flags_org_idx on public.recording_flags(org_id);

alter table public.recording_flags enable row level security;

create policy "anyone who can view the call leg can view its flag"
  on public.recording_flags for select
  using (private.can_view_call_leg(call_leg_id));

create policy "anyone who can view the call leg can flag or unflag it"
  on public.recording_flags for all
  using (private.can_view_call_leg(call_leg_id))
  with check (
    private.can_view_call_leg(call_leg_id)
    and org_id = (select cl.org_id from public.call_legs cl where cl.id = call_leg_id)
  );

revoke all on public.recording_flags from anon;

-- =================================================================================================
-- 4. recording_comments: timestamped (at_second), append-only (no update/delete policy -- a
--    permanent note, same convention as org_audit_log). An agent may only ever insert one whose
--    call_leg_id they can already view (their own), which is exactly "agents can reply on their
--    own calls" -- no separate reply-vs-comment distinction needed, both are the same insert.
-- =================================================================================================

create table public.recording_comments (
  id uuid primary key default gen_random_uuid(),
  call_leg_id uuid not null references public.call_legs(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  at_second int check (at_second >= 0),
  text text not null check (char_length(text) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index recording_comments_leg_idx on public.recording_comments(call_leg_id, created_at);

alter table public.recording_comments enable row level security;

create policy "anyone who can view the call leg can view its comments"
  on public.recording_comments for select
  using (private.can_view_call_leg(call_leg_id));

create policy "anyone who can view the call leg can comment on it"
  on public.recording_comments for insert
  with check (
    private.can_view_call_leg(call_leg_id)
    and author_user_id = auth.uid()
    and org_id = (select cl.org_id from public.call_legs cl where cl.id = call_leg_id)
  );

revoke all on public.recording_comments from anon;

-- =================================================================================================
-- 5. Scorecards: owner/admin define a rubric (named, versionable -- `active` lets an org retire
--    one without losing history on calls already scored against it); a manager (pod-scoped) or
--    owner/admin scores a call; an agent has READ-ONLY access to their own scores (via the same
--    can_view_call_leg visibility -- they are never a valid `scored_by`). Writes go through
--    `set_call_scorecard` (SECURITY DEFINER) -- the manager pod-scope-on-write check and the
--    "criterion must belong to this rubric" validation are both easier in plpgsql than a single
--    RLS WITH CHECK, same reasoning as org_goals/org_broadcasts this same session.
-- =================================================================================================

create table public.scorecard_rubrics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index scorecard_rubrics_org_idx on public.scorecard_rubrics(org_id);

alter table public.scorecard_rubrics enable row level security;

create policy "org members can view rubrics"
  on public.scorecard_rubrics for select
  using (private.is_org_member(org_id));

create policy "owner or admin can manage rubrics"
  on public.scorecard_rubrics for all
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.scorecard_rubrics from anon;

create table public.scorecard_rubric_criteria (
  id uuid primary key default gen_random_uuid(),
  rubric_id uuid not null references public.scorecard_rubrics(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  label text not null,
  kind text not null check (kind in ('scale_1_5', 'yes_no')),
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index scorecard_rubric_criteria_rubric_idx on public.scorecard_rubric_criteria(rubric_id);

alter table public.scorecard_rubric_criteria enable row level security;

create policy "org members can view rubric criteria"
  on public.scorecard_rubric_criteria for select
  using (private.is_org_member(org_id));

create policy "owner or admin can manage rubric criteria"
  on public.scorecard_rubric_criteria for all
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.scorecard_rubric_criteria from anon;

create table public.call_scorecards (
  id uuid primary key default gen_random_uuid(),
  call_leg_id uuid not null references public.call_legs(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  rubric_id uuid not null references public.scorecard_rubrics(id) on delete cascade,
  scored_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (call_leg_id)
);

create index call_scorecards_org_idx on public.call_scorecards(org_id);

alter table public.call_scorecards enable row level security;

create policy "anyone who can view the call leg can view its scorecard"
  on public.call_scorecards for select
  using (private.can_view_call_leg(call_leg_id));

-- No client insert/update/delete -- set_call_scorecard is the only writer.

revoke all on public.call_scorecards from anon;

create table public.call_scorecard_scores (
  id uuid primary key default gen_random_uuid(),
  scorecard_id uuid not null references public.call_scorecards(id) on delete cascade,
  criterion_id uuid not null references public.scorecard_rubric_criteria(id) on delete cascade,
  score_value int check (score_value between 1 and 5),
  score_bool boolean,
  unique (scorecard_id, criterion_id),
  -- Exactly one of the two is set, matching the criterion's own `kind` -- enforced again inside
  -- set_call_scorecard (which decides which column to populate from the criterion's kind), this
  -- is the belt to that suspenders in case a future writer is ever added.
  check ((score_value is not null) <> (score_bool is not null))
);

create index call_scorecard_scores_scorecard_idx on public.call_scorecard_scores(scorecard_id);

alter table public.call_scorecard_scores enable row level security;

create policy "anyone who can view the call leg can view its scores"
  on public.call_scorecard_scores for select
  using (
    exists (
      select 1 from public.call_scorecards cs
      where cs.id = call_scorecard_scores.scorecard_id and private.can_view_call_leg(cs.call_leg_id)
    )
  );

revoke all on public.call_scorecard_scores from anon;

create function public.set_call_scorecard(
  p_org uuid,
  p_call_leg_id uuid,
  p_rubric_id uuid,
  p_scores jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_leg_org_id uuid;
  v_session_id uuid;
  v_agent_id uuid;
  v_scorecard_id uuid;
  v_item jsonb;
  v_criterion_kind text;
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    raise exception 'only an owner, admin, or manager can score a call';
  end if;

  select cl.org_id, cl.session_id into v_leg_org_id, v_session_id
  from public.call_legs cl
  where cl.id = p_call_leg_id;
  if v_leg_org_id is null or v_leg_org_id <> p_org then
    raise exception 'call leg not found for this org';
  end if;

  v_agent_id := private.dial_session_agent_id(v_session_id);
  if not private.is_agent_in_callers_pod_scope(p_org, v_agent_id) then
    raise exception 'that agent is outside your managed pods';
  end if;

  if not exists (
    select 1 from public.scorecard_rubrics where id = p_rubric_id and org_id = p_org
  ) then
    raise exception 'rubric not found for this org';
  end if;

  insert into public.call_scorecards (call_leg_id, org_id, rubric_id, scored_by)
  values (p_call_leg_id, p_org, p_rubric_id, auth.uid())
  on conflict (call_leg_id)
  do update set rubric_id = excluded.rubric_id, scored_by = excluded.scored_by, updated_at = now()
  returning id into v_scorecard_id;

  -- Re-scoring replaces the FULL score set (simplest correct semantics for "score this call
  -- against this rubric right now") rather than trying to merge/diff against a prior scoring.
  delete from public.call_scorecard_scores where scorecard_id = v_scorecard_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb))
  loop
    select kind into v_criterion_kind
    from public.scorecard_rubric_criteria
    where id = (v_item ->> 'criterion_id')::uuid and rubric_id = p_rubric_id;

    if v_criterion_kind is null then
      raise exception 'criterion % does not belong to this rubric', v_item ->> 'criterion_id';
    end if;

    insert into public.call_scorecard_scores (scorecard_id, criterion_id, score_value, score_bool)
    values (
      v_scorecard_id,
      (v_item ->> 'criterion_id')::uuid,
      case when v_criterion_kind = 'scale_1_5' then (v_item ->> 'score_value')::int else null end,
      case when v_criterion_kind = 'yes_no' then (v_item ->> 'score_bool')::boolean else null end
    );
  end loop;

  perform private.log_org_action(
    p_org, 'scorecard.set', 'call_leg', p_call_leg_id,
    jsonb_build_object('rubric_id', p_rubric_id, 'scorecard_id', v_scorecard_id)
  );

  return v_scorecard_id;
end;
$$;

revoke all on function public.set_call_scorecard(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_call_scorecard(uuid, uuid, uuid, jsonb) to authenticated;

-- =================================================================================================
-- 6. my_scorecard_trend: the agent's own "simple trend" for My stats. Blends both criterion
--    kinds into one 0-100 "score_pct" per scorecard (scale_1_5 rescaled linearly, yes_no as
--    100/0) -- a single comparable number across a rubric mixing both kinds, ordered oldest to
--    newest so the client can just plot it. Self-view only, same trust model as
--    agent_self_stats/my_goal_targets (no p_agent parameter).
-- =================================================================================================

create function public.my_scorecard_trend(p_org uuid)
returns table (
  call_leg_id uuid,
  scored_at timestamptz,
  score_pct numeric
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
begin
  if not private.is_org_member(p_org) then
    return;
  end if;

  return query
  select
    cs.call_leg_id,
    cs.updated_at,
    round(avg(
      case
        when s.score_value is not null then (s.score_value - 1) / 4.0 * 100
        when s.score_bool is not null then (case when s.score_bool then 100 else 0 end)
      end
    ), 1) as score_pct
  from public.call_scorecards cs
  join public.call_legs cl on cl.id = cs.call_leg_id
  join public.call_scorecard_scores s on s.scorecard_id = cs.id
  where cs.org_id = p_org
    and private.dial_session_agent_id(cl.session_id) = v_caller
  group by cs.id, cs.call_leg_id, cs.updated_at
  order by cs.updated_at asc;
end;
$$;

revoke all on function public.my_scorecard_trend(uuid) from public, anon;
grant execute on function public.my_scorecard_trend(uuid) to authenticated;

-- =================================================================================================
-- 7. recordings_search: the Recordings page's own one-RPC-per-load list/filter query. Visibility
--    is the row filter (an owner/admin sees every row; a manager's rows are pod-scoped; an agent
--    only their own -- composed the same way can_view_call_leg is, just inlined here since this
--    query already joins dial_sessions for other reasons and a per-row function call would be
--    redundant). `p_agent_id` (narrowing an owner/admin's or manager's OWN query to one agent) is
--    itself scope-checked -- a manager cannot query an out-of-scope agent_id and get an empty-
--    looking-like-a-typo result, they get a clear exception instead.
-- =================================================================================================

create function public.recordings_search(
  p_org uuid,
  p_agent_id uuid default null,
  p_campaign_id uuid default null,
  p_disposition_key text default null,
  p_min_duration_seconds int default null,
  p_max_duration_seconds int default null,
  p_start timestamptz default null,
  p_end timestamptz default null,
  p_flagged_only boolean default false,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  call_leg_id uuid,
  agent_id uuid,
  agent_name text,
  campaign_id uuid,
  campaign_name text,
  disposition_key text,
  disposition_label text,
  duration_seconds int,
  ended_at timestamptz,
  is_flagged boolean,
  flag_reason text,
  comment_count bigint,
  has_scorecard boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager', 'agent']) then
    return;
  end if;

  if p_agent_id is not null
     and not private.is_agent_in_callers_pod_scope(p_org, p_agent_id)
     and p_agent_id <> v_caller then
    raise exception 'that agent is outside your managed pods';
  end if;

  return query
  select
    cl.id,
    ds.agent_id,
    coalesce(nullif(trim(concat(pr.first_name, ' ', pr.last_name)), ''), 'Unknown'),
    cl.campaign_id,
    c.name,
    d.key,
    d.label,
    coalesce(cl.recording_duration_seconds, cl.duration_seconds),
    cl.ended_at,
    (rf.call_leg_id is not null),
    rf.reason,
    coalesce(cc.cnt, 0),
    (cs.id is not null)
  from public.call_legs cl
  join public.dial_sessions ds on ds.id = cl.session_id
  left join public.profiles pr on pr.user_id = ds.agent_id
  left join public.campaigns c on c.id = cl.campaign_id
  left join public.dispositions d on d.id = cl.disposition_id
  left join public.recording_flags rf on rf.call_leg_id = cl.id
  left join public.call_scorecards cs on cs.call_leg_id = cl.id
  left join lateral (
    select count(*) as cnt from public.recording_comments rc where rc.call_leg_id = cl.id
  ) cc on true
  where cl.org_id = p_org
    and cl.kind = 'contact'
    and cl.recording_status = 'saved'
    and (private.is_agent_in_callers_pod_scope(p_org, ds.agent_id) or ds.agent_id = v_caller)
    and (p_agent_id is null or ds.agent_id = p_agent_id)
    and (p_campaign_id is null or cl.campaign_id = p_campaign_id)
    and (p_disposition_key is null or d.key = p_disposition_key)
    and (
      p_min_duration_seconds is null
      or coalesce(cl.recording_duration_seconds, cl.duration_seconds) >= p_min_duration_seconds
    )
    and (
      p_max_duration_seconds is null
      or coalesce(cl.recording_duration_seconds, cl.duration_seconds) <= p_max_duration_seconds
    )
    and (p_start is null or cl.ended_at >= p_start)
    and (p_end is null or cl.ended_at < p_end)
    and (not p_flagged_only or rf.call_leg_id is not null)
  order by cl.ended_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.recordings_search(
  uuid, uuid, uuid, text, int, int, timestamptz, timestamptz, boolean, int, int
) from public, anon;
grant execute on function public.recordings_search(
  uuid, uuid, uuid, text, int, int, timestamptz, timestamptz, boolean, int, int
) to authenticated;
