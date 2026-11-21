/**
 * TASK-H21 (View as intern): the ONE "this tab is a view-only tab" flag. No imports from supabase/api so the client in
 * supabase.ts can read it while being built. An owner/admin's "View as" opens a NEW tab whose URL fragment carries the
 * intern's view session; this module (evaluated before anything else touches the session) moves it into this tab's own
 * sessionStorage and strips it from the address bar. sessionStorage is per tab, so the admin's own tab and its
 * localStorage session are never read or written by a view tab.
 */
export interface ViewAsMeta {
  sessionId: string;
  targetId: string;
  targetName: string;
}

export interface ViewAsBootTokens {
  accessToken: string;
  refreshToken: string;
}

export const VIEW_AS_STORAGE_KEY = 'hd-view-as';
const META_KEY = 'hd-view-as-meta';
const BOOT_KEY = 'hd-view-as-boot';
/** Fragment key the opener writes: `#view_as=<base64url(JSON)>` (see buildViewAsFragment). */
const FRAGMENT_KEY = 'view_as';

function safeSession(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function buildViewAsFragment(tokens: ViewAsBootTokens, meta: ViewAsMeta): string {
  return `#${FRAGMENT_KEY}=${toBase64Url(JSON.stringify({ ...tokens, ...meta }))}`;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Runs once at module load: fragment -> sessionStorage, then the fragment is removed before anything else runs. */
function bootFromFragment(): void {
  const store = safeSession();
  if (!store || typeof window === 'undefined') return;
  const hash = window.location.hash;
  if (!hash.startsWith(`#${FRAGMENT_KEY}=`)) return;
  try {
    const raw = hash.slice(FRAGMENT_KEY.length + 2);
    const p = JSON.parse(fromBase64Url(raw)) as Record<string, unknown>;
    if (
      isString(p.accessToken) &&
      isString(p.refreshToken) &&
      isString(p.sessionId) &&
      isString(p.targetId)
    ) {
      store.setItem(
        META_KEY,
        JSON.stringify({
          sessionId: p.sessionId,
          targetId: p.targetId,
          targetName: isString(p.targetName) ? p.targetName : 'this intern',
        } satisfies ViewAsMeta)
      );
      store.setItem(
        BOOT_KEY,
        JSON.stringify({ accessToken: p.accessToken, refreshToken: p.refreshToken })
      );
    }
  } catch {
    // malformed fragment: ignore (the tab simply is not a view tab)
  } finally {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

bootFromFragment();

export function getViewAsMeta(): ViewAsMeta | null {
  try {
    const raw = safeSession()?.getItem(META_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<ViewAsMeta>;
    return isString(p.sessionId) && isString(p.targetId)
      ? { sessionId: p.sessionId, targetId: p.targetId, targetName: p.targetName ?? 'this intern' }
      : null;
  } catch {
    return null;
  }
}

/** True for the whole life of a view tab (survives refresh: it lives in this tab's sessionStorage). */
export const isViewOnly: boolean = getViewAsMeta() !== null;

/** Tokens waiting to become the tab's session (consumed once by viewAs.ts), or null. */
export function takeBootTokens(): ViewAsBootTokens | null {
  const store = safeSession();
  try {
    const raw = store?.getItem(BOOT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ViewAsBootTokens;
  } catch {
    return null;
  }
}

export function clearBootTokens(): void {
  try {
    safeSession()?.removeItem(BOOT_KEY);
  } catch {
    // ignore
  }
}

export function clearViewAsStorage(): void {
  const store = safeSession();
  try {
    store?.removeItem(META_KEY);
    store?.removeItem(BOOT_KEY);
    store?.removeItem(VIEW_AS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Height of the always-visible banner; the top bar and layout offsets add this in view mode. */
export const VIEW_AS_BANNER_HEIGHT = isViewOnly ? 40 : 0;
