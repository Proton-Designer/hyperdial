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

/** TASK-H38: lowercase, strip accents, turn every run of punctuation into one space. "Bow-Stern, Inc." -> "bow stern inc". */
export function normalizeSearchText(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const digitsOf = (raw: string | null | undefined): string => (raw ?? '').replace(/\D/g, '');

/**
 * TASK-H38: the ONE search rule for people and companies (the same rule is in SQL as private.search_matches, used by
 * recordings_search). A query matches a record when
 *  - every word of the query is found in the record's text ("bow stern" -> "Bow Stern Marketing"), OR
 *  - the query with its spaces removed is found in the record's text with its spaces removed ("bow stern" -> "Bowstern"), OR
 *  - the query is only digits/phone punctuation with at least 3 digits and those digits are found in one of the phone
 *    numbers' digits ("850 570", "(850) 570-7252", "8505707252" -> +18505707252).
 * `texts` are the searchable words (business, names, email); `phones` the phone numbers in any format.
 */
export function searchMatches(
  texts: (string | null | undefined)[],
  phones: (string | null | undefined)[],
  query: string
): boolean {
  const q = normalizeSearchText(query);
  if (!q) return true;
  const hay = normalizeSearchText(texts.filter(Boolean).join(' '));
  const words = q.split(' ');
  if (words.every((w) => hay.includes(w))) return true;
  if (hay.replace(/ /g, '').includes(q.replace(/ /g, ''))) return true;
  const qDigits = digitsOf(query);
  if (qDigits.length >= 3 && /^[\d\s().+-]+$/.test(query.trim())) {
    return phones.some((p) => digitsOf(p).includes(qDigits));
  }
  return false;
}

interface SearchableContact extends NamedContact {
  phone_number?: string | null;
  phone_raw?: string | null;
  owner_contact?: string | null;
}

/** Search matches the business, the person (and the owner/email field), and the phone number -- whichever the headline is. */
export function contactNameMatches(
  c: SearchableContact | null | undefined,
  query: string
): boolean {
  return searchMatches(
    [c?.business_name, c?.first_name, c?.last_name, c?.owner_contact],
    [c?.phone_number, c?.phone_raw],
    query
  );
}
