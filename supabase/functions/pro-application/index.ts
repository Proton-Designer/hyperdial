/**
 * TASK-H29: PUBLIC pro form endpoint (no login; deploy with --no-verify-jwt, see config.toml).
 *   GET  ?token=<64 hex>  -> { orgName, serviceCategories }            404 { error } for anything else (no detail)
 *   POST { token, ownerName, businessName, mobile, email?, services[], cities[], frequencies[], insured,
 *          bestContact?, startingPrice?, capacity?, yearsInBusiness?, website? (honeypot) }
 *        -> 200 { ok: true } | 400 { error } (readable field message) | 404 { error } | 429 { error } | 500 { error }
 * Nothing but the two GET fields is ever read back from the database, and the answer never says whether the number or
 * business already exists. Everything goes through the service-only RPCs get_pro_form_info / submit_pro_application:
 * the table, the rate limits (5/hour per hashed IP, 30/hour per link) and the value validation live there. The raw IP
 * is hashed here (HMAC, secret PRO_FORM_IP_SALT, falling back to the service key) and only the hash leaves this file.
 * A honeypot hit gets the same 200 as a real success and no database call.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  MAX_BODY_BYTES,
  PRO_TOKEN_RE,
  clientIp,
  hashIp,
  parseProApplicationBody,
  submitResponse,
} from '../_shared/pro-application.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const notFound = () => json({ error: 'Not found' }, 404);

function adminClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('token') ?? '';
    if (!PRO_TOKEN_RE.test(token)) return notFound();
    const { data, error } = await adminClient().rpc('get_pro_form_info', { p_token: token });
    if (error) {
      console.error('[pro-application] info failed', error.code);
      return json({ error: 'Something went wrong' }, 500);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return notFound();
    return json({
      orgName: row.org_name as string,
      serviceCategories: (row.service_categories as string[] | null) ?? [],
    });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return json({ error: 'Invalid request' }, 413);
  let raw: unknown;
  try {
    const bodyText = await req.text();
    if (bodyText.length > MAX_BODY_BYTES) return json({ error: 'Invalid request' }, 413);
    raw = JSON.parse(bodyText);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  const parsed = parseProApplicationBody(raw);
  if (parsed.kind === 'honeypot') return json({ ok: true }); // look like a success, store nothing
  if (parsed.kind === 'bad') return json({ error: parsed.error }, 400);
  const input = parsed.input;
  if (!PRO_TOKEN_RE.test(input.token)) return notFound();

  const salt = Deno.env.get('PRO_FORM_IP_SALT') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const ipHash = await hashIp(clientIp(req.headers), salt);

  const { data, error } = await adminClient().rpc('submit_pro_application', {
    p_token: input.token,
    p_ip_hash: ipHash,
    p_owner_name: input.ownerName,
    p_business_name: input.businessName,
    p_mobile: input.mobile,
    p_email: input.email,
    p_services: input.services,
    p_cities: input.cities,
    p_frequencies: input.frequencies,
    p_insured: input.insured,
    p_best_contact: input.bestContact,
    p_starting_price: input.startingPrice,
    p_capacity: input.capacity,
    p_years_in_business: input.yearsInBusiness,
  });
  if (error) {
    console.error('[pro-application] submit failed', error.code);
    const out = submitResponse(undefined, null);
    return json(out.body, out.status);
  }
  const row = Array.isArray(data) ? data[0] : data;
  const out = submitResponse(row?.status as string | undefined, row?.message as string | null);
  return json(out.body, out.status);
});
