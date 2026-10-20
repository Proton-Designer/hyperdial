---
id: domain.dispositions
title: Dispositions
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-10-19
sources:
  - supabase/migrations/20260924002200_dispositions.sql
  - supabase/functions/dialer-session-disposition/index.ts
  - apps/web/src/components/Settings.tsx
  - apps/web/src/lib/api.ts
  - supabase/migrations/20261019201849_call_top_objection.sql
  - apps/web/src/components/dialer/WrapUpModal.tsx
  - supabase/functions/_shared/call-objection.ts
related:
  - domain.dialer
  - domain.crm
  - domain.campaigns
answers:
  - "how does a disposition affect a lead"
  - "where do dispositions get seeded for a new org"
  - "how does a disposition reach GHL"
  - "who can edit the disposition list"
covers: "The per-org disposition list, the submit_disposition RPC and its lead/DNC/GHL-outbox effects, and the Settings editor."
excludes: "The wrap-up form UI internals (components/dialer/WrapUpModal.tsx) → domain.dialer. The GHL push worker's own step-by-step mechanics (upsert/note/tag/task/dnd, retry/backoff) → domain.crm. Recording/transcription (not built) → domain.dialer's Not covered."
tokens_est: 2496
source_hash: 11b2138b18430995cb291cfeb735fb1c209431095064da588fd4d752c41938ba
---

# Dispositions

## Purpose

The outcome an agent (or admin, on their behalf) records after a call — "Interested", "Callback",
"Do not call", etc. Each disposition drives three things atomically: what happens to the lead
(requeue, complete, exhaust, DNC, or schedule a callback), what gets pushed to GHL, and moving the
dial session out of `wrap_up` so refilling resumes.

## Key concepts

| Term | Means |
|---|---|
| `dispositions` | Per-org, editable list (Settings → Dispositions). Seeded with design §5's 7 defaults for every org, existing and new. |
| `lead_effect` | One of `completed`/`callback`/`exhausted`/`dnc`/`queued` — the ONLY vocabulary `submit_disposition` understands; a custom disposition must pick one of these five, not invent a new shape. |
| `ghl_tag` | Nullable. The GHL contact tag this disposition applies. Null means "no tag" (design §5: "Left voicemail"/"No answer (manual)" have none) — NOT a fallback to `key`. |
| `creates_task` | Gates GHL task creation together with a non-null `callback_at`. Only "Callback" is true by default. |
| leg disposition fields | `call_legs.disposition_id/notes/callback_at/dispositioned_by/dispositioned_at` — written once per leg by `submit_disposition`; `dispositioned_at` is the idempotency guard for a re-submit. |
| `top_objection` | Optional per-call objection on `call_legs.top_objection`, one of `too_busy`, `enough_work`, `fees`, `dont_trust_apps`, `not_interested_app_jobs`, `other` (the same six keys as the shift survey). Chosen in the wrap-up modal (`WrapUpModal.tsx`, "Top objection (optional)"), validated in `_shared/call-objection.ts` (`parseTopObjection`, 400 on an unknown value) and again in SQL. Pushed to GHL as the `top_objection` field using the label text (`TOP_OBJECTION_GHL_LABELS`). TASK-G13. |
| win disposition | `dispositions.is_win` (the seeded `yes_build_profile`, "Yes - Build Profile"): a leg with a win disposition counts as a **sign-up** in shift KPIs (`shift_kpi_inputs`, TASK-G01). |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| Table + seed + RPC | `supabase/migrations/20260924002200_dispositions.sql` | `submit_disposition` is the whole feature's core |
| Seed defaults | `private.seed_default_dispositions(org)` | Called by a trigger on `orgs` insert AND a one-time backfill loop in the same migration — one definition, not two copies |
| Edge function | `supabase/functions/dialer-session-disposition/index.ts` | Auth + ownership check, calls the RPC, then `refillSession` |
| GHL payload consumer | `supabase/functions/_shared/ghl-sync-worker.ts` | `DispositionPayload.ghl_tag`/`creates_task` gate the tag/task steps — see domain.crm |
| Settings editor | `apps/web/src/components/Settings.tsx`'s `DispositionsTab` | admin+ only; `key`/`lead_effect` fixed after creation |
| Client contract | `apps/web/src/lib/api.ts` | `Disposition`, `listDispositions`/`createDisposition`/`updateDisposition`/`deleteDisposition`, `submitDisposition` |
| SQL tests | `supabase/tests/dispositions.sql` | Every default's effect, DNC cross-campaign propagation, re-submit idempotency, cross-agent rejection, disabled-callback-assignee rejection, outbox-only-when-connected |

## How it works

1. A leg reaches `ended` while the session is `wrap_up` (domain.dialer). The wrap-up form
   (`components/dialer/WrapUpModal.tsx`) calls `submitDisposition({legId, dispositionKey, notes,
   callbackAt, licenseNumber?, zips?, topObjection?})` — `apps/web/src/lib/api.ts`.
2. `dialer-session-disposition/index.ts`: `requireTelnyxOrgRole`, loads the leg's session, 403s an
   `agent` caller who isn't that session's own agent (owner/admin always pass).
3. `submit_disposition(p_leg, p_org, p_caller_user_id, p_disposition, p_notes, p_callback_at,
   p_license_number default null, p_zips default null, p_top_objection default null)` (latest definition:
   `20261019201849_call_top_objection.sql`, which dropped the 8-argument version) — a
   service-role-only SQL RPC (same shape as `claim_leg`/`transition_session`, NOT the client-JWT
   4-arg sketch the task file first proposed — `auth.uid()` is null under a service-role caller).
   Re-checks caller identity itself (defense in depth), applies the lead effect, propagates DNC
   across every `campaign_leads` row for the contact, calls `enqueue_crm_job('disposition', ...)`,
   and `transition_session(wrap_up → dialing)`.
4. Back in the edge function: `refillSession` (from `_shared/dialer-engine.ts`, called not edited)
   actually dials the next batch — `transition_session` alone only flips state.

## Integration points

| Direction | With | Via |
|---|---|---|
| Depends on | domain.dialer | `call_legs`/`dial_sessions`, `transition_session`, `refillSession` |
| Depended on by | domain.crm | `crm_sync_jobs` payload's `disposition_key`/`ghl_tag`/`creates_task`/etc. |
| Depended on by | domain.campaigns | `campaign_leads.status`/`assigned_agent_id` writes |

## Constraints & gotchas

- **`submit_disposition` is idempotent on a re-submit, but only for the FIRST disposition applied
  to a leg.** A second call updates `notes`/`disposition_id`/`callback_at` but does not undo the
  first lead effect and apply a different one — guarded by `call_legs.dispositioned_at` already
  being set. Changing your mind on an already-submitted leg needs a new leg, not a second call.
- **`ghl_tag` null means "skip the tag step", not "fall back to `disposition_key`"** —
  `ghl-sync-worker.ts` reads `payload.ghl_tag` directly. A custom disposition with no tag set will
  never get one added, even though the key still exists.
- **`creates_task` AND `callback_at` must both be truthy** for the GHL task step to run — a
  disposition with `creates_task=true` but no callback picked (only `lead_effect='callback'` ever
  sets `callback_at`) still creates no task.
- **DNC propagation is unconditional across every `campaign_leads` row for the contact**, including
  ones already `completed`/`exhausted` — a deliberate reading of the task spec's literal "every
  campaign_leads of that contact dnc" (DNC is a compliance signal that should override a stale
  prior outcome).
- **The callback assignee (always the session's own agent) is re-checked as an active org member
  at submit time**, not trusted from when the session started — an agent disabled mid-session must
  not get a callback silently assigned to them. SQL-tested (`dispositions.sql`).
- **`key`/`lead_effect` are not editable from the Settings UI after creation** (client-side only —
  not DB-enforced by a trigger). Deactivate and create a new disposition instead of repurposing one
  that's already been used by a real submission.

## Not covered here

- The wrap-up form UI itself → `components/dialer/WrapUpModal.tsx` → domain.dialer.
- GHL push worker step mechanics (upsert/note/tag/task/dnd, retry/backoff, pg_cron) and which
  fields reach GHL → domain.crm.
- Recording/transcription (design §5's other half — Storage bucket, `transcript_segments`, not
  built) → `enqueue_crm_job`'s payload always sends `recording_url`/`transcript_excerpt` as null
  until that lands. (The recording link in the payload IS populated now: an in-app, login-gated
  `/contacts?leg=<id>` URL, not an audio URL.)

## Unverified

- Live GHL verification (a real disposition → the tag/task/DND actually land) is blocked on the
  same "no live GHL location in this environment" limitation as domain.crm.
- `dialer-session-disposition`'s own live curl round-trip (vs. the local sim scripts) is
  NEEDS-LIVE-VERIFY until migration `20260924002200` is applied — `submit_disposition` itself is
  verified against the real schema via `supabase/tests/dispositions.sql`, but the edge function
  wrapper has only been `deno check`ed, not exercised end-to-end over HTTP.
