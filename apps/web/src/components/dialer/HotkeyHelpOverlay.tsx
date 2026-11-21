import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: 'M', label: 'Mute / unmute the live call' },
  { keys: 'H', label: 'Hold / resume the live call' },
  { keys: 'Space', label: 'Resume dialing while paused' },
  { keys: '?', label: 'Show / hide this help' },
];

interface HotkeyHelpOverlayProps {
  onClose: () => void;
}

/** TASK-T7: triggered by the global "?" hotkey (see Dialer.tsx). Same portal/focus-trap/
 *  backdrop-click shape as StopConfirmDialog -- plus its own Escape handler (this is the only
 *  overlay Dialer.tsx renders, so a small self-contained handler here reads cleaner than
 *  TopNavigation's shared multi-popover one). */
export function HotkeyHelpOverlay({ onClose }: HotkeyHelpOverlayProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="hd-touch fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="hotkey-help-title"
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-sm rounded-app-lg border border-border-subtle bg-surface-1 p-5 shadow-app-md outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id="hotkey-help-title" className="text-page-title text-text-primary">
            Keyboard shortcuts
          </h2>
          <Button
            type="button"
            variant="fe-secondary"
            aria-label="Close"
            onClick={onClose}
            className="p-1.5"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
        <dl className="flex flex-col gap-2">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between gap-4">
              <dt className="text-body text-text-secondary">{s.label}</dt>
              <dd className="rounded-app-sm border border-border-subtle bg-surface-2 px-2 py-0.5 text-meta font-mono text-text-primary">
                {s.keys}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-meta text-text-muted mt-4">
          Shortcuts are disabled while typing in a text field, and only apply during a parallel
          dialing session.
        </p>
      </motion.div>
    </div>,
    document.body
  );
}
