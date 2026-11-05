import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Chip, Field, FREQUENCIES, INPUT, mergeServices } from '@/components/dialer/closeFormParts';
import { addCities, isPlausibleMobile, looksLikeEmail, parseOptionalNumber } from '@/lib/closeForm';
import {
  fetchProFormInfo,
  submitProForm,
  type ProFormFrequency,
  type ProFormInfo,
} from '@/lib/proForm';

type Load =
  | { kind: 'loading' }
  | { kind: 'dead' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; info: ProFormInfo };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-lg px-4 py-6 sm:py-10">{children}</main>
    </div>
  );
}

/**
 * TASK-H29: the public "tell us about your business" form, opened from a link an intern or manager sends. NO login, no app
 * chrome, no Supabase client: it talks only to the pro-application Edge function (lib/proForm.ts). The same questions as
 * Log close; here the pro knows the answers, so the first seven are required. The server decides what is valid; these
 * checks only save a round trip.
 */
export function ProFormPage({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    fetchProFormInfo(token).then((r) => {
      if (cancelled) return;
      if (r.kind === 'ok') setLoad({ kind: 'ready', info: r.info });
      else if (r.kind === 'dead') setLoad({ kind: 'dead' });
      else setLoad({ kind: 'error', message: r.message });
    });
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  if (load.kind === 'loading') {
    return (
      <Shell>
        <div
          className="flex items-center gap-2 text-body text-text-secondary"
          role="status"
          aria-busy="true"
        >
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </Shell>
    );
  }
  if (load.kind === 'dead') {
    return (
      <Shell>
        <h1 className="text-page-title text-text-primary">This link doesn't work</h1>
        <p className="text-body text-text-secondary mt-2">
          It may have been replaced or turned off. Ask the person who sent it for a new link.
        </p>
      </Shell>
    );
  }
  if (load.kind === 'error') {
    return (
      <Shell>
        <div
          role="alert"
          className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3"
        >
          {load.message}
        </div>
        <Button
          type="button"
          variant="fe-secondary"
          className="mt-4"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Try again
        </Button>
      </Shell>
    );
  }
  return (
    <Shell>
      <ProFormBody token={token} info={load.info} />
    </Shell>
  );
}

function ProFormBody({ token, info }: { token: string; info: ProFormInfo }) {
  const [ownerName, setOwnerName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [serviceDraft, setServiceDraft] = useState('');
  const [cities, setCities] = useState<string[]>([]);
  const [cityDraft, setCityDraft] = useState('');
  const [frequencies, setFrequencies] = useState<ProFormFrequency[]>([]);
  const [insured, setInsured] = useState<boolean | null>(null);
  const [bestContact, setBestContact] = useState('');
  const [price, setPrice] = useState('');
  const [capacity, setCapacity] = useState('');
  const [years, setYears] = useState('');
  const [trap, setTrap] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  const toggle = <T,>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const commitCity = () => {
    if (!cityDraft.trim()) return;
    setCities((c) => addCities(c, cityDraft));
    setCityDraft('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    const finalCities = cityDraft.trim() ? addCities(cities, cityDraft) : cities;
    const allServices = mergeServices(services, serviceDraft);
    const priceN = parseOptionalNumber(price);
    const capacityN = parseOptionalNumber(capacity);
    const yearsN = parseOptionalNumber(years);
    if (!ownerName.trim()) return setError('Enter your name.');
    if (!businessName.trim()) return setError('Enter your business name.');
    if (!isPlausibleMobile(mobile)) return setError('Enter a valid mobile number.');
    if (email.trim() && !looksLikeEmail(email)) return setError('That email does not look right.');
    if (allServices.length === 0) return setError('Pick or enter at least one service.');
    if (allServices.length > 10) return setError('Enter at most 10 services.');
    if (allServices.some((x) => x.length > 60))
      return setError('Each service must be 60 characters or fewer.');
    if (finalCities.length === 0) return setError('Add at least one city you cover.');
    if (frequencies.length === 0) return setError('Pick at least one frequency.');
    if (insured === null) return setError('Say whether you are insured.');
    if (priceN === undefined || (priceN !== null && priceN < 0))
      return setError('Starting price must be a number.');
    if (
      capacityN === undefined ||
      (capacityN !== null && (capacityN < 0 || !Number.isInteger(capacityN)))
    )
      return setError('New clients you can take must be a whole number.');
    if (yearsN === undefined || (yearsN !== null && (yearsN < 0 || !Number.isInteger(yearsN))))
      return setError('Years in business must be a whole number.');

    setSubmitting(true);
    const r = await submitProForm(token, {
      ownerName: ownerName.trim(),
      businessName: businessName.trim(),
      mobile: mobile.trim(),
      email: email.trim() || null,
      services: allServices,
      cities: finalCities,
      frequencies,
      insured,
      bestContact: bestContact.trim() || null,
      startingPrice: priceN,
      capacity: capacityN,
      yearsInBusiness: yearsN,
      hd_chk: trap,
    });
    setSubmitting(false);
    if (r.kind === 'ok') setDone(true);
    else if (r.kind === 'field') setError(r.message);
    else if (r.kind === 'dead') setError("This link doesn't work any more. Ask for a new one.");
    else if (r.kind === 'limited') setError('Too many tries. Please wait a while and try again.');
    else setError(r.message);
  };

  if (done) {
    return (
      <div className="text-center space-y-3 py-10" role="status">
        <div className="mx-auto w-10 h-10 rounded-full bg-success/20 text-success flex items-center justify-center">
          <Check className="w-5 h-5" />
        </div>
        <h1 className="text-page-title text-text-primary">Thank you</h1>
        <p className="text-body text-text-secondary">
          {info.orgName ? `${info.orgName} has` : 'We have'} your details and will be in touch. You
          can close this page.
        </p>
      </div>
    );
  }

  const cats = info.serviceCategories;
  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <h1 className="text-page-title text-text-primary">
          {info.orgName ? `Join ${info.orgName}` : 'Tell us about your business'}
        </h1>
        <p className="text-body text-text-secondary mt-1">
          Answer what you can. Fields marked * are needed.
        </p>
      </div>

      {error && (
        <div
          ref={errorRef}
          role="alert"
          className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3"
        >
          {error}
        </div>
      )}

      {/* Honeypot: off-screen, not focusable, never autofilled (name is deliberately not a common field). */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto' }}>
        <input
          type="text"
          name="hd_chk"
          tabIndex={-1}
          autoComplete="off"
          value={trap}
          onChange={(e) => setTrap(e.target.value)}
        />
      </div>

      <Field label="Owner name" required>
        <input
          className={INPUT}
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          autoComplete="name"
          maxLength={120}
        />
      </Field>
      <Field label="Business name" required>
        <input
          className={INPUT}
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          autoComplete="organization"
          maxLength={200}
        />
      </Field>
      <Field label="Mobile number" required>
        <input
          className={INPUT}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
        />
      </Field>
      <Field label="Email">
        <input
          className={INPUT}
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={200}
        />
      </Field>

      <Field label="Services offered" required>
        <div className="space-y-2">
          {cats.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {cats.map((c) => (
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
          <input
            className={INPUT}
            value={serviceDraft}
            onChange={(e) => setServiceDraft(e.target.value)}
            placeholder={cats.length > 0 ? 'Other (separate with commas)' : 'e.g. plumbing, HVAC'}
            aria-label={cats.length > 0 ? 'Other services' : 'Services offered'}
            maxLength={300}
            autoComplete="off"
          />
        </div>
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
          autoComplete="off"
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(',')) {
              setCities((c) => addCities(c, v));
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

      <Button type="submit" variant="primary" className="w-full" disabled={submitting}>
        {submitting ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}
