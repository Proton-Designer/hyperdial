/**
 * FE-B: the Auth/Invite/Reset brand panel's background -- a large, subtle, CSS-only animated
 * version of the logo's own motif (three parallel lines, opacity-tiered 100/70/40%, curving into
 * one bright node). Replaces the old generic template orbs/grid/particles (AnimatedBackground.tsx,
 * now unused) with something that's actually THIS product's own visual language. Pure CSS
 * (`.converge-line`/`.converge-node`, globals.css) so `prefers-reduced-motion` freezes it for
 * free via the same global rule every other animation in this app already goes through.
 */
export function ConvergeBackground() {
  return (
    <div className="absolute inset-0 bg-gradient-to-br from-surface-0 via-[#0D1B32] to-surface-0 overflow-hidden">
      <svg
        className="absolute inset-0 w-full h-full"
        viewBox="0 0 800 600"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        aria-hidden="true"
      >
        <path
          className="converge-line"
          d="M-40 180 H360 C460 180 460 300 600 300"
          stroke="url(#converge-bg-grad)"
          strokeOpacity="1"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          className="converge-line"
          d="M-40 300 H600"
          stroke="url(#converge-bg-grad)"
          strokeOpacity="0.7"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          className="converge-line"
          d="M-40 420 H360 C460 420 460 300 600 300"
          stroke="url(#converge-bg-grad)"
          strokeOpacity="0.4"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
        />
        <circle className="converge-node" cx="600" cy="300" r="7" fill="#00D9FF" />
        <circle cx="600" cy="300" r="16" fill="#00D9FF" fillOpacity="0.25" />
        <defs>
          <linearGradient id="converge-bg-grad" x1="0" y1="0" x2="800" y2="0">
            <stop stopColor="#0066FF" />
            <stop offset="1" stopColor="#00D9FF" />
          </linearGradient>
        </defs>
      </svg>
      {/* Faint grid, kept from the old background -- reads as texture, not a template accent. */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px),
                           linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)`,
          backgroundSize: '50px 50px',
        }}
      />
    </div>
  );
}
