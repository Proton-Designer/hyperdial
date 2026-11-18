import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, RotateCcw, Save, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { micBlockedMessage } from '@/lib/micMessage';
import { recordingToWav } from '@/lib/wavEncode';

/** TASK-H34: record your own voicemail drop in the browser. Max length (the caller's message plays once). */
export const MAX_VOICEMAIL_SECONDS = 60;
const MIN_VOICEMAIL_SECONDS = 1;

type Phase = 'idle' | 'recording' | 'processing' | 'review' | 'saving';

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) =>
    MediaRecorder.isTypeSupported(m)
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

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
  const elapsedRef = useRef(0);

  const supported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const releaseMic = () => {
    if (tick.current !== null) window.clearInterval(tick.current);
    tick.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  useEffect(
    () => () => {
      discard.current = true;
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      releaseMic();
    },
    []
  );

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
    setError(null);
    setPreview(null);
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(micBlockedMessage());
      return;
    }
    stream.current = media;
    const chunks: Blob[] = [];
    discard.current = false;
    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
    } catch {
      releaseMic();
      setError('Recording is not supported in this browser. Upload a file instead.');
      return;
    }
    recorder.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      const seconds = elapsedRef.current;
      releaseMic();
      if (discard.current) return;
      if (seconds < MIN_VOICEMAIL_SECONDS) {
        setPhase('idle');
        setError('That was too short. Record at least a second or two.');
        return;
      }
      setPhase('processing');
      recordingToWav(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' }))
        .then(({ wav, seconds: s }) => {
          if (discard.current) return;
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
    rec.start();
    setPhase('recording');
    tick.current = window.setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
      if (elapsedRef.current >= MAX_VOICEMAIL_SECONDS) stop();
    }, 1000);
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
      {phase === 'idle' && (
        <Button type="button" variant="fe-secondary" className="w-fit" onClick={() => void start()}>
          <Mic className="w-4 h-4" />
          {hasSaved ? 'Record a new one' : 'Record a voicemail'}
        </Button>
      )}
      {phase === 'recording' && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-text-primary" role="status">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" aria-hidden />
            Recording {fmt(elapsed)} / {fmt(MAX_VOICEMAIL_SECONDS)}
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
