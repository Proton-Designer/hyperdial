import { useState } from 'react';
import { motion } from 'motion/react';
import { Mic, MicOff, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ActiveCallProps {
  outboundNumber: string;
  fromNumber: string;
  duration: string;
  onEndCall: () => void;
  onMuteChange: (muted: boolean) => void;
}

export function ActiveCall({
  outboundNumber,
  fromNumber,
  duration,
  onEndCall,
  onMuteChange,
}: ActiveCallProps) {
  const [muted, setMuted] = useState(false);

  const handleMuteToggle = () => {
    const next = !muted;
    setMuted(next);
    onMuteChange(next);
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="max-w-sm mx-auto"
    >
      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-success-soft rounded-full mb-4">
        <div className="relative">
          <div className="w-2 h-2 bg-success rounded-full" />
          <div className="absolute inset-0 w-2 h-2 bg-success rounded-full animate-ping" />
        </div>
        <span className="text-meta text-success font-semibold">Call connected</span>
      </div>

      <div className="bg-surface-1 rounded-app-lg p-6 border border-success/25 shadow-app-md mb-6 flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-full bg-success-soft flex items-center justify-center text-success text-xl font-bold mb-4">
          <span>{outboundNumber.slice(-2)}</span>
        </div>
        <p className="text-page-title text-text-primary">{outboundNumber}</p>
        <p className="text-meta text-text-secondary mt-1">From {fromNumber}</p>

        <motion.div
          className="text-metric text-4xl font-semibold text-text-primary tabular-nums mt-4"
          animate={{ opacity: [1, 0.7, 1] }}
          transition={{ duration: 1, repeat: Infinity }}
        >
          {duration}
        </motion.div>
      </div>

      <div className="flex items-center justify-center gap-3">
        <Button variant="fe-secondary" onClick={handleMuteToggle}>
          {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          {muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button variant="danger" onClick={onEndCall}>
          <PhoneOff className="w-4 h-4" />
          Hang up
        </Button>
      </div>
    </motion.div>
  );
}
