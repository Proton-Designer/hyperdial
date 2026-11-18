import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, RotateCcw, Save, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { micBlockedMessage } from '@/lib/micMessage';
import { recordingToWav } from '@/lib/wavEncode';

/** TASK-H34: record your own voicemail drop in the browser. Max length (the caller's message plays once). */
export const MAX_VOICEMAIL_SECONDS = 60;
const MIN_VOICEMAIL_SECONDS = 1;
/** The voicemail-upload function's cap. 60 s of 16 kHz mono is ~1.9 MB, so this only trips if the cap was bypassed. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type Phase = 'idle' | 'starting' | 'recording' | 'processing' | 'review' | 'saving';

const isSafari = () => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  // Safari has always recorded and decoded AAC in mp4; its webm/opus path is the least trodden one.
  const order = isSafari()
    ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return order.find((m) => MediaRecorder.isTypeSupported(m));
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotFoundError')
    return 'No microphone found. Plug one in, or upload a file instead.';
  if (name === 'NotReadableError') {
    return 'Another app is using the microphone. Close it and tap Record again.';
  }
  return micBlockedMessage();
}

export function VoicemailRecorder({
  hasSaved,
  onSave,
}: {
  hasSaved: boolean;
  /** Uploads the encoded WAV through the existing voicemail-upload API; throws on failure. */
  onSave: (file: File) => Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; wav: Blob; seconds: number } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const tick = useRef<number | null>(null);
  const discard = useRef(false);
  const mounted = useRef(true);
  const starting = useRef(false);
  const startedAt = useRef(0);
  const elapsedRef = useRef(0);

  const supported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const releaseMic = () => {
    if (tick.current !== null) window.clearInterval(tick.current);
    tick.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      discard.current = true;
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      releaseMic();
    };
  }, []);

  useEffect(() => {
    const url = preview?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview]);

  const stop = () => {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  };

  const start = async () => {
    if (starting.current) return; // double tap while the permission prompt is open
    starting.current = true;
    setError(null);
    setPreview(null);
    setPhase('starting');
    try {
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (mounted.current) {
          setPhase('idle');
          setError(micErrorMessage(err));
        }
        return;
      }
      if (!mounted.current) {
        // Left the page while the prompt was open: never keep the mic live.
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;
      const chunks: Blob[] = [];
      discard.current = false;
      const mimeType = pickMimeType();
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
        recorder.current = rec;
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        rec.onerror = () => {
          // A recorder error leaves a partial, untrustworthy recording: drop it and say so.
          discard.current = true;
          setPhase('idle');
          setError('The recording stopped unexpectedly. Try again, or upload a file instead.');
          stop();
          releaseMic();
        };
        rec.onstop = () => {
          const seconds = elapsedRef.current;
          releaseMic();
          if (discard.current) return;
          if (seconds < MIN_VOICEMAIL_SECONDS) {
            setPhase('idle');
            setError((prev) => prev ?? 'That was too short. Record at least a second or two.');
            return;
          }
          setPhase('processing');
          recordingToWav(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' }))
            .then(({ wav, seconds: s }) => {
              if (discard.current) return;
              if (wav.size > MAX_UPLOAD_BYTES) {
                setPhase('idle');
                setError('That recording is too long to save. Keep it under a minute.');
                return;
              }
              setPreview({ url: URL.createObjectURL(wav), wav, seconds: s });
              setPhase('review');
            })
            .catch(() => {
              setPhase('idle');
              setError('Could not read that recording. Try again, or upload a file instead.');
            });
        };
        elapsedRef.current = 0;
        setElapsed(0);
        startedAt.current = Date.now();
        rec.start();
      } catch {
        releaseMic();
        recorder.current = null;
        setPhase('idle');
        setError('Recording is not supported in this browser. Upload a file instead.');
        return;
      }
      setPhase('recording');
      // Wall-clock, not a counter: a throttled or suspended page (screen lock) cannot overrun the cap.
      const update = () => {
        elapsedRef.current = Math.floor((Date.now() - startedAt.current) / 1000);
        setElapsed(Math.min(elapsedRef.current, MAX_VOICEMAIL_SECONDS));
        if (elapsedRef.current >= MAX_VOICEMAIL_SECONDS) stop();
      };
      tick.current = window.setInterval(update, 250);
    } finally {
      starting.current = false;
    }
  };

  const save = async () => {
    if (!preview) return;
    setError(null);
    setPhase('saving');
    try {
      await onSave(new File([preview.wav], 'voicemail-drop.wav', { type: 'audio/wav' }));
      setPreview(null);
      setPhase('idle');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('review');
    }
  };

  if (!supported) {
    return (
      <p className="text-xs text-text-secondary">
        Recording is not supported in this browser. Upload a file instead.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {(phase === 'idle' || phase === 'starting') && (
        <Button
          type="button"
          variant="fe-secondary"
          className="w-fit"
          disabled={phase === 'starting'}
          onClick={() => void start()}
        >
          <Mic className="w-4 h-4" />
          {hasSaved ? 'Record a new one' : 'Record a voicemail'}
        </Button>
      )}
      {phase === 'recording' && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-text-primary">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" aria-hidden />
            Recording {fmt(elapsed)} / {fmt(MAX_VOICEMAIL_SECONDS)}
            <span role="status" className="sr-only">
              Recording started
            </span>
          </span>
          <Button type="button" variant="danger" onClick={stop}>
            <Square className="w-4 h-4" />
            Stop
          </Button>
        </div>
      )}
      {phase === 'processing' && (
        <p className="inline-flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="w-4 h-4 animate-spin" />
          Preparing your recording…
        </p>
      )}
      {(phase === 'review' || phase === 'saving') && preview && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-secondary">
            New recording ({fmt(Math.round(preview.seconds))}). Play it back, then save.
          </p>
          <audio controls src={preview.url} className="w-full max-w-sm h-9" />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              disabled={phase === 'saving'}
              onClick={() => void save()}
            >
              {phase === 'saving' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              Save as my voicemail
            </Button>
            <Button
              type="button"
              variant="fe-secondary"
              disabled={phase === 'saving'}
              onClick={() => void start()}
            >
              <RotateCcw className="w-4 h-4" />
              Re-record
            </Button>
            <Button
              type="button"
              variant="fe-secondary"
              disabled={phase === 'saving'}
              onClick={() => {
                setPreview(null);
                setPhase('idle');
              }}
            >
              Discard
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
