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
 * RPCs a view tab may POST because they only read (PostgREST sends every rpc as POST). MIRRORS audit/H21/read-rpcs.md;
 * anything not listed is refused here, before it is sent. Default deny.
 */
const READ_ONLY_RPCS: ReadonlySet<string> = new Set([
  'active_org_broadcasts',
  'agent_first_activity',
  'agent_onboarding_checklist',
  'agent_schedule_attendance_signal',
  'agent_schedule_live_status',
  'agent_self_stats',
  'agent_time_in_state',
  'answer_rate_heatmap',
  'campaign_drop_rate_summary',
  'connect_rate_by_hour',
  'connect_rate_by_number',
  'contact_disposition_history',
  'count_reassign_impact',
  'count_territory_reassign_impact',
  'funnel_summary',
  'get_disposition_rate_outliers',
  'get_quality_flag_open_counts',
  'list_agent_schedules',
  'list_campaign_script_versions',
  'list_contact_change_history',
  'list_contact_notes',
  'list_pro_applications',
  'list_disposition_quality_flags',
  'lookup_contact_by_phone',
  'my_goal_targets',
  'my_scorecard_trend',
  'power_hour_board',
  'preview_territory_rules',
  'recordings_search',
  'team_daily_stats',
  'team_goal_targets',
  'team_live_board',
]);

/** Auth endpoints a view tab still needs: refreshing its own token and ending its own session. */
const AUTH_PATH_ALLOW = /^\/auth\/v1\/(token|logout)$/;

/**
 * Pure decision for one request (exported for tests). A view tab may send a non-GET request only to: an allowlisted
 * read-only Edge Function, an allowlisted read-only rpc, or its own token refresh / logout. Every other non-GET request
 * to the Supabase project (PostgREST tables, other rpcs, Storage, GoTrue PUT /user, Edge Functions) is refused before it
 * leaves the browser. GETs and requests to other origins are not touched.
 */
export function viewOnlyRefuses(method: string, url: string, supabaseUrl: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  if (!supabaseUrl || !url.startsWith(supabaseUrl)) return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return true;
  }
  if (path.startsWith('/functions/v1/')) {
    const rest = path.slice('/functions/v1/'.length);
    return !(rest && !rest.includes('/') && READ_ONLY_POST_FUNCTIONS.has(rest));
  }
  if (path.startsWith('/rest/v1/rpc/')) {
    const name = path.slice('/rest/v1/rpc/'.length);
    return !(m === 'POST' && !name.includes('/') && READ_ONLY_RPCS.has(name));
  }
  return !AUTH_PATH_ALLOW.test(path);
}

/**
 * One central switch for the whole app (no per-screen code), the web layer of "view only": the server refuses writes too
 * (Edge guard; the DB read-only layer may be off), but nothing a view tab sends should leave the browser unless it is on
 * the allowlists above.
 */
function installViewOnlyFetchGuard() {
  if (!isViewOnly || typeof window === 'undefined') return;
  const realFetch = window.fetch.bind(window);
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (viewOnlyRefuses(requestMethod(input, init), requestUrl(input), supabaseUrl)) {
      notifyViewOnly();
      return viewOnlyResponse();
    }
    const res = await realFetch(input, init);
    if (res.status === 401 || res.status === 403 || res.status === 405 || res.status === 400) {
      // Server-side refusal: guard 403 'View-only', Postgres 25006 (HTTP 405), or an ended session (401).
      const text = await res
        .clone()
        .text()
        .catch(() => '');
      if (res.status === 401 && /view-only session has ended|PT401/i.test(text)) {
        goToEndedPage();
      } else if (/View-only|25006|read-only transaction/i.test(text)) {
        notifyViewOnly();
      }
    }
    return res;
  };
}

/** The view is over (ended elsewhere, basis lost, signed out underneath us): clear this tab and show the ended page. */
function goToEndedPage() {
  clearViewAsStorage();
  window.location.replace('/?view_as_ended=1');
}

installViewOnlyFetchGuard();

let exiting = false;

/** Resolves once the view session is installed in this tab's client (AuthContext waits for it before reading it). */
export const viewAsReady: Promise<void> = (async () => {
  if (!isViewOnly) return;
  const boot = takeBootTokens();
  if (boot) {
    const { error } = await supabase.auth.setSession({
      access_token: boot.accessToken,
      refresh_token: boot.refreshToken,
    });
    clearBootTokens();
    if (error) console.warn('view-as: could not start the session', error.message);
  }
  // A refresh of a tab whose session died (ended elsewhere, basis lost, stale cleanup): no session -> the ended page,
  // never the login form.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session && !exiting) goToEndedPage();
  // The session can also die under a live tab (a failed token refresh signs supabase-js out).
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && !exiting) goToEndedPage();
  });
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

export type ViewAsExitResult = 'ended' | 'failed';

/**
 * Exit: tell the server the view session is over (revokes it), drop this tab's session LOCALLY (never a global
 * sign-out: that would sign the intern out everywhere), clear this tab's storage, then close the tab or, if the
 * browser refuses, show the "View ended" page. If the server cannot be reached the view is NOT left: this returns
 * 'failed' so the banner can say so and offer a retry; `force` leaves anyway (the server session then closes by itself
 * within 2 hours).
 */
export async function exitViewAs(opts: { force?: boolean } = {}): Promise<ViewAsExitResult> {
  exiting = true;
  try {
    await stopViewAs();
  } catch (e) {
    const status = (e as { status?: number }).status;
    // 401/403: the session is already over (ended elsewhere / basis lost); anything else did not reach the server.
    if (status !== 401 && status !== 403 && !opts.force) {
      exiting = false;
      return 'failed';
    }
  }
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  clearViewAsStorage();
  window.close();
  // window.close() only works for script-opened tabs; if we are still here, show the ended page.
  window.location.replace('/?view_as_ended=1');
  return 'ended';
}
