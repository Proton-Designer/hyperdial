import { CalendarRange } from 'lucide-react';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';

/** TASK-F01 stub. Coverage, Requests, Shift KPIs and Setup land in TASK-F04..F06. */
export function TeamShifts() {
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader title="Team Shifts" description="Coverage, requests and shift results." />
      <EmptyState
        icon={CalendarRange}
        title="Team Shifts is on its way"
        body="Coverage, requests and results will appear here."
      />
    </div>
  );
}
