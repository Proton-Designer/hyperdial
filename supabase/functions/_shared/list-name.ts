/**
 * TASK-G18 (spec section 1, "Lead list / batch ID"): the name of the imported list a lead / contact
 * came from. Stored in `campaign_leads.list_name` / `contacts.import_list` (both text, 1..120 chars)
 * and pushed to GHL as `lead_list`. Pure helpers, shared by contacts-import and ghl-import.
 */
export const LIST_NAME_MAX = 120;

/** Trims, collapses whitespace/control characters, caps at LIST_NAME_MAX. Blank / non-string -> null
 *  (an old client that sends no list name, or an empty field, means "no list name"). */
export function normalizeListName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // deno-lint-ignore no-control-regex
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return null;
  return cleaned.slice(0, LIST_NAME_MAX).trim();
}

/** Default for a GHL pull import that was not given a name: "GHL import 2026-10-19", the date in the
 *  org's time zone (`org_timezone_settings.timezone`; an invalid/absent zone falls back to UTC). */
export function defaultGhlListName(now: Date = new Date(), timeZone?: string | null): string {
  let date = now.toISOString().slice(0, 10);
  if (timeZone) {
    try {
      // en-CA formats as YYYY-MM-DD
      date = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
    } catch {
      // unknown zone: keep the UTC date
    }
  }
  return `GHL import ${date}`;
}
