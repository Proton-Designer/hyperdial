import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Loader2, X } from 'lucide-react';
import {
  addLeadsToCampaignBulk,
  type BulkAddLeadsResult,
  type BulkLeadFilter,
  type Contact,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { describeBulkAddResult } from './bulkAddMessage';

const CATEGORIES = ['Cold', 'Warm', 'Follow Up', 'Voicemail', 'Booked'];
const STATUSES = ['No Contact', 'Closed'];
const PREVIEW_DEBOUNCE_MS = 450;

const controlClass =
  'w-full bg-surface-2 border border-border-subtle rounded-app-md px-3 py-2 text-body text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to';

function contactName(c: Contact): string {
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return c.business_name || name || 'Unnamed contact';
}

/** Mirrors the server filter (private.bulk_lead_candidates) for the pick list only -- the server is the authority. */
function matchesFilter(c: Contact, f: BulkLeadFilter): boolean {
  const q = f.search?.trim().toLowerCase();
  if (q) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ').toLowerCase();
    if (!name.includes(q) && !(c.business_name ?? '').toLowerCase().includes(q)) return false;
  }
  if (f.category && (c.category ?? 'Cold') !== f.category) return false;
  if (f.contactStatus && (c.contact_status ?? 'No Contact') !== f.contactStatus) return false;
  const city = f.city?.trim().toLowerCase();
  if (city) {
    const hay = c.city ? c.city : (c.address ?? '');
    if (!hay.toLowerCase().includes(city)) return false;
  }
  return true;
}

interface Props {
  campaignId: string;
  contacts: Contact[];
  /** contact ids that already have a lead row here (hidden from the pick list) */
  existingContactIds: Set<string>;
  /** the org's other campaigns, for "copy another campaign's leads" */
  otherCampaigns: { id: string; name: string }[];
  onClose: () => void;
  /** called after a real (non-dry-run) add; the parent reports and refreshes */
  onDone: (result: BulkAddLeadsResult) => void;
}

/**
 * TASK-H02: add existing contacts to a campaign -- individually, or in bulk ("everyone matching these filters", which is every
 * contact of the org when no filter is set, and can be "everything in another campaign" or "everyone in Austin"). All writes go
 * through one server-side RPC; the live "will add N, skip M" preview is a debounced dry run.
 */
export function AddExistingContactsModal({
  campaignId,
  contacts,
  existingContactIds,
  otherCampaigns,
  onClose,
  onDone,
}: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  const [mode, setMode] = useState<'filter' | 'ids'>('filter');
  const [filter, setFilter] = useState<BulkLeadFilter>({});
  const [skipClosed, setSkipClosed] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<BulkAddLeadsResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importLists = useMemo(
    () => [...new Set(contacts.map((c) => c.import_list).filter((l): l is string => !!l))].sort(),
    [contacts]
  );

  const setF = (patch: Partial<BulkLeadFilter>) => setFilter((prev) => ({ ...prev, ...patch }));

  // Debounced dry run: never fires per keystroke, and a stale response never overwrites a newer one.
  useEffect(() => {
    if (mode !== 'filter') return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const t = setTimeout(() => {
      addLeadsToCampaignBulk({ campaignId, mode: 'filter', filter, skipClosed, dryRun: true })
        .then((r) => {
          if (!cancelled) setPreview(r);
        })
        .catch((e) => {
          if (!cancelled) {
            setPreview(null);
            setPreviewError(e instanceof Error ? e.message : 'Could not preview');
          }
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mode, campaignId, filter, skipClosed]);

  const pickable = useMemo(
    () => contacts.filter((c) => !existingContactIds.has(c.id) && matchesFilter(c, filter)),
    [contacts, existingContactIds, filter]
  );
  const allShownSelected = pickable.length > 0 && pickable.every((c) => selectedIds.has(c.id));

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllShown = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allShownSelected) pickable.forEach((c) => next.delete(c.id));
      else pickable.forEach((c) => next.add(c.id));
      return next;
    });

  const noFilter = !Object.values(filter).some((v) => !!v && String(v).trim() !== '');
  const canSubmit =
    !submitting &&
    (mode === 'ids' ? selectedIds.size > 0 : !!preview && preview.would_add > 0 && !previewLoading);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await addLeadsToCampaignBulk(
        mode === 'ids'
          ? { campaignId, mode: 'ids', contactIds: [...selectedIds], skipClosed }
          : { campaignId, mode: 'filter', filter, skipClosed }
      );
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add contacts');
      setSubmitting(false);
    }
  };

  const submitLabel =
    mode === 'ids'
      ? `Add ${selectedIds.size} selected`
      : preview
        ? `Add ${preview.would_add} contact${preview.would_add === 1 ? '' : 's'}`
        : 'Add contacts';

  return createPortal(
    <div
      className="hd-touch hd-vv fixed inset-0 flex items-center justify-center p-2 max-md:p-0"
      style={{ zIndex: 10000 }}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={submitting ? undefined : onClose}
        aria-hidden
      />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Add existing contacts"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-2xl flex flex-col rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md outline-none max-md:h-full max-md:max-w-none max-md:!max-h-none max-md:rounded-none max-md:border-0"
        style={{ maxHeight: 'calc(100vh - 16px)', minHeight: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-subtle p-4 flex-shrink-0 max-md:pt-[max(1rem,env(safe-area-inset-top))]">
          <h2 className="text-page-title text-text-primary">Add existing contacts</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="rounded-app-md p-2 text-text-secondary hover:bg-white/10 hover:text-text-primary disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 min-h-0 space-y-4">
          <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="How to add">
            {(
              [
                ['filter', 'Everyone matching'],
                ['ids', 'Pick contacts'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={`rounded-app-md border px-3 py-2 text-body ${
                  mode === value
                    ? 'border-accent-to bg-accent-to/10 text-text-primary'
                    : 'border-border-subtle text-text-secondary hover:bg-white/5'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <p className="text-meta text-text-secondary">
            {mode === 'filter'
              ? 'Adds every contact that matches the filters below, not just the ones on screen. With no filters that is every contact in your organization.'
              : 'Tick the contacts to add. Filters narrow the list; "Select all shown" ticks everything the filters show.'}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              className={controlClass}
              placeholder="Search name or business"
              aria-label="Search name or business"
              value={filter.search ?? ''}
              onChange={(e) => setF({ search: e.target.value })}
            />
            <input
              className={controlClass}
              placeholder="City (e.g. Austin)"
              aria-label="City"
              value={filter.city ?? ''}
              onChange={(e) => setF({ city: e.target.value })}
            />
            <select
              className={controlClass}
              aria-label="Category"
              value={filter.category ?? ''}
              onChange={(e) => setF({ category: e.target.value || undefined })}
            >
              <option value="">Any category</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              className={controlClass}
              aria-label="Contact status"
              value={filter.contactStatus ?? ''}
              onChange={(e) => setF({ contactStatus: e.target.value || undefined })}
            >
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {mode === 'filter' && importLists.length > 0 && (
              <select
                className={controlClass}
                aria-label="Import list"
                value={filter.importList ?? ''}
                onChange={(e) => setF({ importList: e.target.value || undefined })}
              >
                <option value="">Any import list</option>
                {importLists.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            )}
            {mode === 'filter' && otherCampaigns.length > 0 && (
              <select
                className={controlClass}
                aria-label="Copy leads from another campaign"
                value={filter.fromCampaignId ?? ''}
                onChange={(e) => setF({ fromCampaignId: e.target.value || undefined })}
              >
                <option value="">Any campaign (or none)</option>
                {otherCampaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    Leads of: {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <label className="flex items-center gap-2 text-body text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={skipClosed}
              onChange={(e) => setSkipClosed(e.target.checked)}
            />
            Skip contacts already marked Closed
          </label>

          {mode === 'filter' ? (
            <div
              className="rounded-app-md border border-border-subtle bg-surface-2 p-3 text-body min-h-[3.5rem]"
              aria-live="polite"
            >
              {previewError ? (
                <span className="text-danger">{previewError}</span>
              ) : previewLoading && !preview ? (
                <span className="inline-flex items-center gap-2 text-text-secondary">
                  <Loader2 className="w-4 h-4 animate-spin" /> Counting matches...
                </span>
              ) : preview ? (
                <div className={previewLoading ? 'opacity-60' : undefined}>
                  <div className="text-text-primary">
                    {describeBulkAddResult(preview, true)}
                    {noFilter && preview.matched > 0 ? ' (no filters: whole organization)' : ''}
                  </div>
                  <div className="text-meta text-text-muted">
                    {preview.matched} contact{preview.matched === 1 ? '' : 's'} match
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="flex items-center gap-2 text-body text-text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allShownSelected}
                    onChange={toggleAllShown}
                    disabled={pickable.length === 0}
                  />
                  Select all shown ({pickable.length})
                </label>
                <span className="text-meta text-text-muted">{selectedIds.size} selected</span>
              </div>
              {pickable.length === 0 ? (
                <p className="text-text-secondary py-4">
                  No contacts to show: they are already in this campaign, or nothing matches the
                  filters.
                </p>
              ) : (
                <ul className="space-y-1 max-h-[40vh] overflow-y-auto">
                  {pickable.map((c) => (
                    <li key={c.id}>
                      <label className="flex items-center gap-3 p-2 rounded-app-md hover:bg-white/5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                        <span className="text-text-primary min-w-0 truncate">{contactName(c)}</span>
                        <span className="text-meta text-text-secondary ml-auto flex-shrink-0">
                          {c.city ?? c.phone_number ?? ''}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-border-subtle flex-shrink-0">
          <Button variant="fe-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={submitting}>
            {submitLabel}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
