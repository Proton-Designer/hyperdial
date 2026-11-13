import type { InputHTMLAttributes } from 'react';
import { cn } from '@/components/ui/utils';

/**
 * TASK-MOB2: a native checkbox inside a 44x44 hit area on touch widths. The visible box
 * stays 16-20px; only the tappable label grows (max-lg), so the desktop table is unchanged.
 * `stopRowClick` keeps a tap on the box from also opening the row it sits in.
 */
export function TapCheckbox({
  className,
  stopRowClick,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { stopRowClick?: boolean }) {
  return (
    <label
      className="flex items-center justify-center flex-shrink-0 cursor-pointer max-lg:h-11 max-lg:w-11 max-lg:-m-2"
      onClick={stopRowClick ? (e) => e.stopPropagation() : undefined}
    >
      <input
        type="checkbox"
        className={cn(
          'rounded border-border-strong bg-surface-2 accent-[var(--accent-to)] max-lg:h-5 max-lg:w-5',
          className
        )}
        {...props}
      />
    </label>
  );
}
