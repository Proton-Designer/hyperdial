-- MISSION-5 TASK-M5-T3: exact count in the territory reassign warning. T2 (ed5295f) only shows a
-- plain mode-level warning ("round-robin's fair distribution will be disturbed") when reassign is
-- checked, because preview_territory_rules doesn't break out "already assigned to someone else"
-- per target. D2's count_reassign_impact can't be reused either -- it takes ONE target agent for
-- the whole batch, but territory resolution can send each lead to a DIFFERENT agent. Investigated
-- and stopped per the task's own instruction ("if that needs a migration, stop and report first");
-- full investigation in audit/M5-T3/notes.md. Design APPROVED by the lead verbatim (see
-- RESUME_PLAN-eng1.md), with one addition folded in: harden the missing revoke on
-- resolve_territory_assignments' original 3-arg signature (unrelated finding from the same
-- investigation, safe to fold in since it's a one-line addition to the same migration).
--
-- =================================================================================================
-- 1. Hardening (unrelated to the count RPC, folded in per the lead's instruction):
--    private.resolve_territory_assignments(uuid, uuid, boolean) -- the ORIGINAL 3-arg signature
--    (20260927224036_territory_rules.sql) -- has no explicit revoke anywhere, so it still carries
--    Postgres' default PUBLIC-execute grant. Only the LATER 4-arg overload
--    (20260928111616_round_robin_distribution.sql) was explicitly revoked from
--    public/anon/authenticated -- confirmed that overload's own revoke already covers
--    'authenticated' too, so no further check needed there. Every real caller of the 3-arg form is
--    itself SECURITY DEFINER (preview_territory_rules, apply_territory_rules, and now
--    count_territory_reassign_impact below), so this changes no live behavior -- it only closes a
--    grant that was never meant to be open. `private` isn't in config.toml's exposed PostgREST
--    schemas, so no client SDK call could reach it today regardless; this just brings the
--    signature in line with the repo's own stated convention.
-- =================================================================================================

revoke all on function private.resolve_territory_assignments(uuid, uuid, boolean) from public, anon, authenticated;

-- =================================================================================================
-- 2. public.count_territory_reassign_impact(p_campaign_id, p_reassign default false) returns int --
--    same role gate as preview_territory_rules/apply_territory_rules (owner/admin/manager may
--    call; p_reassign=true is owner/admin only). Mirrors what apply_territory_rules would ACTUALLY
--    touch at the individual-lead level (audit/M5-T3/notes.md, points 1-4), not just what
--    territory resolution alone found:
--      - resolved_agent_id is not null            (point 1: unmatched leads never move)
--      - current assigned_agent_id is not null
--        and is distinct from resolved_agent_id    (a real move to a DIFFERENT owner, not a no-op)
--      - current owner in caller's pod scope        (point 3: otherwise assign_campaign_leads' own
--                                                     per-lead candidate filter would silently
--                                                     skip it even though the group succeeds)
--      - resolved target in caller's pod scope       (point 2: otherwise the whole group would be
--                                                     caught and skipped by
--                                                     resolve_campaign_assign_access's own gate)
--    No separate active-member re-check on resolved_agent_id needed -- resolve_territory_
--    assignments' own agent_target/pod_pool CTEs already filter to active org_members only
--    (notes.md point 4), so a resolved target can never fail that re-check in practice.
-- =================================================================================================

create function public.count_territory_reassign_impact(p_campaign_id uuid, p_reassign boolean default false)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_count int;
begin
  select org_id into v_org_id from public.campaigns where id = p_campaign_id;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;
  if not (
    private.has_org_role(v_org_id, array['owner', 'admin'])
    or private.has_org_role(v_org_id, array['manager'])
  ) then
    raise exception 'only an owner, admin, or manager can preview territory rules';
  end if;
  if p_reassign and not private.has_org_role(v_org_id, array['owner', 'admin']) then
    raise exception 'only an owner or admin can reassign already-assigned leads';
  end if;

  select count(*) into v_count
  from private.resolve_territory_assignments(v_org_id, p_campaign_id, p_reassign) r
  join public.campaign_leads cl on cl.id = r.lead_id
  where r.resolved_agent_id is not null
    and cl.assigned_agent_id is not null
    and cl.assigned_agent_id is distinct from r.resolved_agent_id
    and private.is_agent_in_callers_pod_scope(v_org_id, cl.assigned_agent_id)
    and private.is_agent_in_callers_pod_scope(v_org_id, r.resolved_agent_id);

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.count_territory_reassign_impact(uuid, boolean) from public, anon;
grant execute on function public.count_territory_reassign_impact(uuid, boolean) to authenticated;
