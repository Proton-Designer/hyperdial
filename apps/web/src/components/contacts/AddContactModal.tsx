import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  createContact,
  CONTACT_CANONICAL_FIELDS,
  type Contact,
  type CreateContactInput,
} from '@/lib/api';
import { normalizePhoneStrict } from '@/lib/phone-normalize';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

const DEFAULT_FIELDS = ['Business Name', 'Business Type', 'Phone Number', 'Website'] as const;
const ADDITIONAL_OPTIONS = CONTACT_CANONICAL_FIELDS.filter(
  (f) => !(DEFAULT_FIELDS as readonly string[]).includes(f)
);

/** Same strict E.164 validation contacts-import applies to a CSV row (design §7) --
 * createContact re-normalizes and throws on save regardless; this is just inline feedback. */
function isValidPhone(v: string): boolean {
  return normalizePhoneStrict(v) !== null;
}

function isValidUrl(v: string): boolean {
  if (!v.trim()) return true;
  try {
    new URL(v.startsWith('http') ? v : `https://${v}`);
    return true;
  } catch {
    return false;
  }
}

interface AddContactModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after contact is created; receives the new contact when provided (e.g. for adding to campaign). */
  onSuccess: (contact?: Contact) => void;
}

export function AddContactModal({ open, onClose, onSuccess }: AddContactModalProps) {
  const [expandAdditional, setExpandAdditional] = useState(false);
  const [additionalFields, setAdditionalFields] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, open);

  const allShownFields = [...DEFAULT_FIELDS, ...additionalFields];
  const availableToAdd = ADDITIONAL_OPTIONS.filter((f) => !additionalFields.includes(f));

  const getValue = (field: string) => values[field] ?? '';
  const setValue = (field: string, v: string) => {
    setValues((prev) => ({ ...prev, [field]: v }));
    setError(null);
  };

  const hasAnyValue = allShownFields.some((f) => (values[f] ?? '').trim() !== '');
  const phone = (values['Phone Number'] ?? '').trim();
  const website = (values['Website'] ?? '').trim();
  const valid = hasAnyValue && (!phone || isValidPhone(phone)) && (!website || isValidUrl(website));

  const handleAddField = (field: string) => {
    setAdditionalFields((prev) => [...prev, field]);
    setExpandAdditional(false);
  };

  const handleRemoveAdditional = (field: string) => {
    setAdditionalFields((prev) => prev.filter((f) => f !== field));
    setValues((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const toDbKey = (label: string): keyof CreateContactInput => {
    const map: Record<string, keyof CreateContactInput> = {
      'Business Name': 'business_name',
      'Business Link': 'business_link',
      'Business Type': 'business_type',
      Rating: 'rating',
      'Review Count': 'review_count',
      'Open Hours': 'open_hours',
      'Phone Number': 'phone_number',
      Website: 'website',
      Notes: 'notes',
      'First Name': 'first_name',
      'Last Name': 'last_name',
      'Owner Contact': 'owner_contact',
      Address: 'address',
    };
    return map[label] ?? 'notes';
  };

  const handleSubmit = async () => {
    if (!valid || saving) return;
    setError(null);
    setSaving(true);
    try {
      const input: CreateContactInput = {};
      for (const field of allShownFields) {
        const v = (values[field] ?? '').trim();
        const key = toDbKey(field);
        if (key === 'rating') input.rating = v ? parseFloat(v) : undefined;
        else if (key === 'review_count') input.review_count = v ? parseInt(v, 10) : undefined;
        else (input as Record<string, string | undefined>)[key] = v || undefined;
      }
      const contact = await createContact(input);
      onSuccess(contact);
      onClose();
      setValues({});
      setAdditionalFields([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add contact');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!saving) {
      setValues({});
      setError(null);
      setAdditionalFields([]);
      onClose();
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} aria-hidden="true" />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-lg rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-subtle p-4">
          <h2 className="text-page-title text-text-primary">Add contact</h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-app-md p-2 text-text-secondary hover:bg-white/10 hover:text-text-primary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3">
              {error}
            </div>
          )}
          {DEFAULT_FIELDS.map((field) => (
            <div key={field}>
              <label className="block text-meta text-text-secondary mb-1">{field}</label>
              <input
                type={field === 'Phone Number' ? 'tel' : field === 'Website' ? 'url' : 'text'}
                value={getValue(field)}
                onChange={(e) => setValue(field, e.target.value)}
                placeholder={field === 'Website' ? 'https://...' : ''}
                className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-3 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
              />
            </div>
          ))}
          <div>
            <button
              type="button"
              onClick={() => setExpandAdditional(!expandAdditional)}
              className="flex items-center gap-2 text-body text-accent-to hover:underline"
            >
              <Plus className="w-4 h-4" />
              Add field
              <ChevronDown
                className={`w-4 h-4 transition-transform ${expandAdditional ? 'rotate-180' : ''}`}
              />
            </button>
            <AnimatePresence>
              {expandAdditional && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-2 overflow-hidden"
                >
                  <div className="flex flex-wrap gap-2">
                    {availableToAdd.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => handleAddField(f)}
                        className="px-3 py-1.5 rounded-app-md bg-surface-2 border border-border-subtle text-text-primary text-body hover:border-accent-to/50"
                      >
                        {f}
                      </button>
                    ))}
                    {availableToAdd.length === 0 && (
                      <span className="text-body text-text-secondary">All fields added</span>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {additionalFields.map((field) => (
            <div key={field} className="flex items-center gap-2">
              <div className="flex-1">
                <label className="block text-meta text-text-secondary mb-1">{field}</label>
                <input
                  type="text"
                  value={getValue(field)}
                  onChange={(e) => setValue(field, e.target.value)}
                  className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-4 py-3 text-text-primary focus:outline-none focus:border-accent-to"
                />
              </div>
              <button
                type="button"
                onClick={() => handleRemoveAdditional(field)}
                className="mt-6 p-2 text-text-secondary hover:text-danger"
                aria-label={`Remove ${field}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle p-4">
          <Button variant="fe-ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!valid || saving}
            loading={saving}
          >
            Save
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
