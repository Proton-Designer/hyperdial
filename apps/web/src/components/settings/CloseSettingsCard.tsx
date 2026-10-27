import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';
import {
  getCloseSettings,
  retryCloseDeliveries,
  saveCloseSettings,
  testCloseWebhook,
  type CloseSettings,
} from '@/lib/api';
import { addCities } from '@/lib/closeForm';

const INPUT =
  'w-full bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white placeholder-text-muted focus:outline-none focus:border-accent-to';

/**
 * TASK-H03: Settings -> Integrations -> "Closes". Owner/admin only (the parent renders it only for them; the
 * close-webhook-settings function enforces it too). Two parts: the service categories interns pick in the Log
 * Close form, and the webhook (Google Apps Script web app or a GoHighLevel inbound webhook) every close is POSTed
 * to, with delivery health and a retry for failed deliveries. The secret is shown once (it signs each request).
 */
export function CloseSettingsCard() {
  const [settings, setSettings] = useState<CloseSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [categories, setCategories] = useState<string[]>([]);
  const [catDraft, setCatDraft] = useState('');
  const [url, setUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const apply = useCallback((s: CloseSettings) => {
    setSettings(s);
    setCategories(s.categories);
    setUrl(s.webhook.url ?? '');
    setEnabled(s.webhook.enabled);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      apply(await getCloseSettings());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load the closes settings');
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : 'Something went wrong' });
    } finally {
      setBusy(null);
    }
  };

  const addCategory = () => {
    if (!catDraft.trim()) return;
    setCategories((c) => addCities(c, catDraft.replace(/,/g, ' ')));
    setCatDraft('');
  };

  const saveCategories = () =>
    run('categories', async () => {
      const list = catDraft.trim()
        ? addCities(categories, catDraft.replace(/,/g, ' '))
        : categories;
      apply(await saveCloseSettings({ categories: list }));
      setCatDraft('');
      setMessage({ tone: 'ok', text: 'Service categories saved.' });
    });

  const saveWebhook = (rotateSecret = false) =>
    run('webhook', async () => {
      const res = await saveCloseSettings({
        webhook: { url: url.trim() || null, enabled, rotateSecret },
      });
      apply(res);
      if (res.secret) setNewSecret(res.secret);
      setMessage({ tone: 'ok', text: 'Webhook saved.' });
    });

  const copySecret = async () => {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const webhookDirty =
    settings !== null &&
    (url.trim() !== (settings.webhook.url ?? '') || enabled !== settings.webhook.enabled);

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-xl mt-6">
      <h3 className="text-white font-medium mb-1">Closes</h3>
      <p className="text-sm text-text-secondary mb-4">
        When an intern logs a close, HyperDial marks the contact Closed and sends the form to the
        webhook below (a Google Apps Script web app that adds a row to your closes sheet, or a
        GoHighLevel inbound webhook).
      </p>

      {!settings && !loadError && (
        <div className="flex items-center gap-2 text-sm text-text-secondary" role="status">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      )}
      {loadError && (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-danger">{loadError}</p>
          <button type="button" onClick={load} className="text-xs text-accent-to hover:underline">
            Try again
          </button>
        </div>
      )}

      {settings && (
        <div className="space-y-6">
          {message && (
            <p
              role={message.tone === 'error' ? 'alert' : 'status'}
              className={`text-sm ${message.tone === 'error' ? 'text-danger' : 'text-success'}`}
            >
              {message.text}
            </p>
          )}

          <section>
            <div className="text-sm text-white mb-1">Service categories</div>
            <p className="text-xs text-text-secondary mb-2">
              The list interns pick &ldquo;Services offered&rdquo; from. Until you add some, the
              form tells them to ask an admin.
            </p>
            {categories.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {categories.map((c) => (
                  <span
                    key={c}
                    className="inline-flex items-center gap-1 pl-3 pr-1.5 py-1 rounded-full bg-surface-3 text-sm text-white"
                  >
                    {c}
                    <button
                      type="button"
                      aria-label={`Remove ${c}`}
                      onClick={() => setCategories((l) => l.filter((x) => x !== c))}
                      className="p-0.5 text-text-secondary hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                className={INPUT}
                value={catDraft}
                maxLength={80}
                placeholder="Add a category, press Enter"
                onChange={(e) => setCatDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCategory();
                  }
                }}
              />
              <button
                type="button"
                onClick={addCategory}
                className="shrink-0 px-3 rounded-app border border-white/10 bg-surface-2 text-text-secondary hover:text-white text-sm"
              >
                Add
              </button>
            </div>
            <button
              type="button"
              disabled={busy !== null}
              onClick={saveCategories}
              className="mt-3 px-4 py-2 rounded-app text-sm text-white bg-gradient-to-r from-accent-from to-accent-to disabled:opacity-50 inline-flex items-center gap-2"
            >
              {busy === 'categories' && <Loader2 className="w-4 h-4 animate-spin" />}
              Save categories
            </button>
          </section>

          <section>
            <div className="text-sm text-white mb-1">Closes webhook</div>
            <label className="block text-xs text-text-secondary mb-1" htmlFor="close-webhook-url">
              Webhook URL (https)
            </label>
            <input
              id="close-webhook-url"
              className={INPUT}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://script.google.com/macros/s/…/exec"
              autoComplete="off"
              inputMode="url"
            />
            <label className="mt-3 flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Send closes to this webhook
            </label>

            <p className="text-xs text-text-secondary mt-3 mb-2">
              {settings.webhook.hasSecret
                ? 'A signing secret is set (each request carries an HMAC signature header). It cannot be shown again.'
                : 'No signing secret. Optional: create one so your receiver can verify requests.'}
            </p>
            {newSecret && (
              <div className="mb-3 rounded-app border border-success/40 p-3" role="status">
                <div className="text-xs text-text-secondary mb-1">New secret (shown once)</div>
                <div className="flex items-stretch gap-2">
                  <code className="flex-1 min-w-0 px-3 py-2 bg-surface-2 border border-white/10 rounded-app text-xs text-white break-all font-mono">
                    {newSecret}
                  </code>
                  <button
                    type="button"
                    onClick={copySecret}
                    aria-label="Copy secret"
                    className="shrink-0 px-3 rounded-app border border-white/10 bg-surface-2 text-text-secondary hover:text-white inline-flex items-center gap-1 text-xs"
                  >
                    {copied ? (
                      <Check className="w-4 h-4 text-success" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy !== null || !webhookDirty}
                onClick={() => saveWebhook(false)}
                className="px-4 py-2 rounded-app text-sm text-white bg-gradient-to-r from-accent-from to-accent-to disabled:opacity-50 inline-flex items-center gap-2"
              >
                {busy === 'webhook' && <Loader2 className="w-4 h-4 animate-spin" />}
                Save webhook
              </button>
              <button
                type="button"
                disabled={busy !== null || webhookDirty || !settings.webhook.url}
                onClick={() =>
                  run('test', async () => {
                    const r = await testCloseWebhook();
                    setMessage(
                      r.outcome === 'sent'
                        ? { tone: 'ok', text: 'Test sent. The receiver answered OK.' }
                        : { tone: 'error', text: `Test failed: ${r.error ?? r.outcome}` }
                    );
                  })
                }
                className="px-3 py-2 rounded-app text-sm text-text-secondary border border-white/10 disabled:opacity-50"
              >
                {busy === 'test' ? 'Sending…' : 'Send test'}
              </button>
              <button
                type="button"
                disabled={busy !== null || webhookDirty}
                onClick={() => void saveWebhook(true)}
                className="text-xs text-text-secondary hover:text-white disabled:opacity-50"
              >
                {settings.webhook.hasSecret
                  ? 'Replace secret (old one stops working)'
                  : 'Create secret'}
              </button>
            </div>
          </section>

          <section>
            <div className="text-sm text-white mb-1">Delivery</div>
            <p className="text-xs text-text-secondary" role="status">
              Last 200 closes: {settings.counts.sent} sent, {settings.counts.pending} waiting,{' '}
              {settings.counts.failed} failed
              {settings.counts.notConfigured > 0 &&
                `, ${settings.counts.notConfigured} saved without a webhook`}
              .
            </p>
            {settings.recentFailures.length > 0 && (
              <ul className="mt-2 space-y-1">
                {settings.recentFailures.map((f) => (
                  <li key={f.id} className="text-xs text-text-secondary">
                    <span className="text-white">{f.businessName ?? 'A close'}</span>
                    {f.lastError ? ` — ${f.lastError}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {(settings.counts.failed > 0 || settings.counts.notConfigured > 0) && (
              <button
                type="button"
                disabled={busy !== null || !settings.webhook.enabled}
                onClick={() =>
                  run('retry', async () => {
                    const r = await retryCloseDeliveries();
                    setMessage({
                      tone: r.failed > 0 ? 'error' : 'ok',
                      text: `Retried ${r.requeued}: ${r.sent} sent, ${r.failed} still failing.`,
                    });
                    await load();
                  })
                }
                className="mt-3 px-3 py-2 rounded-app text-sm text-text-secondary border border-white/10 disabled:opacity-50"
              >
                {busy === 'retry' ? 'Retrying…' : 'Retry failed deliveries'}
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
