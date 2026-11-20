/**
 * TASK-H37: read-only public Calls API for an org's own scripts (server-to-server; no CORS, GET only).
 * Auth is the x-api-key header (sha256 looked up in org_api_keys, see 20261120*_h37_*.sql); deploy with --no-verify-jwt.
 * All logic is in _shared/public-api-core.ts.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  RATE_LIMIT_PER_MINUTE,
  SIGNED_URL_TTL_SECONDS,
  handlePublicApi,
  type CallRow,
  type KeyCheck,
} from '../_shared/public-api-core.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

Deno.serve((req: Request) =>
  handlePublicApi(req, {
    async checkKey(keyHash) {
      const { data, error } = await admin.rpc('public_api_check_key', {
        p_key_hash: keyHash,
        p_limit: RATE_LIMIT_PER_MINUTE,
      });
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as KeyCheck | undefined;
      return row ?? null;
    },
    async listCalls(a) {
      const { data, error } = await admin.rpc('public_api_list_calls', {
        p_org: a.orgId,
        p_since: a.since,
        p_after_ended_at: a.afterEndedAt,
        p_after_id: a.afterId,
        p_limit: a.limit,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as CallRow[];
    },
    async signUrl(path) {
      const { data, error } = await admin.storage
        .from('recordings')
        .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) return null;
      return data.signedUrl;
    },
  })
);
