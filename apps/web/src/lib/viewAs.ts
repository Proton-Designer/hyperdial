import { toast } from 'sonner';
import { supabase } from './supabase';
import { stopViewAs } from './api';
import {
  buildViewAsFragment,
  clearBootTokens,
  clearViewAsStorage,
  isViewOnly,
  takeBootTokens,
  type ViewAsMeta,
} from './viewAsFlag';

export { isViewOnly, getViewAsMeta, VIEW_AS_BANNER_HEIGHT } from './viewAsFlag';

/** TASK-H21: shown wherever a blocked action surfaces; the server answers 403 {error:'View-only'} / Postgres 25006. */
export const VIEW_ONLY_MESSAGE = "You're viewing as an intern — this screen is view only.";

const functionsBase = (() => {
  const url = import.meta.env.VITE_SUPABASE_URL;
  return url ? `${url}/functions/v1` : '';
})();

/**
 * Edge functions a view tab may call with a non-GET method (they only read). MIRRORS the server allowlist
 * (audit/H21/contract.md); the server is authoritative and denies everything else by default, this list only lets the
 * browser refuse a write without a round trip and with a friendly message.
 */
const READ_ONLY_POST_FUNCTIONS: ReadonlySet<string> = new Set([
  'dialer-session-get',
  'dialer-session-active',
  'shifts-week-get',
  'admin-shifts-overview',
  'dashboard-stats',
  'team-performance',
  'analytics-summary',
  'org-audit-log',
  'org-members',
  'telnyx-spend-status',
  'telnyx-list-numbers',
  'recording-url',
  'voicemail-upload',
  'view-as-stop',
]);

let lastToastAt = 0;
function notifyViewOnly() {
  const now = Date.now();
  if (now - lastToastAt < 2000) return;
  lastToastAt = now;
  toast.info(VIEW_ONLY_MESSAGE);
}

function viewOnlyResponse(): Response {
  return new Response(JSON.stringify({ error: 'View-only' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase();
}

/**
 * One central switch for the whole app (no per-screen code): in a view tab every non-GET request to an Edge Function
 * outside READ_ONLY_POST_FUNCTIONS, and every PostgREST write that is not an /rpc/ call, is refused here with a
 * friendly toast. /rpc/ calls and everything else go to the server, which makes the final decision (read-only
 * transaction + guard).
 */
function installViewOnlyFetchGuard() {
  if (!isViewOnly || typeof window === 'undefined') return;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (functionsBase && url.startsWith(`${functionsBase}/`)) {
        const name = url.slice(functionsBase.length + 1).split(/[/?#]/)[0];
        if (!READ_ONLY_POST_FUNCTIONS.has(name)) {
          notifyViewOnly();
          return viewOnlyResponse();
        }
      } else if (url.includes('/rest/v1/') && !url.includes('/rest/v1/rpc/')) {
        notifyViewOnly();
        return viewOnlyResponse();
      }
    }
    const res = await realFetch(input, init);
    if (res.status === 401 || res.status === 403 || res.status === 405 || res.status === 400) {
      // Server-side refusal: guard 403 'View-only', Postgres 25006 (HTTP 405), or an ended session (401).
      const text = await res
        .clone()
        .text()
        .catch(() => '');
      if (res.status === 401 && /view-only session has ended|PT401/i.test(text)) {
        clearViewAsStorage();
        window.location.replace('/?view_as_ended=1');
      } else if (/View-only|25006|read-only transaction/i.test(text)) {
        notifyViewOnly();
      }
    }
    return res;
  };
}

installViewOnlyFetchGuard();

/** Resolves once the view session is installed in this tab's client (AuthContext waits for it before reading it). */
export const viewAsReady: Promise<void> = (async () => {
  if (!isViewOnly) return;
  const boot = takeBootTokens();
  if (!boot) return; // refresh: supabase-js restores the session from this tab's sessionStorage
  const { error } = await supabase.auth.setSession({
    access_token: boot.accessToken,
    refresh_token: boot.refreshToken,
  });
  clearBootTokens();
  if (error) console.warn('view-as: could not start the session', error.message);
})();

/** Opener side (the admin's tab): open the view in a NEW tab with no reference back, tokens only in the fragment. */
export function openViewAsTab(
  tokens: { accessToken: string; refreshToken: string },
  meta: ViewAsMeta
): void {
  const url = `${window.location.origin}/${buildViewAsFragment(tokens, meta)}`;
  // noopener: the new tab gets an EMPTY sessionStorage (no copy of the admin's) and no window.opener.
  window.open(url, '_blank', 'noopener,noreferrer'); // returns null even on success with noopener
}

export type ViewAsExitResult = 'closed' | 'ended';

/**
 * Exit: tell the server the view session is over (revokes it), drop this tab's session LOCALLY (never a global
 * sign-out: that would sign the intern out everywhere), clear this tab's storage, then close the tab or, if the
 * browser refuses, show the "View ended" page.
 */
export async function exitViewAs(): Promise<ViewAsExitResult> {
  try {
    // Ends + audits the view session using the view tab's own token (no global sign-out). A 401/403 or a network
    // failure just means it is already over.
    await stopViewAs().catch(() => undefined);
  } finally {
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    clearViewAsStorage();
  }
  window.close();
  // window.close() only works for script-opened tabs; if we are still here, show the ended page.
  window.location.replace('/?view_as_ended=1');
  return 'ended';
}
