/**
 * TASK-FE-A (FE-2): three logo concepts as React SVG components, one exported switch
 * (`LOGO_VARIANT`) so the user can pick a different one without touching every call site. The
 * lead's pick for this build is Concept A ("converge"): three parallel horizontal strokes (the
 * parallel lines the product dials) curve and converge into one bright node (the one live
 * conversation) -- the product's own name for itself, drawn.
 */
export type LogoVariant = 'converge' | 'hwave' | 'ping';

/** Switch this to try a different concept without touching any call site. */
export const LOGO_VARIANT: LogoVariant = 'converge';

interface LogoMarkProps {
  variant?: LogoVariant;
  /** Pixel size of the square tile. Both concepts are drawn to read clearly at 16 (favicon) and
   *  32 (top bar/sidebar) -- tested via audit/ui/logo-concepts.html. */
  size?: number;
  className?: string;
}

function ConvergeMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="8" fill="url(#converge-tile)" />
      {/* Three parallel lines curving into one node: opacity falls off top-to-bottom (100/70/40%)
          so the eye reads a gradient of "lines" converging on a single bright point. */}
      <path
        d="M6 10 H15 C19 10 19 16 23 16"
        stroke="white"
        strokeOpacity="1"
        strokeWidth="2.25"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M6 16 H23"
        stroke="white"
        strokeOpacity="0.7"
        strokeWidth="2.25"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M6 22 H15 C19 22 19 16 23 16"
        stroke="white"
        strokeOpacity="0.4"
        strokeWidth="2.25"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="24.5" cy="16" r="2.75" fill="white" />
      <circle cx="24.5" cy="16" r="4.5" fill="white" fillOpacity="0.35" />
      <defs>
        <linearGradient
          id="converge-tile"
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#0066FF" />
          <stop offset="1" stopColor="#00D9FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function HWaveMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="8" fill="url(#hwave-tile)" />
      <path d="M9 8 V24" stroke="white" strokeWidth="2.25" strokeLinecap="round" />
      <path d="M23 8 V24" stroke="white" strokeWidth="2.25" strokeLinecap="round" />
      <path
        d="M9 16 H12 L14 11 L18 21 L20 16 H23"
        stroke="white"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <defs>
        <linearGradient
          id="hwave-tile"
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#0066FF" />
          <stop offset="1" stopColor="#00D9FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function PingMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="8" fill="url(#ping-tile)" />
      <path
        d="M22 10a8 8 0 0 1 0 12"
        stroke="white"
        strokeOpacity="0.45"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M19 13a4 4 0 0 1 0 6"
        stroke="white"
        strokeOpacity="0.75"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="14" cy="16" r="3" fill="white" />
      <defs>
        <linearGradient id="ping-tile" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0066FF" />
          <stop offset="1" stopColor="#00D9FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** The tile mark alone -- for the top bar, collapsed sidebar, favicon-sized contexts, etc. */
export function LogoMark({ variant = LOGO_VARIANT, size = 32, className }: LogoMarkProps) {
  const Mark = variant === 'hwave' ? HWaveMark : variant === 'ping' ? PingMark : ConvergeMark;
  return (
    <div className={className} style={{ width: size, height: size, flexShrink: 0 }}>
      <Mark size={size} />
    </div>
  );
}

/** Mark + wordmark, "HyperDial" with "Dial" in the accent gradient -- for the top bar and auth
 *  screens where there's room for the full lockup. */
export function Logo({
  variant = LOGO_VARIANT,
  size = 32,
  className,
  wordmarkClassName,
}: LogoMarkProps & { wordmarkClassName?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className ?? ''}`}>
      <LogoMark variant={variant} size={size} />
      <span
        className={`font-semibold tracking-[-0.01em] text-text-primary ${wordmarkClassName ?? 'text-xl'}`}
      >
        Hyper
        <span className="bg-gradient-to-r from-accent-from to-accent-to bg-clip-text text-transparent">
          Dial
        </span>
      </span>
    </div>
  );
}
