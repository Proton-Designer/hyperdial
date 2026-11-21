import { RecordingPlayer } from '@/components/RecordingPlayer';

/** `?dev_recording_player=1&src=<url>` (TASK-H33) -- the shared recording player alone, for audio-routing checks. */
export function RecordingPlayerHarness() {
  const src = new URLSearchParams(window.location.search).get('src') ?? '';
  return (
    <div className="p-4" style={{ background: '#0a1628', minHeight: '100dvh' }}>
      <RecordingPlayer src={src} className="w-full h-9" />
    </div>
  );
}
