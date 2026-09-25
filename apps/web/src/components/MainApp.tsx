import { useState, useEffect } from 'react';
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

export function MainApp() {
  const { role } = useOrg();
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
  const [activeTab, setActiveTabState] = useState<TabType>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [parallelDialContext, setParallelDialContext] = useState<ParallelDialLaunchContext | null>(
    null
  );

  const setActiveTab = (tab: TabType) => {
    setActiveTabState(restrictToAgentTabs && !AGENT_ALLOWED_TABS.includes(tab) ? 'dialer' : tab);
  };

  // Guards against role loading in after a hidden tab was already selected (e.g. `role` starts
  // null while OrgContext's own fetch is still in flight) -- not just new navigation attempts.
  useEffect(() => {
    if (restrictToAgentTabs && !AGENT_ALLOWED_TABS.includes(activeTab)) setActiveTabState('dialer');
  }, [restrictToAgentTabs, activeTab]);

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
