import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import {
  getGhlFieldCoverage,
  type GhlFieldCoverage,
  type GhlFieldCoverageGroup,
  type GhlFieldCoverageItem,
} from '@/lib/api';

const TYPE_LABEL: Record<string, string> = {
  TEXT: 'Single line text',
  LARGE_TEXT: 'Large text',
  NUMERICAL: 'Number',
  SINGLE_OPTIONS: 'Dropdown (single)',
  DATE: 'Date',
};

function statusText(i: GhlFieldCoverageItem, group: 'provider' | 'intern'): string {
  if (i.status === 'ready') {
    if (i.issues.includes('type')) return `Found, but GHL type is ${i.ghlType ?? 'different'}`;
    if (i.issues.includes('options'))
      return `Found, missing option: ${i.missingOptions.join(', ')}`;
    return 'Ready';
  }
  if (i.status === 'missing_in_ghl') return 'Mapped, but the field is gone from GHL';
  if (i.status === 'not_mapped')
    return group === 'provider' ? 'Not mapped in field mapping' : 'Not created';
  return 'Not created in GHL';
}

function Row({ item, group }: { item: GhlFieldCoverageItem; group: 'provider' | 'intern' }) {
  const ready = item.status === 'ready';
  const warn = ready && item.issues.length > 0;
  return (
    <li className="flex items-start gap-2 py-1.5">
      {warn ? (
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" aria-hidden />
      ) : ready ? (
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-success" aria-hidden />
      ) : (
        <Circle className="w-4 h-4 mt-0.5 shrink-0 text-text-muted" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm text-white break-words">
          {item.label} <code className="text-xs text-text-muted">{item.key}</code>
        </div>
        <div className="text-xs text-text-secondary">
          {TYPE_LABEL[item.type] ?? item.type}
          {item.options ? ` — options: ${item.options.join(' · ')}` : ''}
        </div>
        <div className={`text-xs ${ready && !warn ? 'text-success' : 'text-text-secondary'}`}>
          {statusText(item, group)}
        </div>
      </div>
    </li>
  );
}

function Section({
  title,
  hint,
  group,
  kind,
}: {
  title: string;
  hint: string;
  group: GhlFieldCoverageGroup;
  kind: 'provider' | 'intern';
}) {
  return (
    <details className="mb-3 rounded-app border border-white/10 bg-surface-2 px-3 py-2">
      <summary className="cursor-pointer text-sm text-white">
        {title}{' '}
        <span className="text-text-secondary">
          — {group.ready} of {group.total} ready
        </span>
      </summary>
      <p className="text-xs text-text-secondary mt-2">{hint}</p>
      <ul className="mt-1 divide-y divide-white/5">
        {group.items.map((i) => (
          <Row key={i.key} item={i} group={kind} />
        ))}
      </ul>
    </details>
  );
}

/**
 * TASK-G17: Settings -> GoHighLevel -> "Field coverage". Owner/admin only (the parent renders it only
 * for them; the endpoint enforces it too). A read-only checklist of every field HyperDial pushes and
 * whether it exists in this org's GoHighLevel.
 */
export function GhlFieldCoverageCard() {
  const [data, setData] = useState<GhlFieldCoverage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getGhlFieldCoverage());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to check GHL fields');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-xl mt-6">
      <h3 className="text-white font-medium mb-1">Field coverage</h3>
      <p className="text-sm text-text-secondary mb-4">
        HyperDial skips any field that does not exist in GoHighLevel yet — nothing breaks, the data
        just is not sent. This checks which of the fields it sends are set up. It only reads; create
        missing fields in GoHighLevel.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 className="w-4 h-4 animate-spin" /> Checking GoHighLevel...
        </div>
      )}

      {error && !loading && (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-danger">{error}</p>
          <button type="button" onClick={load} className="text-xs text-accent-to hover:underline">
            Try again
          </button>
        </div>
      )}

      {data && !loading && (
        <>
          <p className="text-sm text-white mb-3" aria-live="polite">
            {data.ready} of {data.total} fields ready
            <button
              type="button"
              onClick={load}
              className="ml-3 text-xs text-accent-to hover:underline"
            >
              Check again
            </button>
          </p>
          {data.total === 0 ? (
            <p className="text-sm text-text-secondary">No fields to check.</p>
          ) : (
            <>
              <Section
                title="Provider contact (calls)"
                hint="Each field must also be mapped in the field mapping above (press Suggest, or paste its id)."
                group={data.provider}
                kind="provider"
              />
              <Section
                title="Intern contact (shifts)"
                hint="Matched by field key: create the field with the exact key shown (GHL shows it as contact.<key>)."
                group={data.intern}
                kind="intern"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
