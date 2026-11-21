/** TASK-G28 */
/** One line for the result of "make sure these tags exist in GHL" after a save. null = nothing to say. */
export function describeTagSync(
  sync:
    | {
        created: string[];
        failed: { tag: string; error: string }[];
        listError: string | null;
      }
    | null
    | undefined
): { tone: 'ok' | 'warn'; text: string } | null {
  if (!sync) return null;
  if (sync.listError)
    return {
      tone: 'warn',
      text: `Saved, but HyperDial couldn't check your GHL tags (${sync.listError}). Tags are created in GHL the first time they are used on a contact.`,
    };
  if (sync.failed.length > 0)
    return {
      tone: 'warn',
      text: `Saved. Couldn't create in GHL: ${sync.failed.map((f) => f.tag).join(', ')}. Check the GHL token has the Tags permission.`,
    };
  if (sync.created.length > 0)
    return { tone: 'ok', text: `Created in GHL: ${sync.created.join(', ')}.` };
  return null;
}
