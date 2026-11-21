import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { AuthProvider } from '../contexts/AuthContext';
import { OrgProvider } from '../contexts/OrgContext';
import { ContactDetailModal } from '../components/contacts/ContactDetailModal';
import type { Contact } from '@/lib/api';

/**
 * TASK-G31: the REAL ContactDetailModal's do-not-call control against a fixture contact, no live network/DB.
 * `?dev_contact_dnc=1`, plus `&role=agent|admin|owner` (default agent) and `&dnc=1|0` (default 1):
 *   agent + dnc=1  the control is disabled, with the reason
 *   agent + dnc=0  an agent can still mark it
 *   admin/owner    can clear (the stubbed update answers with the flipped row)
 */
const ORG = 'dev-fixture-org';
const USER = 'dev-fixture-user';

function fixtureContact(dnc: boolean): Contact {
  return {
    id: 'dev-contact-1',
    user_id: USER,
    org_id: ORG,
    business_name: 'Fixture Plumbing',
    business_link: null,
    business_type: null,
    rating: null,
    review_count: null,
    open_hours: null,
    phone_number: '+15551230001',
    phone_raw: '(555) 123-0001',
    website: null,
    notes: null,
    first_name: 'Pat',
    last_name: 'Fixture',
    owner_contact: null,
    address: null,
    category: null,
    contact_status: null,
    timezone: 'America/Chicago',
    dnc,
    ghl_contact_id: null,
    ghl_tags: null,
  } as unknown as Contact;
}

function useStubs(role: string, dnc: boolean) {
  useState(() => {
    const authAny = supabase.auth as unknown as Record<string, unknown>;
    const supabaseAny = supabase as unknown as Record<string, unknown>;
    const user = { id: USER, email: 'dev@example.invalid' };
    authAny.getSession = async () => ({
      data: { session: { access_token: 'dev-fixture-token', user } },
      error: null,
    });
    authAny.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
    let current = dnc;
    supabaseAny.from = (table: string) => {
      if (table === 'profiles') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({
            data: { first_name: 'Dev', last_name: 'User', active_org_id: ORG },
            error: null,
          }),
        };
        return chain;
      }
      if (table === 'org_members') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: [{ org_id: ORG, role, orgs: { name: 'Fixture Org' } }], error: null }),
        };
        return chain;
      }
      if (table === 'contacts') {
        const chain = {
          update: (patch: { dnc?: boolean }) => {
            if (typeof patch.dnc === 'boolean') current = patch.dnc;
            return chain;
          },
          eq: () => chain,
          select: () => chain,
          single: async () => ({ data: fixtureContact(current), error: null }),
        };
        return chain;
      }
      throw new Error(`ContactDncHarness fake supabase: unexpected table ${table}`);
    };
  });
}

export function ContactDncHarness() {
  const params = new URLSearchParams(window.location.search);
  const role = params.get('role') ?? 'agent';
  const dnc = params.get('dnc') !== '0';
  useStubs(role, dnc);
  const [contact, setContact] = useState<Contact>(() => fixtureContact(dnc));
  return (
    <AuthProvider>
      <OrgProvider>
        <div className="min-h-screen bg-surface-0 p-4">
          <p className="text-xs text-text-muted">
            Contact DNC harness: role = {role}, dnc = {String(contact.dnc)}
          </p>
          <ContactDetailModal
            contact={contact}
            open
            onClose={() => {}}
            onUpdated={(c) => setContact(c)}
          />
        </div>
      </OrgProvider>
    </AuthProvider>
  );
}
