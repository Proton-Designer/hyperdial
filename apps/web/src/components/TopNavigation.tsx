import { useState, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Search, Bell, ChevronDown, LogOut, User, Building2, Check, Settings } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { Logo, LogoMark } from '@/components/brand/Logo';
import { CommandPalette, useCommandPaletteShortcut } from '@/components/app/CommandPalette';
import {
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  ensureWeekSummary,
  type AppNotification,
} from '@/lib/api';
import type { TabType } from './MainApp';

export const TOP_NAV_HEIGHT = 56;

const TAB_LABELS: Record<TabType, string> = {
  dashboard: 'Dashboard',
  dialer: 'Dialer',
  contacts: 'Contacts',
  campaigns: 'Campaigns',
  analytics: 'Analytics',
  team: 'Team',
  recordings: 'Recordings',
  settings: 'Settings',
};

interface TopNavigationProps {
  activeTab?: TabType;
  onTabChange?: (tab: TabType) => void;
}

function getDisplayName(user: { user_metadata?: Record<string, unknown>; email?: string }): string {
  const meta = user?.user_metadata;
  const first = (meta?.first_name as string)?.trim?.() || '';
  const last = (meta?.last_name as string)?.trim?.() || '';
  if (first || last) return `${first} ${last}`.trim();
  return user?.email ?? 'User';
}

function getInitials(user: { user_metadata?: Record<string, unknown>; email?: string }): string {
  const meta = user?.user_metadata;
  const first = (meta?.first_name as string)?.trim?.() || '';
  const last = (meta?.last_name as string)?.trim?.() || '';
  if (first && last) return `${first[0]}${last[0]}`.toUpperCase();
  if (first) return first.slice(0, 2).toUpperCase();
  const email = (user?.email ?? '').trim();
  if (email) return email.slice(0, 2).toUpperCase();
  return 'U';
}

function formatNotificationDate(created_at: string): string {
  const d = new Date(created_at);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString();
}

export function TopNavigation({ activeTab = 'dashboard', onTabChange }: TopNavigationProps) {
  const { user, signOut } = useAuth();
  const { orgId, orgs, switchOrg, role } = useOrg();
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === 'mobile';
  // Fail CLOSED, matching MainApp.tsx/Sidebar.tsx/Dashboard.tsx: the Settings tab is manager-only,
  // so this menu's Profile/Settings entries (both just navigate there) must not be shown until
  // role is CONFIRMED owner/admin. NOT also gated on OrgContext's `loading` -- see MainApp.tsx's
  // comment: that flips true on every refetch (including one an already-confirmed manager
  // triggers themselves), but `role` alone already fails closed without hiding this menu from a
  // manager on every unrelated refetch.
  const isManager = role === 'owner' || role === 'admin';
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showOrgSwitcher, setShowOrgSwitcher] = useState(false);
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Radix Dialog's own focus-restore only reliably tracks a <DialogTrigger>-wrapped trigger;
  // ours is a fully custom button (⌘K can open it too, with no "trigger" in the tree at all), so
  // its default restore-on-close falls back to <body> instead. Track it ourselves and restore
  // explicitly -- closes the "focus returns to the trigger" requirement for real.
  const paletteTriggerRef = useRef<HTMLButtonElement>(null);
  const openPalette = () => setPaletteOpen(true);
  const handlePaletteOpenChange = (open: boolean) => {
    setPaletteOpen(open);
    if (!open) requestAnimationFrame(() => paletteTriggerRef.current?.focus());
  };

  // B1 Phase 1: backdrop-click already closes each popover/dialog below, but Escape did nothing
  // -- only the click-outside div was wired. Topmost-open wins on a given press (the sign-out
  // confirm portal sits above everything else, including a still-open user menu underneath it).
  useEffect(() => {
    if (!showSignOutConfirm && !showUserMenu && !showNotifications && !showOrgSwitcher) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showSignOutConfirm) return setShowSignOutConfirm(false);
      if (showUserMenu) return setShowUserMenu(false);
      if (showNotifications) return setShowNotifications(false);
      if (showOrgSwitcher) return setShowOrgSwitcher(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showSignOutConfirm, showUserMenu, showNotifications, showOrgSwitcher]);

  useCommandPaletteShortcut(openPalette);

  // FE-A / closes B1-004: trap + restore focus for every top-nav popover and the sign-out
  // confirm dialog. Doesn't replace the Escape handler above (that closes; this only traps Tab
  // and returns focus to the trigger on close) -- see useFocusTrap's own doc comment.
  const orgSwitcherRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const signOutRef = useRef<HTMLDivElement>(null);
  useFocusTrap(orgSwitcherRef, showOrgSwitcher);
  useFocusTrap(notificationsRef, showNotifications);
  useFocusTrap(userMenuRef, showUserMenu);
  useFocusTrap(signOutRef, showSignOutConfirm);

  useEffect(() => {
    ensureWeekSummary().catch(() => {});
  }, []);

  useEffect(() => {
    getUnreadNotificationCount()
      .then(setUnreadCount)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!showNotifications) return;
    listNotifications()
      .then(setNotifications)
      .catch(() => setNotifications([]));
    getUnreadNotificationCount()
      .then(setUnreadCount)
      .catch(() => {});
  }, [showNotifications]);

  const displayName = user ? getDisplayName(user) : 'User';
  const email = user?.email ?? '';
  const initials = user ? getInitials(user) : 'U';

  const handleOpenNotification = async (n: AppNotification) => {
    if (!n.read_at) {
      await markNotificationRead(n.id).catch(() => {});
      setUnreadCount((c) => Math.max(0, c - 1));
      setNotifications((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x))
      );
    }
    // MISSION-5 TASK-M5-B2: the raise-hand notification's one-click Listen -- lands on Team
    // (where the live board already shows the raised-hand flag right on the agent's row, with
    // its own Listen button) rather than trying to start a coaching call from here, which has no
    // WebRTC client mounted. `n.data` is null for every notification type that predates this
    // column, so this only ever fires for the type it's meant for.
    // MISSION-5 TASK-M5-B4: the 4 supervisor alerts land the same place -- Team's live board is
    // where every one of these conditions (wrap-up/paused/call/zero-connects) is visible per-row.
    if ((n.type === 'agent_raised_hand' || n.type.startsWith('supervisor_alert.')) && n.data) {
      setShowNotifications(false);
      onTabChange?.('team');
    }
  };

  const handleMarkAllRead = async () => {
    await markAllNotificationsRead().catch(() => {});
    setUnreadCount(0);
    setNotifications((prev) =>
      prev.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() }))
    );
  };

  const currentOrgName = orgs.find((o) => o.orgId === orgId)?.orgName ?? '';

  const handleSwitchOrg = async (newOrgId: string) => {
    if (newOrgId === orgId) {
      setShowOrgSwitcher(false);
      return;
    }
    setSwitchingOrgId(newOrgId);
    try {
      await switchOrg(newOrgId); // reloads the page on success
    } catch {
      setSwitchingOrgId(null);
    }
  };

  const handleSignOutConfirm = () => {
    setShowUserMenu(false);
    setShowSignOutConfirm(false);
    localStorage.clear();
    sessionStorage.clear();
    signOut();
  };

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 flex items-center gap-3 border-b border-border-subtle bg-surface-1/60 px-3 backdrop-blur-xl sm:px-4"
      style={{ height: TOP_NAV_HEIGHT }}
    >
      {/* Left Section */}
      <div className="flex min-w-0 items-center gap-4">
        <button
          type="button"
          onClick={() => onTabChange?.('dashboard')}
          aria-label="Go to dashboard"
          className="flex items-center rounded-app-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-to"
        >
          {isMobile ? <LogoMark size={28} /> : <Logo size={28} wordmarkClassName="text-base" />}
        </button>

        {!isMobile && (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <button
              type="button"
              onClick={() => onTabChange?.('dashboard')}
              aria-label="Go to dashboard"
              className="rounded transition-colors hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-to"
            >
              Home
            </button>
            <span>/</span>
            <span className="text-text-primary">
              {activeTab === 'dashboard' && role === 'agent' ? 'My stats' : TAB_LABELS[activeTab]}
            </span>
          </div>
        )}

        {/* Org switcher: only shown when the user actually belongs to more than one org. */}
        {!isMobile && orgs.length > 1 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowOrgSwitcher((v) => !v)}
              className="flex items-center gap-2 rounded-app-md bg-white/5 px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-white/10"
            >
              <Building2 className="w-4 h-4 text-text-secondary" />
              <span className="max-w-[140px] truncate">{currentOrgName}</span>
              <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
            </button>
            <AnimatePresence>
              {showOrgSwitcher && (
                <>
                  {createPortal(
                    // Portaled to document.body, not a sibling div here: `nav` has
                    // `backdrop-blur-xl` (a backdrop-filter), which makes it the CSS containing
                    // block for any `position: fixed` descendant -- `inset-0` on a backdrop
                    // nested inside `nav` resolves against nav's OWN box, not the viewport, so
                    // it only ever covered the nav strip and silently never caught a click
                    // anywhere else in the app (B1-005). The sign-out confirm dialog below
                    // already portals to document.body for the same reason.
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setShowOrgSwitcher(false)}
                      aria-hidden="true"
                    />,
                    document.body
                  )}
                  <motion.div
                    ref={orgSwitcherRef}
                    tabIndex={-1}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="absolute left-0 top-full mt-2 w-64 overflow-hidden rounded-app-lg border border-border-strong bg-surface-1/95 p-2 shadow-app-md backdrop-blur-xl z-50"
                  >
                    {orgs.map((o) => (
                      <button
                        key={o.orgId}
                        type="button"
                        onClick={() => handleSwitchOrg(o.orgId)}
                        disabled={switchingOrgId !== null}
                        className="flex w-full items-center justify-between gap-2 rounded-app-md px-3 py-2.5 text-left text-sm text-text-primary hover:bg-white/5 disabled:opacity-60"
                      >
                        <span className="truncate">{o.orgName}</span>
                        {switchingOrgId === o.orgId ? (
                          <span className="text-xs text-text-secondary">Switching…</span>
                        ) : o.orgId === orgId ? (
                          <Check className="w-4 h-4 text-accent-to flex-shrink-0" />
                        ) : null}
                      </button>
                    ))}
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Center Section - Command palette trigger (closes B1-006: the old search box had no
          value/onChange at all). */}
      <div className="flex min-w-0 flex-1 justify-center px-2 sm:px-8">
        {isMobile ? (
          <button
            ref={paletteTriggerRef}
            type="button"
            onClick={openPalette}
            aria-label="Search"
            className="ml-auto rounded-app-md p-2 text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary"
          >
            <Search className="w-5 h-5" />
          </button>
        ) : (
          <button
            ref={paletteTriggerRef}
            type="button"
            onClick={openPalette}
            className="flex w-full max-w-[520px] items-center gap-3 rounded-app-md border border-border-subtle bg-surface-2/60 px-4 py-2 text-left text-sm text-text-muted transition-colors hover:border-border-strong"
          >
            <Search className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1 truncate">
              Search contacts, campaigns, or jump to a screen…
            </span>
            <kbd className="hidden flex-shrink-0 rounded border border-border-strong bg-surface-1 px-1.5 py-0.5 text-[10px] text-text-muted sm:inline-block">
              ⌘K
            </kbd>
          </button>
        )}
      </div>

      {/* Right Section */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Live call indicator */}
        <div className="hidden items-center gap-2 rounded-app-md border border-success/20 bg-success-soft px-3 py-1.5 sm:flex">
          <div className="relative">
            <div className="w-2 h-2 rounded-full bg-success" />
            <div className="absolute inset-0 h-2 w-2 animate-ping rounded-full bg-success" />
          </div>
          <span className="text-sm font-medium text-success">Ready</span>
        </div>

        {/* Notifications */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowNotifications(!showNotifications)}
            className="relative rounded-app-md p-2 transition-colors hover:bg-white/5"
            aria-label="Notifications"
          >
            <Bell className="w-5 h-5 text-text-secondary" />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-xs font-semibold text-white">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
          <AnimatePresence>
            {showNotifications && (
              <>
                {createPortal(
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowNotifications(false)}
                    aria-hidden="true"
                  />,
                  document.body
                )}
                <motion.div
                  ref={notificationsRef}
                  tabIndex={-1}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="absolute right-0 top-full mt-2 flex max-h-[420px] w-[92vw] max-w-[360px] flex-col overflow-hidden rounded-app-lg border border-border-strong bg-surface-1/95 shadow-app-md backdrop-blur-xl z-50"
                >
                  <div className="flex items-center justify-between border-b border-border-subtle p-3">
                    <span className="font-semibold text-text-primary">Notifications</span>
                    {unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={handleMarkAllRead}
                        className="text-xs text-accent-to hover:underline"
                      >
                        Mark all read
                      </button>
                    )}
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <p className="p-4 text-center text-sm text-text-secondary">
                        No notifications
                      </p>
                    ) : (
                      <ul className="space-y-1 p-2">
                        {notifications.map((n) => {
                          let bodyContent: ReactNode = n.body;
                          if (n.type === 'week_summary' && n.body) {
                            try {
                              const data = JSON.parse(n.body) as {
                                week_start?: string;
                                week_end?: string;
                                calls?: number;
                                connect_rate?: number;
                                talk_time_formatted?: string;
                              };
                              bodyContent = (
                                <span className="mt-1 block text-xs text-text-secondary">
                                  Calls: {data.calls ?? 0} · Connect rate: {data.connect_rate ?? 0}%
                                  · Talk time: {data.talk_time_formatted ?? '0m'}
                                </span>
                              );
                            } catch {
                              bodyContent = n.body;
                            }
                          }
                          return (
                            <li key={n.id}>
                              <button
                                type="button"
                                onClick={() => handleOpenNotification(n)}
                                className={`w-full rounded-app-md p-3 text-left transition-colors ${n.read_at ? 'bg-transparent hover:bg-white/5' : 'bg-accent-to/10'}`}
                              >
                                <div className="text-sm font-medium text-text-primary">
                                  {n.title}
                                </div>
                                {bodyContent && <div className="mt-0.5">{bodyContent}</div>}
                                <div className="mt-1 text-xs text-text-secondary">
                                  {formatNotificationDate(n.created_at)}
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* User Menu */}
        <div className="relative">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 rounded-app-md p-1 transition-colors hover:bg-white/5 sm:gap-3 sm:px-2 sm:py-1.5"
          >
            <div className="relative">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-accent-from to-accent-to text-sm font-semibold text-white">
                {initials}
              </div>
              <div className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-surface-1 bg-success" />
            </div>
            {!isMobile && <ChevronDown className="hidden h-4 w-4 text-text-secondary sm:block" />}
          </button>

          <AnimatePresence>
            {showUserMenu && (
              <>
                {createPortal(
                  <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />,
                  document.body
                )}
                <motion.div
                  ref={userMenuRef}
                  tabIndex={-1}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                  className="absolute right-0 top-full mt-2 w-64 overflow-hidden rounded-app-lg border border-border-strong bg-surface-1/95 shadow-app-md z-50"
                >
                  <div className="border-b border-border-subtle p-4">
                    <div className="font-semibold text-text-primary">{displayName}</div>
                    <div className="truncate text-sm text-text-secondary">
                      {email || 'No email'}
                    </div>
                  </div>

                  {isManager && (
                    <div className="p-2">
                      <button
                        type="button"
                        onClick={() => {
                          setShowUserMenu(false);
                          onTabChange?.('settings');
                        }}
                        className="flex w-full items-center gap-3 rounded-app-md px-3 py-2.5 text-text-primary transition-colors hover:bg-white/5"
                      >
                        <User className="w-4 h-4 text-text-secondary" />
                        Profile
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowUserMenu(false);
                          onTabChange?.('settings');
                        }}
                        className="flex w-full items-center gap-3 rounded-app-md px-3 py-2.5 text-text-primary transition-colors hover:bg-white/5"
                      >
                        <Settings className="w-4 h-4 text-text-secondary" />
                        Settings
                      </button>
                    </div>
                  )}

                  <div className="border-t border-border-subtle p-2">
                    <button
                      type="button"
                      onClick={() => setShowSignOutConfirm(true)}
                      className="flex w-full items-center gap-3 rounded-app-md px-3 py-2.5 text-danger transition-colors hover:bg-white/5"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign Out
                    </button>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>

      {showSignOutConfirm &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="signout-title"
          >
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setShowSignOutConfirm(false)}
              aria-hidden="true"
            />
            <div
              ref={signOutRef}
              tabIndex={-1}
              className="relative z-[101] flex h-72 w-72 flex-col rounded-app-lg border border-border-strong bg-surface-1 p-5 shadow-app-md"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="signout-title" className="text-base font-semibold text-text-primary">
                Sign out?
              </h2>
              <p className="mt-2 flex-1 text-xs leading-snug text-text-secondary">
                Are you sure you want to sign out? You will need to sign in again to access your
                account.
              </p>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowSignOutConfirm(false)}
                  className="flex-1 rounded-app-md border border-border-strong bg-white/10 px-3 py-2 text-xs font-medium text-text-primary hover:bg-white/20"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSignOutConfirm}
                  className="flex-1 rounded-app-md bg-danger px-3 py-2 text-xs font-medium text-white hover:bg-danger/90"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      <CommandPalette
        open={paletteOpen}
        onOpenChange={handlePaletteOpenChange}
        onTabChange={(tab) => onTabChange?.(tab)}
        isManager={isManager}
      />
    </nav>
  );
}
