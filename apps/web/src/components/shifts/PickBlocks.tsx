import { Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/components/ui/utils';
import type { ShiftActivity } from '@/lib/api';
import { ACTIVITY_LABEL, fmtHours } from './shiftFormat';
import {
  ACTIVITY_FILL,
  ACTIVITY_ORDER,
  SLOT,
  WEEKDAY_SHORT,
  minRangeLabel,
  namesOnDuring,
  slotPowerMinutes,
  type Headcount,
  type PickBlock,
  type PickDay,
} from './pickerModel';

function blockPower(day: PickDay | undefined, b: PickBlock): number {
  if (!day) return 0;
  let n = 0;
  for (let s = b.startMin; s < b.endMin; s += SLOT) n += slotPowerMinutes(day, s);
  return n;
}

interface PickBlocksProps {
  blocks: PickBlock[];
  days: PickDay[];
  headcount: Headcount;
  onActivity: (block: PickBlock, activity: ShiftActivity) => void;
  onRemove: (block: PickBlock) => void;
  /** Show the weekday in each row (desktop panel); the phone day view groups by day already. */
  showDay?: boolean;
  className?: string;
}

/** The "Your picks" list: one row per merged block with its time, activity dropdown and remove. */
export function PickBlocks({
  blocks,
  days,
  headcount,
  onActivity,
  onRemove,
  showDay = true,
  className,
}: PickBlocksProps) {
  return (
    <ul className={cn('space-y-2', className)}>
      {blocks.map((b) => {
        const day = days.find((d) => d.date === b.date);
        const power = blockPower(day, b);
        const others = namesOnDuring(headcount, b.date, b.startMin, b.endMin);
        const label = `${day ? day.short : ''} ${minRangeLabel(b.startMin, b.endMin)}`.trim();
        return (
          <li
            key={`${b.date}-${b.startMin}`}
            className="rounded-app-md border border-border-subtle bg-surface-2 p-2.5"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn('h-8 w-1 shrink-0 rounded-full', ACTIVITY_FILL[b.activity])}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="text-metric text-body font-medium text-text-primary">
                  {showDay && day ? (
                    <span className="mr-1.5 text-text-secondary">
                      {WEEKDAY_SHORT[day.isoWeekday - 1]}
                    </span>
                  ) : null}
                  {minRangeLabel(b.startMin, b.endMin)}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-meta text-text-muted">
                  <span>{fmtHours((b.endMin - b.startMin) / 60)}</span>
                  {power > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-warning">
                      <Zap className="h-3 w-3" /> {fmtHours(power / 60)} high leverage
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="fe-ghost"
                size="icon"
                className="size-8"
                onClick={() => onRemove(b)}
                aria-label={`Remove ${label}`}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="mt-2 pl-3">
              <Select value={b.activity} onValueChange={(v) => onActivity(b, v as ShiftActivity)}>
                <SelectTrigger size="sm" className="w-full" aria-label={`Activity for ${label}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTIVITY_ORDER.map((a) => (
                    <SelectItem key={a} value={a}>
                      {ACTIVITY_LABEL[a]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {others.length > 0 && (
              <p className="mt-1.5 pl-3 text-meta text-text-muted">
                Also on:{' '}
                <span className="text-text-secondary">{others.slice(0, 4).join(', ')}</span>
                {others.length > 4 && ` +${others.length - 4} more`}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
