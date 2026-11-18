import { useEffect, useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { useOrg } from '@/contexts/OrgContext';
import {
  getNumberHealthBadges,
  getNumberHealthStats,
  runNumberHealthCheck,
  type NumberHealthBadge,
  type NumberHealthStat,
} from '@/lib/api';

/**
 * MISSION-4 TASK-T9 (CID-4) + TASK-H35: one plain badge per number (Good / Watch / At risk, or
 * "Not enough calls yet") with a one-line reason, details behind a tap, an on-demand health check, and
 * a "Protect your numbers" box. For Settings -> Telephony -> Numbers, owner/admin only (an agent never
 * sees this: the health check rests numbers org-wide).
 *
 * The badge is defined once in SQL (`number_health_badges`) from free signals only: this week's
 * answer rate against the number's own earlier baseline and the pool median, quick hang-ups, and calls
 * per day. It is NOT a carrier spam label; the box at the bottom says how to check those for free.
 */
const LEVEL_UI: Record<NumberHealthBadge['level'], { label: string; chip: string }> = {
  good: { label: 'Good', chip: 'bg-success/10 text-success' },
  watch: { label: 'Watch', chip: 'bg-warning/10 text-warning' },
  at_risk: { label: 'At risk', chip: 'bg-danger/10 text-danger' },
  unknown: { label: 'Not enough calls yet', chip: 'bg-surface-3 text-text-secondary' },
};

const pct = (rate: number | null) => (rate == null ? '—' : `${Math.round(rate * 100)}%`);
const secs = (s: number | null) => (s == null ? '—' : `${Math.round(s)}s`);

export function NumberHealthPanel() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';
  const [badges, setBadges] = useState<NumberHealthBadge[]>([]);
  const [stats, setStats] = useState<Record<string, NumberHealthStat>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [lastCheckMessage, setLastCheckMessage] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(false);
    Promise.all([getNumberHealthBadges(), getNumberHealthStats()])
      .then(([b, s]) => {
        setBadges(b);
        setStats(Object.fromEntries(s.map((x) => [x.number_id, x])));
      })
      .catch((e) => {
        console.error('Failed to load number health', e);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);

  if (!isAdmin) return null;

  const handleCheckNow = async () => {
    setChecking(true);
    setCheckError(false);
    setLastCheckMessage(null);
    try {
      const flagged = await runNumberHealthCheck();
      setLastCheckMessage(
        flagged.length === 0
          ? 'No numbers flagged -- every number is within a healthy range of the pool median.'
          : `${flagged.length} number${flagged.length === 1 ? '' : 's'} flagged and auto-rested: ` +
              flagged.map((f) => f.phoneNumber).join(', ')
      );
      load();
    } catch (e) {
      console.error('Number health check failed', e);
      setCheckError(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-4xl mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="text-section-title text-text-primary">Number health</h3>
        <button
          type="button"
          onClick={() => void handleCheckNow()}
          disabled={checking}
          className="hd-touch text-sm px-3 py-1.5 rounded-app-md border border-border-subtle text-text-primary hover:bg-surface-2 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Run check now'}
        </button>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        A quick read on each number from your own call data: this week&apos;s answer rate against
        its earlier weeks and your other numbers, people hanging up right away, and how many calls a
        day it makes. Too many calls from one number is the most common reason it gets labelled as
        spam. This is not a carrier spam label; see &quot;Protect your numbers&quot; below. Numbers
        far below the pool median are rested automatically when alerts are turned on.
      </p>

      {checkError && (
        <div
          role="alert"
          className="mb-4 p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm"
        >
          The health check didn&apos;t run. Check your connection and try again.
        </div>
      )}
      {lastCheckMessage && (
        <div className="mb-4 p-3 rounded-app-md bg-surface-2 border border-border-subtle text-text-secondary text-sm">
          {lastCheckMessage}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : loadError ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-text-secondary">
          <span>Couldn&apos;t load number health. Check your connection and try again.</span>
          <button
            type="button"
            onClick={load}
            className="hd-touch px-3 py-1.5 rounded-app-md border border-border-subtle text-text-primary hover:bg-surface-2"
          >
            Try again
          </button>
        </div>
      ) : badges.length === 0 ? (
        <p className="text-sm text-text-secondary">No numbers in the pool yet.</p>
      ) : (
        <ul className="space-y-2">
          {badges.map((b) => {
            const ui = LEVEL_UI[b.level];
            const st = stats[b.number_id];
            const open = openId === b.number_id;
            return (
              <li
                key={b.number_id}
                className="rounded-app-md border border-border-subtle bg-surface-2/40"
              >
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : b.number_id)}
                  className="hd-touch flex w-full items-start gap-3 p-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text-primary">{b.phone_number}</span>
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', ui.chip)}>
                        {ui.label}
                      </span>
                      {b.status === 'resting' && (
                        <span className="text-xs text-text-secondary">Resting</span>
                      )}
                    </div>
                    <div className="mt-1 text-meta text-text-secondary">{b.reason}</div>
                  </div>
                  <ChevronDown
                    className={cn(
                      'mt-1 h-4 w-4 flex-shrink-0 text-text-secondary transition-transform',
                      open && 'rotate-180'
                    )}
                    aria-hidden
                  />
                </button>
                {open && (
                  <div className="border-t border-border-subtle p-3 space-y-3">
                    {b.reasons.length > 1 && (
                      <ul className="list-disc pl-5 text-meta text-text-secondary space-y-0.5">
                        {b.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    )}
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-meta text-text-secondary sm:grid-cols-3">
                      <Detail label="Answer rate this week" value={pct(b.answer_rate_7d)} />
                      <Detail label="Earlier weeks" value={pct(b.answer_rate_prior)} />
                      <Detail label="Pool median" value={pct(b.pool_median_7d)} />
                      <Detail label="Quick hang-ups" value={pct(b.quick_hangup_share)} />
                      <Detail
                        label="Calls / day (busiest)"
                        value={`${b.peak_day_dials} (cap ${b.daily_cap})`}
                      />
                      <Detail
                        label="Dials 7d / 30d"
                        value={`${b.dials_7d} / ${st?.dials_30d ?? '—'}`}
                      />
                      <Detail label="Avg talk 30d" value={secs(st?.avg_talk_seconds_30d ?? null)} />
                    </dl>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-6 rounded-app-md border border-border-subtle bg-surface-2/40 p-4">
        <h4 className="text-sm font-semibold text-text-primary mb-1">Protect your numbers</h4>
        <p className="text-meta text-text-secondary mb-3">
          Phone carriers label calls using three analytics companies. You can register your numbers
          with all three for free. It improves how your calls look; it doesn&apos;t guarantee they
          won&apos;t be labelled.
        </p>
        <ol className="list-decimal pl-5 space-y-1 text-meta text-text-secondary mb-3">
          <li>
            Open the free registry and enter your business name and each phone number you dial from.
          </li>
          <li>
            Use the same business name everywhere, and set it as the caller name (CNAM) for the
            number with your phone provider.
          </li>
          <li>
            Come back to this page after a week of calling: the badges above show whether the answer
            rate held up.
          </li>
        </ol>
        <a
          href="https://www.freecallerregistry.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-accent-from hover:underline touch:min-h-11"
        >
          Open freecallerregistry.com
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="text-sm text-text-primary">{value}</dd>
    </div>
  );
}
