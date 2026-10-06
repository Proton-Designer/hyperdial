import { ClipboardList } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Shift, ShiftSurveySummary } from '@/lib/api';
import {
  OBJECTION_LABEL,
  OBJECTION_ORDER,
  QUALITY_HINT,
  SLOWED_LABEL,
  SLOWED_ORDER,
  sortedCounts,
} from '../shifts/clockModel';
import { fmtTime } from '../shifts/shiftFormat';

/** "This week's survey": what interns said on the way out of their dialing shifts. Counts only,
 *  never a ranking of people. */
export function SurveySummaryCard({ summary }: { summary: ShiftSurveySummary }) {
  const objections = sortedCounts(summary.topObjections, OBJECTION_ORDER);
  const slowed = sortedCounts(summary.slowedBy, SLOWED_ORDER);
  return (
    <section
      aria-labelledby="survey-summary"
      className="rounded-app-lg border border-border-subtle bg-surface-1 p-4"
    >
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          id="survey-summary"
          className="flex items-center gap-2 text-section-title text-text-primary"
        >
          <ClipboardList className="h-4 w-4 text-text-muted" /> This week&apos;s survey
        </h2>
        <span className="text-meta text-text-muted">
          {summary.responses} {summary.responses === 1 ? 'response' : 'responses'}
        </span>
      </header>
      {summary.responses === 0 ? (
        <p className="text-body text-text-secondary">
          No survey answers yet. They show up here when interns end a dialing shift.
        </p>
      ) : (
        <div className="grid gap-5 md:grid-cols-3">
          <CountList title="Top objections" rows={objections} label={(k) => OBJECTION_LABEL[k]} />
          <CountList title="What slowed people down" rows={slowed} label={(k) => SLOWED_LABEL[k]} />
          <div>
            <h3 className="mb-2 text-meta font-medium uppercase tracking-wide text-text-muted">
              List quality
            </h3>
            {summary.avgListQuality === null ? (
              <p className="text-body text-text-secondary">No ratings yet.</p>
            ) : (
              <>
                <div className="text-metric text-2xl font-semibold leading-none text-text-primary">
                  {summary.avgListQuality.toFixed(1)}
                  <span className="ml-1 text-body font-normal text-text-muted">/ 5</span>
                </div>
                <p className="mt-1.5 text-meta text-text-secondary">
                  Average rating (1 = poor, 5 = great)
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function CountList<K extends string>({
  title,
  rows,
  label,
}: {
  title: string;
  rows: [K, number][];
  label: (k: K) => string;
}) {
  const max = rows[0]?.[1] ?? 1;
  return (
    <div>
      <h3 className="mb-2 text-meta font-medium uppercase tracking-wide text-text-muted">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-body text-text-secondary">None.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map(([k, n]) => (
            <li key={k}>
              <div className="flex items-baseline justify-between gap-3 text-body">
                <span className="min-w-0 text-text-primary">{label(k)}</span>
                <span className="text-metric tabular-nums text-text-secondary">{n}</span>
              </div>
              <div className="mt-1 h-1 rounded-full bg-white/5" aria-hidden>
                <div
                  className="h-1 rounded-full bg-accent-to/60"
                  style={{ width: `${Math.max(6, (n / max) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One shift's survey answers, for the expanded KPI row. */
export function SurveyAnswers({ shift, tz }: { shift: Shift; tz: string }) {
  const s = shift.survey;
  if (!s) {
    return (
      <p className="text-body text-text-secondary">
        {shift.clockedOutAt
          ? 'No survey was sent for this shift.'
          : 'No survey yet. It is sent when the intern ends the shift.'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <dl className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        <Answer label="Top objection">
          <span className="font-medium">{OBJECTION_LABEL[s.topObjection]}</span>
          <br />
          {s.objectionNote}
        </Answer>
        <Answer label="What worked best">{s.whatWorked}</Answer>
        <Answer label="What slowed them down">
          <span className="font-medium">{SLOWED_LABEL[s.slowedBy]}</span>
          {s.slowedNote && (
            <>
              <br />
              {s.slowedNote}
            </>
          )}
        </Answer>
        <Answer label="List quality">
          <span className="text-metric font-medium">{s.listQuality} / 5</span>
          <span className="text-text-muted"> · {QUALITY_HINT[s.listQuality]}</span>
        </Answer>
      </dl>
      <p className="text-meta text-text-muted">Sent {fmtTime(s.submittedAt, tz)}</p>
    </div>
  );
}

function Answer({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-meta text-text-muted">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-body text-text-primary">{children}</dd>
    </div>
  );
}
