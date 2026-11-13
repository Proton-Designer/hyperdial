import { useState } from 'react';
import { isViewOnly } from '@/lib/viewAs';
import {
  LayoutGrid,
  Phone,
  Users,
  Target,
  MoreHorizontal,
  BarChart3,
  UsersRound,
  Headphones,
  Inbox as InboxIcon,
  BadgeCheck,
  Settings,
  LogOut,
  CalendarClock,
  CalendarRange,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/contexts/AuthContext';
import { useShiftsEnabled } from '@/contexts/ShiftsContext';
import { useOrg } from '@/contexts/OrgContext';
import type { TabType } from '../MainApp';

interface BottomTabBarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  isManager: boolean;
}

const PRIMARY: { tab: TabType; label: string; icon: typeof LayoutGrid }[] = [
  { tab: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
  { tab: 'dialer', label: 'Dialer', icon: Phone },
  { tab: 'contacts', label: 'Contacts', icon: Users },
  { tab: 'campaigns', label: 'Campaigns', icon: Target },
];

/**
 * Mobile (<768) fixed bottom tab bar (FE-A): Dashboard/Dialer/Contacts/Campaigns, plus "More"
 * opening a sheet with Analytics/Settings/sign-out. Campaigns/Analytics/Settings still respect
 * the manager-only gate (MainApp.tsx's setActiveTab already fails closed for an agent; this only
 * controls which affordances are ever offered, same split as Sidebar.tsx on desktop).
 */
export function BottomTabBar({ activeTab, onTabChange, isManager }: BottomTabBarProps) {
  const { signOut } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const shiftsEnabled = useShiftsEnabled();
  const { role } = useOrg();
  const isManagerOrBetter = isManager || role === 'manager';
  const tabs = isManager ? PRIMARY : PRIMARY.filter((t) => t.tab !== 'campaigns');
  // Same visibility rules as Sidebar.tsx (the desktop list): everything not in the bar is in "More".
  // Managers (not only owner/admin) get Analytics, Team and Settings; agents get none of the three.
  const moreItems: { tab: TabType; label: string; icon: typeof LayoutGrid }[] = [
    ...(isManagerOrBetter
      ? [
          { tab: 'analytics' as TabType, label: 'Analytics', icon: BarChart3 },
          { tab: 'team' as TabType, label: 'Team', icon: UsersRound },
        ]
      : []),
    { tab: 'recordings', label: 'Recordings', icon: Headphones },
    { tab: 'inbox', label: 'Inbox', icon: InboxIcon },
    ...(isManagerOrBetter
      ? [{ tab: 'pros' as TabType, label: 'Onboarded pros', icon: BadgeCheck }]
      : []),
    ...(shiftsEnabled ? [{ tab: 'shifts' as TabType, label: 'Shifts', icon: CalendarClock }] : []),
    ...(isManagerOrBetter
      ? [
          { tab: 'team_shifts' as TabType, label: 'Team Shifts', icon: CalendarRange },
          { tab: 'settings' as TabType, label: 'Settings', icon: Settings },
        ]
      : []),
  ];

  return (
    <>
      <nav
        className="pb-safe fixed bottom-0 left-0 right-0 z-40 flex items-stretch border-t border-border-subtle bg-surface-1/95 backdrop-blur-xl"
        style={{ height: 'calc(56px + env(safe-area-inset-bottom, 0px))' }}
        aria-label="Primary"
      >
        {tabs.map((t) => {
          const isActive = activeTab === t.tab;
          const Icon = t.icon;
          return (
            <button
              key={t.tab}
              type="button"
              onClick={() => onTabChange(t.tab)}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-meta transition-colors ${
                isActive ? 'text-accent-to' : 'text-text-secondary'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className="w-5 h-5" />
              {t.tab === 'dashboard' && role === 'agent' ? 'My stats' : t.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-meta transition-colors ${
            moreOpen ? 'text-accent-to' : 'text-text-secondary'
          }`}
        >
          <MoreHorizontal className="w-5 h-5" />
          More
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="bg-surface-1 border-border-subtle pb-safe">
          <SheetHeader>
            <SheetTitle className="text-text-primary">More</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-1 px-4 pb-4">
            {moreItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.tab}
                  type="button"
                  onClick={() => {
                    onTabChange(item.tab);
                    setMoreOpen(false);
                  }}
                  className="flex min-h-12 items-center gap-3 rounded-app-md px-3 py-3 text-left text-text-primary active:bg-white/10 hover:bg-white/5"
                >
                  <Icon className="w-5 h-5 text-text-secondary" />
                  {item.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false);
                if (!isViewOnly) {
                  localStorage.clear();
                  sessionStorage.clear();
                }
                signOut();
              }}
              className="flex min-h-12 items-center gap-3 rounded-app-md px-3 py-3 text-left text-danger active:bg-white/10 hover:bg-white/5"
            >
              <LogOut className="w-5 h-5" />
              Sign out
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
