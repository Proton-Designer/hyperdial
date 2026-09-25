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
  const { role, loading: orgLoading } = useOrg();
  // Fail CLOSED, not just "hide from agents": gate on a CONFIRMED owner/admin role, not on
  // role === 'agent'. While role is still loading (or came back null -- e.g. right after
  // accepting an invite, before OrgContext has refetched) `isManager` is false, so an actual
  // agent never gets a window where manager tabs are reachable just because role hasn't
  // resolved yet (review fix-forward, TASK-L4, MEDIUM).
  const isManager = role === 'owner' || role === 'admin';
  const restrictToAgentTabs = orgLoading || !isManager;
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
          {activeTab === 'dialer' && (
            <Dialer
              parallelSessionId={parallelDialContext?.sessionId ?? null}
              parallelCampaignId={parallelDialContext?.campaignId ?? null}
              onClearParallelContext={() => setParallelDialContext(null)}
            />
          )}
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
