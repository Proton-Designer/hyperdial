import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { ShiftsApiError } from '@/lib/api';

/** A titled Setup section with an optional save bar that only lights up when there is something
 *  to save. */
export function SetupCard({
  title,
  description,
  children,
  dirty,
  saving,
  canSave = true,
  onSave,
  onReset,
  saveLabel = 'Save changes',
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  dirty?: boolean;
  saving?: boolean;
  canSave?: boolean;
  onSave?: () => void;
  onReset?: () => void;
  saveLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-app-lg border border-border-subtle bg-surface-1">
      <header className="flex flex-wrap items-start gap-3 border-b border-border-subtle px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-section-title text-text-primary">{title}</h2>
          {description && <p className="mt-0.5 text-meta text-text-secondary">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="px-4 py-4 sm:px-5">{children}</div>
      {onSave && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-4 py-3 sm:px-5">
          <span className="mr-auto text-meta text-text-muted" aria-live="polite">
            {dirty ? 'Unsaved changes' : ''}
          </span>
          {onReset && dirty && (
            <Button variant="fe-ghost" size="sm" onClick={onReset} disabled={saving}>
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={!dirty || !canSave || saving}
            loading={saving}
          >
            {!saving && <Check />} {saveLabel}
          </Button>
        </footer>
      )}
    </section>
  );
}

export function FieldLabel({
  label,
  hint,
  htmlFor,
  children,
  className,
  error,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  error?: string | null;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-meta font-medium text-text-secondary">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-meta text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-meta text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** Server refusal for a Setup save, in a sentence. */
export function describeSetupError(e: unknown): string {
  if (e instanceof ShiftsApiError) {
    switch (e.code) {
      case 'forbidden':
        return 'Only an owner or admin can change this.';
      case 'unauthorized':
        return 'Sign in again to continue.';
      case 'bad_request':
        if (e.details.reason === 'ghl_contact_in_use')
          return 'That GoHighLevel contact is already linked to another member.';
        return 'One of the values isn’t valid. Check the highlighted fields.';
      case 'ghl_not_connected':
        return 'GoHighLevel isn’t connected for this team. Connect it in Settings → Integrations.';
    }
  }
  return e instanceof Error ? e.message : 'Could not save. Try again.';
}

export const WEEKDAYS = [
  { n: 1, short: 'Mon', long: 'Monday' },
  { n: 2, short: 'Tue', long: 'Tuesday' },
  { n: 3, short: 'Wed', long: 'Wednesday' },
  { n: 4, short: 'Thu', long: 'Thursday' },
  { n: 5, short: 'Fri', long: 'Friday' },
  { n: 6, short: 'Sat', long: 'Saturday' },
  { n: 7, short: 'Sun', long: 'Sunday' },
];
