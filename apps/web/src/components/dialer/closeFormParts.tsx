import type { CloseFrequency } from '@/lib/api';

/** TASK-H03/H29: the Log Close field pieces, shared by LogCloseForm and the public pro form. */
export const FREQUENCIES: { value: CloseFrequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'monthly', label: 'Monthly' },
];

export const INPUT =
  'w-full rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to';

/** Picked chips + the free-text box (comma separated), trimmed and de-duplicated (case-insensitive). */
export function mergeServices(picked: string[], draft: string): string[] {
  const out: string[] = [];
  for (const raw of [...picked, ...draft.split(',')]) {
    const t = raw.trim();
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-body border transition-colors ${
        selected
          ? 'bg-accent-to/20 border-accent-to text-text-primary'
          : 'bg-surface-2 border-border-subtle text-text-secondary hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  /** Only the public pro form marks fields required; Log close asks for nothing (TASK-H28). */
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-meta text-text-secondary mb-1.5">
        {label}
        {required && <span className="text-danger"> *</span>}
      </div>
      {children}
      {hint && <p className="text-meta text-text-muted mt-1">{hint}</p>}
    </div>
  );
}
