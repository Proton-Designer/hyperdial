import { useCallback, useEffect, useMemo, useState } from 'react';
import '@/styles/touch.css';
import { BadgeCheck, Download, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { getContactById, listOnboardedPros, type Contact, type OnboardedPro } from '@/lib/api';
import { contactHeadline } from '@/lib/contactName';
import { downloadCsv, neutralizeCell, rowsToCsv } from '@/lib/csv';
import {
  countSince,
  rankBy,
  sortPros,
  startOfMonth,
  startOfWeek,
  type ProsSort,
  type RankedCount,
} from '@/lib/prosStats';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useOrg } from '@/contexts/OrgContext';
import { ProApplications } from '@/components/pros/ProApplications';
import { ContactDetailModal } from '@/components/contacts/ContactDetailModal';

interface Filters {
  niche: string | null;
  area: string | null;
  closer: string | null;
}
const NO_FILTERS: Filters = { niche: null, area: null, closer: null };
const UNKNOWN = 'Unknown';

const inputClass =
  'bg-surface-2 border border-border-subtle rounded-app-sm px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to';

// TASK-H28: a close may have no business or owner; fall back to the phone, then a plain label.
const headline = (p: OnboardedPro) => {
  const h = contactHeadline({
    business_name: p.businessName,
    first_name: p.ownerName,
    last_name: null,
  });
  return h !== '—' ? h : p.mobile.trim() || 'Unnamed pro';
};
const insuredText = (p: OnboardedPro) =>
  p.insured === null ? 'Insured: —' : p.insured ? 'Insured' : 'Not insured';
const closerName = (p: OnboardedPro) => p.closedByName?.trim() || UNKNOWN;
const when = (iso: string) => new Date(iso).toLocaleDateString();
const money = (n: number | null) =>
  n === null
    ? '—'
    : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function matchesSearch(p: OnboardedPro, q: string): boolean {
  if (!q) return true;
  // A phone typed with formatting, "(318) 780": compare digits only once the query has 3+ digits.
  const qDigits = q.replace(/\D/g, '');
  if (qDigits.length >= 3 && !/[a-z]/i.test(q) && p.mobile.replace(/\D/g, '').includes(qDigits))
    return true;
  const hay = [p.businessName, p.ownerName, p.mobile, p.email ?? '', ...p.services, ...p.cities]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

function Tile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div title={hint} className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
      <div className="text-meta text-text-secondary">{label}</div>
      <div className="text-page-title text-text-primary mt-1">{value.toLocaleString()}</div>
    </div>
  );
}

function RankedBars({
  title,
  rows,
  selected,
  onSelect,
}: {
  title: string;
  rows: RankedCount[];
  selected: string | null;
  onSelect: (label: string | null) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 8);
  const max = rows[0]?.count ?? 1;
  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 min-w-0">
      <h3 className="text-meta font-semibold text-text-secondary uppercase tracking-wide mb-3">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-meta text-text-muted">Nothing to count yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((r) => {
            const active = selected?.toLowerCase() === r.label.toLowerCase();
            return (
              <li key={r.label}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect(active ? null : r.label)}
                  className={`w-full text-left rounded-app-sm px-2 py-1.5 transition-colors ${
                    active ? 'bg-accent-to/10' : 'hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-text-primary">{r.label}</span>
                    <span className="shrink-0 text-text-secondary tabular-nums">{r.count}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent-to"
                      style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }}
                    />
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 8 && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-2 text-meta text-accent-to hover:underline"
        >
          {all ? 'Show top 8' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

function Tags({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="text-text-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((t) => (
        <span
          key={t}
          className="px-1.5 py-0.5 rounded bg-surface-2 border border-border-subtle text-xs text-text-secondary"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

/**
 * TASK-H25: the onboarded pros list (one row per contact that has at least one close, its latest close) plus counts.
 * Owner/admin see the whole org; a manager only their pods' pros (the read RPC scopes it), so the wording never claims
 * "the company has none". Read only: no edit or delete. Counts are computed from the rows; a pro with several services
 * or cities counts once in each.
 */
export function Pros() {
  const { role } = useOrg();
  const isManagerRole = role === 'manager';
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; pros: OnboardedPro[]; total: number }
  >({ kind: 'loading' });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ProsSort>('newest');
  const [detail, setDetail] = useState<Contact | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    listOnboardedPros()
      .then((r) => setState({ kind: 'ready', pros: r.pros, total: r.total }))
      .catch((e) =>
        setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not load pros' })
      );
  }, []);
  useEffect(load, [load]);

  const pros = useMemo(() => (state.kind === 'ready' ? state.pros : []), [state]);
  const now = new Date();
  const week = useMemo(() => countSince(pros, startOfWeek(new Date())), [pros]);
  const month = useMemo(() => countSince(pros, startOfMonth(new Date())), [pros]);
  const niches = useMemo(() => rankBy(pros, (p) => p.services), [pros]);
  const areas = useMemo(() => rankBy(pros, (p) => p.cities), [pros]);
  const closers = useMemo(() => rankBy(pros, (p) => [closerName(p)]), [pros]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const has = (list: string[], v: string) =>
      list.some((x) => x.trim().toLowerCase() === v.toLowerCase());
    const filtered = pros.filter(
      (p) =>
        (!filters.niche || has(p.services, filters.niche)) &&
        (!filters.area || has(p.cities, filters.area)) &&
        (!filters.closer || closerName(p).toLowerCase() === filters.closer.toLowerCase()) &&
        matchesSearch(p, q)
    );
    return sortPros(filtered, sort, (p) => headline(p).toLowerCase());
  }, [pros, filters, search, sort]);

  const openContact = async (p: OnboardedPro) => {
    setOpening(p.closeId);
    try {
      const c = await getContactById(p.contactId);
      if (!c) toast.error("You don't have access to this contact.");
      else setDetail(c);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open the contact');
    } finally {
      setOpening(null);
    }
  };

  const exportCsv = () => {
    const rows = visible.map((p) => ({
      business: p.businessName,
      owner: p.ownerName,
      mobile: p.mobile,
      email: p.email ?? '',
      services: p.services.map(neutralizeCell).join('; '),
      cities: p.cities.map(neutralizeCell).join('; '),
      frequencies: p.frequencies.map(neutralizeCell).join('; '),
      insured: p.insured === null ? '' : p.insured ? 'Yes' : 'No',
      bestContact: p.bestContact ?? '',
      price: p.startingPrice ?? '',
      capacity: p.capacity ?? '',
      years: p.yearsInBusiness ?? '',
      closedBy: closerName(p),
      closedAt: p.closedAt,
      closes: p.closeCount,
    }));
    const csv = rowsToCsv(
      [
        { key: 'business', label: 'Business' },
        { key: 'owner', label: 'Owner' },
        { key: 'mobile', label: 'Mobile' },
        { key: 'email', label: 'Email' },
        { key: 'services', label: 'Services' },
        { key: 'cities', label: 'Cities' },
        { key: 'frequencies', label: 'Frequencies' },
        { key: 'insured', label: 'Insured' },
        { key: 'bestContact', label: 'Best time/way' },
        { key: 'price', label: 'Starting price' },
        { key: 'capacity', label: 'New clients capacity' },
        { key: 'years', label: 'Years in business' },
        { key: 'closedBy', label: 'Closed by' },
        { key: 'closedAt', label: 'Closed at' },
        { key: 'closes', label: 'Closes' },
      ],
      rows,
      { neutralizeFormulas: true }
    );
    downloadCsv(`onboarded-pros-${now.toISOString().slice(0, 10)}.csv`, csv);
  };

  const anyFilter = Boolean(filters.niche || filters.area || filters.closer || search.trim());
  const scopeNote = isManagerRole ? 'Pros closed by your pods only.' : null;

  return (
    <div className="hd-touch p-4 sm:p-8 max-w-[1440px] mx-auto">
      <PageHeader
        title="Onboarded pros"
        description={
          isManagerRole
            ? 'Pros closed by agents in your pods, with counts by niche, area and closer.'
            : 'Every pro an intern has closed, with counts by niche, area and closer.'
        }
        actions={
          state.kind === 'ready' && pros.length > 0 ? (
            <Button type="button" variant="fe-secondary" size="sm" onClick={exportCsv}>
              <Download className="w-4 h-4" />
              Export CSV
            </Button>
          ) : undefined
        }
      />

      <ProApplications
        canReview={role === 'owner' || role === 'admin'}
        isManager={isManagerRole}
        onApproved={load}
      />

      {state.kind === 'loading' && (
        <div className="space-y-4" aria-busy="true">
          <div className="grid grid-cols-3 gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
      )}

      {state.kind === 'error' && (
        <div
          role="alert"
          className="rounded-app-lg border border-danger/30 bg-danger-soft p-4 flex flex-wrap items-center justify-between gap-3"
        >
          <p className="text-body text-danger">{state.message}</p>
          <Button type="button" variant="fe-secondary" size="sm" onClick={load}>
            Try again
          </Button>
        </div>
      )}

      {state.kind === 'ready' && pros.length === 0 && (
        <EmptyState
          icon={BadgeCheck}
          title={isManagerRole ? 'No onboarded pros in your pods yet' : 'No onboarded pros yet'}
          body={
            isManagerRole
              ? "A pro appears here once an agent in your pods logs a close for them. Pros closed by other pods aren't shown to you."
              : 'A pro appears here once someone logs a close for them, from a contact or after a call.'
          }
        />
      )}

      {state.kind === 'ready' && pros.length > 0 && (
        <div className="space-y-5">
          {scopeNote && <p className="text-meta text-text-muted">{scopeNote}</p>}
          {state.total > pros.length && (
            <p role="status" className="text-meta text-warning">
              Showing the newest {pros.length.toLocaleString()} of {state.total.toLocaleString()}{' '}
              pros. Counts below cover only these.
            </p>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Tile label="Total pros" value={state.total} />
            <Tile
              label="Latest close this week"
              value={week}
              hint="Pros whose most recent close was this week. A pro closed again counts by that newest close."
            />
            <Tile
              label="Latest close this month"
              value={month}
              hint="Pros whose most recent close was this month. A pro closed again counts by that newest close."
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <RankedBars
              title="By niche"
              rows={niches}
              selected={filters.niche}
              onSelect={(v) => setFilters((f) => ({ ...f, niche: v }))}
            />
            <RankedBars
              title="By area"
              rows={areas}
              selected={filters.area}
              onSelect={(v) => setFilters((f) => ({ ...f, area: v }))}
            />
            <RankedBars
              title="Closed by"
              rows={closers}
              selected={filters.closer}
              onSelect={(v) => setFilters((f) => ({ ...f, closer: v }))}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                className={`${inputClass} w-full pl-9`}
                placeholder="Search business, owner, phone, service, city"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search pros"
              />
            </div>
            <select
              className={inputClass}
              value={sort}
              onChange={(e) => setSort(e.target.value as ProsSort)}
              aria-label="Sort pros"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="business">Business A-Z</option>
              <option value="price">Starting price</option>
              <option value="years">Years in business</option>
            </select>
            {(['niche', 'area', 'closer'] as const).map(
              (k) =>
                filters[k] && (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setFilters((f) => ({ ...f, [k]: null }))}
                    className="inline-flex items-center gap-1 rounded-full bg-accent-to/15 border border-accent-to/40 px-2.5 py-1 text-meta text-text-primary"
                  >
                    {filters[k]}
                    <X className="w-3 h-3" aria-label="Clear filter" />
                  </button>
                )
            )}
            {anyFilter && (
              <button
                type="button"
                onClick={() => {
                  setFilters(NO_FILTERS);
                  setSearch('');
                }}
                className="text-meta text-accent-to hover:underline"
              >
                Clear all
              </button>
            )}
            <span className="ml-auto text-meta text-text-muted">
              {visible.length.toLocaleString()} shown
            </span>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No pros match"
              body="Clear a filter or change the search."
            />
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block hd-scroll-x rounded-app-lg border border-border-subtle">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-meta text-text-secondary border-b border-border-subtle">
                      <th className="p-3 font-medium">Business</th>
                      <th className="p-3 font-medium">Contact</th>
                      <th className="p-3 font-medium">Services</th>
                      <th className="p-3 font-medium">Cities</th>
                      <th className="p-3 font-medium">Details</th>
                      <th className="p-3 font-medium">Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((p) => (
                      <tr
                        key={p.closeId}
                        tabIndex={0}
                        onClick={() => void openContact(p)}
                        onKeyDown={(e) => e.key === 'Enter' && void openContact(p)}
                        className={`border-b border-border-subtle last:border-0 cursor-pointer hover:bg-white/5 focus:outline-none focus:bg-white/5 align-top ${
                          opening === p.closeId ? 'opacity-60' : ''
                        }`}
                      >
                        <td className="p-3 min-w-[160px]">
                          <div className="text-text-primary font-medium">{headline(p)}</div>
                          {p.ownerName && p.ownerName !== headline(p) && (
                            <div className="text-meta text-text-secondary">{p.ownerName}</div>
                          )}
                        </td>
                        <td className="p-3 text-text-secondary">
                          <div>{p.mobile}</div>
                          <div className="text-meta text-text-muted break-all">{p.email ?? ''}</div>
                        </td>
                        <td className="p-3 max-w-[200px]">
                          <Tags items={p.services} />
                        </td>
                        <td className="p-3 max-w-[200px]">
                          <Tags items={p.cities} />
                        </td>
                        <td className="p-3 text-meta text-text-secondary whitespace-nowrap">
                          <div>{p.frequencies.join(', ') || '—'}</div>
                          <div>
                            {insuredText(p)} · {money(p.startingPrice)}
                          </div>
                          <div>
                            Cap {p.capacity ?? '—'} · {p.yearsInBusiness ?? '—'} yrs
                          </div>
                        </td>
                        <td className="p-3 text-meta text-text-secondary whitespace-nowrap">
                          <div>{when(p.closedAt)}</div>
                          <div>{closerName(p)}</div>
                          {p.closeCount > 1 && <div>{p.closeCount} closes</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <ul className="md:hidden space-y-3">
                {visible.map((p) => (
                  <li key={p.closeId}>
                    <button
                      type="button"
                      onClick={() => void openContact(p)}
                      className={`w-full text-left rounded-app-lg border border-border-subtle bg-surface-1 p-4 space-y-2 ${
                        opening === p.closeId ? 'opacity-60' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-text-primary font-medium truncate">
                            {headline(p)}
                          </div>
                          {p.ownerName && p.ownerName !== headline(p) && (
                            <div className="text-meta text-text-secondary truncate">
                              {p.ownerName}
                            </div>
                          )}
                        </div>
                        <span className="text-meta text-text-muted shrink-0">
                          {when(p.closedAt)}
                        </span>
                      </div>
                      <div className="text-meta text-text-secondary break-all">
                        {p.mobile}
                        {p.email ? ` · ${p.email}` : ''}
                      </div>
                      <Tags items={p.services} />
                      <Tags items={p.cities} />
                      <div className="text-meta text-text-muted">
                        {p.frequencies.join(', ') || '—'} · {insuredText(p)} ·{' '}
                        {money(p.startingPrice)} · Cap {p.capacity ?? '—'} ·{' '}
                        {p.yearsInBusiness ?? '—'} yrs · closed by {closerName(p)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <ContactDetailModal contact={detail} open={detail != null} onClose={() => setDetail(null)} />
    </div>
  );
}
