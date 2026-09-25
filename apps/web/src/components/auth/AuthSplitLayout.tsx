import type { ReactNode } from 'react';
import { Logo } from '@/components/brand/Logo';
import { ConvergeBackground } from '@/components/brand/ConvergeBackground';

/**
 * FE-B: shared chrome for Auth/Invite/Reset -- a brand panel on the left (logo mark, tagline, the
 * converge background) on desktop, form-only on mobile with the full logo lockup on top. `children`
 * is just the form card; each screen still owns its own card content/states.
 */
export function AuthSplitLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex bg-surface-0 overflow-hidden">
      <div className="hidden lg:flex lg:w-[55%] relative overflow-hidden">
        <ConvergeBackground />
        <div className="relative z-10 flex flex-col justify-center px-16 max-w-xl">
          <Logo size={44} wordmarkClassName="text-3xl" className="mb-8" />
          <h1 className="text-4xl font-semibold text-text-primary leading-tight mb-4">
            Stop waiting on rings.
            <br />
            Start collecting conversations.
          </h1>
          <p className="text-body text-text-secondary max-w-md">
            Dial multiple lines at once — the first human answer connects you, the rest hang up
            automatically.
          </p>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-surface-0 to-transparent" />
      </div>

      <div className="w-full lg:w-[45%] flex items-center justify-center p-6 sm:p-8">
        <div className="w-full max-w-[440px]">
          <div className="mb-8 flex justify-center lg:hidden">
            <Logo size={40} wordmarkClassName="text-2xl" />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
