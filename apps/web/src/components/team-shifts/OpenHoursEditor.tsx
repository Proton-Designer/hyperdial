import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/components/ui/utils';
import { upsertOpenHours, type ShiftOpenHours } from '@/lib/api';
import { SLOT, hhmmToMin, minLabel, minToHhmm } from '../shifts/pickerModel';
import { SetupCard, WEEKDAYS, describeSetupError } from './setupUi';

type Row = { open: boolean; from: number; until: number };
type Draft = Record<number, Row>;

const DEFAULT_ROW: Row = { open: true, from: 7 * 60, until: 21 * 60 };
const LAST = 23 * 60 + 30;
const OPTIONS: number[] = [];
for (let m = 0; m <= 23 * 60 + 30; m += SLOT) OPTIONS.push(m);

function toDraft(hours: ShiftOpenHours[]): Draft {
  const d: Draft = {};
  for (const w of WEEKDAYS) {
    const h = hours.find((x) => x.isoWeekday === w.n);
    d[w.n] = h
      ? { open: true, from: hhmmToMin(h.openFrom), until: hhmmToMin(h.openUntil) }
      : { ...DEFAULT_ROW, open: false };
  }
  return d;
}

/** One row per weekday; switching a day off closes it (the row is removed on save). */
export function OpenHoursEditor({
  openHours,
  onSaved,
}: {
  openHours: ShiftOpenHours[];
  onSaved: () => void;
}) {
  const initial = useMemo(() => toDraft(openHours), [openHours]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const invalid = WEEKDAYS.some((w) => draft[w.n].open && draft[w.n].until <= draft[w.n].from);
  const anyOpen = WEEKDAYS.some((w) => draft[w.n].open);

  const set = (n: number, patch: Partial<Row>) => {
    setError(null);
    setDraft((d) => ({ ...d, [n]: { ...d[n], ...patch } }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await upsertOpenHours(
        WEEKDAYS.filter((w) => draft[w.n].open).map((w) => ({
          isoWeekday: w.n,
          openFrom: minToHhmm(draft[w.n].from),
          openUntil: minToHhmm(draft[w.n].until),
        }))
      );
      toast.success('Open hours saved');
      onSaved();
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SetupCard
      title="Open hours"
      description="The hours interns can pick shifts in, in 30-minute steps. Turn a day off to close it."
      dirty={dirty}
      saving={saving}
      canSave={!invalid && anyOpen}
      onSave={() => void save()}
      onReset={() => setDraft(initial)}
    >
      <ul className="divide-y divide-border-subtle">
        {WEEKDAYS.map((w) => {
          const row = draft[w.n];
          const bad = row.open && row.until <= row.from;
          return (
            <li key={w.n} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <label className="flex w-36 items-center gap-3">
                <Switch
                  checked={row.open}
                  onCheckedChange={(v) => set(w.n, { open: v })}
                  aria-label={`${w.long} open`}
                />
                <span
                  className={cn('text-body', row.open ? 'text-text-primary' : 'text-text-muted')}
                >
                  {w.long}
                </span>
              </label>
              {row.open ? (
                <div className="flex items-center gap-2">
                  <TimeSelect
                    label={`${w.long} opens`}
                    value={row.from}
                    max={LAST - SLOT}
                    onChange={(v) => set(w.n, { from: v })}
                  />
                  <span className="text-meta text-text-muted">to</span>
                  <TimeSelect
                    label={`${w.long} closes`}
                    value={row.until}
                    min={SLOT}
                    onChange={(v) => set(w.n, { until: v })}
                  />
                  {bad && <span className="text-meta text-danger">Close after it opens.</span>}
                </div>
              ) : (
                <span className="text-meta text-text-muted">Closed</span>
              )}
            </li>
          );
        })}
      </ul>
      {!anyOpen && <p className="mt-2 text-meta text-danger">Keep at least one day open.</p>}
      {error && (
        <p role="alert" className="mt-3 text-body text-danger">
          {error}
        </p>
      )}
    </SetupCard>
  );
}

export function TimeSelect({
  label,
  value,
  onChange,
  min = 0,
  max = 23 * 60 + 30,
  className,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  className?: string;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger size="sm" className={cn('w-[7.5rem]', className)} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-64">
        {OPTIONS.filter((m) => m >= min && m <= max).map((m) => (
          <SelectItem key={m} value={String(m)}>
            {minLabel(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
