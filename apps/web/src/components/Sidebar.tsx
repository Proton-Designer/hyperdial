import { motion } from 'motion/react';
import {
  LayoutGrid,
  Phone,
  Users,
  Target,
  BarChart3,
  UsersRound,
  Headphones,
  Inbox as InboxIcon,
  BadgeCheck,
  CalendarClock,
  CalendarRange,
  Settings,
  ChevronsLeft,
  ChevronsRight,
  type LucideIcon,
} from 'lucide-react';
import { TabType } from './MainApp';
import { LogoMark } from '@/components/brand/Logo';
import { useOrg } from '@/contexts/OrgContext';
import { useInboxOpenCount } from '@/hooks/useInboxOpenCount';
import { useShiftsEnabled } from '@/contexts/ShiftsContext';

interface SidebarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** 56px on desktop/tablet (FE-A shell), matching TopNavigation's new height. */
  topOffset: number;
}

interface NavTab {
  id: TabType;
  icon: LucideIcon;
  label: string;
  agentLabel?: string;
  /** undefined = every role (including agent); 'manager' = owner/admin/manager; 'admin' =
   *  owner/admin only. MISSION-5 TASK-M5-A5: Analytics/Team are 'manager' (reports + the Team
   *  page are explicitly in a manager's own scope); Campaigns stays 'admin' -- a manager's
   *  "assign leads" capability is enforced server-side but deliberately has no client entry point
   *  yet (see MainApp.tsx's MANAGER_ALLOWED_TABS comment). */
  minRole?: 'manager' | 'admin';
}

const tabs: NavTab[] = [
  { id: 'dashboard', icon: LayoutGrid, label: 'Dashboard', agentLabel: 'My stats' },
  { id: 'dialer', icon: Phone, label: 'Dialer' },
  { id: 'contacts', icon: Users, label: 'Contacts' },
  { id: 'campaigns', icon: Target, label: 'Campaigns', minRole: 'admin' },
  { id: 'analytics', icon: BarChart3, label: 'Analytics', minRole: 'manager' },
  { id: 'team', icon: UsersRound, label: 'Team', minRole: 'manager' },
  // MISSION-5 TASK-M5-B5: no minRole -- every role gets Recordings, `recordings_search`'s own
  // scoping already narrows an agent to their own calls server-side.
  { id: 'recordings', icon: Headphones, label: 'Recordings' },
  // MISSION-5 TASK-M5-G6: no minRole -- an agent always sees their own missed calls
  // (`private.can_view_inbox_item`), same "server narrows, tab stays visible" shape as Recordings.
  { id: 'inbox', icon: InboxIcon, label: 'Inbox' },
  // TASK-H25: owner/admin/manager only (list_onboarded_pros is role- and pod-scoped server-side); agents never see it.
  { id: 'pros', icon: BadgeCheck, label: 'Pros', minRole: 'manager' },
  // Shifts (TASK-F01): `shifts` shows to every role once the org has it switched on;
  // `team_shifts` is manager-level and always shows (it carries the "Enable Shifts" setup card).
  { id: 'shifts', icon: CalendarClock, label: 'Shifts' },
  { id: 'team_shifts', icon: CalendarRange, label: 'Team Shifts', minRole: 'manager' },
];

export function Sidebar({
  activeTab,
  onTabChange,
  collapsed,
  onToggleCollapse,
  topOffset,
}: SidebarProps) {
  const { role } = useOrg();
  const inboxOpenCount = useInboxOpenCount();
  // Fail CLOSED: an owner/admin-only tab is visible only once role is CONFIRMED owner/admin, not
  // merely "not confirmed agent" -- role null (loading, or right after an invite accept that
  // hasn't refetched yet) must not show manager tabs. NOT also gated on OrgContext's `loading`
  // flag -- see MainApp.tsx's comment: `loading` flips true on every refetch (including one an
  // already-confirmed manager triggers themselves, e.g. saving their profile), but `role` keeps
  // its last-known value throughout, so gating on role alone is both sufficient and avoids
  // bouncing a manager out of a manager-only tab on every unrelated refetch (re-review regression).
  const isManager = role === 'owner' || role === 'admin';
  const isManagerOrBetter = isManager || role === 'manager';
  const isAgent = role === 'agent';
  const shiftsEnabled = useShiftsEnabled();
  const visibleTabs = tabs.filter((tab) => {
    if (tab.id === 'shifts') return shiftsEnabled;
    if (tab.minRole === 'admin') return isManager;
    if (tab.minRole === 'manager') return isManagerOrBetter;
    return true;
  });

  const renderItem = (tab: NavTab, extraOnClick?: () => void) => {
    const Icon = tab.icon;
    const isActive = activeTab === tab.id;
    const label = isAgent && tab.agentLabel ? tab.agentLabel : tab.label;

    return (
      <button
        key={tab.id}
        onClick={() => {
          onTabChange(tab.id);
          extraOnClick?.();
        }}
        aria-current={isActive ? 'page' : undefined}
        className={`
          relative flex w-full items-center gap-3 rounded-app-md px-3 py-2.5 text-sm transition-colors group
          ${isActive ? 'bg-accent-to/10 text-text-primary font-medium' : 'text-text-secondary hover:bg-white/5 hover:text-text-primary'}
        `}
      >
        {isActive && (
          <motion.div
            layoutId="sidebar-active-bar"
            className="absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full bg-accent-to"
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
          />
        )}
        <Icon className={`w-[18px] h-[18px] flex-shrink-0 ${isActive ? 'text-accent-to' : ''}`} />
        {!collapsed && <span className="truncate flex-1 text-left">{label}</span>}
        {!collapsed && tab.id === 'inbox' && inboxOpenCount > 0 && (
          <span className="flex-shrink-0 rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
            {inboxOpenCount > 99 ? '99+' : inboxOpenCount}
          </span>
        )}
        {collapsed && tab.id === 'inbox' && inboxOpenCount > 0 && (
          <span className="absolute top-1 right-1.5 h-1.5 w-1.5 rounded-full bg-danger" />
        )}
        {collapsed && (
          <div className="pointer-events-none absolute left-full ml-2 whitespace-nowrap rounded-app-sm border border-border-strong bg-surface-1 px-2.5 py-1.5 text-xs text-text-primary opacity-0 shadow-app-md transition-opacity group-hover:opacity-100 z-50">
            {label}
          </div>
        )}
      </button>
    );
  };

  return (
    <motion.aside
      className="fixed left-0 bottom-0 z-40 flex flex-col overflow-hidden border-r border-border-subtle bg-surface-1/60 backdrop-blur-xl"
      style={{ top: topOffset }}
      animate={{ width: collapsed ? 64 : 240 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {/* FE-A: the logo lives in the top bar when the sidebar is expanded (no need to repeat it);
          collapsed to a 64px icon rail, the wordmark no longer fits, so the mark alone anchors
          the rail the same way a collapsed sidebar does in most desktop apps. */}
      {collapsed && (
        <div className="flex items-center justify-center py-3">
          <LogoMark size={28} />
        </div>
      )}

      <nav className="flex-1 space-y-1 p-2.5 overflow-y-auto">
        {visibleTabs.map((tab) => renderItem(tab))}
      </nav>

      <div className="space-y-1 border-t border-border-subtle p-2.5">
        {isManagerOrBetter && renderItem({ id: 'settings', icon: Settings, label: 'Settings' })}

        <button
          onClick={onToggleCollapse}
          className="flex w-full items-center justify-center gap-2 rounded-app-md px-3 py-2 text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronsRight className="w-[18px] h-[18px]" />
          ) : (
            <ChevronsLeft className="w-[18px] h-[18px]" />
          )}
        </button>
      </div>
    </motion.aside>
  );
}
