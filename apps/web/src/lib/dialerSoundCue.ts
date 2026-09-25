/**
 * UI-8 (TASK-L2b, optional/cheap): a short chime on human connect. Generated with the Web
 * Audio API -- no asset file, nothing to bundle or fetch, matching the spec's own "if it
 * doesn't need new assets beyond a tiny inline one" condition literally (there's no inline
 * asset at all here, just oscillator math).
 */

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedContext) sharedContext = new Ctor();
  return sharedContext;
}

/** Two quick ascending tones (~180ms total) -- distinct enough to notice without startling
 *  anyone wearing a headset. Never throws: a blocked/unsupported AudioContext is a silent
 *  no-op, not a feature failure (this cue is explicitly optional). */
export function playConnectChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();

    const playTone = (frequency: number, startOffset: number, durationSeconds: number) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const startAt = ctx.currentTime + startOffset;
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(0.15, startAt + 0.01);
      gain.gain.linearRampToValueAtTime(0, startAt + durationSeconds);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + durationSeconds);
    };

    playTone(660, 0, 0.09);
    playTone(880, 0.09, 0.09);
  } catch {
    // Autoplay policy or an unsupported browser -- never let this break the dialer.
  }
}
