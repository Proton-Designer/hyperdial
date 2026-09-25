import { Skeleton } from '@/components/ui/skeleton';
import { StatCardSkeleton } from './StatCard';
import { cn } from '@/components/ui/utils';

/** A single line of placeholder text, sized like a real line so nothing shifts once it resolves. */
export function TextLineSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn('h-4 w-full', className)} />;
}

export { StatCardSkeleton };

/** One row of a dense table -- a row of even-width cells matching a typical column count. */
export function TableRowSkeleton({ columns = 5 }: { columns?: number }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-border-subtle last:border-0">
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton key={i} className={cn('h-4', i === 0 ? 'w-1/4' : 'flex-1')} />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 overflow-hidden">
      {Array.from({ length: rows }).map((_, i) => (
        <TableRowSkeleton key={i} columns={columns} />
      ))}
    </div>
  );
}

/** A card-shaped list row (contacts/campaigns cards, dispositions list, team members, ...). */
export function ListCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-app-lg border border-border-subtle bg-surface-1 p-4',
        className
      )}
    >
      <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-8 w-16 rounded-app-sm flex-shrink-0" />
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <ListCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function StatGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <StatCardSkeleton key={i} />
      ))}
    </div>
  );
}
