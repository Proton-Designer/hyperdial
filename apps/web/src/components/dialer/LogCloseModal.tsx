import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X } from 'lucide-react';
import {
  getCloseContactPrefill,
  getCloseServiceCategories,
  logContactClose,
  type CloseDeliveryStatus,
  type CloseFrequency,
  type LogContactCloseInput,
} from '@/lib/api';
import { addCities, isPlausibleMobile, parseOptionalNumber, prefillCity } from '@/lib/closeForm';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface LogCloseModalProps {
  contactId: string;
  /** Shown/used until the contact's own details load (and as the fallback if they cannot). */
  name: string;
  phone: string;
  onClose: () => void;
  /** Dev/test-only overrides, same convention as WrapUpModal (apps/web/src/dev/LogCloseHarness.tsx). */
  loadPrefill?: typeof getCloseContactPrefill;
  loadCategories?: typeof getCloseServiceCategories;
  submitClose?: typeof logContactClose;
}

const FREQUENCIES: { value: CloseFrequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'monthly', label: 'Monthly' },
];

const INPUT =
  'w-full rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to';

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-body border transition-colors ${
        selected
          ? 'bg-accent-to/20 border-accent-to text-text-primary'
          : 'bg-surface-2 border-border-subtle text-text-secondary hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-meta text-text-secondary mb-1.5">
        {label}
        {required && <span className="text-danger"> *</span>}
      </div>
      {children}
      {hint && <p className="text-meta text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

const DELIVERY_NOTE: Record<CloseDeliveryStatus, string> = {
  sent: 'Sent to the closes sheet.',
  pending: 'Delivery to the closes sheet is in progress; it retries automatically if it fails.',
  failed: 'Saved, but delivery to the closes sheet failed. An admin can retry it in Settings.',
  not_configured:
    'Saved. No closes sheet/webhook is set up yet, so nothing was sent; an admin can add one in Settings.',
};

/**
 * TASK-H03: the "Log Close" form an intern fills when they close a provider. Autofills business name, mobile and
 * city from the contact (editable), validates, then calls log-contact-close, which stores the close, marks the
 * contact 'Closed' and queues delivery to the org's closes webhook. Dismissible: closing is never mandatory.
 */
export function LogCloseModal({
  contactId,
  name,
  phone,
  onClose,
  loadPrefill = getCloseContactPrefill,
  loadCategories = getCloseServiceCategories,
  submitClose = logContactClose,
}: LogCloseModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  const [categories, setCategories] = useState<string[] | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [prefillError, setPrefillError] = useState<string | null>(null);

  const [ownerName, setOwnerName] = useState('');
  const [businessName, setBusinessName] = useState(name);
  const [mobile, setMobile] = useState(phone);
  const [email, setEmail] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [cityDraft, setCityDraft] = useState('');
  const [frequencies, setFrequencies] = useState<CloseFrequency[]>([]);
  const [insured, setInsured] = useState<boolean | null>(null);
  const [bestContact, setBestContact] = useState('');
  const [price, setPrice] = useState('');
  const [capacity, setCapacity] = useState('');
  const [years, setYears] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CloseDeliveryStatus | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // The form scrolls; an error raised from the Submit button at the bottom must not stay out of view at the top.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  // Prefill once. Anything the intern already typed while it loaded is kept (only empty fields are filled).
  useEffect(() => {
    let cancelled = false;
    loadPrefill(contactId)
      .then((p) => {
        if (cancelled) return;
        setOwnerName((v) => v || p.ownerName || '');
        setBusinessName((v) => v || p.businessName || '');
        setMobile((v) => v || p.phone || '');
        setEmail((v) => v || p.email || '');
        const city = prefillCity(p.city, p.address);
        if (city) setCities((v) => (v.length === 0 ? addCities([], city) : v));
      })
      .catch((e) => {
        if (!cancelled)
          setPrefillError(e instanceof Error ? e.message : 'Could not load the contact details');
      });
    loadCategories()
      .then((c) => !cancelled && setCategories(c))
      .catch((e) => {
        if (!cancelled)
          setCategoriesError(
            e instanceof Error ? e.message : 'Could not load the service categories'
          );
      });
    return () => {
      cancelled = true;
    };
  }, [contactId, loadPrefill, loadCategories]);

  const toggle = <T,>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const commitCity = () => {
    if (!cityDraft.trim()) return;
    setCities((c) => addCities(c, cityDraft));
    setCityDraft('');
  };

  const handleSubmit = async () => {
    setError(null);
    const finalCities = cityDraft.trim() ? addCities(cities, cityDraft) : cities;
    const priceN = parseOptionalNumber(price);
    const capacityN = parseOptionalNumber(capacity);
    const yearsN = parseOptionalNumber(years);
    if (!ownerName.trim()) return setError('Enter the owner name.');
    if (!businessName.trim()) return setError('Enter the business name.');
    if (!isPlausibleMobile(mobile)) return setError('Enter a valid mobile number.');
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
      return setError('That email does not look right.');
    if (services.length === 0) return setError('Pick at least one service.');
    if (finalCities.length === 0) return setError('Add at least one city they cover.');
    if (frequencies.length === 0) return setError('Pick at least one frequency.');
    if (insured === null) return setError('Say whether they are insured.');
    if (priceN === undefined || priceN === null ? priceN === undefined : priceN < 0)
      return setError('Starting price must be a number.');
    if (
      capacityN === undefined ||
      (capacityN !== null && (capacityN < 0 || !Number.isInteger(capacityN)))
    )
      return setError('New clients they can take must be a whole number.');
    if (yearsN === undefined || (yearsN !== null && (yearsN < 0 || !Number.isInteger(yearsN))))
      return setError('Years in business must be a whole number.');

    const input: LogContactCloseInput = {
      contactId,
      ownerName: ownerName.trim(),
      businessName: businessName.trim(),
      mobile: mobile.trim(),
      email: email.trim() || null,
      services,
      cities: finalCities,
      frequencies,
      insured,
      bestContact: bestContact.trim() || null,
      startingPrice: priceN,
      capacity: capacityN,
      yearsInBusiness: yearsN,
    };
    setSubmitting(true);
    try {
      const res = await submitClose(input);
      setDone(res.deliveryStatus);
    } catch (e) {
      // Every field stays as typed so the intern can retry without retyping.
      setError(e instanceof Error ? e.message : 'Could not save the close');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      ref={modalRef}
      className="fixed inset-0 flex items-center justify-center p-4 outline-none"
      style={{ zIndex: 10001 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="logclose-title"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Keep Enter/digits/Escape from reaching any listener of a modal underneath (WrapUpModal).
        e.stopPropagation();
        if (e.key === 'Escape' && !submitting) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/70" aria-hidden="true" />
      <div className="relative z-[1] w-full max-w-lg max-h-[92vh] flex flex-col rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md">
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle p-4">
          <div className="min-w-0">
            <h2 id="logclose-title" className="text-page-title text-text-primary">
              Log close
            </h2>
            <p className="text-body text-text-secondary mt-1 truncate">
              {name || 'Unknown contact'} · {phone}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={submitting}
            className="shrink-0 p-1 text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {done ? (
          <>
            <div className="p-6 text-center space-y-3" role="status">
              <div className="mx-auto w-10 h-10 rounded-full bg-success/20 text-success flex items-center justify-center">
                <Check className="w-5 h-5" />
              </div>
              <p className="text-text-primary font-medium">Closed. The contact is marked Closed.</p>
              <p className="text-body text-text-secondary">{DELIVERY_NOTE[done]}</p>
            </div>
            <div className="border-t border-border-subtle p-4 flex justify-end">
              <Button type="button" variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="p-4 space-y-4 overflow-y-auto">
              {error && (
                <div
                  ref={errorRef}
                  role="alert"
                  className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3"
                >
                  {error}
                </div>
              )}
              {prefillError && (
                <p className="text-meta text-text-muted">
                  Could not autofill from the contact ({prefillError}); fill the fields in by hand.
                </p>
              )}

              <Field label="Owner name" required>
                <input
                  className={INPUT}
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Business name" required>
                <input
                  className={INPUT}
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Mobile number" required>
                <input
                  className={INPUT}
                  type="tel"
                  inputMode="tel"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                />
              </Field>
              <Field label="Email">
                <input
                  className={INPUT}
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="off"
                />
              </Field>

              <Field label="Services offered" required>
                {categories === null && !categoriesError ? (
                  <div
                    className="flex items-center gap-2 text-body text-text-secondary"
                    role="status"
                  >
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading services…
                  </div>
                ) : categoriesError ? (
                  <p className="text-meta text-danger">{categoriesError}</p>
                ) : categories && categories.length === 0 ? (
                  <p className="text-body text-text-secondary">
                    No service categories yet — ask an admin to add them in Settings.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {categories?.map((c) => (
                      <Chip
                        key={c}
                        selected={services.includes(c)}
                        onClick={() => setServices((s) => toggle(s, c))}
                      >
                        {c}
                      </Chip>
                    ))}
                  </div>
                )}
              </Field>

              <Field
                label="Cities they cover"
                required
                hint="Type a city and press Enter or comma to add it."
              >
                {cities.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {cities.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center gap-1 pl-3 pr-1.5 py-1 rounded-full bg-surface-3 text-body text-text-primary"
                      >
                        {c}
                        <button
                          type="button"
                          aria-label={`Remove ${c}`}
                          onClick={() => setCities((l) => l.filter((x) => x !== c))}
                          className="p-0.5 text-text-secondary hover:text-text-primary"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  className={INPUT}
                  value={cityDraft}
                  placeholder="Add a city"
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v.includes(',')) {
                      setCities((l) => addCities(l, v));
                      setCityDraft('');
                    } else {
                      setCityDraft(v);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitCity();
                    }
                  }}
                  onBlur={commitCity}
                />
              </Field>

              <Field label="Frequencies offered" required>
                <div className="flex flex-wrap gap-2">
                  {FREQUENCIES.map((f) => (
                    <Chip
                      key={f.value}
                      selected={frequencies.includes(f.value)}
                      onClick={() => setFrequencies((l) => toggle(l, f.value))}
                    >
                      {f.label}
                    </Chip>
                  ))}
                </div>
              </Field>

              <Field label="Insured?" required>
                <div className="flex gap-2">
                  <Chip selected={insured === true} onClick={() => setInsured(true)}>
                    Yes
                  </Chip>
                  <Chip selected={insured === false} onClick={() => setInsured(false)}>
                    No
                  </Chip>
                </div>
              </Field>

              <Field label="Best time and way to reach them">
                <textarea
                  className={`${INPUT} resize-none`}
                  rows={2}
                  maxLength={500}
                  value={bestContact}
                  onChange={(e) => setBestContact(e.target.value)}
                  placeholder="e.g. text after 5pm"
                />
              </Field>

              <Field label="Rough starting price for a recurring visit ($)">
                <input
                  className={INPUT}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="New clients they can take on">
                  <input
                    className={INPUT}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    value={capacity}
                    onChange={(e) => setCapacity(e.target.value)}
                  />
                </Field>
                <Field label="Years in business">
                  <input
                    className={INPUT}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    value={years}
                    onChange={(e) => setYears(e.target.value)}
                  />
                </Field>
              </div>
            </div>
            <div className="border-t border-border-subtle p-4 flex justify-end gap-2">
              <Button type="button" variant="fe-ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="button" variant="primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : 'Log close'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
