import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from './AuthContext';

export type OrgRole = 'owner' | 'admin' | 'agent';

export interface OrgMembership {
  orgId: string;
  orgName: string;
  role: OrgRole;
}

interface OrgContextValue {
  loading: boolean;
  orgId: string | null;
  role: OrgRole | null;
  firstName: string | null;
  lastName: string | null;
  /** Every org this user actively belongs to (for the org switcher). */
  orgs: OrgMembership[];
  refetch: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
}

const OrgContext = createContext<OrgContextValue | null>(null);

interface MembershipRow {
  org_id: string;
  role: OrgRole;
  orgs: { name: string } | { name: string }[] | null;
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [role, setRole] = useState<OrgRole | null>(null);
  const [firstName, setFirstName] = useState<string | null>(null);
  const [lastName, setLastName] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false);
      setOrgId(null);
      setRole(null);
      setOrgs([]);
      return;
    }
    setLoading(true);
    const [{ data: profile }, { data: memberships }] = await Promise.all([
      supabase
        .from('profiles')
        .select('first_name, last_name, active_org_id')
        .eq('user_id', user.id)
        .maybeSingle(),
      supabase
        .from('org_members')
        .select('org_id, role, orgs(name)')
        .eq('user_id', user.id)
        .eq('status', 'active'),
    ]);

    setFirstName((profile?.first_name as string | null) ?? null);
    setLastName((profile?.last_name as string | null) ?? null);

    const list: OrgMembership[] = ((memberships ?? []) as MembershipRow[]).map((m) => ({
      orgId: m.org_id,
      orgName: (Array.isArray(m.orgs) ? m.orgs[0]?.name : m.orgs?.name) ?? 'Untitled org',
      role: m.role,
    }));
    setOrgs(list);

    const activeOrgId = (profile?.active_org_id as string | null) ?? null;
    setOrgId(activeOrgId);
    setRole(list.find((m) => m.orgId === activeOrgId)?.role ?? null);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const switchOrg = useCallback(
    async (newOrgId: string) => {
      if (!user) return;
      const { error } = await supabase
        .from('profiles')
        .update({ active_org_id: newOrgId, updated_at: new Date().toISOString() })
        .eq('user_id', user.id);
      if (error) throw new Error(error.message);
      // Nothing else in the app listens for an org change (every screen fetches its org-scoped
      // data once, on mount) -- a full reload is the simplest way to guarantee every screen
      // re-fetches under the new org rather than mixing stale data from the old one.
      window.location.reload();
    },
    [user]
  );

  const value: OrgContextValue = {
    loading,
    orgId,
    role,
    firstName,
    lastName,
    orgs,
    refetch: load,
    switchOrg,
  };

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within OrgProvider');
  return ctx;
}
