import type { ReactNode } from 'react';
import { AuthProvider } from '@/contexts/AuthContext';

/** Dev harnesses only: some dialer components call useAuth(); the real provider (no sign-in needed) satisfies it. */
export function DevAuth({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
