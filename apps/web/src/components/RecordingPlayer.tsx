import { useEffect, useRef, useState } from 'react';

/**
 * TASK-H33: call recordings are dual-channel mp3s (left = contact, right = agent), so with one earbud or one speaker you
 * only hear one side. This plays the same native <audio controls> (seek, speed, download) but routes it through Web
 * Audio with a mono downmix, so both voices come out of both ears.
 *
 * - The AudioContext is created lazily on the first `play` (a user gesture; iOS Safari needs that) and resume()d.
 * - The signed storage URL is cross-origin, so the element asks for it with crossOrigin="anonymous" (Supabase storage
 *   answers with `access-control-allow-origin: *`); without CORS a media graph outputs SILENCE.
 * - Never silence: if the audio fails to load with CORS, the context cannot be created, or it is not "running" within
 *   500 ms of playing (resume() can stay pending forever on iOS), the element is remounted as plain playback (no graph,
 *   no crossOrigin) at the same position, playing again if it was.
 * - One MediaElementSource per element (a second one throws): the graph lives in a ref and is closed on unmount.
 */
type Graph = { ctx: AudioContext };

/** How long a suspended context gets to reach "running" before we stop trusting the graph (iOS/autoplay can leave
 *  resume() pending forever, which would mean silence). */
const RESUME_TIMEOUT_MS = 500;

export function RecordingPlayer({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const graph = useRef<Graph | null>(null);
  const timer = useRef<number | null>(null);
  /** Where the user was when we fell back, so the plain element picks up from there. */
  const restore = useRef<{ time: number; playing: boolean } | null>(null);
  const [plain, setPlain] = useState(false);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const closeGraph = () => {
    clearTimer();
    const g = graph.current;
    graph.current = null;
    if (g) {
      g.ctx.onstatechange = null;
      void g.ctx.close().catch(() => undefined);
    }
  };

  // closeGraph only touches refs, so the cleanup never goes stale.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => closeGraph, []);

  const fallBack = (reason: string) => {
    const el = ref.current;
    console.warn(`RecordingPlayer: plain playback (${reason})`, el?.error?.code ?? '');
    if (el) restore.current = { time: el.currentTime, playing: !el.paused };
    closeGraph();
    setPlain(true);
  };

  /** Make sure the context is running; if it is not within RESUME_TIMEOUT_MS, drop the graph (never silence). */
  const ensureRunning = (ctx: AudioContext) => {
    if (ctx.state === 'running') {
      clearTimer();
      return;
    }
    void ctx.resume().catch(() => undefined);
    if (timer.current === null) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (graph.current?.ctx === ctx && ctx.state !== 'running')
          fallBack('audio context not running');
      }, RESUME_TIMEOUT_MS);
    }
  };

  const handlePlay = () => {
    if (plain) return;
    const el = ref.current;
    if (!el) return;
    let ctx: AudioContext | null = null;
    try {
      if (!graph.current) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          console.info('RecordingPlayer: no Web Audio, playing stereo as recorded');
          return; // native playback is untouched
        }
        ctx = new Ctor();
        graph.current = { ctx }; // owned from here on, so a throw below still closes it
        const source = ctx.createMediaElementSource(el);
        const mono = ctx.createGain();
        mono.channelCount = 1;
        mono.channelCountMode = 'explicit';
        mono.channelInterpretation = 'speakers'; // stereo -> mono averages L and R
        mono.gain.value = 1.2; // averaging halves a single-sided voice; make up ~1.5 dB without risking clipping
        source.connect(mono);
        mono.connect(ctx.destination);
        const owned = ctx;
        // iOS moves a context to "interrupted" (phone call, lock screen): re-resume while playing, else give up.
        ctx.onstatechange = () => {
          if (owned.state === 'running') clearTimer();
          else if (ref.current && !ref.current.paused) ensureRunning(owned);
        };
      }
      ensureRunning(graph.current.ctx);
    } catch {
      fallBack('audio graph setup failed');
    }
  };

  return (
    <audio
      key={plain ? 'plain' : 'mono'}
      ref={ref}
      controls
      src={src}
      crossOrigin={plain ? undefined : 'anonymous'}
      className={className}
      onPlay={handlePlay}
      onLoadedMetadata={(e) => {
        const r = restore.current;
        if (!r) return;
        restore.current = null;
        const el = e.currentTarget;
        if (r.time > 0) el.currentTime = r.time;
        if (r.playing) void el.play().catch(() => undefined);
      }}
      onError={() => {
        if (!plain) fallBack('audio failed to load with CORS');
      }}
    >
      <track kind="captions" />
    </audio>
  );
}
