-- MISSION-5 TASK-M5-G6: shared team callback inbox for missed inbound calls, with claim.
-- current-state.md named this MISSING (Kixie/Five9/Talkdesk all have some form of it) -- today a
-- missed inbound call (no-answer, busy, agent offline, voicemail) sits only in that agent's own
-- inbound-call history; nobody else on the team sees it or calls back.
--
-- =================================================================================================
-- 1. org_shared_inbox_settings -- OFF by default (owner/admin), same one-row-per-org shape as
--    org_call_takeover_settings (20260927212609). Two knobs: shared_inbox_enabled (gates whether
--    an ORDINARY agent additionally sees OTHER agents' unclaimed items -- see section 3's own
--    header for why item CREATION itself is never gated by this) and claim_stale_minutes (a claim
--    older than this is treated as reopened -- "on read, no cron", see section 6).
-- =================================================================================================

create table public.org_shared_inbox_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  shared_inbox_enabled boolean not null default false,
  claim_stale_minutes int not null default 30 check (claim_stale_minutes > 0),
  updated_at timestamptz not null default now()
);

alter table public.org_shared_inbox_settings enable row level security;

create policy "org members can view shared inbox settings"
  on public.org_shared_inbox_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert shared inbox settings"
  on public.org_shared_inbox_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update shared inbox settings"
  on public.org_shared_inbox_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.org_shared_inbox_settings from anon;

create function private.seed_default_shared_inbox_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_shared_inbox_settings (org_id)
  values (p_org)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_shared_inbox_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_shared_inbox_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_shared_inbox_settings
  after insert on public.orgs
  for each row execute function private.seed_default_shared_inbox_settings_trigger();

do $$
declare
  v_org record;
begin
  for v_org in select id from public.orgs loop
    perform private.seed_default_shared_inbox_settings(v_org.id);
  end loop;
end;
$$;

-- Reuses the EXISTING generic settings-change audit trigger (20260927080000_org_audit_log.sql)
-- unmodified -- same pattern org_call_takeover_settings/org_disposition_quality_settings-shaped
-- tables in this mission already use.
create trigger org_shared_inbox_settings_audit
  after insert or update on public.org_shared_inbox_settings
  for each row execute function private.audit_log_settings_change_trigger('settings.shared_inbox.update', 'org_shared_inbox_settings');

-- =================================================================================================
-- 2. inbox_items -- one row per DISTINCT missed caller currently open/claimed (section 4 is the
--    de-dupe). `target_agent_id` is the ORIGINAL target agent from the FIRST missed call that
--    created this row (`inbound_calls.routed_to_user_id`, null for a team-pool number with no
--    assigned intern) -- never overwritten by a later repeat (see section 4's own header for why).
--    `contact_id`/`to_number_id` are denormalized copies of the inbound call's own resolved
--    values so the item still displays correctly if the source `inbound_calls` row is ever
--    pruned/archived later (not done today, but this table has no FK back to inbound_calls at
--    all -- deliberately: it must survive independently of that table's own retention story).
-- =================================================================================================

create table public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  from_e164 text not null,
  contact_id uuid references public.contacts(id) on delete set null,
  to_number_id uuid references public.user_phone_numbers(id) on delete set null,
  target_agent_id uuid references auth.users(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'claimed', 'done', 'dismissed')),
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_at timestamptz,
  done_at timestamptz,
  dismissed_at timestamptz,
  note text,
  repeat_count int not null default 1 check (repeat_count >= 1),
  received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_inbox_items_org_status on public.inbox_items(org_id, status);
create index idx_inbox_items_target_agent on public.inbox_items(target_agent_id);
create index idx_inbox_items_claimed_by on public.inbox_items(claimed_by) where claimed_by is not null;

-- De-dupe key (requirement #4): org + raw caller number, open/claimed only -- a done/dismissed
-- item never blocks a FRESH item for a caller who tries again later. Deliberately excludes a
-- withheld/anonymous caller id (`from_e164` that doesn't look like a real E.164 number, the exact
-- `isPlausibleE164` regex from inbound-core.ts) from de-duping at all: an anonymous call always
-- creates its own new item, because two withheld calls sharing the same placeholder value are
-- almost certainly NOT the same person, and de-duping them would be actively misleading (a
-- "repeat_count: 4" on what might be 4 different unrelated withheld callers) -- edge case #5,
-- audit/M5-G6/notes.md.
create unique index idx_inbox_items_dedupe_open
  on public.inbox_items(org_id, from_e164)
  where status in ('open', 'claimed') and from_e164 ~ '^\+[1-9][0-9]{6,14}$';

alter table public.inbox_items enable row level security;

revoke all on public.inbox_items from anon;

-- =================================================================================================
-- 3. private.can_view_inbox_item -- the ONE reusable 3-tier visibility check (owner/admin any;
--    manager pod-scoped via target_agent_id; agent their OWN target items, or an open/unclaimed
--    item ANY time -- including one with no target agent at all, e.g. a team-pool number -- but
--    ONLY when the org has shared_inbox_enabled) -- composed once and reused by the SELECT policy
--    below AND every write RPC in section 6 (a SECURITY DEFINER function bypasses RLS entirely,
--    so each write RPC must re-run this same check itself, same "compose once" discipline
--    private.can_view_call_leg (20260927171355) already established for a different feature).
--
--    Item CREATION (section 5's trigger) is never gated by shared_inbox_enabled at all -- only
--    visibility of OTHER agents' unclaimed items is. Per the task's own requirement #2 wording
--    ("an agent sees their OWN missed calls plus unclaimed items when ... on"), an agent already
--    sees their own missed calls regardless of the setting, which is only possible if the row
--    exists unconditionally. This also means the setting's OFF-by-default posture (the "new
--    automatic behaviour ships disabled" rule) is about *cross-agent visibility*, not about
--    whether missed calls get tracked at all -- creating a bookkeeping row has no external
--    side effect (no Telnyx/GHL call, no spend), so it doesn't fall under that rule's own concern.
-- =================================================================================================

create function private.can_view_inbox_item(p_org uuid, p_target_agent_id uuid, p_status text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    private.has_org_role(p_org, array['owner', 'admin'])
    or (
      p_target_agent_id is not null
      and private.is_agent_in_callers_pod_scope(p_org, p_target_agent_id)
    )
    or (
      private.has_org_role(p_org, array['agent'])
      and (
        p_target_agent_id = auth.uid()
        or (
          p_status = 'open'
          and exists (
            select 1 from public.org_shared_inbox_settings s
            where s.org_id = p_org and s.shared_inbox_enabled
          )
        )
      )
    );
$$;

grant execute on function private.can_view_inbox_item(uuid, uuid, text) to authenticated;

create policy "org role scoped inbox visibility"
  on public.inbox_items for select
  using (private.can_view_inbox_item(org_id, target_agent_id, status));

-- =================================================================================================
-- 4. private.upsert_inbox_item_from_missed_call -- the de-dupe upsert. On conflict (an open/
--    claimed item already exists for this org+number): bumps repeat_count and last_received_at
--    ONLY. `target_agent_id`/`received_at`/`to_number_id` stay whatever the FIRST missed call set
--    -- "who was originally supposed to get this" is the whole point of the field, and shouldn't
--    drift just because the SAME caller happened to reach a different intern on retry (edge case
--    "the same number calling two different agents" collapses into the SAME open item -- the
--    de-dupe key is org+number only, not +target_agent, by this task's own index design in
--    section 2 -- documented, not a bug, audit/M5-G6/notes.md). `contact_id` is the one exception:
--    upgraded via `coalesce(old, new)` (never downgraded to null) since a contact match can only
--    IMPROVE between calls (e.g. the contact record didn't exist yet at the first missed call).
-- =================================================================================================

create function private.upsert_inbox_item_from_missed_call(
  p_org uuid,
  p_from_e164 text,
  p_contact_id uuid,
  p_to_number_id uuid,
  p_target_agent_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_from_e164 ~ '^\+[1-9][0-9]{6,14}$' then
    insert into public.inbox_items (
      org_id, from_e164, contact_id, to_number_id, target_agent_id
    ) values (
      p_org, p_from_e164, p_contact_id, p_to_number_id, p_target_agent_id
    )
    -- Matches idx_inbox_items_dedupe_open's own predicate EXACTLY (not just a subset of it) --
    -- ON CONFLICT's inference clause must name a real unique/exclusion constraint, and leaving
    -- off the regex half here would risk Postgres failing to infer this partial index as the
    -- arbiter at all (`there is no unique or exclusion constraint matching the ON CONFLICT
    -- specification`), even though this branch is only ever reached when the regex already
    -- matched -- safer to state it explicitly than to rely on that implication holding.
    on conflict (org_id, from_e164)
      where status in ('open', 'claimed') and from_e164 ~ '^\+[1-9][0-9]{6,14}$'
    do update set
      repeat_count = public.inbox_items.repeat_count + 1,
      last_received_at = now(),
      contact_id = coalesce(public.inbox_items.contact_id, excluded.contact_id),
      updated_at = now();
  else
    -- Anonymous/withheld caller id: never de-duped (see the index's own comment) -- always its
    -- own fresh row.
    insert into public.inbox_items (
      org_id, from_e164, contact_id, to_number_id, target_agent_id
    ) values (
      p_org, p_from_e164, p_contact_id, p_to_number_id, p_target_agent_id
    );
  end if;
end;
$$;

-- =================================================================================================
-- 5. Trigger: fires on inbound_calls AFTER UPDATE the moment a call ends unanswered. Idempotent by
--    construction -- `endInboundCall` (inbound-engine.ts) only ever transitions a row TO 'ended'
--    ONCE (its own `transitionInboundCall` CAS never matches an already-`ended` row, so a
--    redelivered webhook's retry is a no-op before this trigger's UPDATE even lands) -- but the
--    `old.state is distinct from 'ended'` guard is kept anyway as a second, independent line of
--    defense against a future direct UPDATE that doesn't go through that CAS.
--
--    'missed' and 'voicemail' are BOTH "nobody live answered" outcomes (outcomeForEndedCall,
--    inbound-core.ts) -- 'answered_by_agent'/'forwarded' both mean a human DID pick up somewhere,
--    never inbox-worthy.
-- =================================================================================================

create function private.create_inbox_item_from_ended_inbound_call()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'ended' and old.state is distinct from 'ended'
     and new.outcome in ('missed', 'voicemail') then
    perform private.upsert_inbox_item_from_missed_call(
      new.org_id, new.from_e164, new.contact_id, new.to_number_id, new.routed_to_user_id
    );
  end if;
  return new;
end;
$$;

create trigger inbound_calls_create_inbox_item
  after update on public.inbound_calls
  for each row execute function private.create_inbox_item_from_ended_inbound_call();

-- =================================================================================================
-- 6. private.reopen_stale_inbox_claims: "a claim goes stale after N minutes ... and is reopened
--    on read, with no cron" (requirement #3) -- an UPDATE side-effect run at the START of every
--    read/write entry point below (never a standalone cron job). Idempotent (a claim that isn't
--    stale is untouched) and cheap (indexed by org_id+status).
-- =================================================================================================

create function private.reopen_stale_inbox_claims(p_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stale_minutes int;
begin
  select claim_stale_minutes into v_stale_minutes
  from public.org_shared_inbox_settings where org_id = p_org;
  v_stale_minutes := coalesce(v_stale_minutes, 30);

  update public.inbox_items
  set status = 'open', claimed_by = null, claimed_at = null, updated_at = now()
  where org_id = p_org
    and status = 'claimed'
    and claimed_at < now() - make_interval(mins => v_stale_minutes);
end;
$$;

-- Public wrapper the frontend calls once when opening the Inbox, right before its own bare
-- `.from('inbox_items').select()` (RLS-scoped) -- keeps the sweep's role check trivial (any org
-- member) since the actual row-level scoping still happens in the SELECT that follows.
create function public.reopen_stale_inbox_claims(p_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_org_member(p_org) then
    raise exception 'not a member of this org';
  end if;
  perform private.reopen_stale_inbox_claims(p_org);
end;
$$;

revoke all on function public.reopen_stale_inbox_claims(uuid) from public, anon;
grant execute on function public.reopen_stale_inbox_claims(uuid) to authenticated;

-- =================================================================================================
-- 7. Write RPCs: claim / unclaim / mark done / dismiss. Every one re-derives visibility via
--    private.can_view_inbox_item (SECURITY DEFINER bypasses RLS -- see section 3's own header)
--    and self-heals a stale claim first (section 6) so none of these ever fights a claim that
--    should already have been reopened.
-- =================================================================================================

create function public.claim_inbox_item(p_org uuid, p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.inbox_items;
  v_claimed_id uuid;
  v_name text;
begin
  -- SECURITY (same class of gap the lead's own scan caught in section 9 below -- checked here
  -- too, and in every other write RPC in this file): the sweep is an unconditional write scoped
  -- to an arbitrary caller-supplied p_org, so it must never run before confirming the caller
  -- belongs to that org AT ALL -- otherwise any authenticated user could force a write against an
  -- org they have no relationship to just by naming it here, before the real per-item
  -- authorization check below even runs.
  if not private.is_org_member(p_org) then
    raise exception 'not a member of this org';
  end if;
  perform private.reopen_stale_inbox_claims(p_org);

  select * into v_item from public.inbox_items where id = p_item_id and org_id = p_org;
  if v_item.id is null then
    raise exception 'inbox item not found';
  end if;
  if not private.can_view_inbox_item(p_org, v_item.target_agent_id, v_item.status) then
    raise exception 'not authorized to view this item';
  end if;

  update public.inbox_items
  set status = 'claimed', claimed_by = auth.uid(), claimed_at = now(), updated_at = now()
  where id = p_item_id and org_id = p_org and status = 'open'
  returning id into v_claimed_id;

  if v_claimed_id is null then
    -- Lost the race (or the item is in a terminal state) -- re-read fresh to give a clean,
    -- correct message rather than a generic failure.
    select status into v_item.status from public.inbox_items where id = p_item_id;
    if v_item.status in ('done', 'dismissed') then
      raise exception 'This item is already %', v_item.status;
    end if;
    select coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), 'a teammate')
    into v_name
    from public.inbox_items i
    left join public.profiles p on p.user_id = i.claimed_by
    where i.id = p_item_id;
    raise exception 'Already claimed by %', v_name;
  end if;

  perform private.log_org_action(p_org, 'inbox_item.claim', 'inbox_item', p_item_id, '{}'::jsonb);
end;
$$;

revoke all on function public.claim_inbox_item(uuid, uuid) from public, anon;
grant execute on function public.claim_inbox_item(uuid, uuid) to authenticated;

create function public.unclaim_inbox_item(p_org uuid, p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.inbox_items;
begin
  -- SECURITY: same org-membership check as claim_inbox_item's own header comment -- must run
  -- before the sweep, not after.
  if not private.is_org_member(p_org) then
    raise exception 'not a member of this org';
  end if;
  perform private.reopen_stale_inbox_claims(p_org);

  select * into v_item from public.inbox_items where id = p_item_id and org_id = p_org;
  if v_item.id is null then
    raise exception 'inbox item not found';
  end if;
  if v_item.status <> 'claimed' then
    raise exception 'item is not currently claimed';
  end if;
  -- "the claimer or a manager+" (requirement #3) -- a manager+'s own authority already implies
  -- visibility (private.can_view_inbox_item), checked explicitly rather than assumed.
  if v_item.claimed_by <> auth.uid()
     and not (
       private.has_org_role(p_org, array['owner', 'admin', 'manager'])
       and private.can_view_inbox_item(p_org, v_item.target_agent_id, v_item.status)
     ) then
    raise exception 'not authorized to unclaim this item';
  end if;

  update public.inbox_items
  set status = 'open', claimed_by = null, claimed_at = null, updated_at = now()
  where id = p_item_id;
end;
$$;

revoke all on function public.unclaim_inbox_item(uuid, uuid) from public, anon;
grant execute on function public.unclaim_inbox_item(uuid, uuid) to authenticated;

create function public.mark_inbox_item_done(p_org uuid, p_item_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.inbox_items;
begin
  -- SECURITY: same org-membership check as claim_inbox_item's own header comment -- must run
  -- before the sweep, not after.
  if not private.is_org_member(p_org) then
    raise exception 'not a member of this org';
  end if;
  perform private.reopen_stale_inbox_claims(p_org);

  select * into v_item from public.inbox_items where id = p_item_id and org_id = p_org;
  if v_item.id is null then
    raise exception 'inbox item not found';
  end if;
  if v_item.status in ('done', 'dismissed') then
    raise exception 'item is already %', v_item.status;
  end if;
  -- "mark done (optional note)" (requirement #3) -- same "claimer or manager+" shape as unclaim.
  if not (
    (v_item.status = 'claimed' and v_item.claimed_by = auth.uid())
    or (
      private.has_org_role(p_org, array['owner', 'admin', 'manager'])
      and private.can_view_inbox_item(p_org, v_item.target_agent_id, v_item.status)
    )
  ) then
    raise exception 'not authorized to close this item';
  end if;

  update public.inbox_items
  set status = 'done', done_at = now(), note = coalesce(p_note, note), updated_at = now()
  where id = p_item_id;

  perform private.log_org_action(p_org, 'inbox_item.done', 'inbox_item', p_item_id, jsonb_build_object('note', p_note));
end;
$$;

revoke all on function public.mark_inbox_item_done(uuid, uuid, text) from public, anon;
grant execute on function public.mark_inbox_item_done(uuid, uuid, text) to authenticated;

create function public.dismiss_inbox_item(p_org uuid, p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.inbox_items;
begin
  -- SECURITY: same org-membership check as claim_inbox_item's own header comment -- must run
  -- before the sweep, not after.
  if not private.is_org_member(p_org) then
    raise exception 'not a member of this org';
  end if;
  perform private.reopen_stale_inbox_claims(p_org);

  select * into v_item from public.inbox_items where id = p_item_id and org_id = p_org;
  if v_item.id is null then
    raise exception 'inbox item not found';
  end if;
  if v_item.status in ('done', 'dismissed') then
    raise exception 'item is already %', v_item.status;
  end if;
  -- "dismiss (manager+)" (requirement #3) -- explicitly excludes a plain agent, even for their
  -- own missed-call item (unlike claim/done/unclaim, which the claimer themselves can also do).
  if not (
    private.has_org_role(p_org, array['owner', 'admin', 'manager'])
    and private.can_view_inbox_item(p_org, v_item.target_agent_id, v_item.status)
  ) then
    raise exception 'not authorized to dismiss this item';
  end if;

  update public.inbox_items
  set status = 'dismissed', dismissed_at = now(), updated_at = now()
  where id = p_item_id;

  perform private.log_org_action(p_org, 'inbox_item.dismiss', 'inbox_item', p_item_id, '{}'::jsonb);
end;
$$;

revoke all on function public.dismiss_inbox_item(uuid, uuid) from public, anon;
grant execute on function public.dismiss_inbox_item(uuid, uuid) to authenticated;

-- =================================================================================================
-- 8. public.set_shared_inbox_settings -- owner/admin only, the settings-table write RPC every
--    other org_*_settings table in this mission already has one of.
-- =================================================================================================

create function public.set_shared_inbox_settings(
  p_org uuid,
  p_shared_inbox_enabled boolean,
  p_claim_stale_minutes int
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    raise exception 'only an owner or admin may change shared inbox settings';
  end if;
  if p_claim_stale_minutes <= 0 then
    raise exception 'claim_stale_minutes must be positive';
  end if;

  update public.org_shared_inbox_settings
  set
    shared_inbox_enabled = p_shared_inbox_enabled,
    claim_stale_minutes = p_claim_stale_minutes,
    updated_at = now()
  where org_id = p_org;
end;
$$;

revoke all on function public.set_shared_inbox_settings(uuid, boolean, int) from public, anon;
grant execute on function public.set_shared_inbox_settings(uuid, boolean, int) to authenticated;

-- =================================================================================================
-- 9. Offboarding cascade fix-forward (requirement/edge case: "a claimer offboarded while holding
--    claims (items return to open)"). A plain `claimed_by ... on delete set null` FK is NOT
--    enough by itself -- offboarding NEVER hard-deletes the auth.users row (org_members.status
--    just flips, same as every other offboard path in this mission), so that FK action would
--    never even fire; and even if it did, it would leave `status='claimed'` with a null
--    `claimed_by` -- an orphaned claimed state, not literally "open" as the task requires. Exposed
--    as its own tiny RPC (called from org-members/index.ts's cascadeOffboard, mirroring
--    endActiveCoachingSessionsForManager's own "called from the cascade, not a trigger" shape --
--    TASK-M5-B2/EC-8) rather than a trigger on org_members, since this only needs to run at the
--    exact moment of a disable/remove action, not on every org_members UPDATE.
--
--    SECURITY (caught by the lead's own scan of this file before it was committed): this takes an
--    arbitrary p_org/p_user_id with no role check of its own, so it must NEVER be callable by an
--    ordinary authenticated user (who could otherwise reopen ANY org's claimed items). It stays a
--    `public.` function only because PostgREST/`supabase.rpc()` can't reach a `private.` one at
--    all (the actual reason this codebase's `private` schema exists in the first place -- see
--    `private.log_org_action`'s own header) -- but it is `revoke all ... from public, anon,
--    authenticated`, with NO grant to `authenticated` added back, same as
--    `public.transition_leg`/`public.claim_next_leads`/`public.apply_leg_outcome`
--    (20260924000800_dialer_rpcs.sql): callable only by the `service_role` client
--    org-members/index.ts's cascadeOffboard already uses, which bypasses grants entirely and
--    needs no internal role check of its own (there is no `auth.uid()`/user JWT in that context
--    to check a role against anyway).
-- =================================================================================================

create function public.reopen_inbox_claims_for_offboarded_member(p_org uuid, p_user_id uuid)
returns int
language sql
security definer
set search_path = ''
as $$
  with reopened as (
    update public.inbox_items
    set status = 'open', claimed_by = null, claimed_at = null, updated_at = now()
    where org_id = p_org and status = 'claimed' and claimed_by = p_user_id
    returning id
  )
  select count(*)::int from reopened;
$$;

revoke all on function public.reopen_inbox_claims_for_offboarded_member(uuid, uuid) from public, anon, authenticated;
