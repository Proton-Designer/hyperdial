import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ShiftsApiError, getShiftsWeek } from '@/lib/api';
import { useOrg } from '@/contexts/OrgContext';

interface ShiftsContextValue {
  /** null while unknown (loading) -- treated as "off" by the nav so the tab never flashes in. */
  enabled: boolean | null;
  refresh: () => void;
}

const ShiftsContext = createContext<ShiftsContextValue>({
  enabled: null,
  refresh: () => undefined,
});

/** Fetches once per org/role whether Shifts is switched on for this org (`shifts-week-get`
 *  answers 409 `shifts_disabled` when it isn't). Any other failure (backend not deployed yet,
 *  offline) also keeps the tab hidden -- a hidden tab is the safe default. */
export function ShiftsProvider({ children }: { children: ReactNode }) {
  const { role } = useOrg();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!role) return;
    let cancelled = false;
    getShiftsWeek()
      .then((r) => !cancelled && setEnabled(r.settings.enabled))
      .catch((e) => {
        if (cancelled) return;
        setEnabled(false);
        if (!(e instanceof ShiftsApiError)) console.warn('shifts: enabled check failed', e);
      });
    return () => {
      cancelled = true;
    };
  }, [role, nonce]);

  const value = useMemo(() => ({ enabled, refresh }), [enabled, refresh]);
  return <ShiftsContext.Provider value={value}>{children}</ShiftsContext.Provider>;
}

export function useShiftsEnabled(): boolean {
  return useContext(ShiftsContext).enabled === true;
}
