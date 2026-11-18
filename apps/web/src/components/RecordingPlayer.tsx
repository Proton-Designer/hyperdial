import { useEffect, useRef, useState } from 'react';

/**
 * TASK-H33: call recordings are dual-channel mp3s (left = contact, right = agent), so with one earbud or one speaker you
 * only hear one side. This plays the same native <audio controls> (seek, speed, download) but routes it through Web
 * Audio with a mono downmix, so both voices come out of both ears.
 *
 * - The AudioContext is created lazily on the first `play` (a user gesture; iOS Safari needs that) and resume()d.
 * - The signed storage URL is cross-origin, so the element asks for it with crossOrigin="anonymous" (Supabase storage
 *   answers with `access-control-allow-origin: *`); without CORS a media graph outputs SILENCE.
 * - Never silence: if the audio fails to load with CORS, the context cannot be created, or it does not reach "running",
 *   the element is remounted as plain playback (no graph, no crossOrigin).
 * - One MediaElementSource per element (a second one throws): the graph lives in a ref and is closed on unmount.
 */
type Graph = { ctx: AudioContext };

export function RecordingPlayer({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const graph = useRef<Graph | null>(null);
  const [plain, setPlain] = useState(false);

  const closeGraph = () => {
    const g = graph.current;
    graph.current = null;
    if (g) void g.ctx.close().catch(() => undefined);
  };

  useEffect(() => closeGraph, []);

  const fallBack = () => {
    closeGraph();
    setPlain(true);
  };

  const handlePlay = () => {
    if (plain) return;
    const el = ref.current;
    if (!el) return;
    try {
      if (!graph.current) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return; // no Web Audio: native playback is untouched
        const ctx = new Ctor();
        const source = ctx.createMediaElementSource(el);
        const mono = ctx.createGain();
        mono.channelCount = 1;
        mono.channelCountMode = 'explicit';
        mono.channelInterpretation = 'speakers'; // stereo -> mono averages L and R
        mono.gain.value = 1.4; // averaging halves a single-sided voice; make up ~3 dB
        source.connect(mono);
        mono.connect(ctx.destination);
        graph.current = { ctx };
      }
      const { ctx } = graph.current;
      if (ctx.state !== 'running') {
        ctx
          .resume()
          .then(() => {
            if (ctx.state !== 'running') fallBack();
          })
          .catch(fallBack);
      }
    } catch {
      fallBack();
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
      onError={() => {
        if (!plain) fallBack();
      }}
    >
      <track kind="captions" />
    </audio>
  );
}
