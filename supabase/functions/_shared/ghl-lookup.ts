/**
 * TASK-G32 (audit G23 F3): look up CSV-imported (unlinked) contacts in GHL by phone before their first dial,
 * so a person already set to Do Not Disturb there is seen by the reconcile. Never creates anything in GHL.
 *
 * Per org per reconcile tick: claim a small batch of unlinked, non-DNC contacts that still have a queued/callback
 * lead (`claim_ghl_lookup_batch`, oldest-looked-up first, stamps ghl_lookup_at), search GHL for each phone
 * (`GET /contacts/?query=<e164>`, the same endpoint ghl-import's search mode uses), keep only results whose own phone
 * normalises to the same E.164, and then:
 *   exactly one match  -> link (`link_ghl_contacts`); the caller reads that contact in the same tick
 *   no match           -> nothing; the stamp stays, so it is searched again only after the recheck window (72 h)
 *   several matches    -> NOT linked (we cannot tell which person it is); logged, stamp stays
 * The same lease rules as G16/G19/G25 apply: deadline-aware, rows not searched are handed back, transient search errors are
 * handed back (capped unless most of the batch failed).
 *
 * Source: raw GHL OpenAPI contacts.json `get-contacts` (GET /contacts/, params locationId, query, limit; scope
 * contacts.readonly; deprecated in favour of POST /contacts/search but it is what the rest of this codebase uses). The
 * alternative `GET /contacts/search/duplicate?number=` returns ONE contact only, so "several matches" could not be detected.
 * UNVERIFIED live: whether `query` matches a phone given as E.164 (it is documented only as "Contact Query").
 */
import type { GhlClient, GhlContact } from './ghl-client.ts';
import { normalizePhoneStrict } from './phone-normalize.ts';
import { isTransientReadError, transientReleaseCap } from './ghl-reconcile.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

/** GHL contacts of a search result whose own phone is `e164` (compared after normalising both sides). */
export function matchGhlContactsByPhone(contacts: GhlContact[], e164: string): GhlContact[] {
  const seen = new Set<string>();
  const out: GhlContact[] = [];
  for (const c of contacts) {
    if (!c || typeof c.id !== 'string' || seen.has(c.id)) continue;
    const phone = typeof c.phone === 'string' ? normalizePhoneStrict(c.phone)?.e164 : undefined;
    if (phone === e164) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

export interface LookupResult {
  claimed: number;
  /** contacts newly linked to a GHL contact this tick */
  linked: number;
  noMatch: number;
  /** several GHL contacts share the phone: not linked */
  ambiguous: number;
  /** the matching GHL contact is already linked to another HyperDial contact */
  conflicts: number;
  errors: number;
  /** stamps handed back (not searched before the deadline / transient errors) */
  released: number;
  deadlineHit: boolean;
}

export interface LinkedRow {
  contact_id: string;
  ghl_contact_id: string;
  prev_reconciled_at: null;
}

interface ClaimedLookup {
  contact_id: string;
  phone_number: string | null;
  prev_lookup_at: string | null;
}

export const emptyLookupResult = (): LookupResult => ({
  claimed: 0,
  linked: 0,
  noMatch: 0,
  ambiguous: 0,
  conflicts: 0,
  errors: 0,
  released: 0,
  deadlineHit: false,
});

export async function lookupUnlinkedContacts(
  supabase: SupabaseAny,
  client: GhlClient,
  args: { orgId: string; locationId: string; batchSize: number; deadlineMs?: number }
): Promise<{ result: LookupResult; linked: LinkedRow[] }> {
  const result = emptyLookupResult();
  const linkedRows: LinkedRow[] = [];
  if (args.batchSize <= 0) return { result, linked: linkedRows };
  if (args.deadlineMs !== undefined && Date.now() > args.deadlineMs) {
    result.deadlineHit = true;
    return { result, linked: linkedRows };
  }

  const { data, error } = await supabase.rpc('claim_ghl_lookup_batch', {
    p_org: args.orgId,
    p_limit: args.batchSize,
  });
  if (error) throw new Error(`claim_ghl_lookup_batch failed: ${error.message}`);
  const batch = (data ?? []) as ClaimedLookup[];
  result.claimed = batch.length;

  const releasedIds = new Set<string>();
  const release = async (rows: ClaimedLookup[]) => {
    const todo = rows.filter((r) => !releasedIds.has(r.contact_id));
    if (todo.length === 0) return;
    for (const r of todo) releasedIds.add(r.contact_id);
    result.released += todo.length;
    const { error: relError } = await supabase.rpc('release_ghl_lookup_leases', {
      p_org: args.orgId,
      p_items: todo.map((r) => ({ contact_id: r.contact_id, prev_lookup_at: r.prev_lookup_at })),
    });
    if (relError) console.warn(`[ghl-lookup] lease release failed: ${relError.message}`);
  };

  const toLink: { contact_id: string; ghl_contact_id: string }[] = [];
  const transientErrors: ClaimedLookup[] = [];
  for (let i = 0; i < batch.length; i++) {
    const row = batch[i];
    if (args.deadlineMs !== undefined && Date.now() > args.deadlineMs) {
      result.deadlineHit = true;
      await release(batch.slice(i));
      break;
    }
    const e164 = row.phone_number ? normalizePhoneStrict(row.phone_number)?.e164 : undefined;
    if (!e164) {
      result.noMatch++;
      continue;
    }
    try {
      const res = await client.searchContacts({
        locationId: args.locationId,
        query: e164,
        limit: 20,
      });
      const matches = matchGhlContactsByPhone(res.contacts, e164);
      if (matches.length === 1)
        toLink.push({ contact_id: row.contact_id, ghl_contact_id: matches[0].id });
      else if (matches.length === 0) result.noMatch++;
      else {
        result.ambiguous++;
        console.warn(
          `[ghl-lookup] ${matches.length} GHL contacts share the phone of contact ${row.contact_id} (org ${args.orgId}): not linked`
        );
      }
    } catch (err) {
      result.errors++;
      if (isTransientReadError(err)) transientErrors.push(row);
      console.warn(`[ghl-lookup] search for contact ${row.contact_id} failed`, err);
    }
  }

  if (transientErrors.length > 0) {
    const attempted = batch.length - result.noMatch - result.ambiguous - toLink.length;
    const outage = transientErrors.length * 2 >= Math.max(attempted, 1);
    await release(
      outage ? transientErrors : transientErrors.slice(0, transientReleaseCap(args.batchSize))
    );
  }

  if (toLink.length > 0) {
    const { data: linkData, error: linkError } = await supabase.rpc('link_ghl_contacts', {
      p_org: args.orgId,
      p_items: toLink,
    });
    if (linkError) {
      // nothing was linked: hand the stamps back so they are searched again next tick
      await release(batch.filter((r) => toLink.some((l) => l.contact_id === r.contact_id)));
      throw new Error(`link_ghl_contacts failed: ${linkError.message}`);
    }
    const out = (linkData ?? {}) as { linked?: number; conflicts?: number; linked_ids?: string[] };
    result.linked = Number(out.linked ?? 0);
    result.conflicts = Number(out.conflicts ?? 0);
    // only the contacts the RPC really linked are read by the caller (a conflict or a lost race is skipped by the RPC)
    const ids = new Set(out.linked_ids ?? []);
    for (const l of toLink) {
      if (ids.has(l.contact_id)) {
        linkedRows.push({
          contact_id: l.contact_id,
          ghl_contact_id: l.ghl_contact_id,
          prev_reconciled_at: null,
        });
      }
    }
  }
  return { result, linked: linkedRows };
}
