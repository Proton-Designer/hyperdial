import type { ReactNode } from 'react';
import { cn } from '@/components/ui/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}

/**
 * Responsive page header: title + optional description on the left, an actions slot on the
 * right. Below `sm` the actions wrap under the title instead of squeezing beside it (FE-A
 * mobile requirement).
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="text-page-title text-text-primary truncate">{title}</h1>
        {description && <p className="text-body text-text-secondary mt-1">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
