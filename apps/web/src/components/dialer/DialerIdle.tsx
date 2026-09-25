import { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Phone, Delete, ChevronDown, PhoneOff } from 'lucide-react';
import type { UserPhoneNumber } from '../Dialer';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/app/EmptyState';

interface DialerIdleProps {
  userNumbers: UserPhoneNumber[];
  selectedFromNumber: string | null;
  onSelectNumber: (phoneNumber: string) => void;
  onDial: (phoneNumber: string) => void;
  isDialing: boolean;
  error: string | null;
  onNavigateToSettings?: () => void;
}

const keypadButtons = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

export function DialerIdle({
  userNumbers,
  selectedFromNumber,
  onSelectNumber,
  onDial,
  isDialing,
  error,
  onNavigateToSettings,
}: DialerIdleProps) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [countryCode] = useState('+1');
  const [numberPickerOpen, setNumberPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setNumberPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (userNumbers.length === 0) {
    return (
      <EmptyState
        icon={PhoneOff}
        title="No phone number yet"
        body="Purchase a number in Settings to start calling."
        action={
          onNavigateToSettings && (
            <Button variant="fe-secondary" size="sm" onClick={onNavigateToSettings}>
              Go to Settings
            </Button>
          )
        }
      />
    );
  }

  const handleKeyPress = (digit: string) => {
    if (phoneNumber.length < 15) {
      setPhoneNumber(phoneNumber + digit);
    }
  };

  const handleDelete = () => {
    setPhoneNumber(phoneNumber.slice(0, -1));
  };

  const formatPhoneNumber = (number: string) => {
    const cleaned = number.replace(/\D/g, '');
    if (cleaned.length === 0) return '';
    if (cleaned.length <= 3) return `(${cleaned}`;
    if (cleaned.length <= 6) return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3)}`;
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6, 10)}`;
  };

  const fullPhoneNumber = phoneNumber ? `${countryCode}${phoneNumber.replace(/\D/g, '')}` : '';

  const handleCall = () => {
    if (!selectedFromNumber || !fullPhoneNumber) return;
    onDial(fullPhoneNumber);
  };

  const canDial =
    userNumbers.length > 0 && selectedFromNumber && fullPhoneNumber.length >= 10 && !isDialing;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      className="flex flex-col items-center max-w-xs mx-auto"
    >
      {/* Number selector dropdown */}
      <div className="mb-3 w-full" ref={pickerRef}>
        <label className="text-meta text-text-secondary mb-1.5 block">Call from</label>
        <div className="relative">
          <button
            onClick={() => setNumberPickerOpen(!numberPickerOpen)}
            className="w-full flex items-center justify-between px-3 py-2.5 bg-surface-2 border border-border-subtle rounded-app-md hover:border-border-strong transition-colors"
          >
            <span className="text-body font-medium text-text-primary truncate">
              {selectedFromNumber || 'Select number'}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-text-secondary transition-transform ${numberPickerOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {numberPickerOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-surface-1 border border-border-subtle rounded-app-md shadow-app-md z-10 max-h-40 overflow-y-auto">
              {userNumbers.map((num) => (
                <button
                  key={num.id}
                  onClick={() => {
                    onSelectNumber(num.phone_number);
                    setNumberPickerOpen(false);
                  }}
                  className="w-full px-3 py-2.5 text-left text-body text-text-primary hover:bg-surface-2 transition-colors"
                >
                  {num.phone_number}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Phone Number Display */}
      <div className="w-full mb-3">
        <div className="bg-surface-2 border border-border-subtle rounded-app-md px-3 py-3 text-center min-h-[50px] flex items-center justify-center">
          {phoneNumber ? (
            <span className="text-xl font-semibold text-text-primary tracking-wider tabular-nums">
              {countryCode} {formatPhoneNumber(phoneNumber)}
            </span>
          ) : (
            <span className="text-body text-text-muted">Enter phone number</span>
          )}
        </div>
      </div>

      {/* Keypad */}
      <div className="w-full mb-3">
        <div className="grid grid-cols-3 gap-2">
          {keypadButtons.map((button) => (
            <motion.button
              key={button.digit}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => handleKeyPress(button.digit)}
              className="bg-surface-2 border border-border-subtle rounded-app-md p-3 hover:bg-surface-3 hover:border-border-strong transition-colors"
            >
              <div className="text-xl font-semibold text-text-primary mb-0.5">{button.digit}</div>
              {button.letters && (
                <div className="text-[9px] text-text-muted font-medium tracking-wider">
                  {button.letters}
                </div>
              )}
            </motion.button>
          ))}
        </div>

        <div className="flex justify-end mt-2">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleDelete}
            disabled={!phoneNumber}
            className={`p-2 rounded-app-md transition-colors ${
              phoneNumber
                ? 'bg-surface-2 hover:bg-danger-soft border border-border-subtle hover:border-danger/30 text-text-primary hover:text-danger'
                : 'bg-surface-1 border border-border-subtle text-text-muted cursor-not-allowed'
            }`}
          >
            <Delete className="w-4 h-4" />
          </motion.button>
        </div>
      </div>

      {/* Call Button */}
      <motion.button
        onClick={handleCall}
        disabled={!canDial}
        whileHover={canDial ? { scale: 1.05 } : {}}
        whileTap={canDial ? { scale: 0.95 } : {}}
        className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${
          canDial
            ? 'bg-success shadow-app-md hover:shadow-[0_8px_24px_rgba(0,230,118,0.35)]'
            : 'bg-surface-2 border border-border-subtle cursor-not-allowed'
        }`}
      >
        <Phone className={`w-6 h-6 ${canDial ? 'text-white' : 'text-text-muted'}`} />
      </motion.button>

      {error && <p className="mt-3 text-body text-danger text-center">{error}</p>}

      {isDialing && <p className="mt-2 text-body text-accent-to">Connecting...</p>}
    </motion.div>
  );
}
