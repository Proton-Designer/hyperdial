import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getMyVoicemailDrop, getOrgDefaultVoicemailDrop } from '@/lib/api';

export interface VoicemailDropSummary {
  /** `error` = the check failed; callers show nothing rather than a false "not recorded". */
  status: 'loading' | 'error' | 'none' | 'ready';
  /** Whose drop plays for this agent: their own, else the team default. */
  source?: 'mine' | 'team';
  /** Length in seconds when the browser could read it. */
  seconds?: number | null;
}

function readDuration(url: string, onDone: (s: number | null) => void): () => void {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.onloadedmetadata = () =>
    onDone(Number.isFinite(audio.duration) ? Math.round(audio.duration) : null);
  audio.onerror = () => onDone(null);
  audio.src = url;
  return () => {
    audio.onloadedmetadata = null;
    audio.onerror = null;
    audio.removeAttribute('src');
  };
}

/** One lookup (two signed URLs + a metadata fetch) per minute per user, not per dialer start / modal open. */
const CACHE_MS = 60_000;
let cache: { userId: string; at: number; summary: VoicemailDropSummary } | null = null;

/** Call after the drop is saved so the next read is fresh. */
export function invalidateVoicemailDropSummary(): void {
  cache = null;
}

/**
 * TASK-H34d: the agent's voicemail drop at a glance -- their own, else the team default -- with its length.
 * Used by the dialer start screen and the campaign Voicemail Drop setting.
 */
export function useVoicemailDropSummary(enabled = true): VoicemailDropSummary {
  const userId = useAuth().user?.id ?? '';
  const [summary, setSummary] = useState<VoicemailDropSummary>(() =>
    cache && cache.userId === userId && Date.now() - cache.at < CACHE_MS
      ? cache.summary
      : { status: 'loading' }
  );
  useEffect(() => {
    if (!enabled || !userId) return;
    if (cache && cache.userId === userId && Date.now() - cache.at < CACHE_MS) {
      setSummary(cache.summary);
      return;
    }
    let cancelled = false;
    let stopDuration: (() => void) | null = null;
    Promise.all([getMyVoicemailDrop(), getOrgDefaultVoicemailDrop()])
      .then(([mine, team]) => {
        if (cancelled) return;
        const pick = mine.hasFile ? mine : team.hasFile ? team : null;
        if (!pick) {
          cache = { userId, at: Date.now(), summary: { status: 'none' } };
          setSummary({ status: 'none' });
          return;
        }
        const source = mine.hasFile ? 'mine' : 'team';
        setSummary({ status: 'ready', source, seconds: null });
        if (pick.url) {
          stopDuration = readDuration(pick.url, (seconds) => {
            const done: VoicemailDropSummary = { status: 'ready', source, seconds };
            cache = { userId, at: Date.now(), summary: done };
            if (!cancelled) setSummary(done);
          });
        }
      })
      .catch(() => {
        if (!cancelled) setSummary({ status: 'error' });
      });
    return () => {
      cancelled = true;
      stopDuration?.();
    };
  }, [enabled, userId]);
  return summary;
}
