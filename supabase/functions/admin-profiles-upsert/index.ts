// TASK-S03: POST { userId, ghlContactId?: string | null, participates?: boolean } -> { member }.
// Only the keys present are changed; a GHL contact id can belong to one member per org.
import {
  handleAdminPost,
  jsonResponse,
  rpcErrorResponse,
  shiftsError,
} from '../_shared/shifts-io.ts';
import { mapAdminMember, parseMemberBody, type MemberRow } from '../_shared/shifts-admin.ts';

Deno.serve((req) =>
  handleAdminPost(req, 'admin-profiles-upsert', async (ctx, body) => {
    const parsed = parseMemberBody(body);
    if (!parsed.ok) return shiftsError(parsed.code, parsed.detail);
    const b = parsed.value;
    const { data, error } = await ctx.supabase.rpc('admin_upsert_shift_member', {
      p_org: ctx.orgId,
      p_actor: ctx.userId,
      p_user: b.userId,
      p_set_contact: b.setContact,
      p_contact: b.contact,
      p_set_participates: b.setParticipates,
      p_participates: b.participates,
    });
    if (error) return rpcErrorResponse(error, 'admin_upsert_shift_member');
    return jsonResponse(200, { member: mapAdminMember(data as MemberRow) });
  })
);
