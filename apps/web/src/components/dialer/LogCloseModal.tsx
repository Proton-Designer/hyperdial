import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { LogCloseForm, type LogCloseFormProps } from './LogCloseForm';
import { useCloseDraft } from '@/lib/closeDraft';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface LogCloseModalProps extends Omit<LogCloseFormProps, 'scroll' | 'onClose'> {
  onClose: () => void;
}

/**
 * TASK-H03: the "Log Close" dialog (opened from the wrap-up window). The form itself is LogCloseForm, shared with the
 * inline panel on the live-call screen (TASK-H13), so a draft typed during the call is already here. Dismissible:
 * closing is never mandatory.
 */
export function LogCloseModal({ onClose, ...form }: LogCloseModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);
  const { state } = useCloseDraft(form.draftKey, form.name, form.phone);
  const submitting = state.submitting;

  return createPortal(
    <div
      ref={modalRef}
      className="fixed inset-0 flex items-center justify-center p-4 outline-none"
      style={{ zIndex: 10001 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="logclose-title"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Keep Enter/digits/Escape from reaching any listener of a modal underneath (WrapUpModal).
        e.stopPropagation();
        if (e.key === 'Escape' && !submitting) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/70" aria-hidden="true" />
      <div className="relative z-[1] w-full max-w-lg max-h-[92vh] flex flex-col rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md">
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle p-4">
          <div className="min-w-0">
            <h2 id="logclose-title" className="text-page-title text-text-primary">
              Log close
            </h2>
            <p className="text-body text-text-secondary mt-1 truncate">
              {form.name || 'Unknown contact'} · {form.phone}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={submitting}
            className="shrink-0 p-1 text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <LogCloseForm {...form} onClose={onClose} scroll />
      </div>
    </div>,
    document.body
  );
}
