import { Voicemail } from 'lucide-react';
import { useVoicemailDropSummary } from '@/lib/useVoicemailDropStatus';
import { cn } from '@/components/ui/utils';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * TASK-H34d: one always-visible line, "Voicemail drop: Recorded (0:24) - Change" or "Not recorded - Record one",
 * linking to Settings -> Voicemail drop. Shows the agent's own drop, else the team default.
 */
export function VoicemailDropStatusRow({
  enabled = true,
  label = 'Voicemail drop',
  onOpen,
  className,
}: {
  enabled?: boolean;
  label?: string;
  onOpen?: () => void;
  className?: string;
}) {
  const { status, source, seconds } = useVoicemailDropSummary(enabled);
  if (status === 'loading' || status === 'error') return null;
  const length = seconds ? ` (${fmt(seconds)})` : '';
  const text =
    status === 'none'
      ? 'Not recorded'
      : source === 'mine'
        ? `Recorded${length}`
        : `Team default${length}`;
  const action =
    status === 'none' ? 'Record one' : source === 'team' ? 'Record your own' : 'Change';
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-text-secondary',
        className
      )}
    >
      <Voicemail className="w-4 h-4 shrink-0" aria-hidden />
      <span>
        {label}: <span className="text-text-primary">{text}</span>
      </span>
      {onOpen && (
        <button
          type="button"
          className="text-accent-to underline underline-offset-2 touch:min-h-11"
          onClick={onOpen}
        >
          {action}
        </button>
      )}
    </div>
  );
}
