/**
 * TASK-H22: how a contact is NAMED on screen. The business is the headline (it is what interns and admins recognise),
 * the person is the secondary line. One helper for every screen; do not rebuild this per component.
 */
interface NamedContact {
  first_name?: string | null;
  last_name?: string | null;
  business_name?: string | null;
}

export function contactPersonName(c: NamedContact | null | undefined): string {
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ').trim();
}

/** business_name, else the person's name, else '—'. */
export function contactHeadline(c: NamedContact | null | undefined): string {
  return c?.business_name?.trim() || contactPersonName(c) || '—';
}

/** The person's name when it adds something under the headline (a business is shown and the person differs), else ''. */
export function contactSecondaryName(c: NamedContact | null | undefined): string {
  const person = contactPersonName(c);
  const business = c?.business_name?.trim() ?? '';
  return person && business && person.toLowerCase() !== business.toLowerCase() ? person : '';
}

/** Search matches the business AND the person, whichever is the headline. */
export function contactNameMatches(c: NamedContact | null | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (c?.business_name ?? '').toLowerCase().includes(q) ||
    contactPersonName(c).toLowerCase().includes(q)
  );
}
