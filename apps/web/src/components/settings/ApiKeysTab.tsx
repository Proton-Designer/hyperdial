import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { PageHeader } from '@/components/app/PageHeader';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/components/ui/utils';
import {
  createOrgApiKey,
  listOrgApiKeys,
  revokeOrgApiKey,
  type CreatedOrgApiKey,
  type OrgApiKey,
} from '@/lib/api';

const API_URL = 'https://hyperdial.myhomebasesolutions.com/api/v1/calls';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtLastUsed = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Never';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the text is still visible and selectable next to the button.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="hd-touch inline-flex items-center gap-1.5 px-3 py-1.5 rounded-app-md border border-border-subtle text-sm text-text-primary hover:bg-surface-2"
    >
      {copied ? (
        <Check className="w-4 h-4 text-success" aria-hidden />
      ) : (
        <Copy className="w-4 h-4" aria-hidden />
      )}
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * TASK-H37 Part B: Settings -> API keys (owner/admin only). Create a read-only key for the Calls
 * API, see it ONCE, list keys (prefix, created, last used) and revoke with a confirm. The server
 * (RPCs + RLS) is what actually enforces owner/admin; this tab is hidden from everyone else.
 */
export function ApiKeysTab() {
  const [keys, setKeys] = useState<OrgApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedOrgApiKey | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    listOrgApiKeys()
      .then(setKeys)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const row = await createOrgApiKey(trimmed);
      setCreated(row);
      setName('');
      load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    setRevokeError(null);
    try {
      await revokeOrgApiKey(id);
      setConfirmId(null);
      load();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingId(null);
    }
  };

  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => k.revoked_at);

  return (
    <div>
      <PageHeader
        title="API keys"
        description="Let a script of yours read your team's finished calls and recordings. Keys are read-only."
      />

      {created && (
        <div
          role="status"
          className="mb-6 max-w-4xl rounded-app-lg border border-warning/40 bg-warning/10 p-4 sm:p-5"
        >
          <div className="text-sm font-semibold text-text-primary mb-1">
            Copy your key now: {created.name}
          </div>
          <p className="text-sm text-text-secondary mb-3">
            This is the only time it is shown. HyperDial keeps just a fingerprint, so a lost key
            cannot be looked up again: revoke it and create a new one.
          </p>
          <code className="block break-all select-all rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-sm text-text-primary mb-3">
            {created.key}
          </code>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={created.key} label="Copy key" />
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="hd-touch px-3 py-1.5 rounded-app-md border border-border-subtle text-sm text-text-secondary hover:bg-surface-2"
            >
              I&apos;ve saved it
            </button>
          </div>
        </div>
      )}

      <div className="bg-surface-1 rounded-app-lg p-4 sm:p-6 border border-border-subtle max-w-4xl mb-6">
        <h3 className="text-section-title text-text-primary mb-3">Create a key</h3>
        <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="What is it for? (e.g. Call review script)"
            aria-label="Key name"
            className="flex-1 min-w-0 bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-sm text-white placeholder-text-muted focus:outline-none focus:border-accent-to"
          />
          <button
            type="submit"
            disabled={creating || !name.trim()}
            className="hd-touch px-4 py-2 rounded-app-md bg-accent-from text-white text-sm font-medium disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create key'}
          </button>
        </form>
        {createError && (
          <div role="alert" className="mt-3 text-sm text-danger">
            {createError}
          </div>
        )}
      </div>

      <div className="bg-surface-1 rounded-app-lg p-4 sm:p-6 border border-border-subtle max-w-4xl mb-6">
        <h3 className="text-section-title text-text-primary mb-3">Your keys</h3>
        {revokeError && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {revokeError}
          </div>
        )}
        {loading ? (
          <Skeleton className="h-[96px] w-full rounded-app-md" />
        ) : loadError ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-text-secondary">
            <span>Couldn&apos;t load your keys: {loadError}</span>
            <button
              type="button"
              onClick={load}
              className="hd-touch px-3 py-1.5 rounded-app-md border border-border-subtle text-text-primary hover:bg-surface-2"
            >
              Try again
            </button>
          </div>
        ) : keys.length === 0 ? (
          <p className="text-sm text-text-secondary">No keys yet.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {[...active, ...revoked].map((k) => {
              const isRevoked = Boolean(k.revoked_at);
              return (
                <li key={k.id} className={cn('py-3', isRevoked && 'opacity-60')}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <KeyRound className="w-4 h-4 text-text-secondary shrink-0" aria-hidden />
                        <span className="font-medium text-text-primary break-words">{k.name}</span>
                        {isRevoked && (
                          <span className="px-2 py-0.5 rounded-full text-xs bg-surface-3 text-text-secondary">
                            Revoked
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-meta text-text-secondary">
                        <code>{k.key_prefix}…</code> · Created {fmtDate(k.created_at)} · Last used{' '}
                        {fmtLastUsed(k.last_used_at)}
                      </div>
                    </div>
                    {!isRevoked &&
                      (confirmId === k.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-text-secondary">
                            Anything using it stops working now.
                          </span>
                          <button
                            type="button"
                            disabled={revokingId === k.id}
                            onClick={() => void handleRevoke(k.id)}
                            className="hd-touch px-3 py-1.5 rounded-app-md bg-danger text-white text-sm disabled:opacity-50"
                          >
                            {revokingId === k.id ? 'Revoking…' : 'Yes, revoke'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmId(null)}
                            className="hd-touch px-3 py-1.5 rounded-app-md border border-border-subtle text-sm text-text-secondary hover:bg-surface-2"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setRevokeError(null);
                            setConfirmId(k.id);
                          }}
                          className="hd-touch px-3 py-1.5 rounded-app-md border border-danger/40 text-danger text-sm hover:bg-danger/10"
                        >
                          Revoke
                        </button>
                      ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="bg-surface-1 rounded-app-lg p-4 sm:p-6 border border-border-subtle max-w-4xl">
        <h3 className="text-section-title text-text-primary mb-2">How to use it</h3>
        <p className="text-sm text-text-secondary mb-3">
          Send your key in the <code>x-api-key</code> header. Ask for calls that changed after a
          time you choose; follow <code>next_cursor</code> while <code>has_more</code> is true (up
          to 200 calls a page, oldest first). Limit: 60 requests a minute.
        </p>
        <pre className="overflow-x-auto rounded-app-md bg-surface-2 border border-border-subtle p-3 text-xs text-text-primary mb-3">
          {`curl -H "x-api-key: YOUR_KEY" \\
  "${API_URL}?since=2026-01-01T00:00:00Z"`}
        </pre>
        <div className="mb-3">
          <CopyButton
            text={`curl -H "x-api-key: YOUR_KEY" "${API_URL}?since=2026-01-01T00:00:00Z"`}
            label="Copy example"
          />
        </div>
        <ul className="list-disc pl-5 space-y-1 text-sm text-text-secondary">
          <li>
            Each call has the agent, campaign, outcome (<code>disposition</code>), the contact with
            their <code>timezone</code>, <code>callback_at</code> and a <code>recording_url</code>{' '}
            to the MP3 (a link that works for 6 hours). Manual calls are not included.
          </li>
          <li>
            A call can come back: first <code>status: &quot;pending&quot;</code> (outcome or
            recording not there yet), then <code>&quot;complete&quot;</code>. Keep one copy per{' '}
            <code>id</code>, the one with the newest <code>updated_at</code>.
          </li>
          <li>
            If a recording link could not be made, <code>recording_url</code> is null and{' '}
            <code>recording_error</code> says so; the call comes back later with the link.
          </li>
          <li>
            Recordings are two-channel: <strong>left is the contact, right is the agent</strong>.
          </li>
          <li>Anything missing comes back as null. Treat the key like a password.</li>
          <li>
            Full guide: <code>docs/guides/public-api.md</code> in the HyperDial repository.
          </li>
        </ul>
      </div>
    </div>
  );
}
