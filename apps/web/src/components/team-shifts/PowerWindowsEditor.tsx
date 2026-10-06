import { useState } from 'react';
import { Plus, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/components/ui/utils';
import { upsertPowerWindow, type ShiftPowerWindow } from '@/lib/api';
import { hhmmToMin, minToHhmm } from '../shifts/pickerModel';
import { TimeSelect } from './OpenHoursEditor';
import { SetupCard, WEEKDAYS, describeSetupError } from './setupUi';

interface Draft {
  /** undefined until the first save of a new window. */
  id?: string;
  label: string;
  isoWeekdays: number[];
  start: number;
  end: number;
  active: boolean;
}

const fromWindow = (w: ShiftPowerWindow): Draft => ({
  id: w.id,
  label: w.label,
  isoWeekdays: [...w.isoWeekdays].sort(),
  start: hhmmToMin(w.startTime),
  end: hhmmToMin(w.endTime),
  active: w.active,
});

/** High leverage windows: the times the team most wants covered. Each window saves on its own. */
export function PowerWindowsEditor({
  windows,
  onSaved,
}: {
  windows: ShiftPowerWindow[];
  onSaved: () => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <SetupCard
      title="High leverage windows"
      description="Times worth covering. Interns see them highlighted when they pick, and coverage flags a window with too few people. Changes apply to future picks; existing shifts in weeks that haven't started are recalculated."
      actions={
        <Button variant="fe-secondary" size="sm" onClick={() => setAdding(true)} disabled={adding}>
          <Plus /> Add window
        </Button>
      }
    >
      <ul className="space-y-3">
        {windows.map((w) => (
          <li key={w.id}>
            <WindowRow key={JSON.stringify(w)} initial={fromWindow(w)} onSaved={onSaved} />
          </li>
        ))}
        {adding && (
          <li>
            <WindowRow
              initial={{
                label: '',
                isoWeekdays: [1, 2, 3, 4, 5],
                start: 9 * 60,
                end: 11 * 60,
                active: true,
              }}
              isNew
              onSaved={() => {
                setAdding(false);
                onSaved();
              }}
              onCancel={() => setAdding(false)}
            />
          </li>
        )}
        {windows.length === 0 && !adding && (
          <li className="text-body text-text-secondary">
            No windows yet. Add one to highlight the busiest hours.
          </li>
        )}
      </ul>
    </SetupCard>
  );
}

function WindowRow({
  initial,
  isNew,
  onSaved,
  onCancel,
}: {
  initial: Draft;
  isNew?: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = isNew || JSON.stringify(d) !== JSON.stringify(initial);
  const labelErr = d.label.trim() === '' ? 'Give the window a name.' : null;
  const timeErr = d.end <= d.start ? 'End after the start.' : null;
  const dayErr = d.isoWeekdays.length === 0 ? 'Choose at least one day.' : null;
  const valid = !labelErr && !timeErr && !dayErr;

  const patch = (p: Partial<Draft>) => {
    setError(null);
    setD((x) => ({ ...x, ...p }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await upsertPowerWindow({
        ...(d.id ? { id: d.id } : {}),
        label: d.label.trim(),
        isoWeekdays: d.isoWeekdays,
        startTime: minToHhmm(d.start),
        endTime: minToHhmm(d.end),
        active: d.active,
      });
      toast.success(isNew ? 'Window added' : 'Window saved');
      onSaved();
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        'rounded-app-md border bg-surface-2 p-3',
        d.active ? 'border-border-subtle' : 'border-border-subtle opacity-70'
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Zap className="h-4 w-4 shrink-0 text-warning" />
        <Input
          value={d.label}
          onChange={(e) => patch({ label: e.target.value })}
          aria-label="Window name"
          aria-invalid={dirty && !!labelErr}
          placeholder="Name, e.g. Morning"
          maxLength={40}
          className="h-8 w-44"
        />
        <TimeSelect label="Window start" value={d.start} onChange={(v) => patch({ start: v })} />
        <span className="text-meta text-text-muted">to</span>
        <TimeSelect label="Window end" value={d.end} min={30} onChange={(v) => patch({ end: v })} />
        <label className="ml-auto flex items-center gap-2 text-meta text-text-secondary">
          <Switch
            checked={d.active}
            onCheckedChange={(v) => patch({ active: v })}
            aria-label="Window active"
          />
          {d.active ? 'Active' : 'Off'}
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Days">
        {WEEKDAYS.map((w) => {
          const on = d.isoWeekdays.includes(w.n);
          return (
            <button
              key={w.n}
              type="button"
              aria-pressed={on}
              aria-label={w.long}
              onClick={() =>
                patch({
                  isoWeekdays: on
                    ? d.isoWeekdays.filter((x) => x !== w.n)
                    : [...d.isoWeekdays, w.n].sort(),
                })
              }
              className={cn(
                'h-8 min-w-11 rounded-full border px-3 text-meta font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-to/60',
                on
                  ? 'border-accent-to/50 bg-accent-from/25 text-text-primary'
                  : 'border-border-subtle text-text-secondary hover:border-border-strong'
              )}
            >
              {w.short}
            </button>
          );
        })}
      </div>
      {dirty && (labelErr || timeErr || dayErr) && (
        <p className="mt-2 text-meta text-danger">{labelErr ?? timeErr ?? dayErr}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-body text-danger">
          {error}
        </p>
      )}
      {(dirty || isNew) && (
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="fe-ghost"
            size="sm"
            onClick={() => (onCancel ? onCancel() : setD(initial))}
            disabled={saving}
          >
            {isNew ? 'Cancel' : 'Discard'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={!valid || saving}
            loading={saving}
          >
            {isNew ? 'Add window' : 'Save window'}
          </Button>
        </div>
      )}
    </div>
  );
}
