import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { AlertCircle, Check, CircleStop } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ShiftsApiError, type Shift, type ShiftSurveyInput } from '@/lib/api';
import {
  FIELD_ORDER,
  NOTE_MAX,
  OBJECTION_LABEL,
  OBJECTION_ORDER,
  QUALITY_HINT,
  SLOWED_LABEL,
  SLOWED_ORDER,
  clearDraft,
  describeClockError,
  loadDraft,
  saveDraft,
  toSurveyInput,
  validateSurvey,
  type SurveyDraft,
  type SurveyField,
} from './clockModel';
import { ACTIVITY_LABEL, fmtRange, fmtTime } from './shiftFormat';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shift: Shift;
  tz: string;
  /** Throws on failure (the dialog shows the message and keeps the draft). */
  onSubmit: (survey?: ShiftSurveyInput) => Promise<void>;
  /** Where focus goes when the dialog closes (the End shift button that opened it). */
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** End shift. A dialing shift asks four quick questions first; any other shift just confirms.
 *  Cancel keeps the shift running, and typed answers survive a close until the shift is ended. */
export function EndShiftDialog(props: Props) {
  const { open, onOpenChange, shift, tz, returnFocusRef } = props;
  const isMobile = useBreakpoint() === 'mobile';
  const dialing = shift.activity === 'dialing';
  const title = dialing
    ? 'End your shift'
    : `End your ${ACTIVITY_LABEL[shift.activity].toLowerCase()} shift`;
  const description = `${fmtRange(shift.startsAt, shift.endsAt, tz)}${
    shift.clockedInAt ? ` · started ${fmtTime(shift.clockedInAt, tz)}` : ''
  }`;
  const body = (
    <EndForm key={shift.id} {...props} dialing={dialing} onClose={() => onOpenChange(false)} />
  );
  const restoreFocus = (e: Event) => {
    e.preventDefault();
    returnFocusRef.current?.focus();
  };

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          onCloseAutoFocus={restoreFocus}
          className="max-h-[92dvh] gap-0 overflow-hidden rounded-t-app-lg border-border-subtle bg-surface-1 p-0 text-text-primary"
        >
          <SheetHeader className="border-b border-border-subtle px-4 py-3 text-left">
            <SheetTitle className="text-section-title text-text-primary">{title}</SheetTitle>
            <SheetDescription className="text-meta text-text-secondary">
              {description}
            </SheetDescription>
          </SheetHeader>
          {open && body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={restoreFocus}
        className="hd-touch flex max-h-[90dvh] flex-col gap-0 overflow-hidden border-border-subtle bg-surface-1 p-0 text-text-primary sm:max-w-xl"
      >
        <DialogHeader className="border-b border-border-subtle px-6 py-4 text-left">
          <DialogTitle className="text-section-title text-text-primary">{title}</DialogTitle>
          <DialogDescription className="text-meta text-text-secondary">
            {description}
          </DialogDescription>
        </DialogHeader>
        {open && body}
      </DialogContent>
    </Dialog>
  );
}

function EndForm({
  shift,
  dialing,
  onSubmit,
  onClose,
}: Props & { dialing: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState<SurveyDraft>(() => loadDraft(shift.id));
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<SurveyField, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (dialing) saveDraft(shift.id, draft);
  }, [dialing, draft, shift.id]);

  const set = <K extends keyof SurveyDraft>(k: K, v: SurveyDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setServerErrors((s) => {
      const { [k as SurveyField]: _gone, ...rest } = s;
      return rest;
    });
    setError(null);
  };

  const errors = { ...(showErrors ? validateSurvey(draft) : {}), ...serverErrors };
  const noErrors = !FIELD_ORDER.some((f) => errors[f]);

  const submit = async () => {
    if (submitting) return;
    if (dialing) {
      const found = validateSurvey(draft);
      const first = FIELD_ORDER.find((f) => found[f]);
      if (first) {
        setShowErrors(true);
        // Move to the first thing that needs an answer.
        requestAnimationFrame(() =>
          formRef.current
            ?.querySelector<HTMLElement>(
              `[data-field="${first}"] [tabindex="0"], [data-field="${first}"] textarea`
            )
            ?.focus()
        );
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(dialing ? toSurveyInput(draft) : undefined);
      if (dialing) clearDraft(shift.id);
      onClose();
    } catch (e) {
      if (e instanceof ShiftsApiError && e.code === 'bad_survey') {
        const field = String(e.details.field ?? '') as SurveyField;
        if (FIELD_ORDER.includes(field)) {
          setServerErrors({ [field]: 'Check this answer and try again.' });
          setShowErrors(true);
        }
      }
      setError(describeClockError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
        {dialing ? (
          <>
            <p className="text-meta text-text-secondary">
              Four quick questions about today&apos;s calls. Your manager reads these.
            </p>

            <Question n={1} field="topObjection" label="Top objection today" error={undefined}>
              <ChipGroup
                label="Top objection today"
                options={OBJECTION_ORDER.map((v) => ({ value: v, label: OBJECTION_LABEL[v] }))}
                value={draft.topObjection}
                onChange={(v) => set('topObjection', v)}
                invalid={!!errors.topObjection}
              />
              {errors.topObjection && (
                <p role="alert" className="text-meta text-danger">
                  {errors.topObjection}
                </p>
              )}
              <NoteField
                id="survey-objection-note"
                field="objectionNote"
                label="How did you handle it?"
                placeholder="What you said back, and how it landed."
                value={draft.objectionNote}
                onChange={(v) => set('objectionNote', v)}
                error={errors.objectionNote}
              />
            </Question>

            <Question
              n={2}
              field="whatWorked"
              label="What worked best today?"
              error={undefined}
              hint="The opener, line or rebuttal that kept someone on the phone."
            >
              <NoteField
                id="survey-worked"
                field="whatWorked"
                label="What worked best today?"
                hideLabel
                placeholder="Write it the way you said it."
                value={draft.whatWorked}
                onChange={(v) => set('whatWorked', v)}
                error={errors.whatWorked}
              />
            </Question>

            <Question n={3} field="slowedBy" label="What slowed you down?" error={errors.slowedBy}>
              <ChipGroup
                label="What slowed you down?"
                options={SLOWED_ORDER.map((v) => ({ value: v, label: SLOWED_LABEL[v] }))}
                value={draft.slowedBy}
                onChange={(v) => set('slowedBy', v)}
                invalid={!!errors.slowedBy}
              />
              {draft.slowedBy && draft.slowedBy !== 'nothing' && (
                <NoteField
                  id="survey-slowed-note"
                  field="slowedNote"
                  label="What happened?"
                  placeholder="A sentence is plenty."
                  value={draft.slowedNote}
                  onChange={(v) => set('slowedNote', v)}
                  error={errors.slowedNote}
                />
              )}
            </Question>

            <Question
              n={4}
              field="listQuality"
              label="List quality"
              error={errors.listQuality}
              hint="1 = poor, 5 = great"
            >
              <QualityScale
                value={draft.listQuality}
                onChange={(v) => set('listQuality', v)}
                invalid={!!errors.listQuality}
              />
            </Question>
          </>
        ) : (
          <p className="text-body text-text-primary">
            End this shift now? There&apos;s nothing to fill in for it.
          </p>
        )}

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-app-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-body text-text-primary"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div>{error}</div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-1 px-4 py-3 sm:px-6">
        {dialing && showErrors && !noErrors && (
          <span className="mr-auto text-meta text-danger" role="status">
            A few answers are missing.
          </span>
        )}
        <Button type="button" variant="fe-ghost" onClick={onClose} disabled={submitting}>
          Keep working
        </Button>
        <Button type="submit" variant="primary" loading={submitting}>
          {!submitting && (dialing ? <Check /> : <CircleStop />)}
          {dialing ? 'Submit and end shift' : 'End shift'}
        </Button>
      </div>
    </form>
  );
}

function Question({
  n,
  field,
  label,
  hint,
  error,
  children,
}: {
  n: number;
  field: SurveyField;
  label: string;
  hint?: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0 space-y-2.5" data-field={field}>
      <legend className="mb-0.5 flex items-baseline gap-2 text-body font-medium text-text-primary">
        <span className="text-meta text-text-muted" aria-hidden>
          {n}
        </span>
        {label}
      </legend>
      {hint && <p className="-mt-1 text-meta text-text-muted">{hint}</p>}
      {children}
      {error && (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

const chipClass = (on: boolean, invalid: boolean) =>
  cn(
    'rounded-full border px-3 py-1.5 text-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-to/60',
    on
      ? 'border-accent-to/50 bg-accent-to/15 text-text-primary'
      : 'border-border-subtle bg-white/[0.03] text-text-secondary hover:border-border-default hover:text-text-primary',
    !on && invalid && 'border-danger/40'
  );

/** Single-select chips as a radio group: one tab stop, arrows move and select. */
function ChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  invalid,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
  invalid: boolean;
}) {
  const stop = value ?? options[0].value;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === (value ?? stop));
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = options[(i + step + options.length) % options.length];
    onChange(next.value);
    e.currentTarget.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-invalid={invalid || undefined}
      onKeyDown={onKey}
      className="flex flex-wrap gap-2"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-value={o.value}
          tabIndex={o.value === stop ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={chipClass(value === o.value, invalid)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 1 to 5 as one segmented control. */
function QualityScale({
  value,
  onChange,
  invalid,
}: {
  value: number | null;
  onChange: (v: number) => void;
  invalid: boolean;
}) {
  const stop = value ?? 1;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const next = Math.min(5, Math.max(1, (value ?? 0) + dir));
    onChange(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div>
      <div
        role="radiogroup"
        aria-label="List quality, 1 is poor and 5 is great"
        aria-invalid={invalid || undefined}
        onKeyDown={onKey}
        className={cn(
          'grid grid-cols-5 overflow-hidden rounded-app-md border',
          invalid ? 'border-danger/40' : 'border-border-subtle'
        )}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n}, ${QUALITY_HINT[n]}`}
            data-value={n}
            tabIndex={n === stop ? 0 : -1}
            onClick={() => onChange(n)}
            className={cn(
              'text-metric border-l border-border-subtle py-2 text-body font-medium transition-colors first:border-l-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-to/60',
              value === n
                ? 'bg-accent-to/20 text-text-primary'
                : 'bg-white/[0.03] text-text-secondary hover:text-text-primary'
            )}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-meta text-text-muted" aria-hidden>
        <span>Poor</span>
        <span>Great</span>
      </div>
    </div>
  );
}

function NoteField({
  id,
  field,
  label,
  hideLabel,
  placeholder,
  value,
  onChange,
  error,
}: {
  id: string;
  field: SurveyField;
  label: string;
  hideLabel?: boolean;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  error: string | undefined;
}) {
  const len = value.trim().length;
  return (
    <div data-field={field}>
      <label
        htmlFor={id}
        className={cn(
          'mb-1 block text-meta font-medium text-text-secondary',
          hideLabel && 'sr-only'
        )}
      >
        {label}
      </label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={NOTE_MAX}
        placeholder={placeholder}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        className="min-h-[64px]"
      />
      {error ? (
        <p id={`${id}-err`} role="alert" className="mt-1 text-meta text-danger">
          {error}
        </p>
      ) : (
        len > NOTE_MAX - 60 && (
          <p className="mt-1 text-meta text-text-muted">
            {value.length} / {NOTE_MAX}
          </p>
        )
      )}
    </div>
  );
}
