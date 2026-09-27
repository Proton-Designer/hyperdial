/**
 * MISSION-4 TASK-T11 (ADM-8): plain client-side CSV generation + download -- no new edge function
 * needed, both consumers (Team's daily table, Analytics' funnel) already have the rows in memory
 * by the time an owner/admin clicks Export.
 */

/** RFC 4180: a field needs quoting when it contains a comma, a quote, or a newline; an embedded
 *  quote is escaped by doubling it. Never quotes a field that doesn't need it (keeps the common
 *  case, a plain number or short label, readable). */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv<T extends object>(
  columns: { key: keyof T; label: string }[],
  rows: T[]
): string {
  const header = columns.map((c) => csvField(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvField(row[c.key])).join(','));
  return [header, ...lines].join('\r\n');
}

/** Triggers a browser download of `csv` as `filename` -- a plain Blob + object URL, no server
 *  round trip. Revokes the object URL right after the synchronous click so it doesn't leak. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
