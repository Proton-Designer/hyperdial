/**
 * TASK-H03: "Log Close" submit. POST { contactId, ownerName, businessName, mobile, email?, services[], cities[],
 * frequencies[], insured, bestContact?, startingPrice?, capacity?, yearsInBusiness? }
 *   -> { closeId, deduped, deliveryStatus: 'pending'|'sent'|'failed'|'not_configured' }
 * The RPC runs as the CALLER (user JWT + anon key) so auth.uid() and the contacts trigger see the real agent; it
 * inserts the close, marks the contact Closed and queues the GHL tag in one transaction. The webhook delivery is then
 * attempted once right away (service role); failures stay 'pending' for the 5-minute sweep (close-delivery-worker).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import { runCloseDeliveries } from '../_shared/close-delivery-run.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CloseBody {
  contactId?: unknown;
  ownerName?: unknown;
  businessName?: unknown;
  mobile?: unknown;
  email?: unknown;
  services?: unknown;
  cities?: unknown;
  frequencies?: unknown;
  insured?: unknown;
  bestContact?: unknown;
  startingPrice?: unknown;
  capacity?: unknown;
  yearsInBusiness?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
const num = (v: unknown): number | null | undefined =>
  v === null || v === undefined || v === ''
    ? null
    : typeof v === 'number' && Number.isFinite(v)
      ? v
      : undefined;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  // Managers are not admitted: the RPC's contact_read_access gate only covers owner/admin/assigned agent.
  const { error: authError } = await requireOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  const parsed = await readJsonBody<CloseBody>(req);
  if (parsed.errorResponse) return parsed.errorResponse;
  const b = parsed.body;

  const contactId = str(b.contactId);
  const services = strArray(b.services);
  const cities = strArray(b.cities);
  const frequencies = strArray(b.frequencies);
  const price = num(b.startingPrice);
  const capacity = num(b.capacity);
  const years = num(b.yearsInBusiness);
  if (!contactId || !UUID_RE.test(contactId))
    return jsonResponse({ error: 'contactId is required' }, 400);
  if (!services || !cities || !frequencies) {
    return jsonResponse({ error: 'services, cities and frequencies must be arrays of text' }, 400);
  }
  if (typeof b.insured !== 'boolean')
    return jsonResponse({ error: 'insured must be true or false' }, 400);
  if (price === undefined || capacity === undefined || years === undefined) {
    return jsonResponse({ error: 'price, capacity and years must be numbers' }, 400);
  }
  if (capacity !== null && !Number.isInteger(capacity))
    return jsonResponse({ error: 'capacity must be a whole number' }, 400);
  if (years !== null && !Number.isInteger(years))
    return jsonResponse({ error: 'years must be a whole number' }, 400);

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
  const { data, error } = await userClient.rpc('log_contact_close', {
    p_contact_id: contactId,
    p_owner_name: str(b.ownerName) ?? '',
    p_business_name: str(b.businessName) ?? '',
    p_mobile: str(b.mobile) ?? '',
    p_email: str(b.email),
    p_services: services,
    p_cities: cities,
    p_frequencies: frequencies,
    p_insured: b.insured,
    p_best_contact: str(b.bestContact),
    p_starting_price: price,
    p_capacity: capacity,
    p_years_in_business: years,
  });
  if (error) {
    // 22023 = validation message written for the form; 42501/P0002 = not allowed / not found.
    const status =
      error.code === '22023'
        ? 400
        : error.code === '42501'
          ? 403
          : error.code === 'P0002'
            ? 404
            : 500;
    if (status === 500) console.error('[log-contact-close] rpc failed', error);
    return jsonResponse(
      { error: status === 500 ? 'Could not save the close' : error.message },
      status
    );
  }
  const row = Array.isArray(data) ? data[0] : data;
  const closeId = row?.close_id as string | undefined;
  if (!closeId) return jsonResponse({ error: 'Could not save the close' }, 500);

  let deliveryStatus = row.delivery_status as string;
  if (deliveryStatus === 'pending' && row.deduped !== true) {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const attempt = runCloseDeliveries(admin, { limit: 1, closeId })
      .then((t) => t)
      .catch((err) => {
        console.error('[log-contact-close] immediate delivery failed', closeId, err);
        return null;
      });
    // Never make the intern wait on the receiver: the response goes out now, the attempt finishes in the background.
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(attempt);
    else await attempt;
  }
  return jsonResponse({ closeId, deduped: row.deduped === true, deliveryStatus });
});
