import { useState } from 'react';
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
              {t.label}
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
            {isManager && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onTabChange('analytics');
                    setMoreOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-app-md px-3 py-3 text-text-primary hover:bg-white/5"
                >
                  <BarChart3 className="w-5 h-5 text-text-secondary" />
                  Analytics
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onTabChange('team');
                    setMoreOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-app-md px-3 py-3 text-text-primary hover:bg-white/5"
                >
                  <UsersRound className="w-5 h-5 text-text-secondary" />
                  Team
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onTabChange('settings');
                    setMoreOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-app-md px-3 py-3 text-text-primary hover:bg-white/5"
                >
                  <Settings className="w-5 h-5 text-text-secondary" />
                  Settings
                </button>
              </>
            )}
            {shiftsEnabled && (
              <button
                type="button"
                onClick={() => {
                  onTabChange('shifts');
                  setMoreOpen(false);
                }}
                className="flex items-center gap-3 rounded-app-md px-3 py-3 text-text-primary hover:bg-white/5"
              >
                <CalendarClock className="w-5 h-5 text-text-secondary" />
                Shifts
              </button>
            )}
            {isManagerOrBetter && (
              <button
                type="button"
                onClick={() => {
                  onTabChange('team_shifts');
                  setMoreOpen(false);
                }}
                className="flex items-center gap-3 rounded-app-md px-3 py-3 text-text-primary hover:bg-white/5"
              >
                <CalendarRange className="w-5 h-5 text-text-secondary" />
                Team Shifts
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onTabChange('recordings');
                setMoreOpen(false);
              }}
              className="flex items-center gap-3 rounded-app-md px-3 py-3 text-text-primary hover:bg-white/5"
            >
              <Headphones className="w-5 h-5 text-text-secondary" />
              Recordings
            </button>
            <button
              type="button"
              onClick={() => {
                onTabChange('inbox');
                setMoreOpen(false);
              }}
              className="flex items-center gap-3 rounded-app-md px-3 py-3 text-text-primary hover:bg-white/5"
            >
              <InboxIcon className="w-5 h-5 text-text-secondary" />
              Inbox
            </button>
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false);
                localStorage.clear();
                sessionStorage.clear();
                signOut();
              }}
              className="flex items-center gap-3 rounded-app-md px-3 py-3 text-danger hover:bg-white/5"
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
