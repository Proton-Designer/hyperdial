import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/utils';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'rounded-app-lg border border-border-subtle bg-surface-1 p-12 text-center',
        className
      )}
    >
      <Icon className="w-10 h-10 text-text-muted mx-auto mb-4" />
      <div className="text-text-primary font-medium mb-1">{title}</div>
      {body && <p className="text-sm text-text-secondary max-w-sm mx-auto">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
