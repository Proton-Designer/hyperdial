import type { InputHTMLAttributes } from 'react';
import { cn } from '@/components/ui/utils';

/**
 * TASK-MOB2: a native checkbox inside a 44x44 hit area on touch widths. The visible box
 * stays 16-20px; only the tappable label grows (touch), so the desktop table is unchanged.
 * `stopRowClick` keeps a tap on the box from also opening the row it sits in.
 */
export function TapCheckbox({
  className,
  stopRowClick,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { stopRowClick?: boolean }) {
  return (
    <label
      className="inline-flex items-center justify-center flex-shrink-0 cursor-pointer touch:h-11 touch:w-11 touch:-m-2"
      onClick={stopRowClick ? (e) => e.stopPropagation() : undefined}
    >
      <input
        type="checkbox"
        className={cn(
          'rounded border-border-strong bg-surface-2 accent-[var(--accent-to)] touch:h-5 touch:w-5',
          className
        )}
        {...props}
      />
    </label>
  );
}
