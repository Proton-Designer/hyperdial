import { useEffect, useState } from 'react';
import { Mic, MicOff, PhoneOff } from 'lucide-react';

interface LiveCallPanelProps {
  contactName: string;
  phone: string;
  /** TASK-L2b: the leg's real `answered_at` (ISO). Elapsed time is derived from it every tick
   *  instead of a local counter that reset to 0 on every remount (a real bug once this task
   *  put a second, correct timer -- the DialerStateBanner's "Connected — <name> <timer>" -- on
   *  screen at the same time: the two would visibly disagree). `null` shows "0:00" rather than
   *  guessing. */
  answeredAt: string | null;
  onToggleMute: (muted: boolean) => void;
  onEndCall: () => void;
}

export function LiveCallPanel({
  contactName,
  phone,
  answeredAt,
  onToggleMute,
  onEndCall,
}: LiveCallPanelProps) {
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!answeredAt) {
      setSeconds(0);
      return;
    }
    const answeredAtMs = new Date(answeredAt).getTime();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - answeredAtMs) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [answeredAt]);

  const mins = Math.floor(seconds / 60);
  const secs = `${seconds % 60}`.padStart(2, '0');

  return (
    <div className="rounded-2xl border border-[#00E676]/20 bg-[#00E676]/10 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-white text-lg font-bold">Live Call</h3>
          <p className="text-[#B0BEC5] text-sm">
            {contactName} · {phone}
          </p>
        </div>
        <p className="text-white font-mono text-lg">
          {mins}:{secs}
        </p>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            const next = !muted;
            setMuted(next);
            onToggleMute(next);
          }}
          className="px-4 py-2 rounded-lg border border-white/15 bg-[#1A2332] text-white flex items-center gap-2"
        >
          {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          onClick={onEndCall}
          className="px-4 py-2 rounded-lg border border-[#FF3D00]/30 bg-[#FF3D00]/20 text-[#FF3D00] flex items-center gap-2"
        >
          <PhoneOff className="w-4 h-4" />
          End Call & Continue
        </button>
      </div>
      <textarea
        placeholder="Quick notes for this contact..."
        className="mt-4 w-full min-h-[90px] rounded-lg bg-[#1A2332] border border-white/10 px-3 py-2 text-white placeholder:text-[#B0BEC5]/60 focus:outline-none focus:border-[#00D9FF]"
      />
    </div>
  );
}
