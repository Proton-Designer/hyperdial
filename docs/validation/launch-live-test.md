# Launch live test

One ordered runbook covering everything every reviewer this run flagged as
"cannot be proven without a real account" — Telnyx, WebRTC, a real browser, a
real second phone. The lead runs this with the user: the user plays the
intern in a browser with a mic; the lead has Management API / dashboard
access to check the database and applies the one migration this test itself
unblocks (step A6).

Do the steps in order — several later checks assume state a numbered step
left behind (the DNC contact, the voicemail-only number, the second browser
tab). Each row has an expected result and a pass/fail box; check evidence to
capture at the end of each group, not just at the end of the whole run.

**Supersedes** `parallel-dialer-checklist.md` (that file now just points
here — it described the old Redis/`BATCH_FIRING` engine, which no longer
exists).

---

## A. Setup

| #   | Step                                                                                                                                                                                                                                                                                                                                                                           | Expected                                                                                                                     | ☐   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --- |
| A1  | Sign up for the owner account ("MyHomeBase") at the app's normal sign-in screen. **Self-signup is still open right now** — TASK-L4's invite-only trigger (`20260925000300_invite_only_signup.sql`) is committed but deliberately **held**, not applied, specifically so this step can happen.                                                                                  | Account created, lands on Dashboard as `owner`. All 6 tabs visible in the sidebar.                                           | ☐   |
| A2  | Settings → Integrations → connect a real Telnyx API key.                                                                                                                                                                                                                                                                                                                       | Shows connected; no error. Key is stored in Vault, never visible again in plaintext.                                         | ☐   |
| A3  | Settings → Numbers → search and buy one real number.                                                                                                                                                                                                                                                                                                                           | Number appears in the org's number list.                                                                                     | ☐   |
| A4  | Create a campaign, set its **Caller ID Number** to the number from A3, and add 3–5 leads: **include the tester's own real phone number** (this is what answers the live call) **and one known voicemail-only number** (to exercise AMD).                                                                                                                                       | Campaign shows the right contact count; the caller-ID dropdown lists the org's number.                                       | ☐   |
| A5  | Settings → Team → Invite, role **Agent**. Send the intern the link yourself (email delivery isn't built — see `docs/guides/inviting-and-assigning-interns.md`). Open the link in a **second, separate browser profile or incognito window** (this second identity is reused for the whole rest of the test — call it "the intern browser"). Accept the invite, set a password. | Intern signs in, lands on Dashboard. Sidebar shows only **Dashboard / Dialer / Contacts** — no Campaigns/Analytics/Settings. | ☐   |
| A5b | Manage modal on the campaign from A4 → **Assigned Agents** → check the intern → Save.                                                                                                                                                                                                                                                                                          | Intern's Dialer now lists this campaign in its "Start a session" panel.                                                      | ☐   |

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

### B7 — Invite-only signup (TASK-L4) — **do this LAST, after everything above passes**

| #    | Step                                                                                                                                                        | Expected                                                                                                      | ☐   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --- |
| A6   | **Now** — after every check above has passed — the lead applies migration `20260925000300_invite_only_signup.sql` and redeploys the frontend.               | Migration applies clean.                                                                                      | ☐   |
| B7.1 | Try to sign up with no invite token (the plain sign-in screen's own "create account" path, if still linked; otherwise navigate to the signup URL directly). | Rejected — no account created. The public signup form/copy is gone from `AuthScreen.tsx`.                     | ☐   |
| B7.2 | Sign in again as the intern created in A5.                                                                                                                  | Still works (existing accounts are unaffected); sidebar still correctly shows only Dashboard/Dialer/Contacts. | ☐   |
| B7.3 | Owner/admin still see all 6 tabs.                                                                                                                           | Unaffected by the trigger change (it only gates signup, not nav).                                             | ☐   |

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
- **The dialer sweeper's lost-webhook reap** (TASK-L6) is a background safety net for a webhook
  that never arrives — there's no reliable way to force that condition live on demand, so it is
  **not** part of this checklist. It runs every 30s regardless; nothing to click.
- **Multiple tabs across two different physical machines** (not just two tabs of one browser):
  the single-tab lock (B4) was only hands-on-verified with two tabs of the same automated
  browser session before this test; two real machines is the real live-verify this checklist
  covers.
