import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ShiftsApiError, getShiftsWeek, type Shift } from '@/lib/api';
import { applyClock } from '@/components/shifts/clockModel';
import { useOrg } from '@/contexts/OrgContext';
import { useVisibilityPacedPolling } from '@/hooks/useVisibilityPacedPolling';

/** How often the cached current week is refreshed while the tab is visible. The "live shift" itself
 *  is derived from that cache with a local clock, so the dialer banner needs no faster polling. */
const WEEK_REFRESH_MS = 5 * 60 * 1000;

interface ShiftsContextValue {
  /** null while unknown (loading) -- treated as "off" by the nav so the tab never flashes in. */
  enabled: boolean | null;
  refresh: () => void;
  /** Swap in a shift the server just returned (after Start / End shift) without a refetch. */
  patchShift: (shift: Shift) => void;
  /** This week's shifts (every status) for the live-shift banner; empty until loaded. */
  myShifts: Shift[];
  /** The org's shift time zone (settings.timezone). */
  timezone: string;
  /** The caller is an intern, so "dialing outside a shift" is meaningful for them. */
  isIntern: boolean;
}

/** Exported only so the dev harness can feed the dialer banner fixtures. */
export const ShiftsContext = createContext<ShiftsContextValue>({
  enabled: null,
  refresh: () => undefined,
  patchShift: () => undefined,
  myShifts: [],
  timezone: 'America/Chicago',
  isIntern: false,
});

/** Fetches once per org/role whether Shifts is switched on for this org (`shifts-week-get`
 *  answers 409 `shifts_disabled` when it isn't). Any other failure (backend not deployed yet,
 *  offline) also keeps the tab hidden -- a hidden tab is the safe default. */
export function ShiftsProvider({ children }: { children: ReactNode }) {
  const { role } = useOrg();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [myShifts, setMyShifts] = useState<Shift[]>([]);
  const [timezone, setTimezone] = useState('America/Chicago');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const patchShift = useCallback(
    (s: Shift) => setMyShifts((list) => list.map((x) => (x.id === s.id ? applyClock(x, s) : x))),
    []
  );

  useEffect(() => {
    if (!role) return;
    let cancelled = false;
    getShiftsWeek()
      .then((r) => {
        if (cancelled) return;
        setEnabled(r.settings.enabled);
        setMyShifts(r.myShifts);
        setTimezone(r.settings.timezone);
      })
      .catch((e) => {
        if (cancelled) return;
        setEnabled(false);
        if (!(e instanceof ShiftsApiError)) console.warn('shifts: enabled check failed', e);
      });
    return () => {
      cancelled = true;
    };
  }, [role, nonce]);

  // Quiet refresh of the cached week (visibility-paced, only once Shifts is known to be on).
  useVisibilityPacedPolling(
    () => {
      getShiftsWeek()
        .then((r) => setMyShifts(r.myShifts))
        .catch(() => undefined);
    },
    WEEK_REFRESH_MS,
    false,
    enabled === true
  );

  const value = useMemo(
    () => ({ enabled, refresh, patchShift, myShifts, timezone, isIntern: role === 'agent' }),
    [enabled, refresh, patchShift, myShifts, timezone, role]
  );
  return <ShiftsContext.Provider value={value}>{children}</ShiftsContext.Provider>;
}

export function useShiftsEnabled(): boolean {
  return useContext(ShiftsContext).enabled === true;
}

/** Cached current-week shifts and whether the caller is an intern (for the dialer banner). */
export function useShiftsSnapshot(): {
  enabled: boolean;
  myShifts: Shift[];
  timezone: string;
  isIntern: boolean;
  refresh: () => void;
  patchShift: (shift: Shift) => void;
} {
  const { enabled, myShifts, timezone, isIntern, refresh, patchShift } = useContext(ShiftsContext);
  return { enabled: enabled === true, myShifts, timezone, isIntern, refresh, patchShift };
}
