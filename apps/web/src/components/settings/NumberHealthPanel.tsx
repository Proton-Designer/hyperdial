import { useEffect, useState } from 'react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { useOrg } from '@/contexts/OrgContext';
import { TapCheckbox } from '@/components/mobile/TapCheckbox';
import {
  getNumberHealthAutoRest,
  getNumberHealthBadges,
  getNumberHealthScores,
  getNumberHealthStats,
  runNumberHealthCheck,
  setNumberHealthAutoRest,
  setPhoneNumberStatus,
  type NumberHealthBadge,
  type NumberHealthScore,
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

/** TASK-H40: 70+ good, 40-69 so-so, under 40 poor. Null = not enough calls to judge. */
function scoreTone(score: number | null): string {
  if (score == null) return 'text-text-secondary';
  if (score >= 70) return 'text-success';
  if (score >= 40) return 'text-warning';
  return 'text-danger';
}

const SCORE_INFO: {
  key: 'answer_score' | 'stay_score' | 'history_score';
  label: string;
  meaning: string;
  empty: string;
}[] = [
  {
    key: 'answer_score',
    label: 'Answer',
    meaning: 'How often people pick up, compared with your other numbers and its own past weeks.',
    empty: 'Not enough calls this week',
  },
  {
    key: 'stay_score',
    label: 'Stays on the line',
    meaning: 'Of the people who answer, how many stay on for 10 seconds or more.',
    empty: 'Not enough answered calls yet',
  },
  {
    key: 'history_score',
    label: 'History',
    meaning:
      'How much calling history this number has in the last 30 days. More reads as more trusted.',
    empty: '',
  },
];

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
  const [scores, setScores] = useState<Record<string, NumberHealthScore>>({});
  const [autoRest, setAutoRest] = useState<{ enabled: boolean; days: number } | null>(null);
  const [autoRestBusy, setAutoRestBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(false);
    Promise.all([
      getNumberHealthBadges(),
      getNumberHealthStats(),
      getNumberHealthScores(),
      getNumberHealthAutoRest(),
    ])
      .then(([b, s, sc, ar]) => {
        setBadges(b);
        setStats(Object.fromEntries(s.map((x) => [x.number_id, x])));
        setScores(Object.fromEntries(sc.map((x) => [x.number_id, x])));
        setAutoRest(ar);
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

  const handleAutoRestToggle = async (next: boolean) => {
    setAutoRestBusy(true);
    setRowError(null);
    try {
      await setNumberHealthAutoRest(next);
      setAutoRest((cur) => (cur ? { ...cur, enabled: next } : cur));
    } catch (e) {
      console.error('Failed to save the automatic rest setting', e);
      setRowError("Couldn't save that setting. Check your connection and try again.");
    } finally {
      setAutoRestBusy(false);
    }
  };

  const handleReactivate = async (numberId: string) => {
    setReactivatingId(numberId);
    setRowError(null);
    try {
      await setPhoneNumberStatus(numberId, 'active');
      load();
    } catch (e) {
      console.error('Failed to reactivate number', e);
      setRowError("Couldn't reactivate that number. Try again.");
    } finally {
      setReactivatingId(null);
    }
  };

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

      {autoRest && (
        <label className="mb-4 flex items-start gap-3 rounded-app-md border border-border-subtle bg-surface-2/40 p-3 text-sm text-text-primary">
          <TapCheckbox
            checked={autoRest.enabled}
            disabled={autoRestBusy}
            onChange={(e) => void handleAutoRestToggle(e.target.checked)}
            aria-label="Rest likely-flagged numbers automatically"
          />
          <span className="min-w-0">
            Rest a number automatically when it looks flagged
            <span className="block text-meta text-text-secondary">
              When a number&apos;s answer rate drops sharply (well below its own past weeks and your
              other numbers) it is rested for {autoRest.days} days, but only when people who answer
              are also hanging up faster, and never if it is an agent&apos;s only number. You can
              reactivate any number below.
            </span>
          </span>
        </label>
      )}
      {rowError && (
        <div
          role="alert"
          className="mb-4 p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm"
        >
          {rowError}
        </div>
      )}

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
            const sc = scores[b.number_id];
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
                      {sc?.likely_flagged && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-danger/10 text-danger">
                          Likely flagged
                        </span>
                      )}
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
                {sc?.likely_flagged && sc.likely_flagged_reason && (
                  <p className="px-3 pb-2 text-meta text-danger">
                    {sc.likely_flagged_reason}.{' '}
                    {autoRest?.enabled
                      ? sc.auto_rest_confirmed
                        ? `It will be rested for ${autoRest.days} days at the next check (every 6 hours), if its agent has another number to dial from.`
                        : 'It is not rested automatically yet: people who answer are not hanging up faster. Rest it yourself if you want to be safe.'
                      : 'Consider resting it; automatic rest is switched off.'}
                  </p>
                )}
                {b.status === 'resting' && sc?.flagged_at && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-meta text-text-secondary">
                    <span>
                      Rested automatically on {new Date(sc.flagged_at).toLocaleDateString()}
                      {sc.resting_until
                        ? `, resting until ${new Date(sc.resting_until).toLocaleDateString()}`
                        : ''}
                    </span>
                    <button
                      type="button"
                      disabled={reactivatingId === b.number_id}
                      onClick={() => void handleReactivate(b.number_id)}
                      className="hd-touch rounded-app-md border border-border-subtle px-3 py-1 text-sm text-text-primary hover:bg-surface-2 disabled:opacity-50"
                    >
                      {reactivatingId === b.number_id ? 'Reactivating…' : 'Reactivate'}
                    </button>
                  </div>
                )}
                {sc && (
                  <dl className="grid grid-cols-1 gap-2 px-3 pb-3 sm:grid-cols-3">
                    {SCORE_INFO.map((info) => {
                      const v = sc[info.key];
                      return (
                        <div key={info.key} className="min-w-0">
                          <dt className="flex items-baseline gap-2 text-meta text-text-secondary">
                            <span>{info.label}</span>
                            <span className={cn('text-base font-semibold', scoreTone(v))}>
                              {v == null ? '—' : v}
                              {v != null && <span className="text-xs font-normal">/100</span>}
                            </span>
                          </dt>
                          <dd className="text-meta text-text-secondary">
                            {v == null ? info.empty : info.meaning}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                )}
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
                        label="Calls / day (busiest, UTC)"
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
        <ol className="list-decimal pl-5 space-y-2 text-meta text-text-secondary mb-3">
          <li>
            <span className="text-text-primary">Register your numbers for free.</span> Open
            freecallerregistry.com, enter your business name and each number you dial from. One
            registration covers all three analytics companies (Hiya, First Orion and TNS) that
            carriers use to label calls.
          </li>
          <li>
            <span className="text-text-primary">Set a business name (CNAM).</span> Where your phone
            provider offers it, set the same business name as the caller name for each number, so
            people see who is calling.
          </li>
          <li>
            <span className="text-text-primary">Rest a flagged number.</span> When a number shows
            &quot;Likely flagged&quot; or its answer score falls, stop calling from it for a week or
            two. This page does that for you when automatic rest is on.
          </li>
          <li>
            <span className="text-text-primary">Dispute a wrong label.</span> If a number is
            labelled &quot;Spam Likely&quot;, you can ask each company to review it: Hiya and First
            Orion have a free number-lookup and dispute form on their websites, and the carrier
            analytics company TNS has a call-labelling redress form. It can take days or weeks, and
            a review is not guaranteed to change the label.
          </li>
          <li>
            <span className="text-text-primary">Spread your calls.</span> Keep each number under its
            daily limit and add numbers instead of pushing one number harder. Many calls from one
            number is the most common reason it gets labelled.
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
