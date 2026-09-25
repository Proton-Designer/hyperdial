# Launch live test

One ordered runbook covering everything every reviewer this run flagged as
"cannot be proven without a real account" — Telnyx, WebRTC, a real browser, a
real second phone. The lead runs this with the user: the user plays the
intern in a browser with a mic; the lead has Management API / dashboard
access to check the database, applies the pending migrations/functions, and
does the one Vercel deploy this test needs partway through (step A1b).

Do the steps in order — several later checks assume state a numbered step
left behind (the DNC contact, the voicemail-only number, the second browser
tab). Each row has an expected result and a pass/fail box; check evidence to
capture at the end of each group, not just at the end of the whole run.

**Supersedes** `parallel-dialer-checklist.md` (that file now just points
here — it described the old Redis/`BATCH_FIRING` engine, which no longer
exists).

---

## A. Setup

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Expected                                                                                                                     | ☐   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --- |
| A1  | On the **currently deployed site** (the old build — not yet redeployed), sign up for the owner account ("MyHomeBase") at the app's normal sign-in screen. **Do this before A1b.** Self-signup only works pre-deploy: commit `b276470` removes the signup form from the frontend entirely, and TASK-L4's invite-only trigger (`20260925000300_invite_only_signup.sql`) is committed but deliberately **held** specifically so this step can still happen first. | Account created, lands on Dashboard as `owner`.                                                                              | ☐   |
| A1b | The lead now applies every pending migration (including `20260925000300`) and function, then does a fresh Vercel deploy of the current branch. **The rest of this runbook (A2 onward) happens on this newly deployed site** — it's the one with the L1/L7/L2b/L1r4/L5 UI this whole test exists to exercise; the old build never had it.                                                                                                                       | Deploy succeeds; loading the app now shows the new UI (Dialer's own "Start a session" panel, no old dial screen).            | ☐   |
| A1c | Confirm invite-only actually took: try to sign up with no invite token (no "create account" link should even be visible; navigating to the old signup URL directly is rejected). Then sign back in as the A1 owner.                                                                                                                                                                                                                                            | No new account can be created without an invite. The A1 owner still signs in fine, still sees all 6 tabs.                    | ☐   |
| A2  | Settings → Integrations → connect a real Telnyx API key.                                                                                                                                                                                                                                                                                                                                                                                                       | Shows connected; no error. Key is stored in Vault, never visible again in plaintext.                                         | ☐   |
| A3  | Settings → Numbers → search and buy one real number.                                                                                                                                                                                                                                                                                                                                                                                                           | Number appears in the org's number list.                                                                                     | ☐   |
| A4  | Create a campaign, set its **Caller ID Number** to the number from A3, and add 3–5 leads: **include the tester's own real phone number** (this is what answers the live call) **and one known voicemail-only number** (to exercise AMD).                                                                                                                                                                                                                       | Campaign shows the right contact count; the caller-ID dropdown lists the org's number.                                       | ☐   |
| A5  | Settings → Team → Invite, role **Agent**. Send the intern the link yourself (email delivery isn't built — see `docs/guides/inviting-and-assigning-interns.md`). Open the link in a **second, separate browser profile or incognito window** (this second identity is reused for the whole rest of the test — call it "the intern browser"). Accept the invite, set a password.                                                                                 | Intern signs in, lands on Dashboard. Sidebar shows only **Dashboard / Dialer / Contacts** — no Campaigns/Analytics/Settings. | ☐   |
| A5b | Manage modal on the campaign from A4 → **Assigned Agents** → check the intern → Save.                                                                                                                                                                                                                                                                                                                                                                          | Intern's Dialer now lists this campaign in its "Start a session" panel.                                                      | ☐   |

Evidence: a screenshot of the intern's sidebar (proves the role gate), the
campaign's contact list (proves the DNC/voicemail contacts are in it).

---

## B. Live dial-loop checks (do these as the intern, in the intern browser)

### B1 — Starting a session (TASK-L1, L1r4, L7)

| #    | Step                                                                                                                                                                                                                                    | Expected                                                                                                                                                                                                                                                                                                     | ☐   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| B1.1 | Dialer tab → pick the campaign from A4 → **Start**. Allow the mic prompt.                                                                                                                                                               | "Connecting your line…" then goes quiet (registered) within a couple seconds. If it errors instead, that's `getWebrtcCredentials`/`telnyx-webrtc-credentials`, not the dial loop itself.                                                                                                                     | ☐   |
| B1.2 | Immediately after B1.1.                                                                                                                                                                                                                 | The intern's browser **rings with no click required** (auto-answer) within about 1 second — this is the one thing no fake-client test can prove. If the browser never rings at all even after several seconds, see the **sip_uri_calling_preference** note at the bottom before assuming the loop is broken. | ☐   |
| B1.3 | Once the agent leg is answered.                                                                                                                                                                                                         | Banner reads **"Ringing N lines"**; contacts in the campaign (including the tester's own number) start ringing.                                                                                                                                                                                              | ☐   |
| B1.4 | Try starting a **second** session for the same intern in a second tab/campaign.                                                                                                                                                         | 409 — "You already have an active dialer session" (SEC-8: exactly one session per agent, not per campaign).                                                                                                                                                                                                  | ☐   |
| B1.5 | As an owner/admin, try starting a session on a campaign the intern is **not** assigned to, using the intern's own account/token (or just confirm from the app that the intern's Dialer list never shows an unassigned campaign at all). | 403 `NOT_ASSIGNED_TO_CAMPAIGN` if attempted directly; the Dialer's own list never offers the campaign either way (TASK-L1r4 M1).                                                                                                                                                                             | ☐   |

### B2 — The call itself (TASK-L1, L2b, UI-8)

| #    | Step                                                                                    | Expected                                                                                                                                                                                                                                  | ☐   |
| ---- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B2.1 | Let the tester's own phone (the real contact in the batch) answer.                      | Three-way audio: agent hears the customer, customer hears the agent — not silence. Banner reads **"Connected — \<name\> \<timer\>"**, and `LiveCallPanel`'s own timer agrees with the banner's (both derive from the same `answered_at`). | ☐   |
| B2.2 | At the moment of connect.                                                               | A short two-tone chime plays (UI-8) — confirms the browser's autoplay policy is satisfied in practice (the user already interacted with the page via Start).                                                                              | ☐   |
| B2.3 | Let the voicemail-only number get dialed in the same or a later batch.                  | AMD marks it `voicemail`; it does **not** get bridged to the agent.                                                                                                                                                                       | ☐   |
| B2.4 | End the live call (End Call button, or let the customer hang up).                       | Session moves to **`wrap_up`**; **WrapUpModal opens automatically, with no "Continue" bypass** — Stop is the only other button that still works.                                                                                          | ☐   |
| B2.5 | In the wrap-up modal, press a digit key (1–9) to pick a disposition, then Enter.        | Disposition submits; session returns to **`dialing`**; the modal closes.                                                                                                                                                                  | ☐   |
| B2.6 | Refresh the page while a wrap-up modal is showing (before submitting), on a later call. | The same modal re-opens automatically after the refresh, for the same call.                                                                                                                                                               | ☐   |

### B3 — Pause / Resume / Stop / Reconnect (TASK-L1, L2b, L1r4)

| #    | Step                                                                                                | Expected                                                                                                                                                                                                                             | ☐   |
| ---- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| B3.1 | Click **Pause** while `dialing`.                                                                    | Banner reads **"Paused"** with a Resume button; no new lines dial.                                                                                                                                                                   | ☐   |
| B3.2 | Click **Resume**.                                                                                   | Session returns to `dialing`.                                                                                                                                                                                                        | ☐   |
| B3.3 | Mid-call, close the intern's browser tab (or revoke mic permission) to force the agent leg to drop. | The **customer stays connected** (does not hear silence-then-hangup from the agent's own side dropping) — banner shows **"Agent audio lost — Reconnect"**. Auto-reconnect fires **exactly once** — confirm no repeated error toasts. | ☐   |
| B3.4 | Click **Reconnect** (or wait for the one automatic attempt from B3.3).                              | Browser rings again, auto-answers, audio resumes on the **same** call, not a new one.                                                                                                                                                | ☐   |
| B3.5 | Click **Stop** at any point (mid-call, mid-wrap-up, whenever).                                      | Session ends; active legs are hung up; back to the "Start a session" panel.                                                                                                                                                          | ☐   |

### B4 — Tab switch and single-tab lock (TASK-L1r4, now required)

| #    | Step                                                                                                                                                  | Expected                                                                                                            | ☐   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --- |
| B4.1 | Start a session, then while a call is live, **switch to the Contacts tab** in the same browser, wait a few seconds, then switch back to Dialer.       | The call is **not** dropped — the agent's line survives the tab switch (the Dialer stays mounted, only CSS-hidden). | ☐   |
| B4.2 | Open the app in a **second tab** of the same browser (same profile, so it shares the intern's session) while a dialer session is active in the first. | The second tab shows **"HyperDial is open in another tab"** and does not ring or register a line.                   | ☐   |
| B4.3 | Close the first (owning) tab.                                                                                                                         | The second tab takes over ownership within a couple seconds (no need to refresh).                                   | ☐   |

### B5 — DNC and one-active-campaign (TASK-L3)

| #    | Step                                                                                                     | Expected                                                                                                                               | ☐   |
| ---- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B5.1 | As owner/admin, mark one contact in the campaign **DNC** (Contacts → contact detail → DNC toggle).       | Contact shows DNC.                                                                                                                     | ☐   |
| B5.2 | Start (or restart) a dialer session covering that contact.                                               | The DNC contact is **never dialed**.                                                                                                   | ☐   |
| B5.3 | Try adding the SAME contact from A4 (already active in campaign A) to a **second** campaign's lead list. | It's skipped with a visible "skipped — already active elsewhere" count, not silently dropped and not a hard error for the whole batch. | ☐   |

### B6 — Stop-and-restart confirmation (TASK-L5)

| #    | Step                                                                                                                                                        | Expected                                                                                                                                                                               | ☐   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B6.1 | As owner/admin, while the intern's session has a **live, connected** call, open Campaign Manage → try to stop and start a new session on the same campaign. | A confirmation dialog names the contact and warns a live call is in progress; Cancel is the default focus. Confirming actually stops it; cancelling leaves the call running untouched. | ☐   |

### B7 — Invite-only signup (TASK-L4)

Already verified at **A1c**, before the rest of this runbook even started — not repeated here.
The one thing worth re-checking now that an intern account genuinely exists (A5): sign in again
as that intern and confirm the sidebar still correctly shows only Dashboard/Dialer/Contacts —
unaffected by the trigger change, which only gates signup, not nav.

### B8 — Sweeper lost-webhook reap (TASK-L6) — **lead-driven, optional, not part of the user session**

| #    | Step                                                                                                                                                                                                                                                                                                                                    | Expected                                                                                                                                                                                                              | ☐   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B8.1 | The lead only (no need to involve the user/intern for this one): during or shortly after any live call above, pick a `claimed` `call_legs` row via the Management API/dashboard and directly hangup that call at the Telnyx side (or otherwise cause its `call.hangup` webhook to never arrive) rather than through the normal UI flow. | Within ~30s (the sweeper's own cron interval), `dialer-sweeper` reaps the leg via a direct Telnyx `GET /calls/{id}` status check — the leg ends, the session reaches `wrap_up`, without ever seeing the real webhook. | ☐   |

There's no reliable way to force a genuinely lost webhook from the UI side, so this check is a
best-effort, lead-only probe of the safety net — not a launch blocker if skipped. See
`.brain/domains/dialer.md`'s own dialer-sweeper section for exactly what it reconciles.

### B9 — Queue v2 retry rules / time blocks / org-wide DNC (TASK-F-T1)

| #    | Step                                                                                                                                                                                                                  | Expected                                                                                                                                                                   | ☐   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B9.1 | As owner/admin, Settings → Do-not-call list → add a number NOT already a contact in this org.                                                                                                                         | The number appears in the list with source "manual."                                                                                                                       | ☐   |
| B9.2 | Add that same number as a contact and queue it onto the campaign (CSV import or "Add existing contact").                                                                                                              | The import/queue response reports it skipped (`skippedDnc` count increments), and it is never dialed if a session starts.                                                  | ☐   |
| B9.3 | Campaign Manage → Retry Rules card loads with the seeded defaults (no_answer/voicemail = Retry, 4 days, Rotate time block checked; callback = Exact time; the rest = Out). Edit one delay and Save, reload the modal. | The edited value persists.                                                                                                                                                 | ☐   |
| B9.4 | Let (or force, via a real short call) a contact hit `no_answer` on this campaign. Check `call_legs.time_block` and the lead's new `next_attempt_at`/status.                                                           | `time_block` is set to the block the call landed in; on retry, the lead's `next_attempt_at` lands ~4 days out in a **different** time block, status stays `queued`.        | ☐   |
| B9.5 | Drive a lead's attempts to `max_attempts` via repeated `no_answer`s.                                                                                                                                                  | Lead status becomes `exhausted`; if the org has a connected GHL integration, a `nurture_tag` job appears in `crm_sync_jobs` and the GHL contact gets tagged `nurture`.     | ☐   |
| B9.6 | During a multi-line session, cause a losing leg (another line wins first — AMD off, more than one line dialing the same batch).                                                                                       | The losing lead's `attempts` is unchanged, `next_attempt_at` is ~now, and it's the next lead claimed on that session (front of the queue), not a same-attempts fresh lead. | ☐   |

The lead runs `audit/FT1/dryrun.sql` against a rolled-back live transaction for the parts of this
that are impractical to force through the UI (exhaustion timing, exact block rotation, RLS). B9
above covers what a real click-through can actually exercise.

### B10 — Call recording (TASK-F-T2) — **needs a real Telnyx call**

| #     | Step                                                                                                                                        | Expected                                                                                                                                                             | ☐   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B10.1 | Settings → Telephony → confirm "Record calls" is checked (default). As an agent, make and answer a real call that connects for 15+ seconds. | The call proceeds normally — no delay, no error, recording never visible to the agent mid-call.                                                                      | ☐   |
| B10.2 | Within a minute or two of hanging up, open the wrap-up modal (or reopen it if already dispositioned) for that leg.                          | An inline audio player appears with the actual call audio playable. If opened immediately, "Recording processing…" shows first, then the player a few seconds later. | ☐   |
| B10.3 | Check the `recordings` bucket (Supabase Studio → Storage) for the object at `{org_id}/{call_leg_id}.mp3`.                                   | The object exists, private, non-empty, playable.                                                                                                                     | ☐   |
| B10.4 | If the org has a connected GHL integration, check the GHL contact's note for this disposition.                                              | The note includes a `https://hyperdial.myhomebasesolutions.com/contacts?leg=<id>` link (not a raw signed URL).                                                       | ☐   |
| B10.5 | As a different agent (or owner/admin from a different browser/session), try calling `recording-url` for this same `callLegId`.              | Owner/admin: succeeds. A different agent (not this session's own agent): 404.                                                                                        | ☐   |
| B10.6 | Owner/admin: Settings → Telephony → uncheck "Record calls." Make and answer another real call.                                              | No recording appears for this new call; `call_legs.recording_status` stays null for it. Re-check the box afterward to restore the default.                           | ☐   |

The lead runs `audit/FT2/dryrun-tests.sql` against a rolled-back live transaction for the bucket/
columns/RLS/retention-scaffolding parts (nothing here needs a real Telnyx call to verify). B10
above covers only what genuinely needs a real recorded call — retention (90-day deletion) is not
practically checkable live within a single session and is covered by `_shared/recording-core.
test.ts`'s `isPastRetention` unit tests instead.

### B11 — Voicemail drop + real AMD modes (TASK-F-T3) — **needs a real Telnyx call to a voicemail box**

| #     | Step                                                                                                                                                                 | Expected                                                                                                                                                                                                                     | ☐   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B11.1 | Settings → Voicemail drop: upload a short mp3 or wav for your own user, wait for the preview player, then play it back.                                              | Upload succeeds, a signed preview URL loads and plays the uploaded audio.                                                                                                                                                    | ☐   |
| B11.2 | As owner/admin, Settings → Voicemail drop → org default: upload a different file.                                                                                    | Org-default preview updates independently of the per-user file from B11.1; a non-admin agent can still hear the org default if they have no personal file set.                                                               | ☐   |
| B11.3 | Campaign Manage → set AMD mode to **`detect_words`** (or `premium`) and Voicemail drop mode to **`every_attempt`**. Add the known voicemail-only number and dial it. | The AMD result is `machine`; the engine waits for `call.machine.greeting.ended` (or the premium greeting-ended), plays the uploaded voicemail, then hangs up on `call.playback.ended`.                                       | ☐   |
| B11.4 | Check that leg's `call_legs.outcome` after the call above.                                                                                                           | `voicemail_left`, not `machine` — and it counted as an attempt on the lead (`campaign_leads.attempts` incremented).                                                                                                          | ☐   |
| B11.5 | If the org has a connected GHL integration, check the contact's tags after B11.3/B11.4.                                                                              | A `call:voicemail-<n>` tag appears, where `<n>` matches the contact's voicemail-left count so far (1 on the first drop).                                                                                                     | ☐   |
| B11.6 | Repeat B11.3 with AMD mode set to plain **`detect`** (not `detect_words`/`premium`).                                                                                 | No voicemail is played — Telnyx never sends `call.machine.greeting.ended` for plain `detect`, so the leg hangs up plainly with outcome `machine`, matching the vendor constraint documented in `.brain/memory/decisions.md`. | ☐   |
| B11.7 | During a multi-line session, confirm a VM-drop leg from B11.3 does not delay the next batch firing.                                                                  | The next batch of lines dials immediately once the batch's other legs resolve — it does not wait for the voicemail-dropping leg to finish playing/hanging up (VMD-5).                                                        | ☐   |

The lead runs `audit/FT3/dryrun-tests.sql` against a rolled-back live transaction for the
migration/RLS/pacing-exclusion/sweeper-timeout parts (nothing here needs a real Telnyx call to
verify). B11 above covers only what genuinely needs a real AMD-detected call to a voicemail box —
the ~90s sweeper reap for a stuck `voicemail_dropping` leg is covered by the dry-run and by
`dialer-engine.test.ts`'s own timeout tests instead, the same way B8 covers the general sweeper
reap without forcing a live lost webhook.

### B12 — Safety fixes: confirm-before-Stop + ring timeout / max call length (TASK-S1) — no migration, code-only

| #     | Step                                                                                                                                                         | Expected                                                                                                                                                                        | ☐   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B12.1 | Start a session, let a contact answer and bridge (on_call), then click **Stop session**.                                                                     | A confirm dialog appears: "A prospect is on the line. Stop the session and hang up on them?" with "Keep calling" (default-focused) and "Hang up and stop".                      | ☐   |
| B12.2 | Click **Keep calling**.                                                                                                                                      | The dialog closes, the call and session are completely unaffected — still `on_call`, still bridged.                                                                             | ☐   |
| B12.3 | Click **Stop session** again, then **Hang up and stop**.                                                                                                     | The live call ends, the session moves to `stopped`. Same as clicking Stop today outside `on_call` (B12.4) — no second confirmation.                                             | ☐   |
| B12.4 | With no contact bridged (`dialing`/`ready`/`paused`/etc.), click **Stop session**.                                                                           | Stops immediately, no confirm dialog — matches existing behavior exactly.                                                                                                       | ☐   |
| B12.5 | Let a dialed contact's phone simply not pick up (no voicemail, no reject) for the full ring window.                                                          | The leg hangs up on its own after ~25s (`timeout_secs`) with outcome `no_answer` — it does not ring indefinitely.                                                               | ☐   |
| B12.6 | Go Ready and leave the WebRTC tab foregrounded but don't click Accept if a manual test call is placed to your own agent leg (lab-only; skip if impractical). | The agent leg's own ring window is noticeably longer than a contact's (~45s) before it gives up — confirms `AGENT_DIAL_TIMEOUT_SECS` is actually applied, not just unit-tested. | ☐   |

BUG-8's max-call-length (30 min contact / 4h agent leg) and BUG-11's exact confirm-dialog copy/focus
behavior are both exercised end-to-end in `dialer-engine.test.ts` (`stopSession` refuses without
`force` when a leg is `claimed`, and the real dial payload's `timeout_secs`/`time_limit_secs` are
asserted for both leg kinds) and via a screenshot of the confirm dialog through the
`?dev_dialer_states=1` harness (`on_call` state) — B12 above only covers what a real click-through/
real call can add on top of that: the actual UI gate under a live human, and the ring timeout
actually firing against a real unanswered number. Forcing a real 4-hour agent-leg time-limit
hangup or a real 30-minute contact time-limit hangup live is impractical within a test session and
is not part of this checklist; both are unit-tested (`dialer-core.ts`'s `hangupOutcome` for
`hangup_cause: 'time_limit'`) instead.

### B13 — Contacts tagged do-not-call/paused in GHL are never queued or dialed (TASK-G7, GHL-7)

Requires a connected GHL sub-account (Settings → Integrations) and a GHL contact you can freely
tag for this test — do not use a real MyHomeBase contact.

| #     | Step                                                                                                                                                                  | Expected                                                                                                                                                                                      | ☐   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B13.1 | Settings → Integrations → GHL, scroll to "Blocked tags". Confirm the two lists' starting values.                                                                      | Do-not-call: `do not call`, `dnc`, `do-not-call`. Paused: `paused`, `pause` — the built-in defaults, since this org hasn't customized them yet.                                               | ☐   |
| B13.2 | Add a custom tag to each list (e.g. `blacklisted` / `hold`) and click Save changes.                                                                                   | Button shows "Saved"; reloading Settings shows the new tag still present in both lists.                                                                                                       | ☐   |
| B13.3 | In GHL, tag a test contact with `dnc` (a default tag). Contacts → Import from GHL → By tag → `dnc` → Import (no campaign).                                            | Result shows 1 created (or updated) and "1 marked do-not-call from GHL tags". The contact appears in Contacts with its DNC flag set.                                                          | ☐   |
| B13.4 | Settings → Do-not-call list.                                                                                                                                          | The contact's E.164 number is on the list, source `import`, note `GHL tag: dnc` (or whatever the real tag's casing was in GHL).                                                               | ☐   |
| B13.5 | Import that same contact again with a campaign selected this time.                                                                                                    | The contact is **not** added to the campaign's lead list — result shows it under "skipped (do-not-call)".                                                                                     | ☐   |
| B13.6 | In GHL, tag a second test contact with `paused` and import it (by tag `paused`) onto a real campaign.                                                                 | Result shows 1 "paused" from GHL tags; the contact is **not** in that campaign's lead list (skipped as paused).                                                                               | ☐   |
| B13.7 | Manually queue that same contact onto the campaign in-app (Campaign → Manage → Add to campaign), then re-run the Import from GHL for the `paused` tag (same contact). | The contact's `campaign_leads` row for that campaign flips to a non-dialable `paused` status — it does not get dialed by that campaign's session even though it's still listed there.         | ☐   |
| B13.8 | In GHL, remove the `paused` tag from that contact, then re-import (search mode, contact's name, no campaign) works too.                                               | Result shows "1 no longer paused in GHL" — the campaign_leads row from B13.7 stays `paused` (re-queueing is manual, not automatic); the note in the UI says to find and re-queue it yourself. | ☐   |
| B13.9 | Non-owner/admin (an agent account) opens Settings → Integrations.                                                                                                     | The "Blocked tags" panel is visible read-only (chips, no Add/remove controls, no Save button) — matches the existing owner/admin-only pattern for the rest of this tab.                       | ☐   |

The tag-matching/skip/queue logic itself is fully covered by `ghl-import.test.ts`'s deno tests
(default lists, custom lists, case/whitespace normalization, the `dnc_numbers` note text, and the
unpaused-count detection) — B13 above only covers what a real GHL round trip and real DB state can
add on top of that: the Settings editor actually persisting, and the retroactive `campaign_leads`
status change actually happening against a live campaign.

### B14 — Caller-ID number pool: daily caps, rest days, manager assignment (TASK-N1, CID-1/CID-2/ADM-5/CID-5) — **needs a real Telnyx call to exercise the actual dial**

| #     | Step                                                                                                                                                                                                                                                                                                                                                                                                 | Expected                                                                                                                                                                                                                              | ☐   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B14.1 | Settings → Telephony → Phone Numbers. Confirm the org defaults panel shows "Default daily cap" 100 and "Rest days after cap" 2, and every existing number shows real status/cap/dials-today/resting-until (not the old hardcoded "Active" badge).                                                                                                                                                    | Values load from `org_number_pool_settings`/`user_phone_numbers`, not placeholders.                                                                                                                                                   | ☐   |
| B14.2 | Owner/admin: lower the default cap to something small (e.g. 3) and Save. Buy or note a fresh number.                                                                                                                                                                                                                                                                                                 | The new number's own cap column shows 3 — new purchases honor the CURRENT org default, not the schema's 100 default.                                                                                                                  | ☐   |
| B14.3 | Owner/admin: assign a number to a specific intern via the "Assigned to" select.                                                                                                                                                                                                                                                                                                                      | The row updates immediately; reload confirms it persisted. As that intern, Settings still shows nothing (Telephony stays owner/admin-only by design — see decisions.md), but the Dialer idle screen (B14.6) does.                     | ☐   |
| B14.4 | As an agent (not owner/admin), try updating `user_phone_numbers` directly (e.g. via the Supabase dashboard's own SQL editor logged in as that user, or just trust the dry-run's RLS coverage) — this step is a note, not a click-through: ADM-5's negative case is covered by `audit/N1/dryrun-tests.sql`'s RLS assertions, not a UI control (there is no reassign button exposed to agents at all). | N/A — documents why there's no B14.4 UI step to click.                                                                                                                                                                                | ☐   |
| B14.5 | Start a session on a campaign whose agent is assigned a low-cap number (e.g. cap 2) and dial two contacts that actually connect through AMD to a real, distinct outbound leg each.                                                                                                                                                                                                                   | Both dials use the assigned number as caller ID (check `call_legs.from_number_id` via the Supabase dashboard, or Telnyx's own call log for the "from" shown). After the 2nd dial, the number's status flips to `resting` in Settings. | ☐   |
| B14.6 | With that agent's ONLY usable number now resting (and no other pool number assigned/unassigned available, and the campaign has no legacy caller ID set), start or continue a session.                                                                                                                                                                                                                | The session pauses itself with the banner "All your numbers have hit today's dial limit" (not a crash, not silent). The Dialer idle screen shows "Your numbers: 0 active, 1 resting" before starting.                                 | ☐   |
| B14.7 | Add contacts with phone numbers in the same area code as one of the org's pool numbers, and a different area code for another. Dial both (multi-line session, more than one available pool number, none assigned to this agent).                                                                                                                                                                     | The area-code-matching pool number is preferred for the matching contact over an equally-eligible, non-matching pool number (check `from_number_id` per leg).                                                                         | ☐   |

The selection priority order (assigned → pool → legacy fallback, with area-code preference and
fewest-dials as tiebreaks), the cap → resting flip, sequential-call increment safety, and RLS
(ADM-5: an agent cannot reassign a number) are all covered by `audit/N1/dryrun-tests.sql` against a
rolled-back live transaction — B14 above covers only what a real multi-line session with real
Telnyx calls can add on top of that: numbers actually showing up as the real dial's `from`, and the
pause banner actually appearing live. The ~2-day rest period itself is not practically waitable
within a test session; `resting_until` being set correctly is covered by the dry-run instead.

**Known open item (not a bug):** once a pool is exhausted for an agent, a campaign that still has
its own legacy `caller_id_number_id` set keeps dialing from that fixed number rather than pausing —
uncapped, untracked, by design (decisions.md's own TASK-N1 entry). Don't re-report this as "the cap
didn't stop it" unless the campaign has actually cleared its legacy caller ID too.

### B15 — Monthly spend cap + low-balance alert (TASK-SP, SEC-2 + the balance part of SEC-7)

Requires a real, connected BYO Telnyx account (Settings → Telephony) with a real balance. Do not
run B15.4/B15.5 against the real MyHomeBase org's own Telnyx account — use the QA sandbox org's
connection.

| #     | Step                                                                                                                                                                            | Expected                                                                                                                                                                                                                                                                                                                                        | ☐   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B15.1 | Owner/admin: Settings → Telephony, scroll to "Spend & Billing" (only visible once Telnyx is connected).                                                                         | "Current balance" shows a real dollar figure matching the Telnyx dashboard's own balance within the minute (not a placeholder). "Estimated spend this month" shows a number, not an error. Only two inputs — "Monthly spend cap" and "Low-balance alert" — there is no "Minimum to dial" field (TASK-SP2: removed, a low balance never blocks). | ☐   |
| B15.2 | Change "Monthly spend cap" / "Low-balance alert" and tab away.                                                                                                                  | Values persist on reload (`org_spend_settings`). An agent account opening the same tab does not see this card at all (Telephony stays owner/admin-only, same standing invariant as TASK-N1's pool card).                                                                                                                                        | ☐   |
| B15.3 | Owner/admin: set "Low-balance alert" above the QA org's real current balance, then have an intern Go Ready on any campaign.                                                     | Go Ready **succeeds** — the session starts normally (a low balance never blocks dialing, TASK-SP2). A warning toast appears citing the balance and the alert threshold (`LOW_BALANCE`, non-blocking). Reset the alert threshold back down afterward.                                                                                            | ☐   |
| B15.4 | Owner/admin: set "Monthly spend cap" to a value below the current "Estimated spend this month" figure from B15.1.                                                               | Go Ready AND "Purchase a number" (Settings → Telephony → search/purchase) are both refused (`SPEND_CAP_REACHED`), citing the cap and the estimate. This is the ONLY thing that still blocks. Reset the cap afterward (or clear it back to no cap).                                                                                              | ☐   |
| B15.5 | With a session already `dialing`, lower the balance-affecting settings mid-session (or just confirm behavior by reading the code/decisions.md if not safely reproducible live). | The already-running session is **not** killed mid-call — enforcement only runs at Go Ready, not at each refill (documented tradeoff, see decisions.md's TASK-SP entry).                                                                                                                                                                         | ☐   |
| B15.6 | Ask the lead to manually invoke the `spend-alert-check` function once (with the real `X-Cron-Secret`) against an org whose balance is below its alert threshold (default $2).   | A new in-app notification appears for every owner/admin of that org (bell icon, Settings/TopNavigation). Invoking it again within 12h sends no second notification (dedupe).                                                                                                                                                                    | ☐   |

The balance-fetch/gate/alert-dedupe decision logic itself (a low balance never blocking, only
`SPEND_CAP_REACHED` blocking, the non-blocking `LOW_BALANCE` warning, a null cap never blocking,
failing OPEN and silent when Telnyx can't be reached at all, and the 12h alert dedupe window) is
fully covered by deno tests (`spend-estimate.test.ts`, `spend-gate.test.ts`) and the SQL
schema/RLS/grants by `audit/SP/dryrun-tests.sql` — B15 above only covers what a real Telnyx account
and a real live request can add on top of that.

**Known open item (not a bug):** MTD spend is always an ESTIMATE (call minutes × a configurable
per-minute rate + number count × a configurable monthly number price), never a live Telnyx figure —
Telnyx has no cheap, reliable, non-BETA API for it (see decisions.md's TASK-SP entry for the full
citation). Don't re-report a mismatch against Telnyx's own billing dashboard as a bug; tune the
per-minute rate / monthly number price in Settings for a closer estimate instead.

### B16 — Inbound callback routing (TASK-I1, INB-1..4, CID-6) — **needs a real inbound call from a cell phone**

Requires a real, connected BYO Telnyx account with at least one purchased/assigned number
(CID-6 -- confirm via B14 first that the number's own Telnyx-side connection is the org's Call
Control app, not left on the default). Call the org's own number from a personal cell for every
row below; hang up and redial fresh for each one so no prior step's state leaks into the next.

| #     | Step                                                                                                                                                                                                           | Expected                                                                                                                                                                                                                                                                         | ☐   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B16.1 | As the intern assigned that number: open the Dialer tab (idle, no session started) and leave it open. Call the number from your cell.                                                                          | Within ~20s, an "Incoming call" banner appears in the Dialer with your cell's number shown, Answer/Decline buttons. No page refresh needed.                                                                                                                                      | ☐   |
| B16.2 | Click Answer on B16.1's banner.                                                                                                                                                                                | The call connects in-browser (you hear yourself on the cell once you speak). The banner clears. `inbound_calls.outcome` for that call shows `answered_by_agent` (Supabase dashboard or ask the lead to check).                                                                   | ☐   |
| B16.3 | Same setup as B16.1, but click Decline instead (or just let the ~20s ring window elapse without answering).                                                                                                    | The call is NOT dropped -- it continues to the next fallback step. If you set a personal cell forward number (Profile tab), your own cell rings next.                                                                                                                            | ☐   |
| B16.4 | Set a forward number (Profile tab → Call Forwarding) for the assigned intern, then close their Dialer tab entirely (so no WebRTC client is registered) and call the org number.                                | The browser is never rung (nothing registered to ring) -- the call goes straight to the intern's cell after the initial routing. Answering the cell connects the call.                                                                                                           | ☐   |
| B16.5 | Clear that intern's forward number, set an org shared destination number (Settings → Telephony → "Inbound Calls" card, owner/admin only), then repeat B16.4 (still no Dialer tab open, no forward number).     | The call rings the org's shared destination number next (skipping the cleared personal forward step) and connects there when answered.                                                                                                                                           | ☐   |
| B16.6 | Clear the shared destination number too (or let a call go fully unanswered through every step: intern browser declined, no cell, no shared line), and let this call ring out.                                  | The caller hears the org's voicemail greeting (Settings → Telephony → "Inbound Calls" → "Voicemail greeting" text, spoken via TTS), then a beep, then can leave a message. `inbound_calls.outcome` shows `voicemail`, with a `recording_path` once Telnyx finishes uploading it. | ☐   |
| B16.7 | Start a parallel dialing session as the assigned intern (any campaign, `dialing`/`ready`), then call that intern's number from your cell while the batch is actively ringing other contacts.                   | The batch dialing pauses (Pause/Resume banner shows a paused state); your call bridges directly into the intern's existing WebRTC line. The Dialer's contact-card area shows an "Inbound call" flag with your cell number, a live timer, and a working Hang up button.           | ☐   |
| B16.8 | End the call from B16.7 (hang up on your cell, or click the Dialer's Hang up on the inbound card).                                                                                                             | The Dialer session stays paused (does not auto-resume) -- click Resume to continue the batch. `inbound_calls.outcome` shows `answered_by_agent`, `dial_session_id` pointing at that session.                                                                                     | ☐   |
| B16.9 | Ask the lead to confirm a `crm_sync_jobs` row with `kind = 'inbound_call_note'` was enqueued for any of the above calls where the caller's number matched an existing GHL contact, and that it reached `done`. | A note appears on that contact in GHL: "Inbound call from `<number>` — `<outcome>`", with agent name/duration/recording link where applicable.                                                                                                                                   | ☐   |

The full routing decision tree (free/busy/offline/no-forward-number branches, the fallback
chain's ordering, webhook-redelivery idempotency, and every RLS policy including the
`org_members` self-update-scope security fix) is covered by `inbound-engine.test.ts`/
`inbound-core.test.ts` (deno) and `audit/I1/dryrun-tests.sql` (SQL, rolled-back live transaction)
-- B16 above only covers what a real Telnyx call and a real browser can add on top of that.

**Known open items (not bugs, disclosed in RESUME_PLAN-eng2.md/decisions.md):** missed-call
auto-text (INB-5) and voicemail transcription (INB-6) are explicitly out of scope for this task.
A bridged inbound call pauses the session rather than literally reusing the outbound wrap-up
disposition flow -- the agent resumes manually via the existing Resume button, same as any other
pause (see decisions.md's TASK-I1 entry, decision 7).

### B17 -- Manager Team page (TASK-M2, ADM-6/ADM-7)

Needs at least 2 interns (agent role) with a real, active dialing session each -- run this
alongside B14 rather than standing up a session from scratch just for this section.

| #     | Step                                                                                                                                                                                                                                                 | Expected                                                                                                                                                                                                                | ☐   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B17.1 | Owner/admin: open Team (Dashboard sidebar) while both interns have an active session (`ready`/`dialing`/etc.).                                                                                                                                       | The live board shows one card per intern with the real name/email + role chip (Owner/Admin/Agent, not a bare "Agent" for everyone), a status, and non-dash "Calls today"/"Conversations" once either intern has dialed. | ☐   |
| B17.2 | With the board open, have one intern change state (Pause, or let a call bridge and go `on_call`).                                                                                                                                                    | That intern's card updates -- status and "Time in state" -- within about 5 seconds, with no manual refresh (the board polls every 5s).                                                                                  | ☐   |
| B17.3 | After some real dialing from both interns, compare the Daily numbers table's row for one intern (Dials, Connects, Conversations, Wins, Talk time, Dialing hrs) against that SAME intern's own Dashboard numbers and Analytics leaderboard for today. | The figures match across all three screens -- same underlying `call_legs`/`dial_sessions` data, not three different counts.                                                                                             | ☐   |
| B17.4 | Click through the Daily numbers range buttons: Today, Yesterday, Last 7 days, Custom (pick a range spanning today).                                                                                                                                  | Each switch loads cleanly (no console error, no blank table); Yesterday shows zeros if no dialing happened then; Today/Custom(including today) both include the activity from B17.1-B17.3.                              | ☐   |
| B17.5 | Sort the Daily numbers table by a couple of different columns (e.g. Dials, then Talk time).                                                                                                                                                          | Rows reorder correctly; the Total row at the bottom stays pinned and its sums stay correct regardless of sort order.                                                                                                    | ☐   |
| B17.6 | As one of the interns (agent role), try the sidebar (no Team item should exist) and navigate directly to `/team`.                                                                                                                                    | No Team entry anywhere in the agent's nav (desktop sidebar or mobile "More" sheet); the direct `/team` URL redirects to `/dialer`, never rendering the board or table.                                                  | ☐   |

Both RPCs (`team_daily_stats`/`team_live_board`) are `SECURITY DEFINER` but granted straight to
`authenticated` -- each checks the caller's own `has_org_role` itself, so a non-owner/admin caller
gets an empty array back, not an error or someone else's data. This is unit-level covered by the
RPCs' own grants (`anon`/`authenticated`-execute revoked and re-granted correctly per
`.brain/domains/analytics.md`) -- B17 above only covers what real interns and a real live session
can add on top of that: the numbers actually matching across screens and the board actually
updating live.

**Known open item (not a bug):** "today" for both the live board and the daily table is midnight
**America/Chicago**, hardcoded -- no org has its own timezone column yet
(`.brain/domains/analytics.md`). If your team isn't in Central time, "Today" and "Yesterday"
switch over at midnight Chicago time, not your own local midnight. Don't re-report this as a
day-boundary bug.

### B18 -- Add funds + auto-recharge (TASK-BF1) -- **needs a real Telnyx account with a stored payment method on file, real money**

Owner or admin, connected Telnyx (Settings → Telephony → Spend & Billing). Use the QA sandbox
org's own connection for B18.1-B18.4 (never buy/charge against the real MyHomeBase org except the
one deliberate B18.5 real charge, at the smallest preset).

| #     | Step                                                                                                                                                                   | Expected                                                                                                                                                                                                                                                                  | ☐   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| B18.1 | Owner/admin: Settings → Telephony → Spend & Billing → **Add funds**. Click a preset ($10/$25/$50/$100), then Continue.                                                 | A confirm step reads "Charge $X to the payment method saved in your Telnyx account?" with focus already on **Cancel**, not the charge button. Click Cancel.                                                                                                               | ☐   |
| B18.2 | Same dialog: check the "Custom amount" box, try $2 (below the $5 minimum) and $1,500 (above the $1,000 max), then Continue.                                            | Continue stays disabled (or the amount is rejected) for both out-of-range values; a value between $5-$1,000 enables Continue normally.                                                                                                                                    | ☐   |
| B18.3 | Auto-recharge section: toggle Enabled on, set a threshold and a recharge amount, pick a payment source (Card/PayPal vs. Bank/ACH), let it save.                        | Values persist on reload; the SAME values show up in the Telnyx portal's own auto-recharge settings for this account (not just in HyperDial).                                                                                                                             | ☐   |
| B18.4 | As an agent, try to reach the Spend & Billing card (it's inside Settings → Telephony, already route-blocked for agents).                                               | Agent cannot reach Settings at all (pre-existing invariant, unaffected by this feature) -- confirmed via the route block, not by finding the card and it being empty.                                                                                                     | ☐   |
| B18.5 | **Real charge, smallest amount:** click Add funds → $10 preset → Continue → Confirm charge, against a REAL connected Telnyx account with a real stored payment method. | A success toast shows the new balance; the balance shown in HyperDial matches the Telnyx portal's own balance within a minute; a new "Recent billing activity" row shows "Add funds -- $10.00, succeeded"; Telnyx's own transaction history shows the same $10.00 charge. | ☐   |
| B18.6 | Immediately repeat B18.5 (click Add funds again right away, same or a different amount) within 60 seconds of the first charge succeeding.                              | The second attempt is refused with a rate-limit message ("wait a moment... at most once every 60s") -- no second Telnyx charge happens. Wait 60s and confirm a normal charge then succeeds.                                                                               | ☐   |

The validation/rate-limit/idempotency/error-mapping logic itself (amount bounds, the 60s/$2,000-
per-24h rate limits, a duplicate idempotency key refused without a second Telnyx call, the
pending→succeeded/failed audit-row transitions, card-declined/no-payment-method/forbidden-key
error mapping) is fully covered by deno tests (`billing-validation.test.ts`, `billing-core.test.ts`,
`telnyx-client.test.ts`, all against a mocked Telnyx client -- never the real billing endpoints)
and the SQL schema/RLS/idempotency-constraint by `audit/BF1/dryrun-tests.sql` -- B18 above only
covers what a real Telnyx account, a real stored payment method, and one real minimum-amount
charge can add on top of that. Don't repeat B18.5 more than once against a real account without a
real reason -- it's a real charge every time.

**Known open item (not a bug):** there is no Telnyx API to ADD a payment method -- the card/PayPal/
bank account itself is added once in the Telnyx portal directly; HyperDial can only charge or
auto-recharge whatever is already on file there.

---

## C. Evidence to capture

- Screenshots of each `DialerStateBanner` state seen during B2/B3 (Ready, Ringing, Connecting,
  Connected, Wrapping up, Paused, Agent audio lost).
- A screen recording of one full call cycle: Start → ring → answer → wrap-up submit → back to
  dialing. This one recording covers most of B1–B2 at once.
- Timestamps: Go Ready click → first audible ring (targets ~1s per the design doc); this can only
  be eyeballed from the recording, not logged automatically.
- Any browser console errors during the whole run (`F12` → Console) — none are expected.
- After the run, the `dial_sessions`/`call_legs` rows for this session via the Supabase dashboard
  or Management API, to confirm the DB state matches what the UI showed (state reached
  `completed`/`stopped`, legs have real `answered_at`/`ended_at`, no leg stuck in a
  non-terminal state).

## Known open items — not blockers, don't re-report these

- **`sip_uri_calling_preference`**: the agent's Telnyx credential connection is created without
  it set (defaults to disabled). If step B1.2's INVITE never reaches the browser at all across
  several attempts, check the credential connection in the Telnyx dashboard and try setting it
  to `internal` (also blocks spoofed outside calls from being auto-answered as a side benefit).
  See `audit/L1/review-notes-r2.md` minor m1.
- **The dialer sweeper's lost-webhook reap** (TASK-L6, section B8) is a background safety net —
  there's no reliable way to force a genuinely lost webhook from the UI, so B8 is a best-effort,
  lead-only probe, not something the user/intern needs to do. It runs every 30s regardless of
  whether B8 is attempted at all.
- **Multiple tabs across two different physical machines** (not just two tabs of one browser):
  the single-tab lock (B4) was only hands-on-verified with two tabs of the same automated
  browser session before this test; two real machines is the real live-verify this checklist
  covers.
- **REC-5's contact-history recording link** (TASK-F-T2) is not built — there's no contact
  call-history UI anywhere in the app yet. Only the wrap-up modal's recording player exists;
  don't re-report the missing history view, it's tracked as deferred to TASK-F-P4.
- **Voicemail drop under plain `detect`/`off` AMD modes** (TASK-F-T3) is a vendor limitation, not
  a bug: Telnyx never emits `call.machine.greeting.ended` for those modes, so there is no safe
  "greeting is over" signal to time playback against. B11.6 exercises this on purpose — don't
  re-report it as a missed drop.
- **No delete/remove control on the voicemail-drop upload UI** (TASK-F-T3): Settings → Voicemail
  drop can upload/replace a file but has no button to clear one back to "unset." Re-uploading is
  the only way to change it today; tracked as a minor gap, not a launch blocker.
- **Interns have no Settings view of the number pool** (TASK-N1): the Telephony tab stays
  owner/admin-only (a standing invariant that predates this task) — an intern's own read-only
  visibility is the Dialer idle screen's "Your numbers: N active, M resting" line instead. See
  decisions.md's TASK-N1 entry (decision 4). Don't re-report the missing Settings view for agents.
- **A capped-out pool spills over onto a campaign's legacy caller ID, uncapped** (TASK-N1): by
  design, per the task's own priority order (assigned → pool → legacy fallback) — see decisions.md.
  Clear a campaign's legacy caller ID once its pool is fully set up if a hard cap with no spillover
  is actually wanted.
- **No per-number cap override in the UI** (TASK-N1): a number's `daily_cap` is set once at
  purchase time (from the org's current default) and is otherwise only changeable by hand in the
  database — the UI shows it but doesn't offer a per-row editor. Tracked as a minor gap, not a
  launch blocker; the org-level default is the intended day-to-day lever.
