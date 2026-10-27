import type { BulkAddLeadsResult } from '@/lib/api';

/** "Added 40, skipped 12 (5 do-not-call, 7 already in another campaign)". */
export function describeBulkAddResult(r: BulkAddLeadsResult, dryRun = false): string {
  const parts: [number, string][] = [
    [r.skipped_dnc, 'do-not-call'],
    [r.skipped_org_dnc, 'on the do-not-call list'],
    [r.skipped_closed, 'closed'],
    [r.skipped_already_in_campaign, 'already in this campaign'],
    [r.skipped_removed, 'removed from this campaign'],
    [r.skipped_active_elsewhere, 'active in another campaign'],
    [r.skipped_no_phone, 'no phone number'],
    [r.not_found, 'not found'],
  ];
  const skipped = parts.filter(([n]) => n > 0);
  const total = skipped.reduce((sum, [n]) => sum + n, 0);
  const n = dryRun ? r.would_add : r.added;
  const head = `${dryRun ? 'Will add' : 'Added'} ${n} contact${n === 1 ? '' : 's'}`;
  const tail =
    total > 0 ? `, skip ${total} (${skipped.map(([c, label]) => `${c} ${label}`).join(', ')})` : '';
  return (
    head +
    (dryRun ? tail : tail.replace(', skip', ', skipped')) +
    (r.capped ? `. Limit of ${r.cap} per run reached: run it again for the rest.` : '')
  );
}
