import { useEffect, useState } from 'react';
import { contactHeadline } from '@/lib/contactName';
import { createPortal } from 'react-dom';
import {
  X,
  Phone,
  Mail,
  Building2,
  MapPin,
  Globe,
  FileText,
  User,
  Pencil,
  ShieldOff,
} from 'lucide-react';
import { motion } from 'motion/react';
import { listContactFieldDefs, updateContact, type Contact, type ContactFieldDef } from '@/lib/api';
import { useOrg } from '@/contexts/OrgContext';
import { setPendingManualDialNumber } from '@/lib/dialerLaunchIntent';
import { LogCloseModal } from '@/components/dialer/LogCloseModal';
import { isViewOnly } from '@/lib/viewAs';
import { ContactNotesPanel } from './ContactNotesPanel';
import { ContactChangeHistoryPanel } from './ContactChangeHistoryPanel';
import { ManualCallsPanel } from './ManualCallsPanel';

type DetailTab = 'details' | 'notes' | 'history';

const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Arizona (no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
  { value: 'America/Indiana/Indianapolis', label: 'Eastern (Indiana)' },
  { value: 'America/Detroit', label: 'Eastern (Michigan)' },
  { value: 'America/Puerto_Rico', label: 'Atlantic (Puerto Rico)' },
  { value: 'America/Toronto', label: 'Eastern (Canada)' },
  { value: 'America/Winnipeg', label: 'Central (Canada)' },
  { value: 'America/Regina', label: 'Central, no DST (Saskatchewan)' },
  { value: 'America/Edmonton', label: 'Mountain (Canada)' },
  { value: 'America/Vancouver', label: 'Pacific (Canada)' },
  { value: 'America/Halifax', label: 'Atlantic (Canada)' },
  { value: 'America/Moncton', label: 'Atlantic (Canada)' },
  { value: 'America/St_Johns', label: 'Newfoundland' },
  { value: 'America/Whitehorse', label: 'Yukon' },
  { value: 'Pacific/Guam', label: 'Chamorro (Guam)' },
  { value: 'Pacific/Pago_Pago', label: 'Samoa' },
];

function truncateUrl(url: string, maxLen: number): string {
  if (!url || url.length <= maxLen) return url || '—';
  return url.slice(0, maxLen) + '...';
}

interface EditFormState {
  business_name: string;
  business_type: string;
  phone_number: string;
  website: string;
  notes: string;
  first_name: string;
  last_name: string;
  owner_contact: string;
  address: string;
  city: string;
  timezone: string;
}

function toFormState(c: Contact): EditFormState {
  return {
    business_name: c.business_name ?? '',
    business_type: c.business_type ?? '',
    phone_number: c.phone_number ?? '',
    website: c.website ?? '',
    notes: c.notes ?? '',
    first_name: c.first_name ?? '',
    last_name: c.last_name ?? '',
    owner_contact: c.owner_contact ?? '',
    address: c.address ?? '',
    city: c.city ?? '',
    timezone: c.timezone ?? '',
  };
}

const inputClass =
  'w-full bg-surface-2 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to';

interface ContactDetailModalProps {
  contact: Contact | null;
  open: boolean;
  onClose: () => void;
  /** Called after a save succeeds, with the fresh row, so the caller can refresh its list. */
  onUpdated?: (contact: Contact) => void;
  /** TASK-H23 (A): switches to the Dialer tab so "Call" places the call in HyperDial. */
  onNavigateToDialer?: () => void;
}

export function ContactDetailModal({
  contact,
  open,
  onClose,
  onUpdated,
  onNavigateToDialer,
}: ContactDetailModalProps) {
  const { role } = useOrg();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dncSaving, setDncSaving] = useState(false);
  // TASK-H24: "Log close" from the contact itself (a close is otherwise only reachable from a session wrap-up).
  const [logCloseOpen, setLogCloseOpen] = useState(false);
  const [closedHere, setClosedHere] = useState(false);
  const [tab, setTab] = useState<DetailTab>('details');
  const [fieldDefs, setFieldDefs] = useState<ContactFieldDef[]>([]);
  const hasCustomValues = Object.keys(contact?.custom_values ?? {}).length > 0;

  // TASK-H01: labels for the contact's custom values. Best effort -- without them the key is shown.
  useEffect(() => {
    if (!open || !hasCustomValues) return;
    let cancelled = false;
    listContactFieldDefs()
      .then((defs) => {
        if (!cancelled) setFieldDefs(defs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, hasCustomValues]);

  if (!open) return null;
  const c = contact;
  if (!c) return null;

  // Design §2's permission matrix: only owner/admin edit general contact fields. An
  // assigned agent may still toggle DNC (below) -- contacts_agent_update_scope
  // (20260924001300) enforces that boundary server-side regardless of what this UI shows.
  const canEditFields = role === 'owner' || role === 'admin';

  const name = contactHeadline(c);
  const category = c.category ?? 'Cold';
  const contactStatus = c.contact_status ?? 'No Contact';

  const handleClose = () => {
    if (saving || dncSaving) return;
    setEditing(false);
    setForm(null);
    setError(null);
    setTab('details');
    onClose();
  };

  const startEdit = () => {
    setForm(toFormState(c));
    setError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setForm(null);
    setError(null);
  };

  const setField = (key: keyof EditFormState, value: string) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleSave = async () => {
    if (!form || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateContact(c.id, {
        business_name: form.business_name.trim() || undefined,
        business_type: form.business_type.trim() || undefined,
        phone_number: form.phone_number.trim() || undefined,
        website: form.website.trim() || undefined,
        notes: form.notes.trim() || undefined,
        first_name: form.first_name.trim() || undefined,
        last_name: form.last_name.trim() || undefined,
        owner_contact: form.owner_contact.trim() || undefined,
        address: form.address.trim() || undefined,
        city: form.city.trim() || undefined,
        timezone: form.timezone || undefined,
      });
      onUpdated?.(updated);
      setEditing(false);
      setForm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save contact');
    } finally {
      setSaving(false);
    }
  };

  // TASK-G31: marking do-not-call is open to every role that can see the contact; clearing it is owner/admin only
  // (the contacts_agent_update_scope trigger enforces it, this just says so up front).
  const dncLocked = c.dnc && !canEditFields;
  // TASK-H23 (A): "Call" places the call inside HyperDial (the Dialer's manual-dial path), never a
  // tel: link that hands the number to FaceTime. A do-not-call contact is never dialed.
  const callDisabledReason = c.dnc ? 'Do not call: this contact has asked not to be called.' : null;
  const canCall = !callDisabledReason && Boolean(onNavigateToDialer);
  const placeCall = () => {
    if (!canCall || !c.phone_number) return;
    setPendingManualDialNumber(c.phone_number);
    handleClose();
    onNavigateToDialer?.();
  };

  const toggleDnc = async () => {
    if (dncSaving || dncLocked) return;
    setDncSaving(true);
    setError(null);
    try {
      const updated = await updateContact(c.id, { dnc: !c.dnc });
      onUpdated?.(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update do-not-call');
    } finally {
      setDncSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4 max-md:p-0"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} aria-hidden="true" />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[101] flex max-h-[calc(100dvh-1rem)] w-full max-w-lg flex-col rounded-2xl border border-white/10 bg-surface-1 shadow-xl overflow-hidden max-md:h-[100dvh] max-md:max-h-none max-md:max-w-none max-md:rounded-none max-md:border-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 p-4 max-md:pt-[max(1rem,env(safe-area-inset-top))]">
          <h2 className="text-xl font-bold text-white">
            {editing ? 'Edit contact' : 'Contact details'}
          </h2>
          <div className="flex items-center gap-2">
            {!editing && canEditFields && (
              <button
                type="button"
                onClick={startEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-accent-to hover:bg-accent-to/10 touch:min-h-11"
              >
                <Pencil className="w-4 h-4" />
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg p-2 text-text-secondary hover:bg-white/10 hover:text-white max-lg:flex touch:h-11 touch:w-11 max-lg:items-center max-lg:justify-center"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4 min-h-0 flex-1 overflow-y-auto md:max-h-[70vh] max-md:p-4">
          {error && (
            <div className="rounded-lg bg-danger/10 border border-danger/30 text-danger text-sm p-3">
              {error}
            </div>
          )}

          {/* Do-not-call: every role that can see this contact may mark it; only owner/admin may clear it (TASK-G31). */}
          <button
            type="button"
            onClick={toggleDnc}
            disabled={dncSaving || dncLocked}
            title={dncLocked ? 'Only an owner or admin can clear do-not-call' : undefined}
            className={`w-full flex items-center justify-between gap-2 rounded-xl border p-3 text-sm font-medium touch:min-h-11 transition-colors disabled:opacity-50 ${
              c.dnc
                ? 'bg-danger/10 border-danger/30 text-danger'
                : 'bg-white/5 border-white/10 text-text-secondary hover:bg-white/10'
            }`}
          >
            <span className="flex items-center gap-2">
              <ShieldOff className="w-4 h-4" />
              Do not call
            </span>
            <span>
              {c.dnc ? (dncLocked ? 'On' : 'On — click to clear') : 'Off — click to mark'}
            </span>
          </button>
          {dncLocked && (
            <p className="text-xs text-text-secondary -mt-2">
              Only an owner or admin can clear do-not-call. Ask one of them if this was marked by
              mistake.
            </p>
          )}

          {!editing && (
            <div className="flex gap-1 border-b border-white/10">
              {(['details', 'notes', 'history'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`px-3 py-2 text-sm font-medium capitalize border-b-2 -mb-px touch:min-h-11 ${
                    tab === t
                      ? 'border-accent-to text-white'
                      : 'border-transparent text-text-secondary hover:text-white'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          {tab === 'notes' && !editing && <ContactNotesPanel contactId={c.id} />}
          {tab === 'history' && !editing && (
            <>
              <ContactChangeHistoryPanel contactId={c.id} />
              <ManualCallsPanel contactId={c.id} />
            </>
          )}

          {!editing
            ? tab === 'details' && (
                <>
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-full bg-gradient-to-br from-accent-from to-accent-to flex items-center justify-center text-white text-lg font-bold flex-shrink-0">
                      {name
                        .replace('—', '')
                        .split(' ')
                        .map((n) => n[0])
                        .filter(Boolean)
                        .join('')
                        .slice(0, 2) || '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-white text-lg line-clamp-2">{name}</div>
                      <div className="flex gap-2 mt-1 flex-wrap">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-white/10 text-text-secondary">
                          {category}
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-white/10 text-text-secondary">
                          {contactStatus}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 text-sm">
                    {c.business_type && (
                      <div className="flex gap-2">
                        <Building2 className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                        <div className="min-w-0 text-text-secondary">{c.business_type}</div>
                      </div>
                    )}
                    {c.phone_number && (
                      <div className="flex gap-2 items-center">
                        <Phone className="w-4 h-4 text-accent-to flex-shrink-0" />
                        <button
                          type="button"
                          onClick={placeCall}
                          disabled={!canCall}
                          title={callDisabledReason ?? 'Call in HyperDial'}
                          className="text-accent-to hover:underline truncate block touch:min-h-11 max-lg:py-2.5 disabled:text-text-muted disabled:no-underline disabled:cursor-not-allowed"
                        >
                          {c.phone_number}
                        </button>
                      </div>
                    )}
                    {c.timezone && (
                      <div className="flex gap-2 items-center">
                        <FileText className="w-4 h-4 text-accent-to flex-shrink-0" />
                        <div className="text-text-secondary">
                          {TIMEZONE_OPTIONS.find((t) => t.value === c.timezone)?.label ??
                            c.timezone}
                        </div>
                      </div>
                    )}
                    {c.owner_contact?.includes('@') && (
                      <div className="flex gap-2 items-center">
                        <Mail className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                        <a
                          href={`mailto:${c.owner_contact}`}
                          className="text-accent-to hover:underline truncate block"
                          title={c.owner_contact}
                        >
                          {truncateUrl(c.owner_contact, 50)}
                        </a>
                      </div>
                    )}
                    {c.website && (
                      <div className="flex gap-2 items-center">
                        <Globe className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                        <a
                          href={c.website.startsWith('http') ? c.website : `https://${c.website}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent-to hover:underline truncate block"
                          title={c.website}
                        >
                          {truncateUrl(c.website, 50)}
                        </a>
                      </div>
                    )}
                    {c.address && (
                      <div className="flex gap-2">
                        <MapPin className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                        <div className="text-text-secondary line-clamp-2">{c.address}</div>
                      </div>
                    )}
                    {c.city && (
                      <div className="flex gap-2">
                        <MapPin className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                        <div className="text-text-secondary">City: {c.city}</div>
                      </div>
                    )}
                    {c.business_link && (
                      <div className="flex gap-2">
                        <Globe className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                        <a
                          href={
                            c.business_link.startsWith('http')
                              ? c.business_link
                              : `https://${c.business_link}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent-to hover:underline truncate block"
                          title={c.business_link}
                        >
                          {truncateUrl(c.business_link, 50)}
                        </a>
                      </div>
                    )}
                    {(c.first_name || c.last_name) &&
                      (c.first_name || c.last_name) !== (c.business_name ?? '') && (
                        <div className="flex gap-2">
                          <User className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                          <div className="text-text-secondary">
                            {[c.first_name, c.last_name].filter(Boolean).join(' ')}
                          </div>
                        </div>
                      )}
                    {(c.rating != null || c.review_count != null) && (
                      <div className="flex gap-2 text-text-secondary">
                        <FileText className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                        <span>
                          {c.rating != null && `Rating: ${c.rating}`}
                          {c.rating != null && c.review_count != null && ' · '}
                          {c.review_count != null && `Reviews: ${c.review_count}`}
                        </span>
                      </div>
                    )}
                    {c.open_hours && (
                      <div className="flex gap-2">
                        <FileText className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                        <div className="text-text-secondary line-clamp-2">{c.open_hours}</div>
                      </div>
                    )}
                    {c.notes && (
                      <div className="flex gap-2">
                        <FileText className="w-4 h-4 text-accent-to flex-shrink-0 mt-0.5" />
                        <div className="text-text-secondary line-clamp-3">{c.notes}</div>
                      </div>
                    )}
                  </div>

                  {hasCustomValues && (
                    <div className="space-y-1 pt-2 border-t border-white/5">
                      <div className="text-xs font-medium text-text-secondary">Custom fields</div>
                      {Object.entries(c.custom_values ?? {}).map(([key, value]) => (
                        <div key={key} className="flex gap-2 text-sm">
                          <span className="text-text-muted flex-shrink-0">
                            {fieldDefs.find((d) => d.key === key)?.label ?? key}:
                          </span>
                          <span className="text-text-secondary break-words min-w-0">{value}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="text-xs text-text-secondary pt-2 border-t border-white/5">
                    Added {new Date(c.created_at).toLocaleDateString()}
                    {c.updated_at !== c.created_at &&
                      ` · Updated ${new Date(c.updated_at).toLocaleDateString()}`}
                  </div>
                </>
              )
            : form && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm text-text-secondary mb-1">First name</label>
                      <input
                        className={inputClass}
                        value={form.first_name}
                        onChange={(e) => setField('first_name', e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-text-secondary mb-1">Last name</label>
                      <input
                        className={inputClass}
                        value={form.last_name}
                        onChange={(e) => setField('last_name', e.target.value)}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">Business name</label>
                    <input
                      className={inputClass}
                      value={form.business_name}
                      onChange={(e) => setField('business_name', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">Business type</label>
                    <input
                      className={inputClass}
                      value={form.business_type}
                      onChange={(e) => setField('business_type', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">Phone number</label>
                    <input
                      type="tel"
                      className={inputClass}
                      value={form.phone_number}
                      onChange={(e) => setField('phone_number', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">Timezone</label>
                    <select
                      className={inputClass}
                      value={form.timezone}
                      onChange={(e) => setField('timezone', e.target.value)}
                    >
                      <option value="">Not set</option>
                      {TIMEZONE_OPTIONS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">Website</label>
                    <input
                      type="url"
                      className={inputClass}
                      value={form.website}
                      onChange={(e) => setField('website', e.target.value)}
                      placeholder="https://..."
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">Owner / email</label>
                    <input
                      className={inputClass}
                      value={form.owner_contact}
                      onChange={(e) => setField('owner_contact', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">Address</label>
                    <input
                      className={inputClass}
                      value={form.address}
                      onChange={(e) => setField('address', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">City</label>
                    <input
                      className={inputClass}
                      value={form.city}
                      onChange={(e) => setField('city', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">Notes</label>
                    <textarea
                      className={inputClass}
                      rows={3}
                      value={form.notes}
                      onChange={(e) => setField('notes', e.target.value)}
                    />
                  </div>
                </div>
              )}
        </div>
        <div className="p-4 border-t border-white/10 flex justify-end gap-2 max-md:pb-[max(1rem,env(safe-area-inset-bottom))]">
          {editing ? (
            <>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className="px-4 py-2 rounded-xl border border-white/10 text-text-secondary hover:bg-white/5 disabled:opacity-50 touch:min-h-11"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-accent-from to-accent-to text-white font-semibold text-sm disabled:opacity-50 touch:min-h-11"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          ) : (
            <>
              {c.contact_status === 'Closed' || closedHere ? (
                <span className="inline-flex items-center px-3 py-2 rounded-xl border border-success/30 bg-success-soft text-success text-sm font-semibold">
                  Already closed
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setLogCloseOpen(true)}
                  disabled={isViewOnly}
                  title={isViewOnly ? 'View-only' : undefined}
                  className="px-4 py-2 rounded-xl border border-white/10 text-text-primary hover:bg-white/5 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed touch:min-h-11"
                >
                  Log close
                </button>
              )}
              {c.phone_number && (
                <div className="flex flex-col items-start gap-1">
                  <button
                    type="button"
                    onClick={placeCall}
                    disabled={!canCall}
                    title={callDisabledReason ?? undefined}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-accent-from to-accent-to text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed touch:min-h-11"
                  >
                    <Phone className="w-4 h-4" />
                    Call
                  </button>
                  {callDisabledReason && (
                    <span className="text-meta text-text-muted">{callDisabledReason}</span>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 rounded-xl border border-white/10 text-text-secondary hover:bg-white/5 touch:min-h-11"
              >
                Close
              </button>
            </>
          )}
        </div>
      </motion.div>
      {logCloseOpen && (
        <LogCloseModal
          draftKey={`contact:${c.id}`}
          contactId={c.id}
          name={contactHeadline(c)}
          phone={c.phone_number ?? ''}
          onSaved={() => {
            setClosedHere(true);
            onUpdated?.({ ...c, contact_status: 'Closed' });
          }}
          onClose={() => setLogCloseOpen(false)}
        />
      )}
    </div>,
    document.body
  );
}
