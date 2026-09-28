# Design note: Realtime for the team live board (TASK-M5-S1)

Status: **design only, no code.** Written by eng2 as part of Mission-5 EC-9
(`edge-cases-v2.md`: the live board polls `team_live_board` every 5s per open
manager tab; TASK-M5-L1 already stops that poll while a tab is hidden and adds
error backoff, but every VISIBLE manager tab still polls at full rate). This
note evaluates replacing (or supplementing) that poll with Supabase Realtime
`postgres_changes`, and ends with the decision the user needs to make.

## 1. Current state, precisely

`public.team_live_board(p_org uuid)` (`supabase/migrations/20260925080100...sql`,
last reshaped by `20260927160550_manager_role_and_pods.sql`) is a `security
definer` RPC, not a plain table read. Its own body:

- Gates on `private.has_org_role(p_org, ['owner','admin','manager'])`.
- For a manager, further restricts the `members` CTE to
  `private.is_agent_in_callers_pod_scope(p_org, m.user_id)` — pod scope is
  enforced **inside the function body**, in application/SQL logic, not by a
  table-level RLS policy.
- Joins `org_members` + `profiles` + `dial_sessions` (current, non-terminal
  session per agent) + `call_legs` (active leg's contact) + `campaigns` +
  `org_pods` + a same-day `call_legs` aggregate, and returns one denormalized
  row per agent.

`Team.tsx` polls this RPC on a 5s interval (`LIVE_POLL_MS`), now paced by
`useVisibilityPacedPolling` (TASK-M5-L1) so a hidden tab stops polling and a
failing poll backs off 6x/12x. A visible tab still fetches every 5s.

## 2. What would subscribe to what

The three tables whose changes actually drive `team_live_board`'s output:

- **`dial_sessions`** — state, lines, `active_leg_id`, `campaign_id`,
  `pause_reason`, `raised_hand_at`. This is the highest-frequency source: every
  dial-loop state transition and every leg connect/disconnect touches a row
  here (see §4).
- **`agent_state_events`** — the append-only state-transition log. Not read by
  `team_live_board` directly today, but it's the natural source for "agent
  just went ready/paused" if the board ever wants a transition feed instead of
  polling current state.
- **`coaching_sessions`** — drives `raised_hand_at`-adjacent supervisor UI
  (raise-hand, takeover) elsewhere in Team.tsx; not itself a `team_live_board`
  output column but is the other high-value Realtime candidate in this
  screen.

A client-side subscription would be `supabase.channel(...).on('postgres_changes',
{ event: '*', schema: 'public', table: 'dial_sessions', filter: \`org_id=eq.${orgId}\` }, ...)`.

### RLS interaction — the actual blocker, not a formality

Per Supabase's own Realtime docs (fetched for this note, not assumed):
`postgres_changes` **authorizes every change event against every subscriber's
own RLS policies** — "When you make a single change to a table with 100
subscribed users, Realtime performs 100 authorization checks — one per user"
(supabase.com/docs/guides/realtime/postgres-changes). There is no
`security definer`-style bypass: Realtime evaluates the subscribing client's
*actual* row-level SELECT policy on the underlying table, at the moment of
authorization, using that client's own JWT/claims — exactly the mechanism RLS
already uses for a direct `select`, and completely separate from whatever an
RPC's plpgsql body decides to filter.

That's the problem. I checked the live SELECT policies on both tables that
would need to feed the board:

```
-- supabase/migrations/20260924000700_dialer_schema.sql
create policy "owner or admin can view all dial_sessions" ... using (private.has_org_role(org_id, ['owner','admin']));
create policy "agent can view own dial_sessions" ... using (private.has_org_role(org_id, ['agent']) and agent_id = auth.uid());

-- supabase/migrations/20260927070000_agent_state_events.sql
create policy "owner or admin can view org agent_state_events" ... using (private.has_org_role(org_id, ['owner','admin']));
create policy "agent can view own agent_state_events" ... using (private.has_org_role(org_id, ['agent']) and agent_id = auth.uid());
```

**Neither table has a `manager` SELECT policy at all.** A manager isn't
`owner`/`admin` and isn't the row's own `agent_id`, so under RLS as it stands
today a manager's Realtime subscription to `dial_sessions` or
`agent_state_events` would silently receive **zero events, for every agent,
including their own pod** — not a pod-scope leak, the opposite failure: total
blackout for the one role this board most needs to serve, since `team_live_
board`'s RPC is the *only* thing today that lets a manager see pod-scoped
session data, and Realtime does not route through it.

`coaching_sessions` is the one table in this set already fixed for this,
because TASK-M5-P4 (`supervisor_alerts_and_pod_scoping`, 20260927171444) widened
it:

```
create policy "owner or admin see all coaching_sessions, a manager sees their own"
  on public.coaching_sessions for select
  using (private.has_org_role(org_id, ['owner','admin']) or manager_id = auth.uid());
```

That's a `manager_id = auth.uid()` self-scope, not a pod-scope — coincidentally
correct for coaching (a manager only ever sees sessions *they* started) but
not the pattern the live board needs (a manager needs to see *agents in their
pod*, not rows *they themselves* wrote).

**So moving `dial_sessions`/`agent_state_events` to Realtime is not just "turn
on replication" — it requires a new pod-scoped manager SELECT policy on each
table**, e.g.:

```sql
create policy "manager can view pod dial_sessions"
  on public.dial_sessions for select
  using (
    private.has_org_role(org_id, ['manager'])
    and private.is_agent_in_callers_pod_scope(org_id, agent_id)
  );
```

mirroring the exact helper `team_live_board` already calls, so the two paths
(RPC poll fallback + Realtime) can never disagree about who a manager can
see. Owner/admin's existing policy is untouched. This is itself a real,
reviewable RLS change to a live table — not a client-only "design only, no
code" follow-on; flagging it now so it's scoped correctly if the user picks
build.

## 3. Publication + migration needed

- `dial_sessions` and `agent_state_events` are not currently in the
  `supabase_realtime` publication (grep confirms no
  `alter publication supabase_realtime add table` for either in
  `supabase/migrations/`). Adding them is one migration:
  `alter publication supabase_realtime add table public.dial_sessions, public.agent_state_events;`
  plus the new manager RLS policies from §2, plus (per the docs) setting
  `replica identity full` on `dial_sessions` if the board ever wants to filter
  or diff on DELETE events (it currently only cares about UPDATE/INSERT — no
  session is ever hard-deleted — so this can likely be skipped for v1, but say
  so explicitly in the migration comment so a future change to hard-delete
  doesn't silently break it).
- No migration is needed for `coaching_sessions`'s RLS (already pod-correct
  for its own purpose), only adding it to the publication if the raise-hand/
  takeover UI also moves off polling.

## 4. Cost at scale: 30-50 agents x N manager tabs

Supabase's own Realtime quotas page (fetched for this note): Pro plan is 500
concurrent connections / 500 messages/sec by default (10k conns / 2.5k msg/s
on Pro-no-spend-cap); "100 channels per connection" on every plan; and,
critically, **`postgres_changes` throughput is authorization-checked per
subscriber, single-threaded to preserve order — a larger compute add-on does
not increase this throughput.** For a fixed write, cost is O(subscribers), not
O(writes):

- **Connections**: one per open manager tab (today's poll is already
  per-tab; Realtime doesn't change that ratio) — N managers x however many
  tabs each keeps open. Nowhere near the 500/10k connection ceiling at this
  org's scale, but each connection also holds a live socket the browser must
  keep open, which is a materially different failure mode than a stateless
  poll (see §5's dropped-socket fallback).
- **Authorization checks, the real cost**: every `dial_sessions` write is
  checked against every subscribed manager's RLS policy. At 30-50 dialing
  agents mid-batch (each line producing its own leg-lifecycle write — see §5),
  this is `writes_per_second x open_manager_tabs` authorization checks/sec,
  not `writes_per_second`. This is the number to actually watch under load,
  not the raw connection count, and it's exactly the number a 5s poll
  amortizes away today (a poll's cost is O(manager tabs), completely
  independent of how many agents are dialing).

## 5. Risks

**Dialer-engine write volume.** `supabase/functions/_shared/dialer-engine.ts`
issues a `dial_sessions` UPDATE at multiple independent points in the call
lifecycle (call-control-id assignment, per-leg state transitions, active-leg
swaps, recording-status changes, voicemail-drop bookkeeping — at least 8
distinct `.update()` call sites touching this table). A single agent running
5 lines mid-batch can produce several `dial_sessions` writes per second, each
one fanning out to every subscribed manager (§4). This is the dialer engine's
own write path (`.brain`'s own hard rule: "changes are never local, four
functions depend on it") — Realtime adds *read* fan-out on top of an
already-hot write path; it changes nothing about the writes themselves, but
turning up subscriber count directly multiplies authorization-check load on
that same hot path.

**Ordering / "event before row visible."** Not actually a risk for the raw
mechanism — Realtime reads the WAL after commit, so by definition the row is
already durably visible by the time an event is emitted, and Supabase
processes `postgres_changes` single-threaded specifically to preserve
per-table event order. The **real** version of this risk is a payload-shape
mismatch: a `postgres_changes` event on `dial_sessions` delivers only that
raw row (state, lines, active_leg_id, campaign_id, ...), not the denormalized,
joined shape `team_live_board` currently returns (agent name, contact name,
campaign name, pod name). A client that reacts to the event by rendering it
directly, before the joined data it needs (e.g. a brand-new `active_leg_id`'s
contact name) exists in whatever local cache the client keeps, will show a
row with a real state but a blank/stale contact name for one round trip. Two
honest options, not a chosen fix: (a) treat the event purely as an
**invalidation signal** ("something changed, re-fetch `team_live_board` now"
— keeps the RPC as the one source of joined shape, Realtime only replaces the
5s *timer* with an event-driven trigger — this is the low-risk option and
should be the actual v1 scope, not "subscribe to raw rows and render them"),
or (b) have the client denormalize using its own already-fetched
members/campaigns/pods maps and accept the one-event lag on brand-new joins
(e.g. a lead just assigned this second). Recommend (a); it's most of the
latency win with none of the join-staleness risk, and needs zero client-side
denormalization logic.

**Socket drop / fallback.** Task requirement: L1's poll must stay as the
fallback, not be deleted. `useVisibilityPacedPolling` already has the right
shape for this — the Realtime subscription becomes the *fast path*, and the
existing paced poll keeps running at a **slower** base interval (e.g. 30-60s
instead of 5s) purely as a correctness backstop for a dropped/reconnecting
socket, rather than being removed. Supabase's client fires a
`SYSTEM`/`CHANNEL_ERROR` or closes the channel on drop; the concrete signal to
wire into "fall back to fast polling until resubscribed" is the channel's own
`.subscribe((status) => ...)` callback reporting anything other than
`SUBSCRIBED`.

## 6. Phased plan

- **S (small, do first):** Realtime-as-invalidation-signal only (§5 option a),
  `dial_sessions` alone (not `agent_state_events`), owner/admin only (their
  RLS already supports it — no new policy needed). Manager tabs keep polling
  at today's 5s rate unchanged. This alone proves the publication + fan-out
  cost model in §4 against real production write volume before anyone commits
  to the manager RLS change in §2.
- **M (medium):** add the manager pod-scoped `dial_sessions` RLS policy (§2)
  and publication entry, so manager tabs also move to event-driven
  invalidation with a slow poll fallback. Add `coaching_sessions` to the
  publication for the raise-hand/takeover UI (no new RLS needed, already pod-
  correct).
- **L (large, not recommended yet):** `agent_state_events` on Realtime as a
  genuine transition *feed* (not just current-state polling) for a future
  activity-log/timeline UI; would need its own manager RLS policy mirroring
  §2's `dial_sessions` one. Nothing in the current board's requirements needs
  this — listed for completeness, not proposed for this pass.

## The decision the user must make

Whether to spend the review/deploy cost on the manager RLS policy change in
§2 at all, given the org is currently 30-50 agents (well under every quota in
§4) and L1 (already deployed) already caps a *hidden* tab's poll cost to
near-zero. The concrete tradeoff: **S alone** (owner/admin-only Realtime,
zero new RLS) ships the latency win for the roles that already have full
table access and costs one migration + one small `Team.tsx` change; **M**
additionally requires reviewing and deploying a new pod-scoped SELECT policy
on a live table other engineers actively write to every second during dialing
(`dial_sessions`), which is exactly the class of change this run's own
playbook (`RULES-CARD.md`) marks high-risk (auth/permissions + concurrency)
and would need a second reviewer's independent verification, not just a
design note. Recommend shipping S now, watching real authorization-check load
for a few days, then deciding M on data rather than the estimate in §4.
