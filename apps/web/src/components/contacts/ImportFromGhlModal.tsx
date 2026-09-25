import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, CheckCircle, Tag, Search as SearchIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  importFromGhl,
  getGhlIntegrationStatus,
  listCampaigns,
  type ImportFromGhlInput,
  type ImportFromGhlResult,
  type CampaignWithStats,
} from '@/lib/api';

const NO_CAMPAIGN = '__none__';

interface ImportFromGhlModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** Set by "Re-sync": pre-fills the form with the last successful import's params and
   *  submits immediately, landing straight on the result step. */
  initialInput?: ImportFromGhlInput;
  autoSubmit?: boolean;
  /** Reports the exact params a successful import used, so the caller can offer "Re-sync"
   *  with them afterward -- design's "Re-sync" is just this same call replayed. */
  onImported: (input: ImportFromGhlInput) => void;
}

export function ImportFromGhlModal({
  open,
  onClose,
  onSuccess,
  initialInput,
  autoSubmit,
  onImported,
}: ImportFromGhlModalProps) {
  const [mode, setMode] = useState<'tag' | 'search'>(initialInput?.mode ?? 'tag');
  const [value, setValue] = useState(initialInput?.value ?? '');
  const [campaignId, setCampaignId] = useState<string>(initialInput?.campaignId ?? NO_CAMPAIGN);
  const [campaigns, setCampaigns] = useState<CampaignWithStats[]>([]);
  const [ghlConnected, setGhlConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportFromGhlResult | null>(null);
  const hasAutoSubmitted = useRef(false);

  useEffect(() => {
    if (!open) return;
    setMode(initialInput?.mode ?? 'tag');
    setValue(initialInput?.value ?? '');
    setCampaignId(initialInput?.campaignId ?? NO_CAMPAIGN);
    setError(null);
    setResult(null);
    hasAutoSubmitted.current = false;
    listCampaigns()
      .then(setCampaigns)
      .catch(() => setCampaigns([]));
    getGhlIntegrationStatus()
      .then((status) => setGhlConnected(status?.status === 'connected'))
      .catch(() => setGhlConnected(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const runImport = async (input: ImportFromGhlInput) => {
    setLoading(true);
    setError(null);
    try {
      const res = await importFromGhl(input);
      setResult(res);
      onImported(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (
      open &&
      autoSubmit &&
      initialInput &&
      ghlConnected === true &&
      !hasAutoSubmitted.current &&
      !loading &&
      !result
    ) {
      hasAutoSubmitted.current = true;
      runImport(initialInput);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoSubmit, ghlConnected]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || loading) return;
    runImport({
      mode,
      value: trimmed,
      campaignId: campaignId === NO_CAMPAIGN ? undefined : campaignId,
    });
  };

  const handleClose = () => {
    if (loading) return;
    onClose();
  };

  const handleDone = () => {
    onSuccess();
    handleClose();
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-2"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} aria-hidden="true" />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-lg rounded-2xl border border-white/10 bg-[#1A2332] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 p-4">
          <h2 className="text-xl font-bold text-white">
            {result ? 'Import Complete' : 'Import from GHL'}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={loading}
            className="rounded-lg p-2 text-[#B0BEC5] hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <AnimatePresence mode="wait">
            {result ? (
              <motion.div
                key="result"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-4"
              >
                <CheckCircle className="w-12 h-12 text-[#00D9FF] mx-auto" />
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div className="rounded-xl bg-[#1E2A3A] p-3">
                    <div className="text-2xl font-bold text-white">{result.created}</div>
                    <div className="text-xs text-[#B0BEC5]">Created</div>
                  </div>
                  <div className="rounded-xl bg-[#1E2A3A] p-3">
                    <div className="text-2xl font-bold text-white">{result.updated}</div>
                    <div className="text-xs text-[#B0BEC5]">Updated</div>
                  </div>
                  <div className="rounded-xl bg-[#1E2A3A] p-3">
                    <div className="text-2xl font-bold text-white">{result.skipped}</div>
                    <div className="text-xs text-[#B0BEC5]">Skipped</div>
                  </div>
                  <div className="rounded-xl bg-[#1E2A3A] p-3">
                    <div className="text-2xl font-bold text-white">{result.invalid}</div>
                    <div className="text-xs text-[#B0BEC5]">Invalid phone</div>
                  </div>
                </div>
                {(result.skippedDnc > 0 ||
                  result.skippedPaused > 0 ||
                  result.skippedActiveCampaign > 0) && (
                  <p className="text-sm text-[#B0BEC5]">
                    Not added to the campaign:{' '}
                    {[
                      result.skippedDnc > 0 && `${result.skippedDnc} do-not-call`,
                      result.skippedPaused > 0 && `${result.skippedPaused} paused`,
                      result.skippedActiveCampaign > 0 &&
                        `${result.skippedActiveCampaign} already active in another campaign`,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    .
                  </p>
                )}
                {result.truncated && (
                  <p className="text-sm text-yellow-400">
                    This org has more matching GHL contacts than one run fetches. Run "Re-sync"
                    again to continue -- already-imported contacts are skipped, not duplicated.
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleDone}
                  className="w-full px-5 py-3 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold"
                >
                  Done
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="form"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-4"
              >
                {ghlConnected === false && (
                  <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm p-3">
                    GHL isn't connected for this org yet. Connect it in Settings → Integrations
                    first.
                  </div>
                )}
                {error && (
                  <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm p-3">
                    {error}
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('tag')}
                    className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                      mode === 'tag'
                        ? 'bg-[#0066FF] text-white'
                        : 'bg-[#1E2A3A] text-[#B0BEC5] hover:bg-[#252F3E]'
                    }`}
                  >
                    <Tag className="w-4 h-4" />
                    By tag
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('search')}
                    className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                      mode === 'search'
                        ? 'bg-[#0066FF] text-white'
                        : 'bg-[#1E2A3A] text-[#B0BEC5] hover:bg-[#252F3E]'
                    }`}
                  >
                    <SearchIcon className="w-4 h-4" />
                    By search
                  </button>
                </div>

                <div>
                  <label className="text-sm text-[#B0BEC5] block mb-1">
                    {mode === 'tag' ? 'GHL tag' : 'Search term'}
                  </label>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={mode === 'tag' ? 'e.g. hot-lead' : 'Name, phone, or email'}
                    className="w-full bg-[#1E2A3A] border border-white/10 rounded-xl px-4 py-3 text-white placeholder-[#B0BEC5]/50 focus:outline-none focus:border-[#00D9FF] transition-colors"
                  />
                  {mode === 'tag' && (
                    <p className="text-xs text-[#B0BEC5] mt-1">
                      Matches the exact tag on each GHL contact (case-insensitive).
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-sm text-[#B0BEC5] block mb-1">
                    Add to campaign (optional)
                  </label>
                  <Select value={campaignId} onValueChange={setCampaignId}>
                    <SelectTrigger className="w-full bg-[#1E2A3A] border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      className="bg-[#1E2A3A] border-white/10"
                      style={{ zIndex: 10001 }}
                    >
                      <SelectItem
                        value={NO_CAMPAIGN}
                        className="bg-[#1E2A3A] hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                      >
                        None
                      </SelectItem>
                      {campaigns.map((c) => (
                        <SelectItem
                          key={c.id}
                          value={c.id}
                          className="bg-[#1E2A3A] hover:bg-white/10 focus:bg-white/10 text-white focus:text-white"
                        >
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={loading || !value.trim() || ghlConnected !== true}
                  className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-gradient-to-r from-[#00D9FF] to-[#0066FF] rounded-xl text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
                  {loading ? 'Importing...' : 'Import'}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
