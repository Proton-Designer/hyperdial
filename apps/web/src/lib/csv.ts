/**
 * MISSION-4 TASK-T11 (ADM-8): plain client-side CSV generation + download -- no new edge function
 * needed, both consumers (Team's daily table, Analytics' funnel) already have the rows in memory
 * by the time an owner/admin clicks Export.
 */

/** RFC 4180: a field needs quoting when it contains a comma, a quote, or a newline; an embedded
 *  quote is escaped by doubling it. Never quotes a field that doesn't need it (keeps the common
 *  case, a plain number or short label, readable). */
/** TASK-H25: makes one piece of typed text safe to put in a spreadsheet cell. Line breaks and tabs become spaces (a bare
 *  CR/LF can start a "new row" in some parsers, and a tab a new cell), then a leading = + - @ gets an apostrophe so it is
 *  read as text. Apply to each element before joining a list into one cell. */
export function neutralizeCell(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ').trim();
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}

function csvField(value: unknown, neutralize = false): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (neutralize) s = neutralizeCell(s);
  // \r and ; are quoted too: an unquoted CR splits rows in some parsers, and ; splits cells in semicolon locales.
  if (/[",\r\n;]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv<T extends object>(
  columns: { key: keyof T; label: string }[],
  rows: T[],
  opts?: { neutralizeFormulas?: boolean }
): string {
  const safe = opts?.neutralizeFormulas === true;
  const header = columns.map((c) => csvField(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvField(row[c.key], safe)).join(','));
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
