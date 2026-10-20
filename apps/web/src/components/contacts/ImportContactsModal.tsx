import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Upload, Loader2, CheckCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '../ui/utils';
import {
  parseContactsCsv,
  importContacts,
  CONTACT_CANONICAL_FIELDS,
  type ParseCsvResponse,
  type ParseCsvColumn,
  type ImportContactsResult,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

const SKIP_OPTION = 'Skip this column';
const FIELD_OPTIONS = [SKIP_OPTION, ...CONTACT_CANONICAL_FIELDS];

const IMPORT_CATEGORIES = ['Cold', 'Warm', 'Follow Up', 'Voicemail', 'Booked'] as const;

interface ImportContactsModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** When set, imported contacts are also added to this campaign. */
  campaignId?: string;
}

export function ImportContactsModal({
  open,
  onClose,
  onSuccess,
  campaignId,
}: ImportContactsModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [dragOver, setDragOver] = useState(false);
  const [, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState('');
  const [parseResult, setParseResult] = useState<ParseCsvResponse | null>(null);
  const [columns, setColumns] = useState<ParseCsvColumn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportContactsResult | null>(null);
  const [importCategory, setImportCategory] = useState<string>('Cold');
  // TASK-G18: name of the list being imported; defaults to the file name, sent to GHL as "Lead List / Batch ID".
  const [listName, setListName] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, open);

  const assignedCount = columns.filter(
    (c) => c.mapped_field && c.mapped_field !== SKIP_OPTION
  ).length;
  const skippedCount = columns.filter((c) => c.mapped_field === SKIP_OPTION).length;
  const allAssigned = columns.every(
    (c) => c.mapped_field !== null && c.mapped_field !== undefined && c.mapped_field !== ''
  );

  /** Ensure each canonical field is only mapped to one column (first wins; duplicates → incomplete). */
  const normalizeColumnMappings = useCallback((cols: ParseCsvColumn[]): ParseCsvColumn[] => {
    const usedFields = new Set<string>();
    return cols.map((col) => {
      const field = col.mapped_field?.trim();
      if (!field || field === SKIP_OPTION) return { ...col };
      if (usedFields.has(field)) {
        return { ...col, mapped_field: null, status: 'incomplete' as const };
      }
      usedFields.add(field);
      return { ...col };
    });
  }, []);

  const readFile = useCallback(
    (f: File) => {
      if (!f.name.toLowerCase().endsWith('.csv')) {
        setError('Please select a .csv file');
        return;
      }
      setError(null);
      setFile(f);
      setListName(f.name.replace(/\.csv$/i, '').slice(0, 120));
      const reader = new FileReader();
      reader.onload = () => {
        const text = (reader.result as string) || '';
        setCsvText(text);
        setLoading(true);
        parseContactsCsv(text)
          .then((res) => {
            setParseResult(res);
            setColumns(normalizeColumnMappings(res.columns.map((col) => ({ ...col }))));
            setStep(2);
          })
          .catch((e) => setError(e instanceof Error ? e.message : 'Failed to parse CSV'))
          .finally(() => setLoading(false));
      };
      reader.readAsText(f);
    },
    [normalizeColumnMappings]
  );

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) readFile(f);
    e.target.value = '';
  };

  const setMappedField = (index: number, value: string) => {
    setColumns((prev) => {
      const next = [...prev];
      const isSkip = value === SKIP_OPTION;
      const field = isSkip ? null : value;
      if (!isSkip && field) {
        const alreadyUsed = prev.some((c, i) => i !== index && c.mapped_field === field);
        if (alreadyUsed) {
          next[index] = { ...next[index], mapped_field: null, status: 'incomplete' };
          return next;
        }
      }
      next[index] = {
        ...next[index],
        mapped_field: isSkip ? SKIP_OPTION : value,
        status: 'mapped',
      };
      return next;
    });
  };

  const isFieldMappedElsewhere = (field: string, currentIndex: number) => {
    if (field === SKIP_OPTION) return false;
    return columns.some((c, i) => i !== currentIndex && c.mapped_field === field);
  };

  const handleFinishImport = async () => {
    if (!allAssigned || !csvText || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await importContacts(
        csvText,
        columns.map((c) => ({
          original_header: c.original_header,
          mapped_field: c.mapped_field === SKIP_OPTION ? null : (c.mapped_field ?? null),
        })),
        importCategory,
        campaignId,
        listName.trim() || undefined
      );
      setImportResult(result);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setStep(1);
      setFile(null);
      setCsvText('');
      setParseResult(null);
      setColumns([]);
      setError(null);
      setImportResult(null);
      setImportCategory('Cold');
      setListName('');
      onClose();
    }
  };

  const handleViewContacts = () => {
    onSuccess();
    handleClose();
  };

  if (!open) return null;

  const mappedCount = columns.filter((c) => c.status === 'mapped').length;
  const pendingCount = columns.filter(
    (c) => c.status === 'incomplete' || !c.mapped_field || c.mapped_field === ''
  ).length;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-2"
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
        className="relative z-[1] w-full max-w-4xl flex flex-col rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md outline-none"
        style={{ maxHeight: 'calc(100vh - 16px)', minHeight: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-subtle p-4 flex-shrink-0">
          <h2 className="text-page-title text-text-primary">
            {step === 1 && 'Import contacts'}
            {step === 2 && 'Map your columns'}
            {step === 3 && 'Import complete'}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={loading}
            className="rounded-app-md p-2 text-text-secondary hover:bg-white/10 hover:text-text-primary disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 min-h-0">
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-4"
              >
                <p className="text-body text-text-secondary">
                  Upload a .csv file. We'll parse it and help you map columns.
                </p>
                {error && (
                  <div className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3">
                    {error}
                  </div>
                )}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed rounded-app-lg p-12 text-center transition-colors ${
                    dragOver
                      ? 'border-accent-to bg-accent-to/5'
                      : 'border-border-strong hover:border-text-muted'
                  }`}
                >
                  {loading ? (
                    <Loader2 className="w-12 h-12 text-accent-to animate-spin mx-auto mb-2" />
                  ) : (
                    <Upload className="w-12 h-12 text-text-secondary mx-auto mb-2" />
                  )}
                  <p className="text-text-primary font-medium mb-1">
                    {loading ? 'Parsing CSV...' : 'Drag and drop your CSV here'}
                  </p>
                  <p className="text-body text-text-secondary mb-4">or</p>
                  <label className="inline-flex items-center gap-2 px-4 py-2 rounded-app-md bg-accent-from/20 text-accent-to font-medium cursor-pointer hover:bg-accent-from/30">
                    <Upload className="w-4 h-4" />
                    Choose file
                    <input
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={handleFileInput}
                      disabled={loading}
                    />
                  </label>
                </div>
              </motion.div>
            )}

            {step === 2 && parseResult && (
              <motion.div
                key="step2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-4"
              >
                <p className="text-body text-text-secondary">
                  {mappedCount} columns mapped automatically · {pendingCount} need your attention
                </p>
                <p className="text-meta text-text-secondary">
                  {assignedCount + skippedCount} of {columns.length} columns assigned
                </p>
                {parseResult.invalid_phone_count > 0 && (
                  <div className="rounded-app-md bg-warning-soft border border-warning/30 text-warning text-body p-3">
                    {parseResult.invalid_phone_count} row
                    {parseResult.invalid_phone_count === 1 ? '' : 's'} have a phone number that
                    isn't valid and will be skipped on import.
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <label htmlFor="import-list-name" className="text-body text-text-secondary">
                    List name (optional)
                  </label>
                  <input
                    id="import-list-name"
                    type="text"
                    value={listName}
                    maxLength={120}
                    onChange={(e) => setListName(e.target.value)}
                    placeholder="e.g. Austin HVAC scrape, Oct 12"
                    className="w-full bg-surface-2 border border-border-subtle rounded-app-md px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
                  />
                  <p className="text-meta text-text-muted">
                    Sent to GoHighLevel as the lead list for calls to these contacts.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-body text-text-secondary">Category for this import:</span>
                  <Select value={importCategory} onValueChange={setImportCategory}>
                    <SelectTrigger className="w-[180px] min-w-[180px] cursor-pointer bg-surface-2 border-border-subtle text-text-primary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      className="bg-surface-2 border-border-subtle max-h-[14rem] [&_[data-radix-select-viewport]]:!max-h-[12.5rem]"
                      style={{ zIndex: 10001 }}
                    >
                      {IMPORT_CATEGORIES.map((cat) => (
                        <SelectItem
                          key={cat}
                          value={cat}
                          className="bg-surface-2 hover:bg-white/10 focus:bg-white/10 text-text-primary focus:text-text-primary cursor-pointer"
                        >
                          {cat}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {error && (
                  <div className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3">
                    {error}
                  </div>
                )}
                <div className="border border-border-subtle rounded-app-lg overflow-hidden">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-surface-2 border-b border-border-subtle">
                        <th className="p-3 text-meta font-medium text-text-secondary">
                          Column header in file
                        </th>
                        <th className="p-3 text-meta font-medium text-text-secondary">Preview</th>
                        <th className="p-3 text-meta font-medium text-text-secondary">Status</th>
                        <th className="p-3 text-meta font-medium text-text-secondary">Object</th>
                        <th className="p-3 text-meta font-medium text-text-secondary">Fields</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((col, index) => (
                        <tr
                          key={col.original_header}
                          className="border-b border-border-subtle hover:bg-white/5"
                        >
                          <td className="p-3 text-text-primary font-medium">
                            {col.original_header}
                          </td>
                          <td className="p-3 text-meta text-text-secondary max-w-[200px]">
                            <div className="flex flex-col gap-0.5">
                              {col.preview_data.slice(0, 3).map((v, i) => (
                                <span key={i} className="truncate" title={v}>
                                  {v}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="p-3">
                            {col.mapped_field && col.mapped_field !== SKIP_OPTION ? (
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-success-soft text-success">
                                <CheckCircle className="w-3 h-3" /> Mapped
                              </span>
                            ) : (
                              <span className="inline-flex px-2 py-1 rounded-full text-xs font-medium bg-surface-3 text-text-secondary">
                                Pending
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-text-secondary text-meta">Contact</td>
                          <td className="p-3 w-[220px]">
                            <Select
                              value={col.mapped_field ?? ''}
                              onValueChange={(v) => setMappedField(index, v)}
                            >
                              <SelectTrigger className="w-full min-w-[200px] cursor-pointer bg-surface-2 border-border-subtle text-text-primary h-10 rounded-app-md transition-all duration-200 hover:border-accent-to/30 focus:ring-2 focus:ring-accent-to/20">
                                <SelectValue placeholder="Please Select" />
                              </SelectTrigger>
                              <SelectContent
                                className="bg-surface-2 border border-border-subtle rounded-app-md shadow-app-md overflow-y-auto [&_.select-viewport]:!max-h-[14rem] [&_.select-viewport]:!h-auto p-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200 data-[side=bottom]:slide-in-from-top-1"
                                style={{ zIndex: 10001, maxHeight: '14rem' }}
                              >
                                {FIELD_OPTIONS.map((opt) => {
                                  const isCurrentSelection = col.mapped_field === opt;
                                  const isMappedElsewhere = isFieldMappedElsewhere(opt, index);
                                  return (
                                    <SelectItem
                                      key={opt}
                                      value={opt}
                                      disabled={isMappedElsewhere}
                                      className={cn(
                                        'rounded-app-sm py-2.5 pl-3 pr-3 text-sm transition-colors duration-150 cursor-pointer [&>span:first-of-type]:!hidden',
                                        'bg-transparent hover:bg-white/10 focus:bg-white/10 focus:text-text-primary focus:outline-none',
                                        isCurrentSelection && 'text-accent-to bg-accent-to/5',
                                        isMappedElsewhere &&
                                          'text-text-muted opacity-70 cursor-not-allowed'
                                      )}
                                    >
                                      {opt}
                                    </SelectItem>
                                  );
                                })}
                              </SelectContent>
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="fe-ghost" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleFinishImport}
                    disabled={!allAssigned || loading}
                    loading={loading}
                  >
                    Finish import
                  </Button>
                </div>
              </motion.div>
            )}

            {step === 3 && importResult && (
              <motion.div
                key="step3"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-center py-8"
              >
                <CheckCircle className="w-16 h-16 text-success mx-auto mb-4" />
                <h3 className="text-page-title text-text-primary mb-2">
                  {importResult.imported} contacts imported successfully
                </h3>
                <p className="text-body text-text-secondary mb-6">
                  {importResult.skipped > 0 &&
                    `${importResult.skipped} row${importResult.skipped === 1 ? '' : 's'} skipped (missing or invalid phone number${importResult.invalid > 0 ? `, ${importResult.invalid} invalid` : ''}). `}
                  {importResult.duplicates > 0 && `${importResult.duplicates} duplicates skipped. `}
                  {importResult.skippedDnc > 0 &&
                    `${importResult.skippedDnc} not added to the campaign (do-not-call). `}
                  {importResult.skippedActiveCampaign > 0 &&
                    `${importResult.skippedActiveCampaign} not added to the campaign (already active in another campaign).`}
                </p>
                <Button variant="primary" onClick={handleViewContacts}>
                  View contacts
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
