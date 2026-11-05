import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { getMyProFormLink } from '@/lib/api';
import { isViewOnly } from '@/lib/viewAs';

/**
 * TASK-H29: "send them the form" -- copies the caller's own pro-form link (credited to them). The link is fetched on the
 * click, not on mount, because the first call creates it. Hidden in a view-only tab (that call is a write). If the browser
 * refuses the clipboard, the link is shown selected so it can be copied by hand.
 */
export function CopyFormLink({
  label = 'Copy link',
  className,
  size = 'sm',
}: {
  label?: string;
  className?: string;
  size?: 'sm' | 'default';
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  if (isViewOnly) return null;

  const copy = async () => {
    if (busy) return;
    setBusy(true);
    setManual(null);
    try {
      const url = await getMyProFormLink();
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2500);
      } catch {
        setManual(url);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not get your form link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={className}>
      <Button type="button" variant="fe-secondary" size={size} onClick={copy} disabled={busy}>
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : copied ? (
          <Check className="w-4 h-4 text-success" />
        ) : (
          <Copy className="w-4 h-4" />
        )}
        {copied ? 'Copied' : label}
      </Button>
      {manual && (
        <input
          readOnly
          autoFocus
          value={manual}
          aria-label="Form link"
          onFocus={(e) => e.currentTarget.select()}
          className="mt-2 block w-full rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-meta text-text-primary"
        />
      )}
    </span>
  );
}
