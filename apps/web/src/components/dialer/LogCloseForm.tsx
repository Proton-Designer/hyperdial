import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import {
  getCloseContactPrefill,
  getCloseServiceCategories,
  logContactClose,
  type CloseDeliveryStatus,
  type LogContactCloseInput,
} from '@/lib/api';
import { addCities, isPlausibleMobile, parseOptionalNumber, prefillCity } from '@/lib/closeForm';
import { Button } from '@/components/ui/button';
import { emptyCloseDraftValues, useCloseDraft } from '@/lib/closeDraft';
import { CopyFormLink } from './CopyFormLink';
import { isViewOnly } from '@/lib/viewAs';
import { Chip, Field, FREQUENCIES, INPUT, mergeServices } from './closeFormParts';

export interface LogCloseFormProps {
  /** The call leg id the draft is keyed by (falls back to the contact id when there is no leg). */
  draftKey: string;
  /** The contact to prefill from. Absent for a number that is not a contact (TASK-H24). */
  contactId?: string;
  /** TASK-H24: close by the dialed number instead of by contact id: the server finds the org contact by phone or
   *  creates it from the form, and lets an agent through to a contact they cannot read only if that number phoned in. */
  byPhone?: boolean;
  /** Called once a close was saved (the contact modal uses it to show "Closed"). */
  onSaved?: () => void;
  /** Shown/used until the contact's own details load (and as the fallback if they cannot). */
  name: string;
  phone: string;
  /** Leaves the form (Cancel / Done). Absent on the inline panel, where there is nothing to leave. */
  onClose?: () => void;
  /** Modal: the field area scrolls inside the dialog. Inline: it flows with the page. */
  scroll?: boolean;
  /** Dev/test-only overrides, same convention as WrapUpModal (apps/web/src/dev/LogCloseHarness.tsx). */
  loadPrefill?: typeof getCloseContactPrefill;
  loadCategories?: typeof getCloseServiceCategories;
  submitClose?: typeof logContactClose;
}

const DELIVERY_NOTE: Record<CloseDeliveryStatus, string> = {
  sent: 'Sent to the closes sheet.',
  pending: 'Delivery to the closes sheet is in progress; it retries automatically if it fails.',
  failed: 'Saved, but delivery to the closes sheet failed. An admin can retry it in Settings.',
  not_configured:
    'Saved. No closes sheet/webhook is set up yet, so nothing was sent; an admin can add one in Settings.',
};

/**
 * TASK-H03/H13: the Log Close fields, submit and success view. Rendered by the modal (wrap-up) and by the inline panel on
 * the live-call screen; both read and write the same draft (lib/closeDraft.ts).
 */
export function LogCloseForm({
  draftKey,
  contactId,
  byPhone = false,
  onSaved,
  name,
  phone,
  onClose,
  scroll = false,
  loadPrefill = getCloseContactPrefill,
  loadCategories = getCloseServiceCategories,
  submitClose = logContactClose,
}: LogCloseFormProps) {
  const { state, patchValues, patchState } = useCloseDraft(draftKey, name, phone);
  const { values, submitting, done } = state;
  const {
    ownerName,
    businessName,
    mobile,
    email,
    services,
    cities,
    cityDraft,
    serviceDraft,
    frequencies,
    insured,
    bestContact,
    price,
    capacity,
    years,
  } = values;

  const [categories, setCategories] = useState<string[] | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [prefillError, setPrefillError] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // The form scrolls; an error raised from the Submit button at the bottom must not stay out of view at the top.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  // Prefill once per draft (the other surface may already have done it). Anything the intern already typed while it
  // loaded is kept (only empty fields are filled).
  useEffect(() => {
    let cancelled = false;
    if (!state.values.prefilled && !contactId) {
      patchValues({ prefilled: true });
    } else if (!state.values.prefilled && contactId) {
      loadPrefill(contactId)
        .then((p) => {
          if (cancelled) return;
          patchValues((v) => {
            const city = prefillCity(p.city, p.address);
            return {
              ownerName: v.ownerName || p.ownerName || '',
              businessName: v.businessName || p.businessName || '',
              mobile: v.mobile || p.phone || '',
              email: v.email || p.email || '',
              cities: city && v.cities.length === 0 ? addCities([], city) : v.cities,
              prefilled: true,
            };
          });
        })
        .catch((e) => {
          if (!cancelled)
            setPrefillError(e instanceof Error ? e.message : 'Could not load the contact details');
        });
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount / contact; state.values.prefilled is read at mount
  }, [contactId, loadPrefill, loadCategories]);

  const toggle = <T,>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const commitCity = () => {
    if (!cityDraft.trim()) return;
    patchValues((v) => ({ cities: addCities(v.cities, v.cityDraft), cityDraft: '' }));
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setError(null);
    const finalCities = cityDraft.trim() ? addCities(cities, cityDraft) : cities;
    const priceN = parseOptionalNumber(price);
    const capacityN = parseOptionalNumber(capacity);
    const yearsN = parseOptionalNumber(years);
    // TASK-H28: nothing is required (the contact or dialed number is the anchor); what IS entered must still be valid.
    if (mobile.trim() && !isPlausibleMobile(mobile))
      return setError('Enter a valid mobile number.');
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
      return setError('That email does not look right.');
    const allServices = mergeServices(services, serviceDraft);
    if (allServices.length > 10) return setError('Enter at most 10 services.');
    if (allServices.some((x) => x.length > 60))
      return setError('Each service must be 60 characters or fewer.');
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
      ...(byPhone || !contactId ? { phone } : { contactId }),
      ownerName: ownerName.trim() || null,
      businessName: businessName.trim() || null,
      mobile: mobile.trim() || null,
      email: email.trim() || null,
      services: allServices,
      cities: finalCities,
      frequencies,
      insured,
      bestContact: bestContact.trim() || null,
      startingPrice: priceN,
      capacity: capacityN,
      yearsInBusiness: yearsN,
    };
    patchState({ submitting: true });
    try {
      const res = await submitClose(input);
      // Logged once: both surfaces now show "Closed", and the typed values are gone.
      onSaved?.();
      patchState({
        done: res.deliveryStatus,
        submitting: false,
        values: emptyCloseDraftValues(name, phone),
      });
    } catch (e) {
      // Every field stays as typed so the intern can retry without retyping.
      setError(e instanceof Error ? e.message : 'Could not save the close');
      patchState({ submitting: false });
    }
  };

  return (
    <>
      {done ? (
        <>
          <div className="p-6 text-center space-y-3" role="status">
            <div className="mx-auto w-10 h-10 rounded-full bg-success/20 text-success flex items-center justify-center">
              <Check className="w-5 h-5" />
            </div>
            <p className="text-text-primary font-medium">Closed. The contact is marked Closed.</p>
            <p className="text-body text-text-secondary">{DELIVERY_NOTE[done]}</p>
          </div>
          {onClose && (
            <div className="border-t border-border-subtle p-4 flex justify-end">
              <Button type="button" variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className={`p-4 space-y-4 ${scroll ? 'overflow-y-auto' : ''}`}>
            <p className="text-body text-text-secondary">Fill in what you know.</p>
            {/* TASK-H29: a pro who is not closing on the call fills in the form themselves. */}
            {!isViewOnly && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-app-md border border-border-subtle bg-surface-2 p-3">
                <span className="text-body text-text-secondary">
                  Not closing yet? Send them the form
                </span>
                <CopyFormLink />
              </div>
            )}
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

            <Field label="Owner name">
              <input
                className={INPUT}
                value={ownerName}
                onChange={(e) => patchValues({ ownerName: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Business name">
              <input
                className={INPUT}
                value={businessName}
                onChange={(e) => patchValues({ businessName: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Mobile number">
              <input
                className={INPUT}
                type="tel"
                inputMode="tel"
                value={mobile}
                onChange={(e) => patchValues({ mobile: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <input
                className={INPUT}
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => patchValues({ email: e.target.value })}
                autoComplete="off"
              />
            </Field>

            <Field label="Services offered">
              {categories === null && !categoriesError ? (
                <div
                  className="flex items-center gap-2 text-body text-text-secondary"
                  role="status"
                >
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading services…
                </div>
              ) : (
                <div className="space-y-2">
                  {categoriesError && <p className="text-meta text-danger">{categoriesError}</p>}
                  {categories && categories.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {categories.map((c) => (
                        <Chip
                          key={c}
                          selected={services.includes(c)}
                          onClick={() => patchValues((v) => ({ services: toggle(v.services, c) }))}
                        >
                          {c}
                        </Chip>
                      ))}
                    </div>
                  )}
                  <input
                    className={INPUT}
                    value={serviceDraft}
                    onChange={(e) => patchValues({ serviceDraft: e.target.value })}
                    placeholder={
                      categories && categories.length > 0
                        ? 'Other (separate with commas)'
                        : 'e.g. plumbing, HVAC'
                    }
                    aria-label={
                      categories && categories.length > 0 ? 'Other services' : 'Services offered'
                    }
                    maxLength={300}
                    autoComplete="off"
                  />
                </div>
              )}
            </Field>

            <Field label="Cities they cover" hint="Type a city and press Enter or comma to add it.">
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
                        onClick={() =>
                          patchValues((v) => ({ cities: v.cities.filter((x) => x !== c) }))
                        }
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
                    patchValues((s) => ({ cities: addCities(s.cities, v), cityDraft: '' }));
                  } else {
                    patchValues({ cityDraft: v });
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

            <Field label="Frequencies offered">
              <div className="flex flex-wrap gap-2">
                {FREQUENCIES.map((f) => (
                  <Chip
                    key={f.value}
                    selected={frequencies.includes(f.value)}
                    onClick={() =>
                      patchValues((v) => ({ frequencies: toggle(v.frequencies, f.value) }))
                    }
                  >
                    {f.label}
                  </Chip>
                ))}
              </div>
            </Field>

            <Field label="Insured?">
              <div className="flex gap-2">
                <Chip
                  selected={insured === true}
                  onClick={() => patchValues({ insured: insured === true ? null : true })}
                >
                  Yes
                </Chip>
                <Chip
                  selected={insured === false}
                  onClick={() => patchValues({ insured: insured === false ? null : false })}
                >
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
                onChange={(e) => patchValues({ bestContact: e.target.value })}
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
                onChange={(e) => patchValues({ price: e.target.value })}
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
                  onChange={(e) => patchValues({ capacity: e.target.value })}
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
                  onChange={(e) => patchValues({ years: e.target.value })}
                />
              </Field>
            </div>
          </div>
          <div className="border-t border-border-subtle p-4 flex justify-end gap-2">
            {onClose && (
              <Button type="button" variant="fe-ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
            )}
            <Button type="button" variant="primary" onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : 'Log close'}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
