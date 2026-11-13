import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Search, Loader2, X } from 'lucide-react';
import { searchPhoneNumbers, purchasePhoneNumber } from '@/lib/api';
import { usePhoneNumbers } from '@/contexts/PhoneNumbersContext';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface PurchaseNumbersModalProps {
  open: boolean;
  onClose: () => void;
}

/** TASK-U2 (user order): the always-visible "Purchase Numbers" block is now a popup, opened from
 *  a button in the phone-numbers module's own header -- same search/results/purchase flow as
 *  before (searchPhoneNumbers/purchasePhoneNumber, unchanged), same hand-rolled portal/focus-trap
 *  modal shape as AddContactModal.tsx (this codebase's real dialog convention), plus an explicit
 *  Escape handler -- useFocusTrap deliberately doesn't add one itself (see its own doc comment),
 *  and nothing else in this file's existing modals has one either. Refreshes the pool via the
 *  SAME PhoneNumbersContext NumberPoolCard reads from, so a purchase here updates that list
 *  without a prop callback. */
export function PurchaseNumbersModal({ open, onClose }: PurchaseNumbersModalProps) {
  const { refetch } = usePhoneNumbers();
  const [searchAreaCode, setSearchAreaCode] = useState('');
  const [searchResults, setSearchResults] = useState<
    { phone_number: string; monthly_cost?: string }[]
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [purchaseLoading, setPurchaseLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, open);

  const handleClose = () => {
    setSearchAreaCode('');
    setSearchResults([]);
    setSearchAttempted(false);
    setError(null);
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleClose only reads/resets local state, stable enough for this listener's lifetime
  }, [open]);

  if (!open) return null;

  const handleSearch = async () => {
    setSearchLoading(true);
    setError(null);
    setSearchResults([]);
    setSearchAttempted(false);
    try {
      const numbers = await searchPhoneNumbers(searchAreaCode);
      setSearchResults(numbers);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearchLoading(false);
      setSearchAttempted(true);
    }
  };

  const handlePurchase = async (phoneNumber: string) => {
    setPurchaseLoading(phoneNumber);
    setError(null);
    try {
      await purchasePhoneNumber(phoneNumber);
      await refetch();
      setSearchResults((prev) => prev.filter((n) => n.phone_number !== phoneNumber));
    } catch (e) {
      setError(String(e));
    } finally {
      setPurchaseLoading(null);
    }
  };

  return createPortal(
    <div
      className="hd-touch fixed inset-0 flex items-center justify-center p-4 max-md:p-0"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="purchase-numbers-title"
    >
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} aria-hidden="true" />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-lg max-h-[85vh] max-md:h-[100dvh] max-md:max-h-none max-md:max-w-none max-md:rounded-none max-md:border-0 flex flex-col rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-subtle p-4 shrink-0 max-md:pt-[max(1rem,env(safe-area-inset-top))]">
          <h2 id="purchase-numbers-title" className="text-page-title text-text-primary">
            Purchase numbers
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="rounded-app-md p-2 text-text-secondary hover:bg-white/10 hover:text-text-primary"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <p className="text-text-secondary text-sm">
            Search by area code (e.g. 415, 920) or leave blank to browse US numbers.
          </p>

          {error && (
            <div className="p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Area code (e.g. 415) or leave blank"
              value={searchAreaCode}
              onChange={(e) => setSearchAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
              className="flex-1 bg-surface-2 border border-white/10 rounded-app-md px-4 py-3 text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
            />
            <button
              type="button"
              onClick={() => void handleSearch()}
              disabled={searchLoading}
              className="px-6 py-3 bg-gradient-to-r from-accent-from to-accent-to rounded-app-md text-white font-semibold disabled:opacity-50 flex items-center gap-2 shrink-0"
            >
              {searchLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Search className="w-5 h-5" />
              )}
              Search
            </button>
          </div>

          {searchLoading && (
            <div className="py-4 text-center text-text-secondary">
              Searching Telnyx marketplace…
            </div>
          )}
          {searchAttempted && !searchLoading && searchResults.length === 0 && (
            <div className="py-4 text-center text-text-secondary text-sm">
              No numbers found for this area. Try a different area code or leave blank for US
              numbers.
            </div>
          )}
          {searchResults.length > 0 && (
            <div className="space-y-2">
              {searchResults.map((n) => (
                <div
                  key={n.phone_number}
                  className="flex items-center justify-between p-3 bg-surface-2/60 rounded-lg"
                >
                  <span className="text-white font-medium">{n.phone_number}</span>
                  <span className="text-text-secondary text-sm">
                    {n.monthly_cost ? `$${n.monthly_cost}/mo` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handlePurchase(n.phone_number)}
                    disabled={purchaseLoading === n.phone_number}
                    className="px-4 py-2 bg-success/20 hover:bg-success/30 border border-success/30 rounded-lg text-success text-sm font-medium disabled:opacity-50 flex items-center gap-1"
                  >
                    {purchaseLoading === n.phone_number ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : null}
                    Purchase
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
