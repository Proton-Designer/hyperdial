/** Plain "the microphone is blocked" text per platform (same wording the dialer shows on Start). */
export function micBlockedMessage(): string {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (!coarse)
    return 'Microphone access is required. Allow microphone access for this site and try again.';
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios
    ? 'Microphone access is blocked. On iPhone: tap aA in the address bar > Website Settings > Microphone > Allow (or Settings > Apps > Safari > Microphone). Then tap Record again.'
    : 'Microphone access is blocked. On Android: tap the lock icon in the address bar > Permissions > Microphone > Allow. Then tap Record again.';
}
