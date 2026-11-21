import type { OnboardedPro } from '@/lib/api';

export interface RankedCount {
  label: string;
  count: number;
}

/** Counts how many pros carry each value; a pro with several values counts once in each (and once per value even
 *  if the list repeats it). Case-insensitive grouping, keeping the first spelling seen. Ranked high to low, then A-Z. */
export function rankBy(pros: OnboardedPro[], pick: (p: OnboardedPro) => string[]): RankedCount[] {
  const map = new Map<string, RankedCount>();
  for (const p of pros) {
    const seen = new Set<string>();
    for (const raw of pick(p)) {
      const label = raw.trim();
      const key = label.toLowerCase();
      if (!label || seen.has(key)) continue;
      seen.add(key);
      const hit = map.get(key);
      if (hit) hit.count += 1;
      else map.set(key, { label, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function startOfWeek(now: Date): Date {
  // Monday 00:00 local
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d;
}

export function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function countSince(pros: OnboardedPro[], since: Date): number {
  return pros.filter((p) => new Date(p.closedAt).getTime() >= since.getTime()).length;
}

export type ProsSort = 'newest' | 'oldest' | 'business' | 'price' | 'years';

export function sortPros(
  pros: OnboardedPro[],
  sort: ProsSort,
  headline: (p: OnboardedPro) => string
): OnboardedPro[] {
  const out = [...pros];
  const byDate = (a: OnboardedPro, b: OnboardedPro) =>
    new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime();
  switch (sort) {
    case 'oldest':
      return out.sort((a, b) => -byDate(a, b));
    case 'business':
      return out.sort((a, b) => headline(a).localeCompare(headline(b)));
    case 'price':
      return out.sort((a, b) => (b.startingPrice ?? -1) - (a.startingPrice ?? -1) || byDate(a, b));
    case 'years':
      return out.sort(
        (a, b) => (b.yearsInBusiness ?? -1) - (a.yearsInBusiness ?? -1) || byDate(a, b)
      );
    default:
      return out.sort(byDate);
  }
}
