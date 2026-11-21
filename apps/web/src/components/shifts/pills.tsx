import type { ReactNode } from 'react';
import { cn } from '@/components/ui/utils';
import type { ShiftRequestStatus, ShiftStatus } from '@/lib/api';

export type PillTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const TONE: Record<PillTone, string> = {
  neutral: 'bg-white/5 text-text-secondary border-border-subtle',
  accent: 'bg-accent-to/10 text-accent-to border-accent-to/20',
  success: 'bg-success-soft text-success border-success/20',
  warning: 'bg-warning-soft text-warning border-warning/20',
  danger: 'bg-danger-soft text-danger border-danger/20',
};

/** Small status/tag pill on the dark theme's soft-tint tokens. Not the shadcn Badge: that one's
 *  variants are the light-theme defaults and don't carry the app's success/warning/danger tints. */
export function Pill({
  tone = 'neutral',
  icon,
  children,
  className,
}: {
  tone?: PillTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-4 [&>svg]:h-3 [&>svg]:w-3',
        TONE[tone],
        className
      )}
    >
      {icon}
      {children}
    </span>
  );
}

const SHIFT_STATUS: Record<ShiftStatus, { label: string; tone: PillTone }> = {
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'success' },
  missed: { label: 'Missed', tone: 'danger' },
  excused: { label: 'Excused', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export function ShiftStatusPill({ status }: { status: ShiftStatus }) {
  const s = SHIFT_STATUS[status];
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

const REQUEST_STATUS: Record<ShiftRequestStatus, { label: string; tone: PillTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  denied: { label: 'Denied', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

export function RequestStatusPill({ status }: { status: ShiftRequestStatus }) {
  const s = REQUEST_STATUS[status];
  return <Pill tone={s.tone}>{s.label}</Pill>;
}
