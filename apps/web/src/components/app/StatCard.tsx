import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Info } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface StatCardProps {
  label: string;
  value: ReactNode;
  subtext?: ReactNode;
  delta?: ReactNode;
  icon?: LucideIcon;
  tooltip?: string;
  loading?: boolean;
  className?: string;
}

/**
 * Compact metric card (FE-A: <=110px tall, replacing the old ~220px hero-tile shape). A label
 * (with an optional info tooltip), a big tabular value, an optional subtext/delta line, and a
 * small icon -- plus its own skeleton state so a screen's first load never has to hand-roll one.
 */
export function StatCard({
  label,
  value,
  subtext,
  delta,
  icon: Icon,
  tooltip,
  loading,
  className,
}: StatCardProps) {
  if (loading) return <StatCardSkeleton className={className} />;

  return (
    <div
      className={cn(
        'rounded-app-lg border border-border-subtle bg-surface-1 p-4 shadow-app-sm',
        'flex flex-col justify-between gap-2 h-full max-h-[110px]',
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-meta text-text-secondary">
          <span className="truncate">{label}</span>
          {tooltip && (
            <span title={tooltip}>
              <Info className="w-3 h-3 text-text-muted cursor-help flex-shrink-0" />
            </span>
          )}
        </div>
        {Icon && <Icon className="w-4 h-4 text-text-muted flex-shrink-0" />}
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="text-metric text-2xl font-semibold text-text-primary leading-none truncate">
          {value}
        </div>
        {delta}
      </div>
      {subtext && <div className="text-meta text-text-muted truncate">{subtext}</div>}
    </div>
  );
}

export function StatCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-app-lg border border-border-subtle bg-surface-1 p-4 max-h-[110px]',
        'flex flex-col justify-between gap-2',
        className
      )}
    >
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-4 rounded" />
      </div>
      <Skeleton className="h-7 w-16" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}
