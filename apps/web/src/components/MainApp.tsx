import { useState, useEffect, useRef } from 'react';
import { TopNavigation, TOP_NAV_HEIGHT } from './TopNavigation';
import { Sidebar } from './Sidebar';
import { Dashboard } from './Dashboard';
import { Dialer } from './Dialer';
import { Contacts } from './Contacts';
import { Campaigns } from './Campaigns';
import { Analytics } from './Analytics';
import { Team } from './Team';
import { Recordings } from './Recordings';
import { Inbox } from './Inbox';
import { Settings } from './Settings';
import { Shifts } from './Shifts';
import { TeamShifts } from './TeamShifts';
import { BottomTabBar } from './app/BottomTabBar';
import { PageTransition } from './app/PageTransition';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useOrg } from '@/contexts/OrgContext';

export type TabType =
  | 'dashboard'
  | 'dialer'
  | 'contacts'
  | 'campaigns'
  | 'analytics'
  | 'team'
  | 'recordings'
  | 'inbox'
  | 'shifts'
  | 'team_shifts'
  | 'settings';

export interface ParallelDialLaunchContext {
  sessionId: string;
  campaignId: string;
}

// TASK-L4 / UI-4: interns (role 'agent') only get Dashboard/Dialer/Contacts. Campaigns,
// Analytics, and Settings are for owner/admin. Enforced here (not just in Sidebar's tab list) so
// every entry point -- the sidebar, a quick-action button, a future deep link -- falls back to
// Dialer instead of rendering a hidden tab.
// MISSION-5 TASK-M5-B5: Recordings added for every role, including agent -- `recordings_search`'s
// own scoping already restricts an agent to their own calls, so there is no separate "own calls
// only" client view to build; the same page just renders narrower for them.
// MISSION-5 TASK-M5-G6: same for Inbox -- an agent always sees their own missed calls regardless
// of the shared_inbox_enabled setting (requirement #2), enforced by `private.can_view_inbox_item`
// itself, not by hiding the tab.
const AGENT_ALLOWED_TABS: readonly TabType[] = [
  'dashboard',
  'dialer',
  'contacts',
  'recordings',
  'inbox',
  // Shifts (TASK-F01): every role; the tab itself only appears once the org has switched Shifts on
  // (ShiftsContext), and a deep link while it's off lands on the screen's own "not turned on" state.
  'shifts',
];

// MISSION-5 TASK-M5-A5: a manager gets Analytics (reports) and Team, plus Settings (internally
// restricted to just the Activity/audit-log sub-tab and their own profile -- see Settings.tsx's
// own `isManagerRole` gate), but NOT Campaigns -- "assign leads" for a manager is enforced
// server-side (assign_campaign_leads' pod-scope check) but deliberately has no client entry point
// in this pass, since Campaigns.tsx has other unrelated, un-scoped surface (CSV import, campaign
// creation, agent-roster assignment) that would need its own manager-safe review first. Not done;
// see RESUME_PLAN-eng1.md/LANE-eng1.md.
const MANAGER_ALLOWED_TABS: readonly TabType[] = [
  'dashboard',
  'dialer',
  'contacts',
  'analytics',
  'team',
  'recordings',
  'inbox',
  'shifts',
  'team_shifts',
  'settings',
];

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
  team: '/team',
  recordings: '/recordings',
  inbox: '/inbox',
  shifts: '/shifts',
  team_shifts: '/team-shifts',
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
  // MISSION-5 TASK-M5-A5: `allowedTabs` generalizes the old binary "agent vs. everyone" gate to
  // three tiers -- null means unrestricted (owner/admin, unchanged). A manager gets its own,
  // narrower list (MANAGER_ALLOWED_TABS); role null/loading or 'agent' still fails closed to the
  // most restrictive list, exactly as before.
  const allowedTabs: readonly TabType[] | null =
    role === 'manager' ? MANAGER_ALLOWED_TABS : isManager ? null : AGENT_ALLOWED_TABS;
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
  // TASK-FE-A: mobile (<768) drops the sidebar entirely for a fixed bottom tab bar instead (no
  // amount of collapsing fixed B1-007 properly -- a 64px rail plus its own top bar was still
  // cramped on a 390px screen, and a bottom tab bar is the platform-native pattern). Desktop
  // (>=1024) defaults expanded; tablet (768-1023) defaults collapsed. A live resize listener
  // (useBreakpoint), replacing the old one-shot mount-time matchMedia check -- the shell now
  // needs to actually react to a resize/rotate, not just pick a starting value.
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === 'mobile';
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() => {
    try {
      const stored = typeof window !== 'undefined' && localStorage.getItem('hd_sidebar_collapsed');
      if (stored === 'true') return true;
      if (stored === 'false') return false;
    } catch {
      // localStorage unavailable (private mode, blocked) -- fall through to the breakpoint default.
    }
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
  });
  const setSidebarCollapsed = (value: boolean) => {
    setSidebarCollapsedState(value);
    try {
      localStorage.setItem('hd_sidebar_collapsed', String(value));
    } catch {
      // Best-effort only -- not persisting the preference isn't worth surfacing an error for.
    }
  };
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
    const resolved = allowedTabs !== null && !allowedTabs.includes(tab) ? 'dialer' : tab;
    setActiveTabState(resolved);
    syncUrl(resolved);
  };

  // Guards against role loading in after a hidden tab was already selected (e.g. `role` starts
  // null while OrgContext's own fetch is still in flight) -- not just new navigation attempts.
  useEffect(() => {
    if (allowedTabs !== null && !allowedTabs.includes(activeTab)) {
      setActiveTabState('dialer');
      syncUrl('dialer', { replace: true });
    }
  }, [allowedTabs, activeTab]);

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
    if (allowedTabs === null || allowedTabs.includes(pending)) {
      setActiveTabState(pending);
      syncUrl(pending, { replace: true });
    } else {
      syncUrl('dialer', { replace: true });
    }
  }, [orgLoading, allowedTabs]);

  // Back/Forward: reflect the browser's own history navigation in state without pushing a new
  // entry (that would corrupt the back-stack) -- only ever replaceState, and only to correct a
  // URL an agent reached that they're not allowed to see.
  useEffect(() => {
    const onPopState = () => {
      const urlTab = tabFromPath(window.location.pathname);
      const resolved = allowedTabs !== null && !allowedTabs.includes(urlTab) ? 'dialer' : urlTab;
      setActiveTabState(resolved);
      if (resolved !== urlTab) window.history.replaceState(null, '', TAB_PATHS[resolved]);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [allowedTabs]);

  return (
    <div className="h-screen bg-surface-0 flex flex-col overflow-hidden">
      <TopNavigation activeTab={activeTab} onTabChange={setActiveTab} />
      {/* Spacer reserves space so content starts below the fixed top bar */}
      <div aria-hidden className="flex-shrink-0" style={{ height: TOP_NAV_HEIGHT }} />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isMobile && (
          <Sidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            topOffset={TOP_NAV_HEIGHT}
          />
        )}
        <main
          className="flex-1 min-h-0 overflow-auto transition-[margin-left] duration-200 ease-out"
          style={{
            marginLeft: isMobile ? 0 : sidebarCollapsed ? 64 : 240,
            // Mobile: clear the fixed bottom tab bar (56px + the device's own safe-area inset)
            // so the last row of content is never hidden behind it.
            paddingBottom: isMobile ? 'calc(56px + env(safe-area-inset-bottom, 0px))' : undefined,
            // Sticky footers (Shifts picker) sit above the fixed bottom tab bar on mobile.
            ['--app-bottom-inset' as string]: isMobile
              ? 'calc(56px + env(safe-area-inset-bottom, 0px))'
              : '0px',
          }}
        >
          {activeTab === 'dashboard' && (
            <PageTransition>
              <Dashboard
                onNavigateToDialer={() => setActiveTab('dialer')}
                onNavigateToContacts={() => setActiveTab('contacts')}
                onNavigateToCampaigns={() => setActiveTab('campaigns')}
              />
            </PageTransition>
          )}
          {/* Review fix (L1 round-3 review-notes-r3.md, MAJOR 3): the Dialer used to only render
              (and its useTelnyxCall client only exist) while activeTab === 'dialer', so leaving
              the tab mid-session unmounted it -- disconnect()'s cleanup dropped the agent's own
              WebRTC leg, hanging up on the customer's ears (they'd hear nobody) while the call
              itself stayed technically alive server-side until it, too, was cleaned up. Keeping
              Dialer permanently mounted and only CSS-hiding it when another tab is active keeps
              the SAME TelnyxRTC client (and the "exactly one client per tab" invariant) alive
              across every tab switch; `display: none` also removes it from the tab order/a11y
              tree while hidden, same as not rendering it at all. NOT wrapped in PageTransition
              (FE-A) -- that component keys/re-renders on mount, and this div must never unmount. */}
          <div style={activeTab === 'dialer' ? undefined : { display: 'none' }}>
            <Dialer
              parallelSessionId={parallelDialContext?.sessionId ?? null}
              parallelCampaignId={parallelDialContext?.campaignId ?? null}
              onClearParallelContext={() => setParallelDialContext(null)}
              onNavigateToSettings={() => setActiveTab('settings')}
            />
          </div>
          {activeTab === 'contacts' && (
            <PageTransition>
              <Contacts />
            </PageTransition>
          )}
          {activeTab === 'campaigns' && (
            <PageTransition>
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
            </PageTransition>
          )}
          {activeTab === 'analytics' && (
            <PageTransition>
              <Analytics />
            </PageTransition>
          )}
          {activeTab === 'team' && (
            <PageTransition>
              <Team />
            </PageTransition>
          )}
          {activeTab === 'recordings' && (
            <PageTransition>
              <Recordings />
            </PageTransition>
          )}
          {activeTab === 'inbox' && (
            <PageTransition>
              <Inbox onNavigateToDialer={() => setActiveTab('dialer')} />
            </PageTransition>
          )}
          {activeTab === 'shifts' && (
            <PageTransition>
              <Shifts />
            </PageTransition>
          )}
          {activeTab === 'team_shifts' && (
            <PageTransition>
              <TeamShifts />
            </PageTransition>
          )}
          {activeTab === 'settings' && (
            <PageTransition>
              <Settings />
            </PageTransition>
          )}
        </main>
      </div>
      {isMobile && (
        <BottomTabBar activeTab={activeTab} onTabChange={setActiveTab} isManager={isManager} />
      )}
    </div>
  );
}
