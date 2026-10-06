import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { updateShiftSettings, type ShiftSettings } from '@/lib/api';
import { FieldLabel, SetupCard, WEEKDAYS, describeSetupError } from './setupUi';

type NumKey =
  | 'minWeeklyHours'
  | 'changeNoticeHours'
  | 'graceMinutes'
  | 'conversationMinSeconds'
  | 'idleFlagMinutes'
  | 'adherenceFlagPct'
  | 'openSessionTailMinutes'
  | 'powerCoverageAlert'
  | 'powerWeekPct';

interface NumField {
  key: NumKey;
  label: string;
  unit: string;
  hint: string;
  min: number;
  max?: number;
  step?: number;
}

const WEEKLY: NumField[] = [
  {
    key: 'minWeeklyHours',
    label: 'Weekly minimum',
    unit: 'hours',
    hint: 'What each intern commits to every week. A light week can lower it.',
    min: 0,
    max: 80,
    step: 0.5,
  },
  {
    key: 'changeNoticeHours',
    label: 'Change notice',
    unit: 'hours',
    hint: 'A change asked for closer than this to the shift is marked late.',
    min: 0,
    max: 168,
  },
];

const TRACKING: NumField[] = [
  {
    key: 'graceMinutes',
    label: 'Grace period',
    unit: 'minutes',
    hint: 'How long after a shift starts before a late start counts.',
    min: 0,
    max: 120,
  },
  {
    key: 'conversationMinSeconds',
    label: 'Conversation length',
    unit: 'seconds',
    hint: 'A connected call at least this long counts as a conversation.',
    min: 0,
    max: 600,
  },
  {
    key: 'idleFlagMinutes',
    label: 'Idle flag',
    unit: 'minutes',
    hint: 'A gap between calls longer than this is flagged.',
    min: 0,
    max: 240,
  },
  {
    key: 'adherenceFlagPct',
    label: 'Adherence flag',
    unit: '%',
    hint: 'Shifts with less active dialing than this are flagged.',
    min: 0,
    max: 100,
  },
  {
    key: 'openSessionTailMinutes',
    label: 'Session tail',
    unit: 'minutes',
    hint: 'Dialing this long after a shift ends still counts toward it.',
    min: 0,
    max: 60,
  },
];

const COVERAGE: NumField[] = [
  {
    key: 'powerCoverageAlert',
    label: 'Coverage alert',
    unit: 'people',
    hint: 'A high leverage slot with fewer people than this shows red on Coverage.',
    min: 0,
    max: 50,
  },
  {
    key: 'powerWeekPct',
    label: 'Power week',
    unit: '% in high leverage windows',
    hint: 'An intern earns a Power week by dialing at least this share in those windows.',
    min: 0,
    max: 100,
  },
];

const ALL = [...WEEKLY, ...TRACKING, ...COVERAGE];

interface Draft {
  nums: Record<NumKey, string>;
  lockWeekday: number;
  lockTime: string;
  ghlCalendarId: string;
  ghlOwnerUserId: string;
}

const toDraft = (s: ShiftSettings): Draft => ({
  nums: Object.fromEntries(ALL.map((f) => [f.key, String(s[f.key])])) as Record<NumKey, string>,
  lockWeekday: s.lockWeekday,
  lockTime: s.lockTime,
  ghlCalendarId: s.ghlCalendarId ?? '',
  ghlOwnerUserId: s.ghlOwnerUserId ?? '',
});

/** Every shift setting, grouped, with units. Saves only what changed. */
export function SettingsForm({
  settings,
  onSaved,
}: {
  settings: ShiftSettings;
  onSaved: () => void;
}) {
  const initial = useMemo(() => toDraft(settings), [settings]);
  const [d, setD] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const fieldError = (f: NumField): string | null => {
    const raw = d.nums[f.key].trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) return 'Enter a number.';
    if (n < f.min) return `At least ${f.min}.`;
    if (f.max !== undefined && n > f.max) return `At most ${f.max}.`;
    return null;
  };
  const errors = ALL.filter((f) => fieldError(f) !== null);
  const timeBad = !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.lockTime);
  const canSave = errors.length === 0 && !timeBad;

  const save = async () => {
    setSaving(true);
    setError(null);
    const patch: Partial<ShiftSettings> = {};
    for (const f of ALL) {
      if (d.nums[f.key] !== initial.nums[f.key]) patch[f.key] = Number(d.nums[f.key]);
    }
    if (d.lockWeekday !== initial.lockWeekday) patch.lockWeekday = d.lockWeekday;
    if (d.lockTime !== initial.lockTime) patch.lockTime = d.lockTime;
    if (d.ghlCalendarId !== initial.ghlCalendarId)
      patch.ghlCalendarId = d.ghlCalendarId.trim() || null;
    if (d.ghlOwnerUserId !== initial.ghlOwnerUserId)
      patch.ghlOwnerUserId = d.ghlOwnerUserId.trim() || null;
    try {
      await updateShiftSettings(patch);
      toast.success('Settings saved');
      onSaved();
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setSaving(false);
    }
  };

  const num = (f: NumField) => {
    const err = d.nums[f.key] !== initial.nums[f.key] ? fieldError(f) : null;
    return (
      <FieldLabel key={f.key} label={f.label} hint={f.hint} htmlFor={`ss-${f.key}`} error={err}>
        <div className="flex items-center gap-2">
          <Input
            id={`ss-${f.key}`}
            type="number"
            inputMode="decimal"
            min={f.min}
            max={f.max}
            step={f.step ?? 1}
            value={d.nums[f.key]}
            aria-invalid={err !== null}
            onChange={(e) => {
              setError(null);
              setD((x) => ({ ...x, nums: { ...x.nums, [f.key]: e.target.value } }));
            }}
            className="h-9 w-24"
          />
          <span className="text-meta text-text-muted">{f.unit}</span>
        </div>
      </FieldLabel>
    );
  };

  return (
    <SetupCard
      title="Settings"
      description="Rules for weekly picks, shift tracking and coverage. Times use your team's time zone."
      dirty={dirty}
      saving={saving}
      canSave={canSave}
      onSave={() => void save()}
      onReset={() => setD(initial)}
    >
      <div className="space-y-6">
        <Group title="Weekly picks">
          <div className="grid gap-4 sm:grid-cols-2">
            {WEEKLY.map(num)}
            <FieldLabel
              label="Picks close"
              hint={`Interns lock next week's picks at this time (${settings.timezone}).`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={String(d.lockWeekday)}
                  onValueChange={(v) => setD((x) => ({ ...x, lockWeekday: Number(v) }))}
                >
                  <SelectTrigger size="sm" className="w-36" aria-label="Deadline weekday">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((w) => (
                      <SelectItem key={w.n} value={String(w.n)}>
                        {w.long}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-meta text-text-muted">at</span>
                <Input
                  type="time"
                  step={60}
                  value={d.lockTime}
                  aria-label="Deadline time"
                  aria-invalid={timeBad}
                  onChange={(e) => setD((x) => ({ ...x, lockTime: e.target.value }))}
                  className="h-8 w-32"
                />
              </div>
            </FieldLabel>
          </div>
        </Group>
        <Group title="Shift tracking">
          <div className="grid gap-4 sm:grid-cols-2">{TRACKING.map(num)}</div>
        </Group>
        <Group title="Coverage and recognition">
          <div className="grid gap-4 sm:grid-cols-2">{COVERAGE.map(num)}</div>
        </Group>
        <Group title="GoHighLevel">
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldLabel
              label="Calendar ID"
              hint="Shifts appear as appointments on this GHL calendar. Leave empty to skip appointments."
              htmlFor="ss-cal"
            >
              <Input
                id="ss-cal"
                value={d.ghlCalendarId}
                onChange={(e) => setD((x) => ({ ...x, ghlCalendarId: e.target.value }))}
                placeholder="Paste the calendar ID"
                className="h-9"
              />
            </FieldLabel>
            <FieldLabel
              label="Owner user ID"
              hint="The GHL user the appointments are assigned to (optional)."
              htmlFor="ss-owner"
            >
              <Input
                id="ss-owner"
                value={d.ghlOwnerUserId}
                onChange={(e) => setD((x) => ({ ...x, ghlOwnerUserId: e.target.value }))}
                placeholder="Paste the user ID"
                className="h-9"
              />
            </FieldLabel>
          </div>
        </Group>
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
      </div>
    </SetupCard>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-meta font-medium uppercase tracking-wide text-text-muted">
        {title}
      </h3>
      {children}
    </div>
  );
}
