/**
 * GHL push outbox worker logic (TASK-P3-P3, design §6): processes one `crm_sync_jobs` row's
 * GHL side effects, step by step, tracking which steps already succeeded so a retry after a
 * partial failure never redoes a completed step ("idempotent per job: don't double-post a note
 * on retry after a partial success" -- the task's own acceptance requirement).
 *
 * Split into this pure-ish module (I/O only through the injected `GhlClient`, same shape as
 * `_shared/ghl-import.ts`'s split) and `ghl-sync-worker/index.ts` (the thin `Deno.serve`
 * wrapper that claims jobs, resolves each org's GHL client, and persists progress/outcome via
 * the RPCs in `20260924002000_ghl_push_worker.sql`) so this file is `deno test`-able with a
 * stubbed fetch and no Supabase client at all.
 */
import type { GhlClient } from './ghl-client.ts';

export interface JobProgress {
  upserted?: boolean;
  note_added?: boolean;
  tag_added?: boolean;
  task_created?: boolean;
  dnd_set?: boolean;
}

export interface DispositionPayload {
  disposition_key: string;
  disposition_label: string;
  notes: string | null;
  callback_at: string | null;
  agent_name: string;
  duration_seconds: number;
  recording_url: string | null;
  transcript_excerpt: string | null;
}

/** `.brain/domains/crm.md`'s documented disposition-job note shape, condensed into GHL's
 *  single `body` string field. Transcript is capped at 1,000 characters per the task spec. */
export function buildDispositionNote(p: DispositionPayload): string {
  const lines = [
    `Disposition: ${p.disposition_label}`,
    `Agent: ${p.agent_name}`,
    `Duration: ${p.duration_seconds}s`,
  ];
  if (p.notes) lines.push(`Notes: ${p.notes}`);
  if (p.recording_url) lines.push(`Recording: ${p.recording_url}`);
  if (p.transcript_excerpt) lines.push(`Transcript: ${p.transcript_excerpt.slice(0, 1000)}`);
  return lines.join('\n');
}

export interface ContactFields {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email?: string | null;
}

export interface ProcessDispositionJobArgs {
  client: GhlClient;
  locationId: string;
  /** Null if this contact has never been linked to GHL -- the upsert step resolves and returns
   *  one, which the caller must persist onto `contacts.ghl_contact_id` regardless of whether
   *  the job as a whole ends up ok or not (a later step can still fail after a real upsert
   *  succeeded, and that link must not be lost or re-upserted needlessly next retry). */
  ghlContactId: string | null;
  contactFields: ContactFields;
  payload: DispositionPayload;
  /** Steps already completed by a prior attempt -- each step is skipped when its flag is set. */
  progress: JobProgress;
}

export interface ProcessJobResult {
  ok: boolean;
  /** Every step successfully completed THIS call or a prior one, merged. Always persist this,
   *  ok or not -- it's what makes the next retry skip already-done work. */
  progress: JobProgress;
  /** The GHL contact id this job resolved to, once known (from `ghlContactId` or a fresh
   *  upsert) -- persist onto `contacts.ghl_contact_id` regardless of `ok`. */
  resolvedGhlContactId: string | null;
  error?: string;
}

/**
 * Runs the disposition steps in order (upsert -> note -> tag -> task -> dnd), skipping any
 * step whose `progress` flag is already true. Stops at the first failure and returns
 * `ok: false` with whatever progress was made this call merged in -- it never throws, so the
 * caller doesn't need try/catch to get partial-progress information out.
 */
export async function processDispositionJob(
  args: ProcessDispositionJobArgs
): Promise<ProcessJobResult> {
  const progress: JobProgress = { ...args.progress };
  let ghlContactId = args.ghlContactId;

  try {
    if (!progress.upserted) {
      if (!ghlContactId) {
        if (!args.contactFields.phone) {
          throw new Error('cannot upsert to GHL: contact has no phone number');
        }
        const res = await args.client.upsertContact({
          locationId: args.locationId,
          firstName: args.contactFields.firstName ?? undefined,
          lastName: args.contactFields.lastName ?? undefined,
          phone: args.contactFields.phone,
          email: args.contactFields.email ?? undefined,
        });
        ghlContactId = res.contactId;
      }
      progress.upserted = true;
    }
    if (!ghlContactId) {
      throw new Error('no GHL contact id available after the upsert step');
    }

    if (!progress.note_added) {
      await args.client.addNote(ghlContactId, { body: buildDispositionNote(args.payload) });
      progress.note_added = true;
    }

    if (!progress.tag_added) {
      await args.client.addTags(ghlContactId, [args.payload.disposition_key]);
      progress.tag_added = true;
    }

    if (!progress.task_created) {
      if (args.payload.callback_at) {
        await args.client.createTask(ghlContactId, {
          title: `Callback: ${args.payload.disposition_label}`,
          dueDate: args.payload.callback_at,
        });
      }
      progress.task_created = true;
    }

    if (!progress.dnd_set) {
      if (args.payload.disposition_key === 'dnc') {
        await args.client.setDnd(ghlContactId, true);
      }
      progress.dnd_set = true;
    }

    return { ok: true, progress, resolvedGhlContactId: ghlContactId };
  } catch (err) {
    return {
      ok: false,
      progress,
      resolvedGhlContactId: ghlContactId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ProcessContactUpsertJobArgs {
  client: GhlClient;
  locationId: string;
  ghlContactId: string | null;
  contactFields: ContactFields;
}

/** The simpler `kind='contact_upsert'` job: push one contact to GHL, done. No documented
 *  payload shape exists for this kind (crm.md's shape table only covers `disposition`) -- this
 *  is the minimal reading of the task title's "upsert contacts lacking a GHL id." */
export async function processContactUpsertJob(
  args: ProcessContactUpsertJobArgs
): Promise<ProcessJobResult> {
  if (args.ghlContactId) {
    return { ok: true, progress: { upserted: true }, resolvedGhlContactId: args.ghlContactId };
  }
  if (!args.contactFields.phone) {
    return {
      ok: false,
      progress: {},
      resolvedGhlContactId: null,
      error: 'cannot upsert to GHL: contact has no phone number',
    };
  }
  try {
    const res = await args.client.upsertContact({
      locationId: args.locationId,
      firstName: args.contactFields.firstName ?? undefined,
      lastName: args.contactFields.lastName ?? undefined,
      phone: args.contactFields.phone,
      email: args.contactFields.email ?? undefined,
    });
    return { ok: true, progress: { upserted: true }, resolvedGhlContactId: res.contactId };
  } catch (err) {
    return {
      ok: false,
      progress: {},
      resolvedGhlContactId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
