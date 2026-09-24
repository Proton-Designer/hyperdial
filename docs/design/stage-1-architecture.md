# Stage 1 Architecture — Softdial Studio

**Status:** DRAFT, awaiting owner approval · **Author:** Opus Lead · **Date:** 2026-09-23
**Inputs:** platform audit and dialer audit (2026-09-23), owner decisions (2026-09-23)

Stage 1 = a startup cold-calling team (and a few friendly businesses) can sign up,
bring their own Telnyx account, invite reps, import or sync leads from GHL, and run
1–7 line parallel dialing with dispositions and transcripts that land back in GHL.

---

## 0. Owner decisions (fixed inputs)

| Topic | Decision |
|---|---|
| Telnyx | **Bring your own key (BYO key).** Each team (org) pastes its own Telnyx API key and is billed by Telnyx directly. No Stripe. |
| GHL | Private Integration Token per org (one GHL sub-account), **two-way sync**. |
| Transcripts | Telnyx in-call transcription using the **Deepgram engine** ($0.005/min) plus dual-channel recording ($0.002/min), billed to the org's Telnyx account. Chosen over Deepgram direct ($0.0043/min) because a second vendor key costs more to operate than the $0.0007/min it saves. |
| Roles | Owner / Admin / Agent. |
| Lines | 1–7 per agent. |
| AMD | Toggle per campaign. |

## 1. Audit verdicts that drive this design

- **Tenancy:** single-user throughout (`auth.uid() = user_id` on 10 tables, plus hand-written ownership checks in 13 functions). There is no org concept. → **Add orgs.**
- **Dial engine:** **REWRITE** the lifecycle, lock, batch and bridge logic. By default the agent is never actually bridged: the contact is connected into an empty conference while the app reports "connected". Losing legs are stuck at `dialing` forever. The human-claim lock is per session rather than per batch, so it hangs up later humans. Traversal is a fixed-offset pointer into a changing filtered view. There are no attempts, no second pass, no AMD toggle, no dispositions and no transcripts.
- **Salvage:** `_shared/telnyx.ts` REST wrappers, `_shared/dialer-events.ts` (Realtime broadcast), `amd.ts` result normalization, the webhook's "acknowledge, then process" shape, and the contacts CSV parse/import.
- **Mock UI to replace:** `Analytics.tsx`, and the `Settings.tsx` Profile, Billing, Team and Integrations tabs.

---

## 2. Tenancy and roles

### Schema (new)
```
orgs            (id, name, created_by, created_at)
org_members     (org_id, user_id, role: owner|admin|agent, status: active|disabled, PK(org_id,user_id))
org_invites     (id, org_id, email, role, token_hash, invited_by, expires_at, accepted_at)
profiles        (user_id PK, first_name, last_name, active_org_id)
```
- Every business table gets `org_id NOT NULL`. `user_id` becomes `created_by` / `agent_id` where it carries meaning.
- **RLS helpers:** `private.is_org_member(org uuid)` and `private.has_org_role(org uuid, roles text[])`. These are `SECURITY DEFINER`, `STABLE`, `search_path` pinned, and live in a non-exposed schema. Every policy is written with them. There are no inline sub-selects in policies, which avoids recursive RLS on `org_members`.
- **Edge functions** use one shared `requireOrgRole(req, orgId, roles)` in `_shared/auth.ts`, which replaces the 13 hand-written `user_id` filters. Service-role queries must filter on `org_id`.
- **Invites:** an Admin or Owner creates an invite, which produces a single-use link (the token is stored hashed). The invitee signs up or logs in through that link and `accept-invite` creates the membership. Each member has their own Supabase login. For now the owner shares the link manually; sending it by email is a stretch goal.
- **Migration:** append-only. Backfill creates one org per existing user, with that user as owner. Columns are added nullable, backfilled, then set `NOT NULL`, and the old policies are dropped and recreated.

### Permission matrix
| Capability | Owner | Admin | Agent |
|---|---|---|---|
| Telnyx key, GHL token, delete org, transfer ownership | ✅ | — | — |
| Invite, remove or change the role of members (not the owner) | ✅ | ✅ | — |
| Buy or release numbers; assign caller ID | ✅ | ✅ | — |
| Create or edit campaigns; assign agents; import contacts | ✅ | ✅ | — |
| See all calls, recordings, transcripts and team stats | ✅ | ✅ | own only |
| Dial assigned campaigns; set dispositions; edit notes | ✅ | ✅ | ✅ |
| Mark a contact DNC | ✅ | ✅ | ✅ |

Agents can read contacts only through campaigns assigned to them (`campaign_agents`).

---

## 3. Bring-your-own Telnyx

### Storage
`org_telephony` stores:
- `org_id`
- `api_key_secret_id` (a Supabase Vault reference; the key is never kept in a plain column)
- `webhook_public_key` (the ed25519 key from the org's Telnyx portal)
- `call_control_app_id`, `credential_connection_id`, `outbound_voice_profile_id`
- `status`, `verified_at`

This table has **no client SELECT policy**. The client reads a safe view that shows only status and the last 4 characters of the key. The key is decrypted only inside edge functions, through a service-role-only RPC.

### "Connect Telnyx" (the `telnyx-connect` function)
1. Validate the key (`GET /v2/balance`).
2. Create an Outbound Voice Profile.
3. Create a **Call Control Application** with webhook URL `…/telnyx-webhook?org=<org_id>`.
4. Create a **Credential Connection** for the agents' WebRTC.
5. Store the resulting IDs. The owner pastes the account's webhook public key, and the UI links to where it is in the Telnyx portal.

This is idempotent: re-running it reuses existing resources, found by tag or name.

### Numbers
Search and purchase use the org's key. Purchased numbers are assigned to the org's Call Control app and stored in `phone_numbers(org_id, …)`. Each campaign has a default caller ID. Local presence (matching the caller ID to the lead's area code) is Stage 2.

### Agent WebRTC
- **One** telephony credential per member, created on first "Go Ready" and stored in `org_members.telnyx_credential_id`.
- Each session mints a short-lived token from that credential. This fixes the credential leak, where a new credential was created on every call and never deleted.

### Webhook security (fixes known-issues #0, required for Stage 1)
With several orgs' Telnyx accounts posting to one endpoint, the unauthenticated webhook becomes a cross-tenant problem. `telnyx-webhook`:
1. Reads `?org=` and loads that org's public key.
2. Verifies the `telnyx-signature-ed25519` header over `timestamp|body`.
3. Rejects timestamps older than 5 minutes (replay window).
4. Rejects the request on failure. **It fails closed.**
5. Checks that the leg or session in `client_state` belongs to that org.

The HMAC path is deleted. This lands before any live traffic, and together with a live verification step, so that real Telnyx events are known to pass.

---

## 4. The dial engine (rewrite)

### 4.1 Topology: a persistent agent leg in a conference
1. **Go Ready.** The browser registers the WebRTC client. The server creates a Telnyx **conference** for the session and **dials the agent's SIP URI** (`sip:<cred-user>@sip.telnyx.com`) from the org's Call Control app. The browser auto-answers calls that carry `X-Softdial-Session: <id>`. The agent is now sitting in the conference.
2. **Dial.** Contact legs are originated with `client_state = {org, session, leg}`.
3. **Win.** The winning leg is joined into the conference, so the agent hears the contact within about 100 ms of the join, with no ring-to-agent delay.
4. **After the call** the contact leg hangs up, and the agent **stays in the conference** for the next contact.

This removes the "nobody on the line" failure, removes callback numbers, and gives recording and transcription a stable anchor.

**The engine refuses to dial unless the agent leg is `answered`.** If the agent leg drops, the session is set to `paused_agent_lost` and every ringing leg is hung up.

### 4.2 List traversal: queue-ordered "rolling refill" (not batch waves)
**Why not waves (dial N, wait for all to resolve, repeat)?** A wave is only as fast as its slowest leg, which rings until the timeout (about 25 s). With 7 lines, most of every wave is dead time after the fast failures come back.

**The algorithm:**
- While the agent is `READY` (not on a call, not in wrap-up), keep `lines` legs ringing.
- Each time a leg ends without a claim (no answer, busy, machine, failed), **immediately dial the next lead** into the free line.
- When a leg is **claimed**, hang up every other ringing leg, stop refilling, and bridge.
- After the call ends and the agent submits a disposition (wrap-up), refill all lines.

This is how "multi-line" power dialers get their throughput. The agent waits for the next human, not for a wave to finish.

**The queue is the second-pass mechanism, and it lives in Postgres** (`campaign_leads`):
```
status        queued | in_flight | completed | exhausted | dnc | callback
attempts      int
next_attempt_at timestamptz
last_outcome  text
position      bigint  (import order)
assigned_agent_id (for callbacks)
```
Lead selection happens in one RPC, `claim_next_leads(session_id, n)`:
```sql
SELECT … FROM campaign_leads
WHERE campaign_id = $c AND status = 'queued' AND next_attempt_at <= now()
  AND contact is callable now (local calling window, see §7)
ORDER BY attempts ASC, next_attempt_at ASC, position ASC
FOR UPDATE SKIP LOCKED LIMIT $n
→ UPDATE status='in_flight'
```
- `ORDER BY attempts` is your algorithm, generalized. Everyone gets pass 1 before anyone gets pass 2, and unanswered leads sink to the next pass automatically.
- `SKIP LOCKED` lets **several agents dial the same campaign without dialing the same person twice**, which a team needs and the current code cannot do.

**Outcome rules** (defaults, configurable per campaign):

| Leg outcome | Lead goes to | attempts | next_attempt_at |
|---|---|---|---|
| no_answer / busy | queued | +1 | now + retry_interval (default 2 h) |
| machine (AMD on) | queued | +1 | now + retry_interval |
| dropped (rang, was hung up because another leg won) | queued | +0 | now + 15 min |
| abandoned (human answered, lost the claim race) | queued, high priority | +1 | now + 15 min |
| failed / invalid number | exhausted | — | — |
| connected → disposition | set by the disposition (below) | +1 | — |
| attempts ≥ max_attempts (default 3) | exhausted | — | — |

**"Dropped" is not counted as an attempt.** The person was rung only because of our parallelism, and counting it would burn their attempts on calls that were never really tried.

### 4.3 Single-winner claim (Postgres, not Redis)
```sql
UPDATE dial_sessions SET active_leg_id = $leg, state = 'connecting'
WHERE id = $s AND state = 'dialing' AND active_leg_id IS NULL
RETURNING id;
```
A conditional `UPDATE` is atomic in Postgres, so exactly one leg wins. The lock is the session's `active_leg_id`, which is cleared when that call ends. That makes it naturally **per call**, which fixes the stale 300-second lock.

**This reverses the "Redis alongside Postgres" decision on purpose.** That decision rested on latency, but Upstash is *also* an HTTP round trip from an edge function, so Postgres RPC costs about the same. What it gains us:
- one source of truth
- transactional claim, queue and leg writes (which fixes the unguarded read-modify-write race)
- no lost state on a Redis eviction
- one less secret per deployment

Redis is removed from the dial path. The decisions.md entry gets superseded with this rationale.

### 4.4 State machines
**Session:** `ready_pending` → `ready` (agent leg answered) ⇄ `dialing` → `connecting` → `on_call` → `wrap_up` → `dialing` … Other states: `paused`, `paused_agent_lost`, `stopped`, `completed` (the queue is exhausted).

**Leg (`call_legs`):** `initiated` → `ringing` → `answered` → [`amd_pending`] → `claimed` | `dropped` | `abandoned` | `machine` → `ended`. Every leg reaches a terminal state with `outcome`, `duration`, `hangup_cause`. There are no more stuck `dialing` rows.

**Every transition is a Postgres RPC** that checks the expected prior state. That makes webhook redelivery or out-of-order events harmless no-ops (idempotency), keyed by `call_control_id` plus the event id, which is stored in `webhook_events` for dedupe.

### 4.5 AMD
Per-campaign `amd_mode: off | on`.
- **Off:** `call.answered` triggers the claim. Fastest connect; the agent hangs up on voicemail greetings themselves.
- **On:** use Telnyx **premium** AMD ($0.0065 per call against $0.002 for standard). Accuracy is what matters, since a false "machine" drops a real prospect. `human` or `not_sure` triggers a claim; `machine`, `fax` or `silence` hang up and requeue.
- The engine tracks the gap between `answered` and the claim, because every second spent on AMD raises the abandon risk. The UI says so honestly next to the toggle.

### 4.6 Abandoned humans
When two people answer within the same second, only one can win. Under the US Telemarketing Sales Rule, an abandoned call must play a recorded identification within 2 seconds, and abandons must stay under 3% per campaign over 30 days. So:
- Losing *answered* humans hear a short `speak` message: "Sorry we missed you — this is <org name>, we'll call you back." Then the call is hung up.
- The abandon rate is shown per campaign.

Ringing, unanswered legs are hung up silently.

### 4.7 Stuck-state safety net
- Telnyx `timeout_secs=25` on every dial guarantees a hangup event.
- A **pg_cron** job runs every 30 s and calls the `dialer-sweeper` function through pg_net. It ends legs with no event for more than 60 s, fails sessions whose agent leg is gone, and unlocks `in_flight` leads whose leg ended.

**This is a deliberate architecture change.** CLAUDE.md says not to add a cron casually; this is the one deliberate cron, and it gets recorded in decisions.md.

---

## 5. Dispositions, recording and transcripts

**Dispositions:** a per-org configurable list, seeded with these defaults and their effect on the lead:

| Disposition | Lead effect | GHL effect |
|---|---|---|
| Interested / Meeting booked | completed | tag + note |
| Callback | status `callback`, `next_attempt_at` = the chosen time, `assigned_agent_id` = the agent | tag + note + task |
| Not interested | completed | tag + note |
| Wrong number | exhausted | tag + note |
| Do not call | contact `dnc=true` in every campaign | tag `DNC` + DND on |
| Left voicemail | queued, +1 | note |
| No answer (manual) | queued, +1 | — |

- The wrap-up screen is **mandatory** after each connected call. It has a disposition, notes and a callback picker, and refilling the lines waits for it to be submitted. An optional auto-wrap timeout is configurable.
- The dead `LiveCallPanel` notes textarea becomes the real notes field.

**Recording:** `record_start` runs on the contact leg when the claim succeeds (dual channel, mp3). Telnyx's `call.recording.saved` link expires, so the webhook enqueues a job that downloads the file into the Supabase Storage bucket `recordings/<org_id>/…`. Storage RLS is scoped to the org, with the agent seeing only their own recordings.

**Transcription:** `transcription_start` runs on the contact leg with the Deepgram engine and `tracks: both`. The `call.transcription` webhooks write rows into `transcript_segments(leg_id, speaker, text, ts)`. The UI shows the transcript live in the call panel and afterwards in the call detail. *Before building, the exact parameter names get verified against current Telnyx docs.*

---

## 6. GHL two-way sync (Private Integration Token)

`org_integrations(org_id, provider='ghl', token_secret_id (Vault), location_id, status)`. It uses the LeadConnector API v2 (`services.leadconnectorhq.com`, `Version: 2021-07-28`).

- **Pull:** "Import from GHL" by tag or search into `contacts` with `ghl_contact_id`, deduplicated on phone or `ghl_contact_id`. There is a manual re-sync button. Real-time GHL→Softdial webhooks are Stage 2.
- **Push:** after each disposition, one outbox row is written to `crm_sync_jobs`. A pg_cron worker processes it with retry and backoff. The push:
  - adds a **note** (outcome, duration, agent, notes, recording link, first ~1,000 characters of the transcript)
  - adds a **disposition tag**
  - creates a **task** for callbacks
  - turns **DND** on for DNC

  The outbox exists so that GHL outages never block the dialer.
- Contacts created in Softdial that have no GHL id are upserted to GHL on their first disposition.

---

## 7. Contacts and campaigns changes

- **Contacts:**
  - Numbers are normalized to strict E.164 with `libphonenumber-js`; invalid ones are rejected at import with a count.
  - `timezone` is derived from the area code, can be overridden, and feeds the calling window.
  - Real contact editing.
  - An org-wide DNC flag.
  - Dedupe per org.
- **Campaigns:**
  - Settings: `lines (1–7)`, `amd_mode`, `caller_id_number_id`, `max_attempts`, `retry_interval`, `calling_window (default 08:00–21:00 contact-local)`, `assigned agents`.
  - A delete action.
  - Status is enforced (a paused campaign cannot start a session).
  - Stats are computed from `call_legs` instead of the columns that were never written.
- **Calling window:** enforced inside `claim_next_leads` using the contact's timezone. On by default; an admin can widen it.
- **Dashboard and Analytics:** rebuilt on `call_legs` and dispositions. The `call_events` table and the fake Analytics constants are removed. *(This is at the end of Stage 1 and small once `call_legs` exists.)*

---

## 8. Build plan (at most 2 parallel Sonnet agents)

Each phase ends with `npm run check` plus `npm run build` plus the phase's verification. Every migration is also tested with `supabase db reset` locally, and RLS is verified with a positive and a negative test per role.

| Phase | Agent A (platform) | Agent B (telephony) | Gate |
|---|---|---|---|
| **1. Foundation** | Tenancy migration and backfill, RLS helpers, `requireOrgRole`, profiles, real Settings Profile, invites and team management UI, role gating | Vault-backed Telnyx key storage, `telnyx-connect` provisioning, ed25519 webhook verification with org routing, per-member WebRTC credential (pure `_shared` modules first; schema after A's migration lands) | RLS test matrix passes; a forged webhook is rejected (unit test) |
| **2. Dialer core** | Contacts (E.164, timezone, edit, DNC), campaigns (settings, agents, delete, status), numbers per org, caller ID | New schema (`dial_sessions`, `call_legs`, queue columns, `webhook_events`), transition RPCs, `claim_next_leads`, the engine rewrite, the persistent agent leg, AMD toggle, lines 1–7, sweeper, new dialer UI state machine | Deno unit tests for queue ordering and state transitions; **live call test by the owner** |
| **3. After the call** | GHL connect, pull import, push outbox worker | Dispositions and wrap-up UI, recording to Storage, live transcription | Live test: disposition → GHL note appears |
| **4. Truth and cleanup** | Dashboard and Analytics on real data, delete the mock UI, remove Redis and `call_events` | Abandon-rate reporting, manual E2E checklist rewrite, .brain docs updated | Owner walks the full checklist |

Phase 2's engine work touches `_shared/`, so **Agent B owns `_shared/dialer-*` and `telnyx-webhook` exclusively.** Agent A never edits them. Both share `api.ts`, and each change to it is flagged in their report.

---

## 9. Open questions for the owner

1. **Existing data:** is there a deployed Supabase project with real contacts or calls to keep? If not, the migration can be much simpler.
2. **Test environment:** is there a Telnyx account plus a Supabase project we can use for the live tests in Phases 2–3, and a phone you can answer?
3. **Calling window default** of 08:00–21:00 in the contact's local time: keep it on by default?
4. **Abandoned-call message:** OK to play a short identification message to a human who lost the race, rather than silently hanging up?
