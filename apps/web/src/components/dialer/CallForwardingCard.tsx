import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getMyForwardNumber, setMyForwardNumber } from '@/lib/api';

/**
 * TASK-I1 review fix (eng1 review-eng1.md finding #5): the Profile tab's own "Call Forwarding"
 * field (Settings.tsx) is unreachable by an agent -- `MainApp.tsx`'s `AGENT_ALLOWED_TABS` never
 * includes `'settings'` at all, so an agent can never open that tab to set it, making INB-3's
 * own per-user forward number dead code in practice for every agent. Per the lead's own
 * direction: a small, standalone self-service panel on the Dialer's idle screen, reachable by
 * every role, WITHOUT opening the rest of Settings to agents. `getMyForwardNumber`/
 * `setMyForwardNumber` (api.ts) are already self-service (org_members' own RLS + the
 * 070101 trigger scope this to the caller's own row/columns regardless of role) -- this is a
 * second UI surface for the exact same API, not a new capability.
 */
export function CallForwardingCard() {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyForwardNumber()
      .then((n) => setValue(n ?? ''))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setMyForwardNumber(value.trim() || null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface-1 rounded-app-lg p-4 border border-border-subtle mt-4">
      <h3 className="text-meta text-text-secondary mb-2 font-medium">Call Forwarding</h3>
      {error && <p className="text-danger text-xs mb-2">{error}</p>}
      <div className="flex items-end gap-2">
        <input
          type="tel"
          value={value}
          disabled={loading || saving}
          onChange={(e) => setValue(e.target.value)}
          placeholder="+15551234567"
          className="flex-1 bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white placeholder-text-muted focus:outline-none focus:border-accent-to disabled:opacity-60"
        />
        <Button
          variant="fe-secondary"
          onClick={() => void handleSave()}
          disabled={loading || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p className="text-meta text-text-muted mt-1.5">
        {saved
          ? 'Saved.'
          : "Optional. If you don't answer an inbound call in your browser, it rings this number next."}
      </p>
    </div>
  );
}
