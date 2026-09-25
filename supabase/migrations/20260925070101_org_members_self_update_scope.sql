-- TASK-I1 security fix-forward: close a privilege-escalation gap in the self-service RLS
-- policy added by 20260925070100_inbound_routing.sql ("member can update own heartbeat and
-- forward number"). Caught by a background security review before deploy, not by eng1's own
-- review yet (this migration runs ahead of it as a fix-forward, same shape as N1's).
--
-- The bug: that policy's USING/WITH CHECK are both just `user_id = auth.uid()` -- it restricts
-- WHICH ROW an unprivileged member may touch, but nothing restricts WHICH COLUMNS. Since RLS
-- policies for the same command are combined with OR, this policy is a second, independent path
-- into `org_members` alongside the existing "owner or admin can update non-owner members"
-- policy (20260924000100) -- and unlike that one, it has no role check and no column scope at
-- all. Any authenticated member (agent, not just admin/owner) could `PATCH
-- /rest/v1/org_members?user_id=eq.<self>&org_id=eq.<their org>` with `{"role": "owner"}` (or
-- flip their own `status`, or overwrite `telnyx_credential_id`) and it would pass this policy's
-- own check, self-promoting to owner -- a full compromise of the tenancy model, not a narrow
-- bug. Not yet deployed (caught before the lead's dry-run/deploy step), but migrations in this
-- repo are append-only from the moment they're committed, per the N1 fix-forward's own
-- precedent -- fixed here as a new migration, not by editing 20260925070100 in place.
--
-- The fix mirrors the EXISTING, already-reviewed pattern for exactly this shape of problem:
-- `private.enforce_agent_contact_update_scope()` (20260924001300_contacts_e164_tz_dnc.sql) locks
-- an unprivileged actor's UPDATE to an explicit allowlist of columns via a BEFORE trigger (RLS
-- itself has no column-level primitive -- WITH CHECK only ever sees the post-update row, never
-- OLD, so "did column X change" can only be enforced in a trigger). Same allowlist-via-denylist
-- shape (`to_jsonb(new) - <allowed columns> is distinct from to_jsonb(old) - <allowed columns>`,
-- so a future org_members column is column-locked by default instead of silently becoming
-- member-writable), same `auth.role() is distinct from 'authenticated'` exemption for
-- service-role/backend writes (org_members.telnyx_credential_id is written by
-- `_shared/agent-webrtc-credential.ts` via the service-role client -- see its own file), and the
-- same owner/admin exemption so the pre-existing "owner or admin can update non-owner members"
-- policy's legitimate role/status changes are completely unaffected by this trigger.

create function private.enforce_org_members_self_update_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  if private.has_org_role(new.org_id, array['owner', 'admin']) then
    return new;
  end if;

  -- Anyone else matching the row (the member themselves, per the "member can update own
  -- heartbeat and forward number" policy) may only change these two self-service columns.
  if (to_jsonb(new) - 'forward_phone_number' - 'last_seen_at')
     is distinct from (to_jsonb(old) - 'forward_phone_number' - 'last_seen_at') then
    raise exception 'org_members: self-service update may only change forward_phone_number/last_seen_at'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger org_members_self_update_scope
before update on public.org_members
for each row execute function private.enforce_org_members_self_update_scope();
