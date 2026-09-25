import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, PhoneOff, Grid3x3 } from 'lucide-react';
import { DialerIdle } from './DialerIdle';
import { ActiveCall } from './ActiveCall';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { UserPhoneNumber } from '../Dialer';
import type { DialerStatus } from '../Dialer';

interface ManualDialPanelProps {
  userNumbers: UserPhoneNumber[];
  selectedFromNumber: string | null;
  onSelectNumber: (phoneNumber: string) => void;
  onDial: (phoneNumber: string) => void;
  dialerStatus: DialerStatus;
  error: string | null;
  outboundNumber: string;
  callDurationFormatted: string;
  onEndCall: () => void;
  onMuteChange: (muted: boolean) => void;
  onNavigateToSettings?: () => void;
}

/**
 * FE-B: the single-line manual dialer used to be always-on-screen real estate even though the
 * new session-first Dialer treats a parallel campaign session as the default path. Collapsed by
 * default on tablet/desktop (a disclosure), a bottom Sheet on mobile -- but forced open the
 * moment a manual call is actually in progress (`dialerStatus !== 'idle'`) so an active call is
 * never hidden behind a collapsed/closed panel, regardless of the user's last toggle state.
 */
export function ManualDialPanel(props: ManualDialPanelProps) {
  const {
    userNumbers,
    selectedFromNumber,
    onSelectNumber,
    onDial,
    dialerStatus,
    error,
    outboundNumber,
    callDurationFormatted,
    onEndCall,
    onMuteChange,
    onNavigateToSettings,
  } = props;
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === 'mobile';
  const [open, setOpen] = useState(false);
  const forcedOpen = dialerStatus !== 'idle';
  const effectiveOpen = open || forcedOpen;

  const content = (
    <AnimatePresence mode="wait">
      {dialerStatus === 'idle' && (
        <DialerIdle
          key="idle"
          userNumbers={userNumbers}
          selectedFromNumber={selectedFromNumber}
          onSelectNumber={onSelectNumber}
          onDial={onDial}
          isDialing={false}
          error={error}
          onNavigateToSettings={onNavigateToSettings}
        />
      )}

      {dialerStatus === 'dialing' && (
        <motion.div
          key="dialing"
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          className="max-w-sm mx-auto"
        >
          <div className="text-center p-6 rounded-app-lg bg-surface-1 border border-accent-to/25">
            <h2 className="text-section-title text-text-primary mb-1">
              Connecting to {outboundNumber}
              <span className="animate-pulse">...</span>
            </h2>
            <p className="text-body text-text-secondary mb-5">Ringing</p>
            <Button variant="danger-ghost" onClick={onEndCall}>
              <PhoneOff className="w-4 h-4" />
              End call
            </Button>
          </div>
        </motion.div>
      )}

      {dialerStatus === 'connected' && (
        <ActiveCall
          key="connected"
          outboundNumber={outboundNumber}
          fromNumber={selectedFromNumber || ''}
          duration={callDurationFormatted}
          onEndCall={onEndCall}
          onMuteChange={onMuteChange}
        />
      )}
    </AnimatePresence>
  );

  if (isMobile) {
    return (
      <Sheet open={effectiveOpen} onOpenChange={(next) => !forcedOpen && setOpen(next)}>
        <div className="max-w-3xl mx-auto">
          <Button variant="fe-secondary" size="sm" onClick={() => setOpen(true)} className="w-full">
            <Grid3x3 className="w-4 h-4" />
            Manual dial
          </Button>
        </div>
        <SheetContent side="bottom" className="bg-surface-1 border-border-subtle max-h-[85vh]">
          <SheetHeader>
            <SheetTitle className="text-text-primary">Manual dial</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6 overflow-y-auto">{content}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div className="max-w-3xl mx-auto mt-8 rounded-app-lg border border-border-subtle bg-surface-1">
      <button
        type="button"
        onClick={() => !forcedOpen && setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3 text-left"
        aria-expanded={effectiveOpen}
      >
        <span className="text-section-title text-text-primary flex items-center gap-2">
          <Grid3x3 className="w-4 h-4 text-text-muted" />
          Manual dial
        </span>
        <ChevronDown
          className={`w-4 h-4 text-text-muted transition-transform ${effectiveOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {effectiveOpen && (
        <div className="px-5 pb-6 border-t border-border-subtle pt-5">{content}</div>
      )}
    </div>
  );
}
