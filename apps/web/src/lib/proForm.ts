/**
 * TASK-H29: client for the PUBLIC pro form (`/join/:token`). Deliberately imports nothing that touches Supabase auth
 * (not lib/api.ts, not the supabase client): a visitor has no session and the page must never read or create one. It
 * talks only to the `pro-application` Edge function, with no Authorization header.
 */

export type ProFormFrequency = 'weekly' | 'biweekly' | 'monthly';

export interface ProFormInfo {
  orgName: string;
  serviceCategories: string[];
}

export interface ProFormSubmission {
  ownerName: string;
  businessName: string;
  mobile: string;
  email: string | null;
  services: string[];
  cities: string[];
  frequencies: ProFormFrequency[];
  insured: boolean;
  bestContact: string | null;
  startingPrice: number | null;
  capacity: number | null;
  yearsInBusiness: number | null;
  /** The honeypot: a real visitor never sees or fills it. */
  hd_chk: string;
}

const endpoint = (): string => {
  const base = import.meta.env.VITE_SUPABASE_URL;
  return base ? `${base}/functions/v1/pro-application` : '';
};

/** `/join/<token>` -> token, or null when the path is not the form's. */
export function proFormTokenFromPath(pathname: string): string | null {
  const m = /^\/join\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export type ProFormInfoResult =
  { kind: 'ok'; info: ProFormInfo } | { kind: 'dead' } | { kind: 'error'; message: string };

export async function fetchProFormInfo(token: string): Promise<ProFormInfoResult> {
  const url = endpoint();
  if (!url) return { kind: 'error', message: 'This page is not set up yet.' };
  try {
    const res = await fetch(`${url}?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (res.status === 404) return { kind: 'dead' };
    if (!res.ok) return { kind: 'error', message: 'Something went wrong. Try again in a moment.' };
    const data = (await res.json()) as Partial<ProFormInfo>;
    return {
      kind: 'ok',
      info: {
        orgName: typeof data.orgName === 'string' ? data.orgName : '',
        serviceCategories: Array.isArray(data.serviceCategories)
          ? data.serviceCategories.filter((s): s is string => typeof s === 'string')
          : [],
      },
    };
  } catch {
    return { kind: 'error', message: 'Could not reach the server. Check your connection.' };
  }
}

export type ProFormSubmitResult =
  | { kind: 'ok' }
  | { kind: 'dead' }
  | { kind: 'field'; message: string }
  | { kind: 'limited' }
  | { kind: 'error'; message: string };

export async function submitProForm(
  token: string,
  form: ProFormSubmission
): Promise<ProFormSubmitResult> {
  const url = endpoint();
  if (!url) return { kind: 'error', message: 'This page is not set up yet.' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...form }),
      cache: 'no-store',
    });
    if (res.ok) return { kind: 'ok' };
    if (res.status === 404) return { kind: 'dead' };
    if (res.status === 429) return { kind: 'limited' };
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    const message = typeof data.error === 'string' ? data.error : '';
    // 400 carries a readable field message; "Invalid request" and everything else is a generic failure.
    if (res.status === 400 && message && message !== 'Invalid request')
      return { kind: 'field', message };
    return { kind: 'error', message: 'Something went wrong. Try again in a moment.' };
  } catch {
    return { kind: 'error', message: 'Could not reach the server. Check your connection.' };
  }
}
