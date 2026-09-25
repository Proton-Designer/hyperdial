import { useEffect, useState } from 'react';
import { Phone, Loader2, CheckCircle2 } from 'lucide-react';
import { cn } from '@/components/ui/utils';

type ContactState = 'dialing' | 'connecting' | 'connected';

interface ContactBatchCardProps {
  name: string;
  phone: string;
  state: ContactState;
  /** Only meaningful for the one line that's `connected` -- the other lines have no per-line
   *  answer timestamp of their own (they're either still ringing or being AMD-checked). */
  answeredAt?: string | null;
}

const STATE_CHIP: Record<ContactState, { label: string; className: string }> = {
  dialing: { label: 'Ringing', className: 'bg-surface-3 text-text-secondary' },
  connecting: { label: 'Answered', className: 'bg-warning-soft text-warning' },
  connected: { label: 'Connected', className: 'bg-success-soft text-success' },
};

function useElapsed(answeredAt: string | null | undefined): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!answeredAt) {
      setSeconds(0);
      return;
    }
    const answeredAtMs = new Date(answeredAt).getTime();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - answeredAtMs) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [answeredAt]);
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export function ContactBatchCard({ name, phone, state, answeredAt }: ContactBatchCardProps) {
  const chip = STATE_CHIP[state];
  const elapsed = useElapsed(state === 'connected' ? answeredAt : null);

  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-body font-semibold text-text-primary truncate">{name}</h4>
          <p className="text-meta text-text-secondary truncate">{phone}</p>
        </div>
        {state === 'dialing' ? (
          <Loader2 className="w-4 h-4 text-text-muted animate-spin flex-shrink-0" />
        ) : state === 'connecting' ? (
          <Loader2 className="w-4 h-4 text-warning animate-spin flex-shrink-0" />
        ) : (
          <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
        )}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-meta font-medium',
            chip.className
          )}
        >
          {chip.label}
        </span>
        {state === 'connected' && (
          <span className="text-meta text-text-secondary tabular-nums flex items-center gap-1">
            <Phone className="w-3 h-3" />
            {elapsed}
          </span>
        )}
      </div>
    </div>
  );
}
