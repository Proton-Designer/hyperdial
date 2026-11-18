import { useEffect, useState } from 'react';
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

/**
 * TASK-H34d: the agent's voicemail drop at a glance -- their own, else the team default -- with its length.
 * Used by the dialer start screen and the campaign Voicemail Drop setting.
 */
export function useVoicemailDropSummary(enabled = true): VoicemailDropSummary {
  const [summary, setSummary] = useState<VoicemailDropSummary>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let stopDuration: (() => void) | null = null;
    Promise.all([getMyVoicemailDrop(), getOrgDefaultVoicemailDrop()])
      .then(([mine, team]) => {
        if (cancelled) return;
        const pick = mine.hasFile ? mine : team.hasFile ? team : null;
        if (!pick) {
          setSummary({ status: 'none' });
          return;
        }
        const source = mine.hasFile ? 'mine' : 'team';
        setSummary({ status: 'ready', source, seconds: null });
        if (pick.url) {
          stopDuration = readDuration(pick.url, (seconds) => {
            if (!cancelled) setSummary({ status: 'ready', source, seconds });
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
  }, [enabled]);
  return summary;
}
