import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/components/ui/utils';

interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  /** Rendered top-right of the header, next to the title -- stays visible/clickable even while
   *  the section is collapsed (e.g. a "Purchase numbers" button that shouldn't require expanding
   *  the section first). */
  actions?: ReactNode;
  children: ReactNode;
}

/** TASK-U2: shared collapsible group for a Settings tab's cards. A real <button> via Radix's
 *  Collapsible (aria-expanded + keyboard handling come from the primitive, not hand-rolled here),
 *  a rotating chevron, and consistent header spacing -- introduced to fix the Telephony tab's
 *  "Spend & Billing" title sitting flush under the card above it (no shared vertical rhythm
 *  between cards) by giving every group the SAME header/content gap instead of each card
 *  spacing itself. */
export function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = false,
  actions,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-8">
      <div className="flex items-start justify-between gap-4">
        <CollapsibleTrigger asChild>
          <button type="button" className="flex items-start gap-2 text-left min-w-0">
            <ChevronDown
              className={cn(
                'w-4 h-4 mt-1 text-text-secondary shrink-0 transition-transform duration-150',
                !open && '-rotate-90'
              )}
            />
            <span className="min-w-0">
              <span className="text-section-title text-text-primary block">{title}</span>
              {subtitle && (
                <span className="text-meta text-text-secondary block mt-1">{subtitle}</span>
              )}
            </span>
          </button>
        </CollapsibleTrigger>
        {actions && <div className="shrink-0 pt-0.5">{actions}</div>}
      </div>
      <CollapsibleContent className="mt-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}
