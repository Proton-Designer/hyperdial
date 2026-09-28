# Running your team in HyperDial

A single reference for an owner, admin, or manager running a dialing team — what exists, who can
use it, where it lives in the UI, and what's off by default. Mission 5 shipped roughly 30
team-management features across roles, pods, distribution, supervision, coaching, goals, schedules,
a shared inbox, and contact collaboration; this guide ties them together. Every claim below was
checked against the current code (the RPC's own role check, the migration that seeded a default,
the component that renders the button) as of this writing, not against a task file's original
intent — where behavior diverged from a task's stated design, the code wins.

For inviting your first intern and getting them onto a campaign, see
[inviting-and-assigning-interns.md](inviting-and-assigning-interns.md) — this guide assumes that
part is done and covers everything Mission 5 added on top of it.

**The four roles**, from broadest to narrowest: **owner** (one per org today — billing, connecting
Telnyx/GHL, everything), **admin** (everything an owner can do except what's explicitly
owner-only, e.g. taking an action against another admin), **manager** (team supervision and
coaching, scoped to the pods they're given — see §1), **agent** (dials, sees only their own data
and whatever a manager/admin explicitly shares).

## 1. Roles & pods

**What it's for:** grouping agents into pods so a manager can be given visibility into a slice of
the team instead of the whole org.

**Who:** creating/renaming/deleting pods and picking a manager's scope is owner/admin only.
Everyone's own pod membership (or a manager's own scope) then shapes what THEY can see elsewhere.

**Where:** Settings → Team → **Pods** (create/rename/delete a pod; a member's own pod is a column
in the same roster table; a manager's scope is the checkbox list under their row).

**How it's set up:**

1. Create a pod (just a name).
2. In the roster table, set each agent's **Pod** column (zero or one pod — no multi-pod agent
   membership).
3. For each manager, check the pods in their own row's checkbox list — this is a _separate_
   relationship from #2; a manager doesn't have to sit in a pod themselves to supervise one.
4. Owner/admin always see everything regardless of pods — pod scope never applies to them.

**What a manager can do**, scoped to their managed pods' agents: see the Team page (live board,
daily stats, attendance, onboarding checklist), assign/reassign leads (manual, territory rules,
round-robin — a territory rule's _target_ agent/pod must also be in scope), coach
(listen/whisper/barge) and take over a call, remotely pause/end a session, view recordings and set
scorecards, see the audit log filtered to their own scope (§10), and — as of TASK-M5-P1 — **read**
(never write) contact detail, notes, and change history for any contact one of their pod's agents
is currently working (granted by a `campaign_leads` assignment, not campaign membership).

**What a manager can never do**, regardless of pod scope: buy or release phone numbers, touch
billing/spend, change anyone's role, edit org-wide settings (quality-check rules, DNC, distribution
defaults, integrations), or restructure pods/roles themselves. Settings only shows a manager the
**Profile** and **Activity** tabs — everything else (Telephony, Team, Integrations, Dispositions,
DNC, Distribution) is owner/admin only, even though the Team _page_ (the live-board one — a
different screen from Settings → Team) is manager-visible.

**Gotcha:** a manager scoped to zero pods sees an empty Team page and an empty audit log, with no
error — easy to mistake for a bug right after inviting a new manager. Check the Pods checkbox row
in Settings → Team as soon as you invite one.

## 2. Onboarding & offboarding

**What it's for:** getting a new hire signed in and dialing, and cleanly winding one down.

**Who:** inviting/resending/offboarding is owner/admin only (an admin needs the owner's help to
act on another admin). The onboarding checklist is owner/admin/manager, pod-scoped for a manager.

**Where:** Settings → Team → **Invite members** (invite/resend); a member row's **Disable**/
**Remove** buttons (offboard); Team page → Overview → **Onboarding checklist** panel.

**Steps to invite:**

1. Settings → Team → **Invite members**, pick a role (Admin/Manager/Agent).
2. Copy the generated link and send it yourself — there's no email delivery built (see
   [inviting-and-assigning-interns.md](inviting-and-assigning-interns.md)).
3. If the link expires before they use it, find them in the roster (expired invites stay listed,
   they used to disappear) and click **Resend**.

**Onboarding checklist**: four items per agent, derived from real activity rather than a tracked
flag — pre-flight passed (ever started a dial session), a number assigned, a campaign assigned,
first real call made. There's no literal "first activity" timestamp anywhere in the app (§7) —
this is the closest real substitute.

**Steps to offboard:**

1. Settings → Team → the member's row → **Disable** (reversible, seat stays) or **Remove**
   (soft-delete, 72h restore window).
2. The wizard previews the blast radius first — queued leads and pending callbacks this member
   currently holds.
3. Confirm.

**What the cascade does automatically:** halts new-batch dialing for them, releases their phone
number(s) back to the org pool, releases their queued leads back to the pool (unassigned, not
handed to anyone), and immediately reopens any shared-inbox items they had claimed (rather than
waiting on the 5-minute sweep, §8).

**Gotcha:** pending/future **callbacks** are NOT auto-reassigned on offboarding — you'll need to
manually reassign those from Campaigns yourself; that step is still deferred.

## 3. Distributing leads

**What it's for:** getting queued leads onto the right agent's list, three ways that stack in a
fixed order.

**Who:** owner/admin always; manager for a target agent/pod within their own scope.

**Where:** Campaigns → \[campaign\] → Manage → **Assign leads** / **Territory rules** / the
distribution-mode dropdown.

**How they interact:** territory rules run first for any newly-added lead; whatever's left
unmatched falls to round-robin (if that mode is on); manual assignment can be used any time on
top of either, and always wins for the lead it touches.

**Manual assignment (steps):**

1. Manage → **Assign leads**.
2. Pick a target agent and a filter — all queued leads, a position range, a percentage, or a GHL
   tag.
3. Submit. If any matched leads are currently assigned to someone _else_, you get a warning ("N
   of these leads are currently assigned to other agents and will be reassigned") first — a
   second click confirms.

That warning count is computed server-side (`count_reassign_impact`), sharing the exact same
candidate logic the real assignment uses, so it can never disagree with what actually happens —
and it fails open: if the count itself can't be computed, the assignment still goes through
without a warning rather than blocking you.

**Territory rules (steps), off by default per campaign (no rules = no effect):**

1. Manage → **Territory rules**.
2. Add a rule: match by contact state and/or area code, route to a specific agent or pod.
3. If a rule has BOTH fields set, a lead must match BOTH to qualify (AND, not OR) — state=TX +
   area code=512 only catches 512 leads in Texas, not every Texas lead. One field set treats the
   other as "don't care."
4. Apply — a one-time sweep over currently-unassigned queued leads (round-robin, below, also
   calls this same resolver automatically for every future new lead).

**Round-robin (steps), off by default (starts as "Manual distribution"):**

1. Manage → the distribution-mode dropdown → **Round-robin distribution**.
2. Every new lead added from now on auto-routes: territory rules get first shot, round-robin picks
   up whatever's left, rotating across the campaign's active agents from wherever it last stopped.
3. **Rebalance now** re-runs the rotation over every currently-unassigned queued lead on demand —
   it never touches an already-assigned lead.

**Gotcha:** none of these three paths override DNC or the one-active-session-per-agent limit —
they only ever change who a lead is assigned to, never whether it's callable at all.

## 4. Live supervision

**What it's for:** watching the floor in real time and stepping in when needed.

**Who:** the live board and every action below are owner/admin/manager, manager pod-scoped.
Raising a hand is an agent's own action.

**Where:** Team page → Overview → the live board (top section); Call takeover's on/off switch is
Settings → Team → **Call takeover**.

**The live board**, polling every 5 seconds: each agent's status (offline/ready/dialing/on_call/
wrap_up/paused), current lines, who they're on with, pause reason, campaign, pod — filterable by
status/campaign/pod, sortable, with a raised-hand indicator per row.

**Raise hand** (agent side): Dialer page, hotkey `R` or a button, flags they need help without
interrupting the call. Clears automatically the moment a manager starts coaching them (or the
agent clears it themselves).

**Listen / Whisper / Barge (steps):**

1. Live board → an agent's row → **Listen**, **Whisper**, or **Barge**.
2. Listen hears both sides silently; Whisper lets you talk to the agent only; Barge puts you into
   the call with both sides.
3. Switch modes mid-session without leaving and rejoining.
4. To end, just hang up your own leg — there's no separate "end coaching" button.

**Call takeover, off by default:**

1. Settings → Team → **Call takeover** → enable (owner/admin only to flip this switch).
2. Once on, any owner/admin/manager already listening/whispering/barging (pod-scoped for a
   manager) can take a call over completely — the agent's own leg drops and the supervisor becomes
   the only agent-side party on the line.
3. The agent rejoins normally the next time they go Ready — nothing else about their session is
   disrupted.

**Remote pause / hang up / end session:** row actions on the live board. Pause stops an agent's
dialer mid-session with a reason shown to them; hang up drops their current live call; end session
stops it outright — if a call is actually in progress, ending defers until that call's disposition
is saved rather than cutting it off instantly.

## 5. Coaching & quality

**What it's for:** reviewing past calls and catching disposition problems automatically.

**Who:** Recordings is every role (server-scoped — an agent sees only their own calls, a manager
only their pod's). Disposition quality checks are owner/admin to configure.

**Where:** **Recordings** (top-level nav); Settings → **Dispositions** for the quality-check rules.

**Recordings review (steps):**

1. Open **Recordings**, optionally filter to **Flagged only**.
2. Open a call to see its details, leave timestamped comments, flag it for review, or fill out a
   scorecard against your org's rubric.

**Disposition quality checks, off by default at the org level:**

1. Settings → Dispositions → enable org-wide checks.
2. Configure per-disposition rules: a minimum required talk time before that disposition is
   allowed, a required field (notes and/or a callback time), or a rate-outlier check (an agent
   using one disposition far more than the team average — computed on read, not stored).
3. A failed rule NEVER blocks the disposition itself — it only writes a flag for later review.

**Flags queue:** shows up per-call in Recordings, plus a small open-flag count badge next to an
agent's name on the Team page's daily table. Mark a flag **Reviewed OK** or **Coached** once
handled.

## 6. Goals, broadcasts, leaderboards

**What it's for:** setting daily targets, posting team messages, and seeing who's producing —
corrected for how many lines someone's dialing.

**Who:** setting goals/broadcasts is owner/admin any scope, manager their own pods; every member
sees their own effective goal and the leaderboard within their visibility (owner/admin org-wide,
manager pod-scoped, agent themselves).

**Where:** Team page → Overview, top panels.

**Goals:** a daily numeric target per metric, settable at the org level, per pod, or per agent —
most specific wins. No on/off switch; a goal simply has no effect anywhere until someone sets one.

**Broadcasts:** a short message posted org-wide or to one pod, with an expiry. Agents see it on
their own Dialer page until it expires or they dismiss it (dismissal is per-viewer — dismissing
doesn't hide it for anyone else).

**Leaderboard / daily table:** per-agent dials, connects, conversations, wins, callbacks set, talk
time, dialing hours, and two normalized fairness columns side by side — **Fairness**
(conversations per 100 dials) and **Per line-hr** (conversations per line-hour, i.e.
`lines × dialing hours`, so an agent dialing 5 lines isn't unfairly favored over one dialing 2 for
the same output). Both render "—" below a small floor rather than a misleading spike right after
Go Ready. Sortable, with CSV export.

**Power hours (steps):**

1. Team page → Overview → **Power hours** → create (owner/admin any scope, manager their own
   pods) — pick a metric (conversations, connects, or appointments), a scope (org or one pod), a
   time window.
2. A ranked board shows live progress to whoever's in scope.
3. A compact banner on the Dialer page shows every power hour currently running that the viewer is
   in scope for (not just the first, if more than one overlaps), including the viewer's own rank
   even when they're outside the visible top 3.

## 7. Schedules & attendance

**What it's for:** knowing an agent's expected working hours and how they actually spent their
day.

**Who:** setting a schedule is owner/admin any active member, manager their own pod's agents,
agent never. Viewing Attendance is the same manager-pod-scope/owner-admin split.

**Where:** Team page → Overview → **Schedules** panel; Team page → **Attendance** toggle.

**Schedules (steps):**

1. Team page → Overview → Schedules panel → pick an agent and a weekday.
2. Set one or more shifts in that agent's own timezone (or the org's default, if they have no
   override) — shifts survive daylight saving unchanged because they're wall-clock time, not a
   fixed UTC offset. A shift can cross midnight (e.g. 22:00–06:00).
3. Used to flag an agent dialing outside their own configured schedule.

**Attendance:** Team page → **Attendance** toggle → per agent per day: time dialing, on a call, in
wrap-up, and paused (broken down by reason), plus a productive-time percentage, over a date range,
with CSV export.

**Gotcha:** there is **no literal "first activity of the day" clock time** anywhere in this app —
deliberately not built, rather than faked with an approximation. The onboarding checklist (§2) and
Attendance's own time-in-state numbers are the closest real substitutes.

## 8. Shared callback inbox

**What it's for:** a pool of missed/voicemail calls any eligible agent can claim and work, for
numbers that don't belong to one specific agent.

**Who:** enabling it and setting the claim-stale window is owner/admin only. Once on, every member
can use the Inbox itself (server-scoped — an agent sees only items routed to them or genuinely
unclaimed/shared ones).

**Where:** Settings → Team → **Shared inbox** (the toggle + stale-minutes setting); **Inbox**
top-level nav (the working view).

**How to turn it on, off by default:**

1. Settings → Team → **Shared inbox** → enable.
2. Set the claim-stale window in minutes (default 30 when never customized).
3. The **Inbox** nav item now shows missed/voicemail items to every eligible member.

**Working an item (steps):** claim it, work it, then mark it done or dismiss it — each one click.
Unclaim to release it back if you can't get to it.

**Claim expiry:** a claim left untouched past the org's own stale window reopens automatically. It
used to only reopen the next time _anyone_ opened the Inbox — an org where nobody checked it could
keep a claim marked forever. A background sweep now also reopens stale claims across every org
every 5 minutes regardless, on top of the on-open check. This
changes nothing about what counts as "stale," only how promptly it's caught when nobody's looking.

## 9. Contact collaboration

**What it's for:** a shared record of what the team knows about a contact, and history of what
changed.

**Who:** owner/admin always; an agent for contacts they're assigned; a manager read-only for
contacts one of their pod's agents is working. Script history is owner/admin/manager.

**Where:** open any contact → **Notes** / **History** tabs; Campaigns → \[campaign\] → Manage →
the script/objection-sheet editor's own history panel.

**Notes (steps):**

1. Open a contact → **Notes**.
2. Post a note; type `@` to mention a teammate — mentioning someone who isn't an active org member
   is silently dropped, not an error, so a stale suggestion never blocks saving.
3. The older single overwritable "legacy note" field still exists and still shows pinned at the
   top, separate from this threaded log.

**Change history:** same contact → **History** tab — a log of what changed on this contact and
when.

**Script version history (steps):**

1. Campaigns → \[campaign\] → Manage → open the script or objection-sheet editor.
2. Its own history panel lists every prior edit.
3. Restore any prior version.

**Gotcha:** only the call script and objection-sheet text are versioned — nothing else about a
campaign has edit history this way.

## 10. Admin safety

**What it's for:** knowing who did what, and catching a silent background failure.

**Who:** the audit log is owner/admin (full org) or manager (their own scope only). System health
is owner/admin only. The lock-out guard applies to everyone, always.

**Where:** Settings → **Activity**.

**Audit log (steps):**

1. Settings → Activity.
2. Filter by actor, action, or date range.
3. Export to CSV (owner/admin only).

Every team-management write — role changes, invites, removals, reassignments, coaching starts,
remote pause/stop, settings changes, exports — is logged here. A manager sees only rows where they
or one of their own pod's agents is the actor or the target — an approximation, not a precise
per-action scope, since not every logged action is member-shaped.

**System health**, same Activity page, owner/admin only (a manager sees the Activity page but not
this panel): visibility into 3 background guards designed to never block the write they're
attached to (disposition quality checks, round-robin distribution, the shared inbox's missed-call
handler) — if one fails internally, the disposition/assignment/inbox item still saves correctly,
but the background step itself silently no-ops. Failures from the last 7 days show up with a
count, source, error, and an acknowledge action, capped at 100 logged failures per org per day.

**Admin lock-out guard:** not a setting — built into every role/status change. Nobody can demote,
disable, or remove the last remaining active owner/admin from an org, and only the owner (not
another admin) can change, disable, or remove a _different_ admin. Enforced server-side, so it
holds even against a direct API call, not just what the UI shows.
