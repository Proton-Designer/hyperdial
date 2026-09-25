/**
 * VMD-1 (TASK-F-T3): upload (and re-fetch a signed preview URL for) a voicemail-drop recording.
 * Not telnyx-/dialer-prefixed -- `requireOrgRole` (not `requireTelnyxOrgRole`) is the right auth
 * helper, same reasoning as every other non-Telnyx-specific settings endpoint (LANE-eng2's own
 * TASK-P1-05 note: `requireOrgRole` explicitly excludes `telnyx-*`/`dialer-*`, which don't apply
 * here -- this endpoint doesn't touch Telnyx at all).
 *
 * Two operations on one endpoint (keeps this a single new function, matching the task's own file
 * list) -- `?scope=self|org` selects WHICH row:
 * - POST, raw audio body (Content-Type: audio/mpeg or audio/wav, <=5MB): validates type/size,
 *   uploads to the private `voicemail-drops` bucket, upserts `voicemail_drop_settings`, returns a
 *   freshly-minted signed URL for immediate playback preview.
 * - GET: returns a freshly-minted signed URL for whatever is ALREADY stored at that scope, or 404
 *   if nothing is set yet -- lets Settings re-render a preview player on a later page load
 *   without re-uploading (the bucket is private, same "RLS enabled + zero policies = deny all
 *   except service_role" shape as `recordings`, live-verified in TASK-F-T2 -- no direct client
 *   read exists).
 *
 * Auth: `scope=self` -- any org member, only their own row. `scope=org` -- read allowed for any
 * org member (RLS's own wording: "members read... the org default"); write requires owner/admin.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import {
  MAX_VOICEMAIL_DROP_UPLOAD_BYTES,
  VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS,
  voicemailAudioExtensionForContentType,
  voicemailDropStoragePath,
} from '../_shared/voicemail-core.ts';

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const {
    user,
    orgId,
    role,
    error: authError,
  } = await requireOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  const url = new URL(req.url);
  const scope = url.searchParams.get('scope');
  if (scope !== 'self' && scope !== 'org') {
    return jsonResponse(400, { error: "scope must be 'self' or 'org'" });
  }
  const isOrgDefault = scope === 'org';
  const isAdmin = role === 'owner' || role === 'admin';
  if (isOrgDefault && req.method === 'POST' && !isAdmin) {
    return jsonResponse(403, { error: 'Only an owner or admin can set the org default.' });
  }

  const supabase = getSupabaseAdmin();
  const targetUserId = isOrgDefault ? null : user.id;

  if (req.method === 'GET') {
    let query = supabase.from('voicemail_drop_settings').select('storage_path').eq('org_id', orgId);
    query = targetUserId === null ? query.is('user_id', null) : query.eq('user_id', targetUserId);
    const { data: row, error: rowError } = await query.maybeSingle();
    if (rowError) return jsonResponse(500, { error: rowError.message });
    if (!row?.storage_path) return jsonResponse(404, { error: 'No voicemail drop set.' });

    const { data: signed, error: signError } = await supabase.storage
      .from('voicemail-drops')
      .createSignedUrl(row.storage_path, VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS);
    if (signError || !signed?.signedUrl) {
      return jsonResponse(500, { error: signError?.message ?? 'Failed to create signed URL' });
    }
    return jsonResponse(200, {
      path: row.storage_path,
      url: signed.signedUrl,
      expiresInSeconds: VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS,
    });
  }

  // POST: a real upload.
  const contentType = req.headers.get('Content-Type') ?? '';
  const ext = voicemailAudioExtensionForContentType(contentType);
  if (!ext) {
    return jsonResponse(400, { error: 'Content-Type must be audio/mpeg or audio/wav.' });
  }
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) {
    return jsonResponse(400, { error: 'Empty upload body.' });
  }
  if (bytes.byteLength > MAX_VOICEMAIL_DROP_UPLOAD_BYTES) {
    return jsonResponse(400, { error: 'File exceeds the 5MB limit.' });
  }

  const path = voicemailDropStoragePath(orgId, targetUserId, ext);
  const { error: uploadError } = await supabase.storage
    .from('voicemail-drops')
    .upload(path, bytes, { contentType, upsert: true });
  if (uploadError) return jsonResponse(500, { error: uploadError.message });

  // Manual select-then-insert-or-update, not `.upsert({onConflict})` -- the migration's two
  // unique indexes are PARTIAL (one per NULL-vs-not-NULL user_id), and PostgREST's onConflict
  // can only infer a plain (non-partial) unique index/constraint from a column list.
  let existingQuery = supabase.from('voicemail_drop_settings').select('id').eq('org_id', orgId);
  existingQuery =
    targetUserId === null
      ? existingQuery.is('user_id', null)
      : existingQuery.eq('user_id', targetUserId);
  const { data: existing, error: existingError } = await existingQuery.maybeSingle();
  if (existingError) return jsonResponse(500, { error: existingError.message });

  const settingsError = existing
    ? (
        await supabase
          .from('voicemail_drop_settings')
          .update({ storage_path: path, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
      ).error
    : (
        await supabase
          .from('voicemail_drop_settings')
          .insert({ org_id: orgId, user_id: targetUserId, storage_path: path })
      ).error;
  if (settingsError) return jsonResponse(500, { error: settingsError.message });

  const { data: signed, error: signError } = await supabase.storage
    .from('voicemail-drops')
    .createSignedUrl(path, VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS);
  if (signError || !signed?.signedUrl) {
    return jsonResponse(500, { error: signError?.message ?? 'Failed to create signed URL' });
  }
  return jsonResponse(200, {
    path,
    url: signed.signedUrl,
    expiresInSeconds: VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS,
  });
});
