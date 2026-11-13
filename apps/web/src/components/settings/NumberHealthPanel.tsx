import { useEffect, useState } from 'react';
import { useOrg } from '@/contexts/OrgContext';
import { getNumberHealthStats, runNumberHealthCheck, type NumberHealthStat } from '@/lib/api';

/**
 * MISSION-4 TASK-T9 (CID-4): per-number dial/answer-rate/talk-time stats + an on-demand health
 * check button, for Settings -> Telephony -> Numbers. Mounted in `Settings.tsx` right after
 * `<NumberPoolCard />` (was built standalone in its own commit while `Settings.tsx` was held by
 * eng2's concurrent TASK-T8-m4; wired in once that claim released).
 *
 * Owner/admin only, same gate as NumberPoolCard's own `isAdmin` check -- an agent never sees
 * this (the health check flags/rests numbers org-wide, an owner/admin concern, not a per-agent
 * one).
 */
export function NumberHealthPanel() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';
  const [stats, setStats] = useState<NumberHealthStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckMessage, setLastCheckMessage] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    getNumberHealthStats()
      .then(setStats)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);

  if (!isAdmin) return null;

  const handleCheckNow = async () => {
    setChecking(true);
    setError(null);
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
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  const formatPct = (rate: number | null) => (rate == null ? '—' : `${Math.round(rate * 100)}%`);
  const formatSeconds = (s: number | null) => (s == null ? '—' : `${Math.round(s)}s`);

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-4xl mt-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-section-title text-text-primary">Number health</h3>
        <button
          type="button"
          onClick={() => void handleCheckNow()}
          disabled={checking}
          className="text-sm px-3 py-1.5 rounded-app-md border border-border-subtle text-text-primary hover:bg-surface-2 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Run check now'}
        </button>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        Weekly (and on demand): a number whose human-answer rate falls well below the pool median,
        with enough dials sampled, is automatically rested and flagged below. Rested numbers are
        excluded from dialing until reactivated (the existing rest-day cooldown, same as a daily-cap
        rest).
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}
      {lastCheckMessage && (
        <div className="mb-4 p-3 rounded-app-md bg-surface-2 border border-border-subtle text-text-secondary text-sm">
          {lastCheckMessage}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : stats.length === 0 ? (
        <p className="text-sm text-text-secondary">No numbers in the pool yet.</p>
      ) : (
        <>
          <div className="space-y-2 lg:hidden">
            {stats.map((s) => (
              <div
                key={s.number_id}
                className="rounded-app-md border border-border-subtle bg-surface-2/40 p-3 space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-text-primary">{s.phone_number}</span>
                  {s.status === 'resting' && s.flagged_reason ? (
                    <span className="px-2 py-0.5 rounded-full bg-danger/10 text-danger text-xs">
                      Flagged
                    </span>
                  ) : (
                    <span className="text-text-secondary text-sm capitalize">{s.status}</span>
                  )}
                </div>
                {s.status === 'resting' && s.flagged_reason && (
                  <div className="text-meta text-danger">{s.flagged_reason}</div>
                )}
                <div className="grid grid-cols-3 gap-2 text-meta text-text-secondary">
                  <div>
                    Dials 7d / 30d
                    <div className="text-sm text-text-primary">
                      {s.dials_7d} / {s.dials_30d}
                    </div>
                  </div>
                  <div>
                    Answer rate
                    <div className="text-sm text-text-primary">
                      {formatPct(s.human_answer_rate_7d)} / {formatPct(s.human_answer_rate_30d)}
                    </div>
                  </div>
                  <div>
                    Avg talk 30d
                    <div className="text-sm text-text-primary">
                      {formatSeconds(s.avg_talk_seconds_30d)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden lg:block hd-scroll-x">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-secondary border-b border-border-subtle">
                  <th className="py-2 pr-4">Number</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Dials (7d / 30d)</th>
                  <th className="py-2 pr-4">Answer rate (7d / 30d)</th>
                  <th className="py-2 pr-4">Avg talk (30d)</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.number_id} className="border-b border-border-subtle last:border-0">
                    <td className="py-2 pr-4 text-text-primary">{s.phone_number}</td>
                    <td className="py-2 pr-4">
                      {s.status === 'resting' && s.flagged_reason ? (
                        <span
                          className="px-2 py-0.5 rounded-full bg-danger/10 text-danger text-xs"
                          title={s.flagged_reason}
                        >
                          Flagged
                        </span>
                      ) : (
                        <span className="text-text-secondary capitalize">{s.status}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-text-primary">
                      {s.dials_7d} / {s.dials_30d}
                    </td>
                    <td className="py-2 pr-4 text-text-primary">
                      {formatPct(s.human_answer_rate_7d)} / {formatPct(s.human_answer_rate_30d)}
                    </td>
                    <td className="py-2 pr-4 text-text-primary">
                      {formatSeconds(s.avg_talk_seconds_30d)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
