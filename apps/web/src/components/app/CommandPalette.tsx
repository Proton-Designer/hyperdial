import { useEffect, useRef, useState } from 'react';
import { contactHeadline } from '@/lib/contactName';
import {
  LayoutGrid,
  Phone,
  Users,
  Target,
  BarChart3,
  Settings as SettingsIcon,
  User2,
} from 'lucide-react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { listContacts, listCampaigns, type Contact, type CampaignWithStats } from '@/lib/api';
import type { TabType } from '../MainApp';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: TabType) => void;
  isManager: boolean;
}

interface ScreenEntry {
  tab: TabType;
  label: string;
  icon: typeof LayoutGrid;
  managerOnly?: boolean;
}

const SCREENS: ScreenEntry[] = [
  { tab: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
  { tab: 'dialer', label: 'Dialer', icon: Phone },
  { tab: 'contacts', label: 'Contacts', icon: Users },
  { tab: 'campaigns', label: 'Campaigns', icon: Target, managerOnly: true },
  { tab: 'analytics', label: 'Analytics', icon: BarChart3, managerOnly: true },
  { tab: 'settings', label: 'Settings', icon: SettingsIcon },
];

function contactLabel(c: Contact): string {
  const headline = contactHeadline(c);
  return headline !== '—' ? headline : c.phone_raw || c.phone_number || 'Contact';
}

/**
 * FE-A / closes B1-006: the top-nav search box used to be purely decorative (no value/onChange
 * at all). This is a real command palette -- jumps to screens, searches contacts and campaigns
 * through the existing api.ts calls (the same listContacts/listCampaigns Contacts.tsx and
 * Campaigns.tsx already use; there's no dedicated search endpoint yet, so this filters
 * client-side the same way those screens' own search boxes already do). Lists are fetched once
 * per open (not per keystroke) and cached for the rest of that session while the app stays
 * mounted, since neither list changes shape mid-search.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onTabChange,
  isManager,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignWithStats[] | null>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    listContacts()
      .then(setContacts)
      .catch(() => setContacts([]));
    if (isManager) {
      listCampaigns()
        .then(setCampaigns)
        .catch(() => setCampaigns([]));
    }
  }, [open, isManager]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const go = (tab: TabType) => {
    onTabChange(tab);
    onOpenChange(false);
  };

  const q = query.trim().toLowerCase();
  const matchedContacts = (contacts ?? []).filter((c) => {
    if (!q) return false;
    return (
      contactLabel(c).toLowerCase().includes(q) ||
      (c.phone_raw ?? '').toLowerCase().includes(q) ||
      (c.phone_number ?? '').toLowerCase().includes(q)
    );
  });
  const matchedCampaigns = (campaigns ?? []).filter((c) => q && c.name.toLowerCase().includes(q));

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a screen, or search contacts and campaigns"
    >
      <CommandInput
        placeholder="Jump to a screen, or search contacts and campaigns…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Go to">
          {SCREENS.filter((s) => isManager || !s.managerOnly).map((s) => (
            <CommandItem key={s.tab} value={`go-${s.label}`} onSelect={() => go(s.tab)}>
              <s.icon />
              {s.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {matchedContacts.length > 0 && (
          <CommandGroup heading="Contacts">
            {matchedContacts.slice(0, 8).map((c) => (
              <CommandItem key={c.id} value={`contact-${c.id}`} onSelect={() => go('contacts')}>
                <User2 />
                <span className="truncate">{contactLabel(c)}</span>
                {(c.phone_raw || c.phone_number) && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {c.phone_raw ?? c.phone_number}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {matchedCampaigns.length > 0 && (
          <CommandGroup heading="Campaigns">
            {matchedCampaigns.slice(0, 8).map((c) => (
              <CommandItem key={c.id} value={`campaign-${c.id}`} onSelect={() => go('campaigns')}>
                <Target />
                <span className="truncate">{c.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

/** ⌘K / Ctrl+K to open, from anywhere in the app shell. */
export function useCommandPaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpen]);
}
