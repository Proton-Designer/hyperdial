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
  /** MISSION-4 TASK-T2 (GHL-11/13): last_call_at/last_call_outcome/call_attempts (+
   *  license_number/service_zips for a 'yes_build_profile' disposition) pushed via
   *  `updateContactCustomFields`. */
  custom_fields_pushed?: boolean;
  /** MISSION-4 TASK-T2 (GHL-12): the org-configured outcome -> pipeline stage move applied. */
  stage_moved?: boolean;
}

/** MISSION-4 TASK-T2 (GHL-11/12/13): everything a push job needs to know about the ORG's own
 *  push-direction configuration -- resolved once per org by the caller (same "resolve per org,
 *  not per job" shape `resolveOrgGhlContext`/`buildEnrichment` already use), not re-fetched per
 *  job. Both fields are entirely optional/absent-safe: an org with no push field mapping or no
 *  outcome->stage config configured at all just gets a job with `pushFieldMapping: undefined`/
 *  no `stageTarget`, and every new step below no-ops cleanly. */
export interface GhlPushConfig {
  /** target key -> GHL custom-field-definition id. The SAME `org_integrations.ghl_field_mapping`
   *  jsonb T1 built for pull-direction enrichment, reused unchanged in its natural stored
   *  direction (target key -> field id) -- push needs no inversion, only pull did. */
  pushFieldMapping?: Record<string, string>;
}

/** Fields resolved by the CALLER (ghl-sync-worker/index.ts) at push time from `call_legs`/
 *  `campaign_leads` -- kept OUT of `DispositionPayload` (which is `submit_disposition`'s own
 *  enqueue-time snapshot, an already-live, complex RPC not worth touching for this) so this
 *  module never needs the SQL side to change at all. */
export interface DispositionPushTimeContext {
  /** ISO 8601, or null if genuinely unknown (never invented as "now" -- a stale/absent value is
   *  more honest than a wrong one). */
  lastCallAt?: string | null;
  /** `campaign_leads.attempts` for this lead, or null when the leg has no lead_id at all (e.g. a
   *  contact dialed outside any campaign). */
  callAttempts?: number | null;
  /** The org's configured outcome -> pipeline/stage move for THIS disposition
   *  (`dispositions.ghl_pipeline_id`/`ghl_pipeline_stage_id`) -- absent/null means "unmapped,
   *  never move" per the task's own explicit requirement. */
  stageTarget?: { pipelineId: string; pipelineStageId: string } | null;
  /** TASK-G02: the calling intern's GHL user id (`org_members.ghl_user_id` of the session's
   *  agent), used only as the callback task's `assignedTo`. Absent/null when the agent has no
   *  GHL user mapped -- the task is then created unassigned, as before. Never sent on the
   *  contact itself (the contact's GHL owner is GHL-controlled, spec §4). */
  callerGhlUserId?: string | null;
  /** TASK-G11 (spec §1 "Called by"): the calling intern's display name, pushed to the `called_by`
   *  custom field. A custom field, never the contact's GHL owner. */
  callerName?: string | null;
  /** TASK-G11 (spec §1 "Lead list / batch ID"): the dial session's campaign name (`lead_list`). */
  leadList?: string | null;
}

/** Builds the `{id, fieldValue}[]` array `updateContactCustomFields` needs from whichever of
 *  last_call_at/last_call_outcome/call_attempts/license_number/service_zips have BOTH a value
 *  worth pushing AND a configured GHL field id -- an org that hasn't mapped a given key, or a
 *  value that's simply absent this time (e.g. no license_number on a non-build-profile
 *  disposition), silently contributes nothing for that one key rather than erroring. Exported for
 *  its own direct test coverage (pure, no I/O). */
export function buildPushCustomFields(
  mapping: Record<string, string> | undefined,
  values: {
    lastCallAt?: string | null;
    lastCallOutcome?: string | null;
    callAttempts?: number | null;
    licenseNumber?: string | null;
    serviceZips?: string[] | null;
    /** TASK-G02 (spec §1): ISO 8601 callback time, only for a disposition with a callback. */
    callbackAt?: string | null;
    /** TASK-G02: seconds; 0 is a real value (a hangup), only null/undefined is absent. */
    callDurationSeconds?: number | null;
    /** TASK-G02: link only, never the audio. */
    recordingUrl?: string | null;
    /** TASK-G11 */
    calledBy?: string | null;
    calledByGhlUserId?: string | null;
    leadList?: string | null;
  }
): { id: string; fieldValue: string }[] {
  if (!mapping) return [];
  const out: { id: string; fieldValue: string }[] = [];
  const push = (targetKey: string, value: string | undefined | null) => {
    const fieldId = mapping[targetKey];
    if (fieldId && value !== undefined && value !== null && value !== '') {
      out.push({ id: fieldId, fieldValue: value });
    }
  };
  push('last_call_at', values.lastCallAt);
  push('last_call_outcome', values.lastCallOutcome);
  push('call_attempts', values.callAttempts === null ? null : String(values.callAttempts ?? ''));
  push('license_number', values.licenseNumber);
  push(
    'service_zips',
    values.serviceZips && values.serviceZips.length > 0 ? values.serviceZips.join(', ') : null
  );
  push('callback_at', values.callbackAt);
  push(
    'call_duration',
    values.callDurationSeconds === null || values.callDurationSeconds === undefined
      ? null
      : String(values.callDurationSeconds)
  );
  push('recording_url', values.recordingUrl);
  push('called_by', values.calledBy);
  push('called_by_ghl_user_id', values.calledByGhlUserId);
  push('lead_list', values.leadList);
  return out;
}

export interface DispositionPayload {
  disposition_key: string;
  disposition_label: string;
  notes: string | null;
  callback_at: string | null;
  /** TASK-P3-E1: the org's per-disposition GHL tag (`dispositions.ghl_tag`), null for a
   *  disposition design §5 marks note-only or no-GHL-effect (e.g. "Left voicemail", "No answer
   *  (manual)") -- `processDispositionJob` skips the tag-add step entirely when this is null,
   *  rather than falling back to `disposition_key` as an implicit tag. */
  ghl_tag: string | null;
  /** TASK-P3-E1: `dispositions.creates_task` -- only "Callback" is true by default. Gates the
   *  task-creation step together with `callback_at` (a task with no due date isn't meaningful),
   *  so a future org-customized disposition can't accidentally create a dateless task either. */
  creates_task: boolean;
  agent_name: string;
  duration_seconds: number;
  recording_url: string | null;
  transcript_excerpt: string | null;
  /** TASK-F-P1 (DSP-1): carried now, F-P2 maps them to GHL custom fields later. */
  license_number: string | null;
  zips: string[] | null;
  /** TASK-F-P1: whether THIS disposition's lead_effect is 'dnc', derived server-side in
   *  submit_disposition -- never infer this from `disposition_key` here. An org's DNC
   *  disposition can be keyed 'dnc' (a pre-F-P1 org) or 'do_not_call' (the new canonical key,
   *  TASK-F-T1's own decisions.md), or any future custom key an org creates with lead_effect
   *  'dnc' -- matching a literal key string would silently stop setting DND the moment an org's
   *  key differs from whatever was hardcoded here. */
  is_dnc: boolean;
}

/** TASK-G02 (spec §1: "Do not log every no-answer as a separate note"): dispositions whose only
 *  GHL record is the tag/attempt fields. A no-answer or voicemail with an EMPTY notes field gets no
 *  note; if the intern typed notes the note is still posted. Matched on the seeded keys
 *  (`no_answer`, `voicemail_left`) plus the legacy pre-F-P1 `voicemail`. */
const NOTELESS_WHEN_EMPTY_DISPOSITION_KEYS = new Set(['no_answer', 'voicemail_left', 'voicemail']);

export function shouldSkipDispositionNote(p: DispositionPayload): boolean {
  return NOTELESS_WHEN_EMPTY_DISPOSITION_KEYS.has(p.disposition_key) && !(p.notes ?? '').trim();
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
  if (p.license_number) lines.push(`License #: ${p.license_number}`);
  if (p.zips && p.zips.length > 0) lines.push(`ZIPs served: ${p.zips.join(', ')}`);
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
  /** MISSION-4 TASK-T2: optional -- an org with no push field mapping / no stage config at all
   *  simply gets no custom-fields/stage-move step run (both steps still mark themselves done,
   *  since "nothing to push" is a completed no-op, not a failure to retry forever). */
  pushConfig?: GhlPushConfig;
  pushTimeContext?: DispositionPushTimeContext;
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
      if (!shouldSkipDispositionNote(args.payload)) {
        await args.client.addNote(ghlContactId, { body: buildDispositionNote(args.payload) });
      }
      progress.note_added = true;
    }

    if (!progress.tag_added) {
      if (args.payload.ghl_tag) {
        await args.client.addTags(ghlContactId, [args.payload.ghl_tag]);
      }
      progress.tag_added = true;
    }

    if (!progress.task_created) {
      if (args.payload.creates_task && args.payload.callback_at) {
        await args.client.createTask(ghlContactId, {
          title: `Callback: ${args.payload.disposition_label}`,
          dueDate: args.payload.callback_at,
          ...(args.pushTimeContext?.callerGhlUserId && {
            assignedTo: args.pushTimeContext.callerGhlUserId,
          }),
        });
      }
      progress.task_created = true;
    }

    if (!progress.dnd_set) {
      if (args.payload.is_dnc) {
        await args.client.setDnd(ghlContactId, true);
      }
      progress.dnd_set = true;
    }

    // MISSION-4 TASK-T2 (GHL-11/13): last_call_at/last_call_outcome/call_attempts, plus
    // license_number/service_zips (carried in the payload since TASK-F-P1, unmapped until now)
    // when the org's field mapping has a GHL field id for any of them.
    if (!progress.custom_fields_pushed) {
      const fields = buildPushCustomFields(args.pushConfig?.pushFieldMapping, {
        lastCallAt: args.pushTimeContext?.lastCallAt,
        lastCallOutcome: args.payload.disposition_label,
        callAttempts: args.pushTimeContext?.callAttempts,
        licenseNumber: args.payload.license_number,
        serviceZips: args.payload.zips,
        callbackAt: args.payload.callback_at,
        callDurationSeconds: args.payload.duration_seconds,
        recordingUrl: args.payload.recording_url,
        calledBy: args.pushTimeContext?.callerName ?? args.payload.agent_name,
        calledByGhlUserId: args.pushTimeContext?.callerGhlUserId,
        leadList: args.pushTimeContext?.leadList,
      });
      if (fields.length > 0) {
        await args.client.updateContactCustomFields(ghlContactId, fields);
      }
      progress.custom_fields_pushed = true;
    }

    // MISSION-4 TASK-T2 (GHL-12): "the pipeline stage moves with the outcome ... unmapped = no
    // move" -- stageTarget is null/absent for a disposition the admin hasn't configured a
    // pipeline/stage for, in which case this step does nothing but still marks itself done.
    if (!progress.stage_moved) {
      const stageTarget = args.pushTimeContext?.stageTarget;
      if (stageTarget) {
        await args.client.moveOpportunityStage({
          locationId: args.locationId,
          contactId: ghlContactId,
          pipelineId: stageTarget.pipelineId,
          pipelineStageId: stageTarget.pipelineStageId,
          opportunityName:
            [args.contactFields.firstName, args.contactFields.lastName]
              .filter(Boolean)
              .join(' ')
              .trim() || 'HyperDial lead',
        });
      }
      progress.stage_moved = true;
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

/** TASK-I1 (INB-4): "a GHL note job ('Inbound call from …, <outcome>')". */
export interface InboundCallNotePayload {
  from_e164: string;
  outcome: 'answered_by_agent' | 'forwarded' | 'voicemail' | 'missed';
  agent_name: string | null;
  duration_seconds: number;
  recording_url: string | null;
  /** MISSION-4 TASK-T2 (GHL-11/16): ISO 8601 -- when the inbound call actually happened, for the
   *  same push-time "last_call_at" custom field a disposition job pushes. Optional/nullable
   *  rather than defaulting to "now" here -- a job can be retried well after the real call, and
   *  the caller (inbound-engine.ts) already has the real timestamp (`inbound_calls.ended_at`)
   *  available at enqueue time, so there's no reason to guess. */
  occurred_at?: string | null;
}

/** MISSION-4 TASK-T2 (GHL-16): "inbound calls push a GHL note + the last-call fields," same tag
 *  convention GHL-10 established for outbound dispositions (`'call:' || key`) -- inbound has no
 *  disposition key, so this is the one hardcoded literal for the inbound case specifically. */
const INBOUND_CALL_GHL_TAG = 'call:inbound';

export function buildInboundCallNote(p: InboundCallNotePayload): string {
  const outcomeLabel: Record<InboundCallNotePayload['outcome'], string> = {
    answered_by_agent: 'answered',
    forwarded: 'forwarded',
    voicemail: 'left a voicemail',
    missed: 'missed',
  };
  const lines = [`Inbound call from ${p.from_e164} -- ${outcomeLabel[p.outcome]}`];
  if (p.agent_name) lines.push(`Agent: ${p.agent_name}`);
  lines.push(`Duration: ${p.duration_seconds}s`);
  if (p.recording_url) lines.push(`Recording: ${p.recording_url}`);
  return lines.join('\n');
}

export interface ProcessInboundCallNoteJobArgs {
  client: GhlClient;
  locationId: string;
  ghlContactId: string | null;
  contactFields: ContactFields;
  payload: InboundCallNotePayload;
  progress: JobProgress;
  /** MISSION-4 TASK-T2 (GHL-11/16): same org-wide push field mapping a disposition job gets --
   *  inbound calls have no per-outcome pipeline-stage config (GHL-12 is disposition-only, per
   *  the task's own "the pipeline stage moves with the outcome" wording), so only
   *  `pushFieldMapping` applies here, never a `stageTarget`. */
  pushConfig?: GhlPushConfig;
}

/** Mirrors processNurtureTagJob's shape (upsert-if-needed) but with THREE steps of its own
 *  (note -> tag -> custom fields), not one -- GHL-16's "note + the last-call fields" plus GHL-10's
 *  same tagging convention applied to the inbound case. */
export async function processInboundCallNoteJob(
  args: ProcessInboundCallNoteJobArgs
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
      await args.client.addNote(ghlContactId, { body: buildInboundCallNote(args.payload) });
      progress.note_added = true;
    }

    if (!progress.tag_added) {
      await args.client.addTags(ghlContactId, [INBOUND_CALL_GHL_TAG]);
      progress.tag_added = true;
    }

    if (!progress.custom_fields_pushed) {
      const fields = buildPushCustomFields(args.pushConfig?.pushFieldMapping, {
        lastCallAt: args.payload.occurred_at,
        lastCallOutcome: args.payload.outcome,
      });
      if (fields.length > 0) {
        await args.client.updateContactCustomFields(ghlContactId, fields);
      }
      progress.custom_fields_pushed = true;
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

export interface ProcessNurtureTagJobArgs {
  client: GhlClient;
  locationId: string;
  ghlContactId: string | null;
  contactFields: ContactFields;
  /** Steps already completed by a prior attempt, same skip-on-retry shape as
   *  ProcessDispositionJobArgs.progress. */
  progress: JobProgress;
}

/** TASK-F-T1 (QUE-3): "max attempts -> nurture tag pushed to GHL." Mirrors
 *  processDispositionJob's own upsert step exactly (including its progress.upserted guard), then
 *  tags the contact `nurture` (configurable later by F-P2 -- kept minimal per the task's own
 *  words) guarded by progress.tag_added. No note/task/dnd steps -- this job kind only ever tags. */
export async function processNurtureTagJob(
  args: ProcessNurtureTagJobArgs
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

    if (!progress.tag_added) {
      await args.client.addTags(ghlContactId, ['nurture']);
      progress.tag_added = true;
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

export interface ProcessTagJobArgs {
  client: GhlClient;
  locationId: string;
  ghlContactId: string | null;
  contactFields: ContactFields;
  /** The literal tag to push -- computed at ENQUEUE time (SQL), e.g. `call:voicemail-2` or
   *  `call:no-answer-1`. Unlike `processNurtureTagJob`'s hardcoded 'nurture', this job kind's
   *  whole point (TASK-F-T3, VMD-3/GHL-9) is a per-contact COUNT baked into the tag string. */
  tag: string;
  progress: JobProgress;
  /** TASK-G03 (spec §1): same org push mapping a disposition job gets. Absent = no field push. */
  pushConfig?: GhlPushConfig;
  /** TASK-G03: only `lastCallAt`/`callAttempts` are used -- an automated no-answer/voicemail has no
   *  callback, duration worth a field, recording or stage move. */
  pushTimeContext?: Pick<
    DispositionPushTimeContext,
    'lastCallAt' | 'callAttempts' | 'callerName' | 'callerGhlUserId' | 'leadList'
  >;
}

/** TASK-F-T3 (VMD-3, GHL-9 overlap): "voicemail_tag"/"no_answer_tag" job kinds -- an automated
 *  engine outcome (voicemail_left/no_answer on call_legs) pushing a counted GHL tag, distinct
 *  from `processDispositionJob`'s agent-submitted disposition tags. Same shape as
 *  `processNurtureTagJob` (upsert-then-tag, no note/task/dnd steps), just with the tag coming
 *  from the payload instead of a hardcoded literal. */
export async function processTagJob(args: ProcessTagJobArgs): Promise<ProcessJobResult> {
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

    if (!progress.tag_added) {
      await args.client.addTags(ghlContactId, [args.tag]);
      progress.tag_added = true;
    }

    // TASK-G03 (spec §1): attempt count + last attempt date after EVERY call, not only agent
    // dispositions. No note (spec: "do not log every no-answer as a separate note").
    if (!progress.custom_fields_pushed) {
      const fields = buildPushCustomFields(args.pushConfig?.pushFieldMapping, {
        lastCallAt: args.pushTimeContext?.lastCallAt,
        callAttempts: args.pushTimeContext?.callAttempts,
        calledBy: args.pushTimeContext?.callerName,
        calledByGhlUserId: args.pushTimeContext?.callerGhlUserId,
        leadList: args.pushTimeContext?.leadList,
      });
      if (fields.length > 0) {
        await args.client.updateContactCustomFields(ghlContactId, fields);
      }
      progress.custom_fields_pushed = true;
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

export interface ProcessDncFlagJobArgs {
  client: GhlClient;
  /** The contact's GHL id -- a dnc_flag job only exists for a contact already linked to GHL. */
  ghlContactId: string | null;
  /** The org's DNC tag (its lead_effect='dnc' disposition's `ghl_tag`, default 'DNC'). */
  dncTag: string;
  progress: JobProgress;
}

/** TASK-G05 (spec section 4): a contact became DNC in HyperDial by some route other than the DNC
 *  disposition -> set GHL DND and add the DNC tag. Reads the GHL contact first and skips what is
 *  already there (DNC that came FROM GHL via pull import is not echoed back; a disposition job's own
 *  DND for the same change is not repeated). Steps are progress-flagged like every other job. */
export async function processDncFlagJob(args: ProcessDncFlagJobArgs): Promise<ProcessJobResult> {
  const progress: JobProgress = { ...args.progress };
  const ghlContactId = args.ghlContactId;
  try {
    if (!ghlContactId) throw new Error('dnc_flag job: contact has no GHL contact id');
    if (!progress.dnd_set || !progress.tag_added) {
      const ghl = await args.client.getContact(ghlContactId);
      if (!progress.dnd_set) {
        if (ghl.dnd !== true) await args.client.setDnd(ghlContactId, true);
        progress.dnd_set = true;
      }
      if (!progress.tag_added) {
        const have = (ghl.tags ?? []).some(
          (t) => t.trim().toLowerCase() === args.dncTag.trim().toLowerCase()
        );
        if (!have) await args.client.addTags(ghlContactId, [args.dncTag]);
        progress.tag_added = true;
      }
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

/** MISSION-4 lead follow-up to TASK-T2's own fix-forward: the `'transfer_note'` job kind
 *  (`crm_sync_jobs_kind_check` already widened by eng2's `20260926070002_transfer_hold.sql` --
 *  DB side is done; `transfer-core.ts`'s own `enqueue_crm_job(..., 'transfer_note', ...)` is
 *  eng2's still-pending T4 work). Payload contract per the lead: `{note_body, transfer_type,
 *  call_leg_id}`. `call_leg_id` here is purely informational (already carried on the job row's
 *  own `call_legs.id` column from enqueue time) and `transfer_type` is not folded into the note
 *  text -- the lead's own wording is "posts payload.note_body as a GHL contact note", not a
 *  reformatted/prefixed version of it, so this posts it verbatim. */
export interface TransferNotePayload {
  note_body: string;
  transfer_type: 'warm' | 'cold';
  call_leg_id: string;
}

export interface ProcessTransferNoteJobArgs {
  client: GhlClient;
  locationId: string;
  ghlContactId: string | null;
  contactFields: ContactFields;
  payload: TransferNotePayload;
  progress: JobProgress;
}

/** Mirrors `processNurtureTagJob`'s shape exactly (upsert-if-needed, then ONE more step) but the
 *  second step is a note, not a tag -- same `progress.note_added` guard `processDispositionJob`/
 *  `processInboundCallNoteJob` already use for their own note step, so a partial-failure retry
 *  never double-posts the note. No tag/custom-fields/stage steps: this job kind only ever notes. */
export async function processTransferNoteJob(
  args: ProcessTransferNoteJobArgs
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
      await args.client.addNote(ghlContactId, { body: args.payload.note_body });
      progress.note_added = true;
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
