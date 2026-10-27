import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { AuthProvider } from '../contexts/AuthContext';
import { OrgProvider } from '../contexts/OrgContext';
import { ImportContactsModal } from '../components/contacts/ImportContactsModal';
import { AddExistingContactsModal } from '../components/campaigns/AddExistingContactsModal';
import { ContactDetailModal } from '../components/contacts/ContactDetailModal';
import type { Contact } from '@/lib/api';

/**
 * TASK-H01: the REAL ImportContactsModal / ContactDetailModal against fixtures, no live network/DB.
 * `?dev_contact_import=1`, plus `&view=import` (default), `&view=detail` or (TASK-H02) `&view=bulk` (the bulk add-to-campaign modal; the stubbed
 * RPC counts the fixture contacts, `&scenario=capped` makes it report the cap):
 *   import  upload any .csv; the stubbed parse call proposes City, Phone and Name columns and leaves the rest unmatched
 *           (they default to "New custom field"); `&scenario=capped` makes the stubbed import report columns skipped at the cap.
 *   detail  a contact with city + custom values, owner role.
 */
const ORG = 'dev-fixture-org';
const USER = 'dev-fixture-user';

const CUSTOM_VALUES = {
  insured: 'Yes',
  years_in_business: '12',
  best_time_to_call: 'Weekday mornings',
};

function fixtureContact(): Contact {
  return {
    id: 'dev-contact-1',
    user_id: USER,
    org_id: ORG,
    business_name: 'Fixture Plumbing',
    phone_number: '+15551230001',
    phone_raw: '(555) 123-0001',
    address: '12 Main St',
    city: 'Austin',
    custom_values: CUSTOM_VALUES,
    timezone: 'America/Chicago',
    dnc: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Contact;
}

function useStubs(scenario: string) {
  useState(() => {
    const authAny = supabase.auth as unknown as Record<string, unknown>;
    const supabaseAny = supabase as unknown as Record<string, unknown>;
    const user = { id: USER, email: 'dev@example.invalid' };
    authAny.getSession = async () => ({
      data: { session: { access_token: 'dev-fixture-token', user } },
      error: null,
    });
    authAny.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
    supabaseAny.from = (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        maybeSingle: async () => ({
          data: { first_name: 'Dev', last_name: 'User', active_org_id: ORG },
          error: null,
        }),
        then: (resolve: (v: unknown) => void) => {
          if (table === 'org_members')
            resolve({
              data: [{ org_id: ORG, role: 'owner', orgs: { name: 'Fixture Org' } }],
              error: null,
            });
          else if (table === 'contact_field_defs')
            resolve({
              data: Object.keys(CUSTOM_VALUES).map((key) => ({
                key,
                label: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
              })),
              error: null,
            });
          else resolve({ data: [], error: null });
        },
      };
      return chain;
    };
    supabaseAny.rpc = async (_fn: string, args: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 300));
      const dry = args.p_dry_run === true;
      const n = args.p_mode === 'ids' ? (args.p_contact_ids as string[]).length : 240;
      const capped = scenario === 'capped';
      const eligible = capped ? 6000 : n - 12;
      const take = capped ? 5000 : eligible;
      return {
        data: {
          dry_run: dry,
          matched: n + 8,
          eligible,
          would_add: take,
          added: dry ? 0 : take,
          capped,
          cap: 5000,
          not_found: 0,
          skipped_no_phone: 3,
          skipped_dnc: 4,
          skipped_org_dnc: 1,
          skipped_closed: 2,
          skipped_removed: 0,
          skipped_already_in_campaign: 6,
          skipped_active_elsewhere: 2,
        },
        error: null,
      };
    };
    const originalFetch = window.fetch;
    window.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/contacts-parse-csv')) {
        const text = JSON.parse(String(init?.body)).csv_text as string;
        const headers = text
          .split('\n')[0]
          .split(',')
          .map((h) => h.trim());
        const known: Record<string, string> = {
          City: 'City',
          Phone: 'Phone Number',
          Name: 'Business Name',
        };
        return json({
          columns: headers.map((h) => ({
            original_header: h,
            mapped_field: known[h] ?? null,
            status: known[h] ? 'mapped' : 'incomplete',
            preview_data: ['sample', 'value'],
          })),
          total_rows: 2,
          preview_rows: [],
          invalid_phone_count: 0,
        });
      }
      if (u.includes('/contacts-import')) {
        const maps = JSON.parse(String(init?.body)).column_mappings as {
          mapped_field: string | null;
        }[];
        const custom = maps.filter((m) => m.mapped_field === 'Custom field').length;
        return json({
          imported: 2,
          skipped: 0,
          invalid: 0,
          duplicates: 0,
          skippedDnc: 0,
          skippedActiveCampaign: 0,
          customFieldsCreated: scenario === 'capped' ? 1 : custom,
          customFieldsSkipped: scenario === 'capped' ? custom - 1 : 0,
        });
      }
      return originalFetch(url as RequestInfo, init);
    }) as typeof window.fetch;
  });
}

export function ContactImportHarness() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') ?? 'import';
  useStubs(params.get('scenario') ?? 'default');
  const [contact] = useState<Contact>(() => fixtureContact());
  const pickContacts = useState<Contact[]>(() =>
    ['Austin Roofing', 'Dallas Plumbing', 'Waco HVAC', 'Austin Electric'].map(
      (name, i) =>
        ({
          ...fixtureContact(),
          id: `dev-pick-${i}`,
          business_name: name,
          city: name.split(' ')[0],
          phone_number: `+1555123000${i}`,
        }) as Contact
    )
  )[0];
  return (
    <AuthProvider>
      <OrgProvider>
        <div className="min-h-screen bg-surface-0 p-4">
          {view === 'bulk' ? (
            <AddExistingContactsModal
              campaignId="dev-campaign"
              contacts={pickContacts}
              existingContactIds={new Set()}
              otherCampaigns={[{ id: 'dev-other', name: 'Austin HVAC, Oct' }]}
              onClose={() => {}}
              onDone={() => {}}
            />
          ) : view === 'detail' ? (
            <ContactDetailModal contact={contact} open onClose={() => {}} />
          ) : (
            <ImportContactsModal open onClose={() => {}} onSuccess={() => {}} />
          )}
        </div>
      </OrgProvider>
    </AuthProvider>
  );
}
