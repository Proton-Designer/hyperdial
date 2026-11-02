import { useCallback, useSyncExternalStore } from 'react';
import type { CloseDeliveryStatus, CloseFrequency } from '@/lib/api';

/**
 * TASK-H13: the Log Close form is shown on the live-call screen AND in the wrap-up window. Both render the same
 * draft, held here (module scope, one draft at a time) and keyed by the call leg id, so what an intern types during
 * the call survives the hang-up and the wrap-up "Log close" opens already filled. The draft is dropped when a
 * different leg asks for one (the next call connecting) and cleared after a successful submit.
 */
export interface CloseDraftValues {
  ownerName: string;
  businessName: string;
  mobile: string;
  email: string;
  services: string[];
  /** TASK-H20: free-text services (comma separated): the only input when the org has no categories, "Other" otherwise. */
  serviceDraft: string;
  cities: string[];
  cityDraft: string;
  frequencies: CloseFrequency[];
  insured: boolean | null;
  bestContact: string;
  price: string;
  capacity: string;
  years: string;
  /** The contact prefill (owner, city, ...) has already been applied: do not re-apply it over the intern's edits. */
  prefilled: boolean;
}

export interface CloseDraftState {
  key: string;
  values: CloseDraftValues;
  submitting: boolean;
  /** Set after a successful submit; both surfaces then show "Closed" instead of the form (a call is logged once). */
  done: CloseDeliveryStatus | null;
}

export function emptyCloseDraftValues(name: string, phone: string): CloseDraftValues {
  return {
    ownerName: '',
    businessName: name,
    mobile: phone,
    email: '',
    services: [],
    serviceDraft: '',
    cities: [],
    cityDraft: '',
    frequencies: [],
    insured: null,
    bestContact: '',
    price: '',
    capacity: '',
    years: '',
    prefilled: false,
  };
}

let current: CloseDraftState | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Make `key` the live draft, dropping any other leg's. Idempotent; safe to call while rendering. */
export function ensureCloseDraft(key: string, name: string, phone: string): CloseDraftState {
  if (current?.key !== key) {
    current = {
      key,
      values: emptyCloseDraftValues(name, phone),
      submitting: false,
      done: null,
    };
  }
  return current;
}

export function patchCloseDraft(
  key: string,
  patch: Partial<CloseDraftState> | ((s: CloseDraftState) => Partial<CloseDraftState>)
) {
  if (current?.key !== key) return;
  const p = typeof patch === 'function' ? patch(current) : patch;
  current = { ...current, ...p };
  emit();
}

export function patchCloseDraftValues(
  key: string,
  patch: Partial<CloseDraftValues> | ((v: CloseDraftValues) => Partial<CloseDraftValues>)
) {
  patchCloseDraft(key, (s) => ({
    values: { ...s.values, ...(typeof patch === 'function' ? patch(s.values) : patch) },
  }));
}

/** Clears the draft: on sign-out (AuthContext) and in tests. */
export function resetCloseDraft() {
  current = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useCloseDraft(key: string, name: string, phone: string) {
  ensureCloseDraft(key, name, phone);
  const state = useSyncExternalStore(
    subscribe,
    () => current,
    () => current
  ) as CloseDraftState;
  const patchValues = useCallback(
    (p: Parameters<typeof patchCloseDraftValues>[1]) => patchCloseDraftValues(key, p),
    [key]
  );
  const patchState = useCallback(
    (p: Parameters<typeof patchCloseDraft>[1]) => patchCloseDraft(key, p),
    [key]
  );
  return { state, patchValues, patchState };
}
