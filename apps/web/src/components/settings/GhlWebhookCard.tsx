import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import {
  getGhlWebhookSettings,
  revokeGhlWebhookSecret,
  rotateGhlWebhookSecret,
  type GhlIntakeOutcome,
  type GhlIntakeSummary,
  type GhlWebhookSettings,
} from '@/lib/api';

function CopyField({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mb-3">
      <div className="text-xs text-text-secondary mb-1">{label}</div>
      <div className="flex items-stretch gap-2">
        <code
          className={`flex-1 min-w-0 px-3 py-2 bg-surface-2 border border-white/10 rounded-app text-xs text-white break-all ${mono ? 'font-mono' : ''}`}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="shrink-0 px-3 rounded-app border border-white/10 bg-surface-2 text-text-secondary hover:text-white inline-flex items-center gap-1 text-xs"
        >
          {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

/** TASK-H17: plain words for what happened to a lead that arrived through the webhook. */
function describeIntake(
  outcome: GhlIntakeOutcome,
  campaignName: string | null
): { text: string; tone: 'good' | 'warn' | 'muted' | 'bad' } {
  switch (outcome) {
    case 'queued':
      return {
        text: campaignName ? `Added to ${campaignName}` : 'Added to a campaign',
        tone: 'good',
      };
    case 'already_queued':
      return { text: 'Already in a campaign', tone: 'muted' };
    case 'skipped_dnc':
      return { text: 'Do-not-call, skipped', tone: 'warn' };
    case 'skipped_paused':
      return { text: 'Has a paused tag, skipped', tone: 'warn' };
    case 'skipped_active_elsewhere':
      return { text: 'Active in another campaign, skipped', tone: 'muted' };
    case 'no_matching_rule':
      return { text: 'No rule for its tags', tone: 'warn' };
    default:
      return { text: 'Could not be added (error)', tone: 'bad' };
  }
}

const TONE_CLASS = {
  good: 'text-success',
  warn: 'text-yellow-400',
  muted: 'text-text-secondary',
  bad: 'text-danger',
} as const;

/** The latest leads GoHighLevel sent, newest first. The empty state tells the admin what to do first. */
function RecentLeads({ intake }: { intake: GhlIntakeSummary | undefined }) {
  const recent = intake?.recent ?? [];
  return (
    <div className="mb-4">
      <h4 className="text-sm text-white font-medium mb-1">Recent leads</h4>
      <p className="text-xs text-text-muted mb-2" role="status">
        {intake?.lastIntakeAt
          ? `Last new lead received ${when(intake.lastIntakeAt)}.`
          : 'No new leads received yet.'}
      </p>
      {recent.length === 0 ? (
        <div className="rounded-app border border-dashed border-white/10 p-3 text-xs text-text-secondary">
          <p className="text-white mb-1">Nothing here yet. To get started:</p>
          <ol className="list-decimal pl-5 space-y-0.5">
            <li>
              Switch on &ldquo;Also check GHL every 5 minutes&rdquo; above (instant leads need it),
              and add a tag &rarr; campaign rule in &ldquo;Tag/stage &rarr; campaign mappings&rdquo;
              below.
            </li>
            <li>
              Create the one GoHighLevel workflow (&ldquo;Set up in GoHighLevel&rdquo; below).
            </li>
            <li>
              Create a test contact in GoHighLevel with that tag and a phone number. It shows up
              here within seconds.
            </li>
          </ol>
        </div>
      ) : (
        <ul className="divide-y divide-white/10 rounded-app border border-white/10 bg-surface-2">
          {recent.slice(0, 20).map((r, i) => {
            const d = describeIntake(r.outcome, r.campaignName);
            const who = [r.contactName, r.phone].filter(Boolean).join(' · ') || 'Unknown contact';
            return (
              <li
                key={`${r.receivedAt}-${i}`}
                className="px-3 py-2 flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              >
                <div className="min-w-0">
                  <div className="text-xs text-white truncate">{who}</div>
                  <div className="text-xs text-text-muted">{when(r.receivedAt)}</div>
                </div>
                <div className={`text-xs sm:text-right ${TONE_CLASS[d.tone]}`}>{d.text}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * TASK-G30: Settings -> GoHighLevel -> "Instant updates". Owner/admin only (the parent renders it only for
 * them; the endpoint enforces it too). Shows the webhook URL, whether events are arriving, and creates /
 * replaces / deletes the secret a GoHighLevel workflow "Custom Webhook" sends. The secret is shown ONCE (only
 * its hash is stored), so a replace has an inline confirmation.
 */
export function GhlWebhookCard() {
  const [settings, setSettings] = useState<GhlWebhookSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'rotate' | 'revoke' | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSettings(await getGhlWebhookSettings());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load the webhook settings');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (kind: 'rotate' | 'revoke') => {
    setBusy(true);
    setActionError(null);
    setConfirming(null);
    try {
      const res =
        kind === 'rotate' ? await rotateGhlWebhookSecret() : await revokeGhlWebhookSecret();
      setNewSecret(res.secret ?? null);
      setSettings({ ...res, secret: undefined });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-xl mt-6">
      <h3 className="text-white font-medium mb-1">Instant new leads from GoHighLevel</h3>
      <p className="text-sm text-text-secondary mb-2">
        A GoHighLevel workflow can now send NEW leads to HyperDial the moment they appear, so
        interns can dial them within seconds. Each lead goes to a campaign by its tag or pipeline
        stage, using the rules in{' '}
        <a href="#ghl-campaign-mappings" className="text-accent-to hover:underline">
          Tag/stage &rarr; campaign mappings
        </a>
        . The same workflow URL and secret also give instant do-not-call, signed-up and owner
        updates.
      </p>
      <p className="text-sm text-text-secondary mb-4">
        Instant new leads only work while &ldquo;Also check GHL every 5 minutes&rdquo; above is
        switched on (it is also the backup if an instant update is missed) and at least one rule
        exists.
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
        <>
          {!settings.reconcileEnabled && (
            <p className="text-sm text-yellow-400 mb-4" role="status">
              Instant do-not-call and signed-up updates only act while &ldquo;Remove from call
              lists&rdquo; above is switched on. It is off right now, so those events are ignored
              (new leads need the 5-minute check and a rule instead).
            </p>
          )}

          <CopyField label="Webhook URL" value={settings.webhookUrl} />

          <RecentLeads intake={settings.intake} />

          <p className="text-xs text-text-muted mb-4" role="status">
            {settings.lastEventAt
              ? `Last update received ${when(settings.lastEventAt)} (${settings.lastEventType ?? 'event'}). ${settings.handledCount} received in total.`
              : 'No updates received yet.'}
          </p>

          <div className="mb-4">
            <div className="text-sm text-white mb-1">Workflow secret</div>
            <p className="text-xs text-text-secondary mb-2">
              {settings.hasSecret
                ? `A secret is set${settings.secretRotatedAt ? ` (created ${when(settings.secretRotatedAt)})` : ''}. It cannot be shown again; create a new one if you lost it.`
                : 'No secret yet. Create one, then paste it into the GoHighLevel workflow (steps below).'}
            </p>

            {newSecret && (
              <div className="mb-3 rounded-app border border-success/40 p-3" role="status">
                <CopyField label="New secret (shown once)" value={newSecret} />
                <p className="text-xs text-text-secondary">
                  Copy it now and paste it into your GoHighLevel workflows. Any older secret has
                  stopped working.
                </p>
              </div>
            )}

            {confirming ? (
              <div className="flex flex-wrap items-center gap-2" role="alert">
                <span className="text-xs text-text-secondary">
                  {confirming === 'rotate'
                    ? 'Workflows using the old secret will stop working. Continue?'
                    : 'Workflow webhooks will be refused until you create a new secret. Continue?'}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(confirming)}
                  className="px-3 py-1.5 rounded-app text-xs text-white bg-danger disabled:opacity-50"
                >
                  {confirming === 'rotate' ? 'Replace secret' : 'Delete secret'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="px-3 py-1.5 rounded-app text-xs text-text-secondary border border-white/10"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    settings.hasSecret ? setConfirming('rotate') : void run('rotate')
                  }
                  className="px-4 py-2 rounded-app text-sm text-white bg-gradient-to-r from-accent-from to-accent-to disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                  {settings.hasSecret ? 'Create a new secret' : 'Create secret'}
                </button>
                {settings.hasSecret && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirming('revoke')}
                    className="text-xs text-text-secondary hover:text-danger"
                  >
                    Delete secret
                  </button>
                )}
              </div>
            )}
            {actionError && (
              <p className="text-sm text-danger mt-2" role="alert">
                {actionError}
              </p>
            )}
          </div>

          <details className="rounded-app border border-white/10 bg-surface-2 px-3 py-2 mb-3">
            <summary className="cursor-pointer text-sm text-white">
              Set up in GoHighLevel (no app needed)
            </summary>
            <ol className="list-decimal pl-5 mt-2 space-y-1.5 text-xs text-text-secondary">
              <li>
                In GoHighLevel open Automation &rarr; Workflows &rarr; Create workflow (start from
                scratch).
              </li>
              <li>
                <span className="text-white">For new leads (one workflow for ALL campaigns):</span>{' '}
                Trigger &ldquo;Contact Created&rdquo;, no filter. You set this up once and never
                edit it: adding a campaign later needs no change in GoHighLevel. n8n must put the
                campaign&rsquo;s tag (shown on the Campaigns list, for example{' '}
                <code className="text-white">hd-mckinney</code>) on the contact when it creates it,
                together with the phone number. If the tag is added in a later step, the 5-minute
                check adds the lead instead (or use the trigger &ldquo;Contact Tag&rdquo; with the
                filter &ldquo;Tag Added&rdquo; as an alternative).
              </li>
              <li>
                <span className="text-white">For do-not-call, signed-up and owner changes:</span>{' '}
                make a separate workflow with the trigger &ldquo;Contact DND&rdquo;, &ldquo;Contact
                Tag&rdquo; (added or removed) or &ldquo;Pipeline Stage Changed&rdquo;.
              </li>
              <li>
                Action: &ldquo;Custom Webhook&rdquo;. Method POST, URL = the Webhook URL above,
                authorization &ldquo;No auth&rdquo;.
              </li>
              <li>
                Headers: add <code className="text-white">X-HyperDial-Webhook-Secret</code> with the
                secret as the value (create the secret above first; it is shown once).
              </li>
              <li>
                Custom data: <code className="text-white">contact_id</code> ={' '}
                <code className="text-white">{'{{contact.id}}'}</code> and{' '}
                <code className="text-white">location_id</code> ={' '}
                <code className="text-white">{'{{location.id}}'}</code>.
              </li>
              <li>
                Save and publish the workflow, then create a test contact with a campaign tag and
                watch &ldquo;Recent leads&rdquo; above. A full walkthrough, including n8n, is in
                docs/guides/ghl-instant-intake.md.
              </li>
            </ol>
          </details>

          <details className="rounded-app border border-white/10 bg-surface-2 px-3 py-2">
            <summary className="cursor-pointer text-sm text-white">
              Set it up as a GoHighLevel Marketplace app (signed)
            </summary>
            <ol className="list-decimal pl-5 mt-2 space-y-1.5 text-xs text-text-secondary">
              <li>
                Create a private app in the GoHighLevel developer area and install it on this
                location.
              </li>
              <li>
                Webhook URL = the Webhook URL above. Subscribe to ContactDndUpdate,
                ContactTagUpdate, ContactUpdate and OpportunityStageUpdate.
              </li>
              <li>
                No secret is needed: the app&rsquo;s deliveries are checked with GoHighLevel&rsquo;s
                published signature.
              </li>
            </ol>
          </details>
        </>
      )}
    </div>
  );
}
