import { useState, useEffect, useRef } from 'react';
import { TopNavigation } from './TopNavigation';
import { Sidebar } from './Sidebar';
import { Dashboard } from './Dashboard';
import { Dialer } from './Dialer';
import { Contacts } from './Contacts';
import { Campaigns } from './Campaigns';
import { Analytics } from './Analytics';
import { Settings } from './Settings';
import { useOrg } from '@/contexts/OrgContext';

export type TabType = 'dashboard' | 'dialer' | 'contacts' | 'campaigns' | 'analytics' | 'settings';

export interface ParallelDialLaunchContext {
  sessionId: string;
  campaignId: string;
}

// TASK-L4 / UI-4: interns (role 'agent') only get Dashboard/Dialer/Contacts. Campaigns,
// Analytics, and Settings are for owner/admin. Enforced here (not just in Sidebar's tab list) so
// every entry point -- the sidebar, a quick-action button, a future deep link -- falls back to
// Dialer instead of rendering a hidden tab.
const AGENT_ALLOWED_TABS: readonly TabType[] = ['dashboard', 'dialer', 'contacts'];

// TASK-B1 Phase 1: minimal URL sync (B1's known gap -- no routing, refresh always lands on
// Dashboard, Back/Forward don't move tabs, tabs aren't bookmarkable/deep-linkable). Real
// pathname + History API, not a hash route -- vercel.json already rewrites every path to
// index.html, so a deep link like /campaigns is already served correctly by the host; only the
// client-side sync was missing.
const TAB_PATHS: Record<TabType, string> = {
  dashboard: '/',
  dialer: '/dialer',
  contacts: '/contacts',
  campaigns: '/campaigns',
  analytics: '/analytics',
  settings: '/settings',
};
const PATH_TABS: Partial<Record<string, TabType>> = Object.fromEntries(
  Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as TabType])
);

function tabFromPath(pathname: string): TabType {
  return PATH_TABS[pathname] ?? 'dashboard';
}

export function MainApp() {
  const { role, loading: orgLoading } = useOrg();
  // Fail CLOSED, not just "hide from agents": gate on a CONFIRMED owner/admin role, not on
  // role === 'agent'. While role is still null (loading, or right after accepting an invite
  // before OrgContext has refetched) `isManager` is false, so an actual agent never gets a
  // window where manager tabs are reachable just because role hasn't resolved yet.
  //
  // Deliberately NOT also gating on OrgContext's `loading` flag (a regression from the first
  // fix-forward pass, caught in re-review): `loading` flips true on every refetch, including one
  // triggered by an ALREADY-confirmed owner/admin saving their profile in Settings.tsx -- but
  // `role` itself keeps its last-known value throughout a refetch (OrgContext's `load()` never
  // resets it to null before the fetch resolves), so gating on role alone already fails closed
  // on first load/right after an invite accept, without bouncing an already-confirmed manager
  // out of a manager-only tab every time something else triggers a refetch.
  const isManager = role === 'owner' || role === 'admin';
  const restrictToAgentTabs = !isManager;
  // If the deep-linked path is manager-only, we don't yet know (role hasn't resolved on first
  // paint) whether to honor it -- start on the same safe 'dialer' fallback an agent would land
  // on, and remember the real target here so the role-resolution effect below can promote to it
  // once we know the visitor is actually a manager. Never guessed at wrong; only ever narrows.
  const pendingDeepLinkTabRef = useRef<TabType | null>(null);
  const [activeTab, setActiveTabState] = useState<TabType>(() => {
    const urlTab = tabFromPath(window.location.pathname);
    if (AGENT_ALLOWED_TABS.includes(urlTab)) return urlTab;
    pendingDeepLinkTabRef.current = urlTab;
    return 'dialer';
  });
  // B1 Phase 2: on a narrow (mobile) viewport, an expanded 280px sidebar left only ~110px for
  // the main content at 390px wide -- cards were clipped, not reflowed (confirmed live, no
  // horizontal scroll, just genuinely cut off). Default to the existing 64px-collapsed state
  // (the manual toggle already handles the rest) below the same breakpoint Tailwind's own `md`
  // utilities use elsewhere in this app, checked once at mount -- not a live resize listener,
  // matching this component's existing one-shot-at-mount pattern for the URL-driven initial tab.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  );
  const [parallelDialContext, setParallelDialContext] = useState<ParallelDialLaunchContext | null>(
    null
  );

  const syncUrl = (tab: TabType, opts?: { replace?: boolean }) => {
    const path = TAB_PATHS[tab];
    if (window.location.pathname === path) return;
    if (opts?.replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
  };

  const setActiveTab = (tab: TabType) => {
    const resolved = restrictToAgentTabs && !AGENT_ALLOWED_TABS.includes(tab) ? 'dialer' : tab;
    setActiveTabState(resolved);
    syncUrl(resolved);
  };

  // Guards against role loading in after a hidden tab was already selected (e.g. `role` starts
  // null while OrgContext's own fetch is still in flight) -- not just new navigation attempts.
  useEffect(() => {
    if (restrictToAgentTabs && !AGENT_ALLOWED_TABS.includes(activeTab)) {
      setActiveTabState('dialer');
      syncUrl('dialer', { replace: true });
    }
  }, [restrictToAgentTabs, activeTab]);

  // Resolves the deep-link deferred above, as soon as OrgContext's REAL fetch (the one for the
  // actual signed-in user) settles: promote to the real manager-only tab if the visitor turned
  // out to be a manager, otherwise just correct the URL to match the 'dialer' fallback already
  // on screen.
  //
  // OrgProvider mounts above AppContent's own auth-loading gate (App.tsx), so on every fresh
  // mount it runs an unavoidable SPURIOUS first load cycle with `user` still null (AuthContext's
  // own session restore hasn't resolved yet) -- that cycle resolves `loading` straight from its
  // initial `true` to `false` with role=null, often before this component's effects even run
  // once, i.e. `orgLoading` can already read `false` on THIS effect's very first invocation. A
  // naive "orgLoading just became false" check treats that spurious tick as final and discards
  // the pending deep link before the real cycle (which always follows, and always visibly sets
  // `orgLoading` true first -- `load()`'s real-user branch calls `setLoading(true)` explicitly
  // before its awaits) ever gets to promote it. Caught live: an admin deep-linking to
  // /campaigns stayed stuck on /dialer forever. Agents were unaffected only by coincidence --
  // role=null and role='agent' both resolve to the same restricted fallback, so the wrong cycle
  // winning didn't change the outcome for that role.
  //
  // Fix: only trust an `orgLoading=false` observation once this effect has also observed
  // `orgLoading=true` at some point since mount -- i.e. wait for an actual loading transition,
  // not just a level read that might already be stale before we ever looked.
  const sawOrgLoadingRef = useRef(false);
  useEffect(() => {
    if (orgLoading) {
      sawOrgLoadingRef.current = true;
      return;
    }
    const pending = pendingDeepLinkTabRef.current;
    if (pending === null) return;
    if (!sawOrgLoadingRef.current) return; // still the spurious pre-auth cycle; wait for the real one
    pendingDeepLinkTabRef.current = null;
    if (!restrictToAgentTabs) {
      setActiveTabState(pending);
      syncUrl(pending, { replace: true });
    } else {
      syncUrl('dialer', { replace: true });
    }
  }, [orgLoading, restrictToAgentTabs]);

  // Back/Forward: reflect the browser's own history navigation in state without pushing a new
  // entry (that would corrupt the back-stack) -- only ever replaceState, and only to correct a
  // URL an agent reached that they're not allowed to see.
  useEffect(() => {
    const onPopState = () => {
      const urlTab = tabFromPath(window.location.pathname);
      const resolved =
        restrictToAgentTabs && !AGENT_ALLOWED_TABS.includes(urlTab) ? 'dialer' : urlTab;
      setActiveTabState(resolved);
      if (resolved !== urlTab) window.history.replaceState(null, '', TAB_PATHS[resolved]);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [restrictToAgentTabs]);

  const topBarHeight = 72;

  return (
    <div className="h-screen bg-[#0A1628] flex flex-col overflow-hidden">
      <TopNavigation activeTab={activeTab} onTabChange={setActiveTab} />
      {/* Spacer reserves space so content starts below the fixed top bar */}
      <div aria-hidden className="flex-shrink-0" style={{ height: topBarHeight }} />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
        <main
          className="flex-1 min-h-0 overflow-auto transition-[margin-left] duration-250 ease-out"
          style={{ marginLeft: sidebarCollapsed ? 64 : 280 }}
        >
          {activeTab === 'dashboard' && (
            <Dashboard
              onNavigateToDialer={() => setActiveTab('dialer')}
              onNavigateToContacts={() => setActiveTab('contacts')}
              onNavigateToCampaigns={() => setActiveTab('campaigns')}
            />
          )}
          {/* Review fix (L1 round-3 review-notes-r3.md, MAJOR 3): the Dialer used to only render
              (and its useTelnyxCall client only exist) while activeTab === 'dialer', so leaving
              the tab mid-session unmounted it -- disconnect()'s cleanup dropped the agent's own
              WebRTC leg, hanging up on the customer's ears (they'd hear nobody) while the call
              itself stayed technically alive server-side until it, too, was cleaned up. Keeping
              Dialer permanently mounted and only CSS-hiding it when another tab is active keeps
              the SAME TelnyxRTC client (and the "exactly one client per tab" invariant) alive
              across every tab switch; `display: none` also removes it from the tab order/a11y
              tree while hidden, same as not rendering it at all. */}
          <div style={activeTab === 'dialer' ? undefined : { display: 'none' }}>
            <Dialer
              parallelSessionId={parallelDialContext?.sessionId ?? null}
              parallelCampaignId={parallelDialContext?.campaignId ?? null}
              onClearParallelContext={() => setParallelDialContext(null)}
            />
          </div>
          {activeTab === 'contacts' && <Contacts />}
          {activeTab === 'campaigns' && (
            <Campaigns
              onNavigateToDialer={() => setActiveTab('dialer')}
              onStartParallelDial={(ctx) => {
                setParallelDialContext(ctx);
                setActiveTab('dialer');
              }}
              onOpenDialerWithSession={(ctx) => {
                setParallelDialContext(ctx);
                setActiveTab('dialer');
              }}
            />
          )}
          {activeTab === 'analytics' && <Analytics />}
          {activeTab === 'settings' && <Settings />}
        </main>
      </div>
    </div>
  );
}
