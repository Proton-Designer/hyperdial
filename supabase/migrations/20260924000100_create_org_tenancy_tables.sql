-- Tenancy foundation (1/3): org core tables, RLS helpers, signup trigger.
-- See docs/design/stage-1-architecture.md §2. Existing tables gain org_id in the next migration;
-- this one only adds new tables so it is safe to apply against the legacy single-tenant schema.

create schema if not exists private;
-- A freshly created schema grants USAGE to nobody but its owner by default (unlike `public`).
-- `authenticated` needs it to even resolve `private.is_org_member(...)` from inside a policy --
-- EXECUTE on the function alone is not enough without USAGE on its schema.
grant usage on schema private to authenticated;
revoke all on schema private from public, anon;

-- orgs ------------------------------------------------------------------

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

-- org_members -------------------------------------------------------------

create table public.org_members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'agent')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  telnyx_credential_id text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index idx_org_members_user_id on public.org_members(user_id);

-- org_invites ---------------------------------------------------------------

create table public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'agent')),
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_org_invites_org_id on public.org_invites(org_id);
create index idx_org_invites_email on public.org_invites(email);

-- profiles --------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  first_name text,
  last_name text,
  active_org_id uuid references public.orgs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS helpers (private schema, not exposed via PostgREST) -----------------
--
-- Both are SECURITY DEFINER, owned by the migration role (table owner), so they bypass RLS on
-- org_members when they query it. That is what makes it safe to call them from org_members' own
-- policies below without recursion -- the alternative, an inline `... IN (SELECT ... FROM
-- org_members ...)` subquery directly in a policy, would re-evaluate org_members' RLS while
-- evaluating org_members' RLS. See the invariant in TASK-P1-01: no policy has an inline subquery
-- on org_members.

create function private.is_org_member(org uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.org_members m
    where m.org_id = org
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create function private.has_org_role(org uuid, roles text[])
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.org_members m
    where m.org_id = org
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role = any(roles)
  );
$$;

grant execute on function private.is_org_member(uuid) to authenticated;
grant execute on function private.has_org_role(uuid, text[]) to authenticated;

-- private.ensure_org_for_user: shared by the signup trigger below and the one-time backfill in
-- the next migration. Idempotent: a user who already has an active_org_id is returned as-is.

create function private.ensure_org_for_user(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_meta jsonb;
  v_email text;
  v_org_name text;
begin
  select active_org_id into v_org_id from public.profiles where user_id = p_user_id;
  if v_org_id is not null then
    return v_org_id;
  end if;

  select raw_user_meta_data, email into v_meta, v_email from auth.users where id = p_user_id;

  v_org_name := nullif(trim(both from (v_meta ->> 'company_name')), '');
  if v_org_name is null and v_email is not null and position('@' in v_email) > 0 then
    v_org_name := split_part(v_email, '@', 2);
  end if;
  if v_org_name is null or v_org_name = '' then
    v_org_name := 'My Team';
  end if;

  insert into public.orgs (name, created_by)
  values (v_org_name, p_user_id)
  returning id into v_org_id;

  insert into public.org_members (org_id, user_id, role, status)
  values (v_org_id, p_user_id, 'owner', 'active')
  on conflict (org_id, user_id) do nothing;

  insert into public.profiles (user_id, first_name, last_name, active_org_id)
  values (
    p_user_id,
    nullif(v_meta ->> 'first_name', ''),
    nullif(v_meta ->> 'last_name', ''),
    v_org_id
  )
  on conflict (user_id) do update
    set active_org_id = excluded.active_org_id
    where public.profiles.active_org_id is null;

  return v_org_id;
end;
$$;

-- New-signup trigger ------------------------------------------------------
--
-- Contract for TASK-P1-02 / TASK-P1-03 (accept-invite, invite-flow signup UI): pass the invite
-- token through auth signup metadata as `invite_token`. When present, this trigger creates only
-- the profile (no org, no membership) -- accept-invite is expected to insert the org_members row
-- for the invited org/role and set profiles.active_org_id once the invite is verified. When
-- absent, this trigger runs the normal self-serve path: new org, owner membership, profile.

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.raw_user_meta_data ->> 'invite_token') is null then
    perform private.ensure_org_for_user(new.id);
  else
    insert into public.profiles (user_id, first_name, last_name)
    values (
      new.id,
      nullif(new.raw_user_meta_data ->> 'first_name', ''),
      nullif(new.raw_user_meta_data ->> 'last_name', '')
    )
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS: orgs -----------------------------------------------------------------
-- No INSERT policy: orgs are created only by ensure_org_for_user (signup trigger / backfill),
-- which runs SECURITY DEFINER and bypasses RLS. Self-serve "create another org" is not a Stage 1
-- feature; add a policy (or a dedicated function) if that changes.

alter table public.orgs enable row level security;

create policy "org members can view their org"
  on public.orgs for select
  using (private.is_org_member(id));

create policy "owner can update their org"
  on public.orgs for update
  using (private.has_org_role(id, array['owner']))
  with check (private.has_org_role(id, array['owner']));

create policy "owner can delete their org"
  on public.orgs for delete
  using (private.has_org_role(id, array['owner']));

-- RLS: org_members ------------------------------------------------------
-- Owner rows are managed only by the signup trigger / ensure_org_for_user (ownership transfer is
-- a Stage 2 feature); owner/admin can manage non-owner rows.

alter table public.org_members enable row level security;

create policy "org members can view roster"
  on public.org_members for select
  using (private.is_org_member(org_id));

create policy "owner or admin can add non-owner members"
  on public.org_members for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']) and role <> 'owner');

create policy "owner or admin can update non-owner members"
  on public.org_members for update
  using (private.has_org_role(org_id, array['owner', 'admin']) and role <> 'owner')
  with check (private.has_org_role(org_id, array['owner', 'admin']) and role <> 'owner');

create policy "owner or admin can remove non-owner members"
  on public.org_members for delete
  using (private.has_org_role(org_id, array['owner', 'admin']) and role <> 'owner');

-- RLS: org_invites ------------------------------------------------------

alter table public.org_invites enable row level security;

create policy "owner or admin can view invites"
  on public.org_invites for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can create invites"
  on public.org_invites for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update invites"
  on public.org_invites for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can delete invites"
  on public.org_invites for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- RLS: profiles -----------------------------------------------------------
-- Personal, not org-shared: a user reads/writes only their own profile. Team-roster name lookups
-- for other members go through an org-scoped Edge Function (TASK-P1-02), not a direct client
-- SELECT across users.

alter table public.profiles enable row level security;

create policy "users can view own profile"
  on public.profiles for select
  using (user_id = auth.uid());

create policy "users can insert own profile"
  on public.profiles for insert
  with check (user_id = auth.uid());

create policy "users can update own profile"
  on public.profiles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
