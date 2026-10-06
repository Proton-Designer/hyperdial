import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Shift, ShiftsWeekResponse } from '@/lib/api';
import { fmtShiftWhen } from './shiftFormat';

export interface RequestChangeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The shift the intern clicked "Request change" on; null for a week-level request. */
  shift: Shift | null;
  week: ShiftsWeekResponse;
  /** Called after a request is created so the parent can refresh its data. */
  onSubmitted: () => void;
}

/** TASK-F01 stub: the real type picker, time picker, reason counter and live warnings land in
 *  TASK-F03. The props above are the contract F03 fills in, so MyShifts doesn't change. */
export function RequestChangeModal({ open, onOpenChange, shift, week }: RequestChangeModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border-subtle bg-surface-1 text-text-primary">
        <DialogHeader>
          <DialogTitle>Request a change</DialogTitle>
          <DialogDescription className="text-text-secondary">
            {shift
              ? fmtShiftWhen(shift.startsAt, shift.endsAt, week.week.timezone)
              : 'Change your hours for this week'}
          </DialogDescription>
        </DialogHeader>
        <p className="text-body text-text-secondary">Change requests are coming soon.</p>
      </DialogContent>
    </Dialog>
  );
}
