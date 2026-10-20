# HyperDial ↔ GoHighLevel data sync: setup guide

For Kareem (and whoever builds the GoHighLevel workflows). It covers what HyperDial sends to GoHighLevel (GHL), when it sends it, which fields and tags you need to create, and what flows back from GHL into HyperDial. No coding is needed. The Shifts go-live steps (calendar, scopes, first checks) are in [shifts-setup.md](shifts-setup.md); this page covers the data sync.

The sync follows your spec (`ghl-data-sync`, sections 1 to 4). Everything below says plainly what is built and what is not (section 8).

## 1. What HyperDial sends, and when

| What happens in HyperDial                                | Goes to                  | When it shows up in GHL               | What is sent                                                                                                                    |
| -------------------------------------------------------- | ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| An intern saves a call outcome (wrap-up)                 | The **provider** contact | About a minute later                  | Fields (section 3), the outcome tag (section 5), a note, a callback task if the outcome is Callback, an optional pipeline stage |
| A call ends with no answer or voicemail (automatic)      | The provider contact     | About a minute later                  | Attempt count, last call time, a counted tag such as `call:no-answer-3`. **No note** (you asked for no note per no-answer)      |
| An inbound call is answered, forwarded or missed         | The provider contact     | About a minute later                  | Last call outcome and time, tag `call:inbound`, a note                                                                          |
| A contact becomes Do Not Call in HyperDial (any way)     | The provider contact     | About a minute later                  | Do Not Disturb switched on and the DNC tag added                                                                                |
| An intern presses **End shift**                          | The **intern** contact   | About a minute later                  | A quick "shift ended" update: fields only (clock times, survey answers, counts so far, week totals). No tags, no note           |
| A shift is finalized (about 2 hours after it ends)       | The intern contact       | Within about 15 minutes of that point | The full shift fields, a note, the tags `shift-evt-completed` or `shift-evt-missed` (and `-flagged`, `-late-start` when true)   |
| A week is submitted, locked or closed; a request is made | The intern contact       | About a minute later                  | The schedule and week fields, the matching `shift-evt-…` tag                                                                    |

Notes on timing:

- The queue is worked every minute. If GHL is down, HyperDial retries with growing waits and nothing is lost. A job that fails 8 times (calls) or 6 times (shifts) is parked and shows under **Settings → Integrations** (provider calls) or **Team Shifts → Setup → GoHighLevel sync** (shifts), where it can be retried.
- Field updates overwrite the old value each time, so a field always holds the latest call or shift. Tags are only added, never removed by HyperDial.
- The End shift update (second row) exists so the clock times and survey reach GHL right away. The finalize update about 2 hours later adds late calls and the final flags, and is the only one that fires the "completed" or "missed" tag.

## 2. Create the fields in GHL

You create the custom fields in GHL; HyperDial cannot create them for you. There are two kinds, and they connect to HyperDial differently:

- **Provider fields** (the people being called): you create them, then tell HyperDial which GHL field is which in a mapping screen (section 4). A field you do not map is simply not sent, and nothing breaks.
- **Intern fields** (the people dialing): you create them with the **exact key** shown below. No mapping screen; HyperDial finds each by its key. A key that does not exist in GHL is skipped and logged (not an error), and starts filling the next time that kind of update is sent after you create it.

Number fields receive text like `142` (GHL accepts that). Times are sent as text like `2026-10-20T15:00:00.000Z`. **Use a Single Line text field for every time field until we have confirmed GHL's date-time format against a real location.** Dropdown options must match the text below exactly; we send the option text.

### 2a. Provider contact fields (sent after calls)

Suggested folder: `Hyper Dialer – Calls`.

| Field name (suggested)  | Mapping key             | Type               | Sent as                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Last Call Outcome       | `last_call_outcome`     | Single Line        | The outcome label: `Yes - Build Profile`, `Callback`, `Not interested`, `Already on platform`, `Wrong number`, `Gatekeeper`, `Do not call`, `Left voicemail`, `No answer (manual)`. Inbound calls send `answered_by_agent`, `forwarded`, `voicemail` or `missed`. If you use a Dropdown, list every one of these exactly |
| Last Call At            | `last_call_at`          | Single Line (time) | When the call ended                                                                                                                                                                                                                                                                                                      |
| Call Attempts           | `call_attempts`         | Number             | Running total of attempts for that lead (includes automatic no-answer and voicemail calls)                                                                                                                                                                                                                               |
| Callback Date/Time      | `callback_at`           | Single Line (time) | Only on a Callback outcome                                                                                                                                                                                                                                                                                               |
| Call Duration (sec)     | `call_duration`         | Number             | Seconds of the call                                                                                                                                                                                                                                                                                                      |
| Recording Link          | `recording_url`         | URL or Single Line | A link to the call in HyperDial. It needs a HyperDial login; it is a link to the page, not the audio file                                                                                                                                                                                                                |
| Called By               | `called_by`             | Single Line        | The intern's name                                                                                                                                                                                                                                                                                                        |
| Called By (GHL user id) | `called_by_ghl_user_id` | Single Line        | The intern's GHL user id, only when it is saved on their Team profile                                                                                                                                                                                                                                                    |
| Lead List / Batch ID    | `lead_list`             | Single Line        | The **name of the imported list** the lead came from: the List name typed (default: the file name) on the CSV import screen, or `GHL import <date>` for an import from GHL. Falls back to the campaign name for leads imported before this existed                                                                       |
| Top Objection           | `top_objection`         | Dropdown (single)  | Only when the intern picked one at wrap-up. Options: `Too busy`, `Has enough work`, `Fees`, `Does not trust apps`, `Not interested in app jobs`, `Other`                                                                                                                                                                 |
| License Number          | `license_number`        | Single Line        | Only for `Yes - Build Profile`                                                                                                                                                                                                                                                                                           |
| Service ZIPs            | `service_zips`          | Large Text         | Comma list, only for `Yes - Build Profile`                                                                                                                                                                                                                                                                               |

Two more things you asked for are handled without a field: the **disposition as a dropdown** is `Last Call Outcome` above, and the **disposition as a tag or pipeline stage** is in sections 4 and 5. The contact's GHL **Owner** is never changed by HyperDial; "Called By" is a separate field, and a Callback task is assigned to the intern's GHL user when known.

### 2b. Intern contact fields (sent from shifts)

Folder: `Intern Shifts`. Create these with the exact key (GHL shows it as `contact.<key>`).

**Per shift (the last finished shift)**

| Field name                       | Key                                | Type              | Notes                                                                                                                           |
| -------------------------------- | ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Last shift date                  | `last_shift_date`                  | Date              | `YYYY-MM-DD`                                                                                                                    |
| Last shift status                | `last_shift_status`                | Dropdown (single) | `completed`, `missed`                                                                                                           |
| Last shift active minutes        | `last_shift_active_minutes`        | Number            | Active dialing minutes                                                                                                          |
| Last shift power active minutes  | `last_shift_power_active_minutes`  | Number            | Dialing minutes inside the high-leverage windows                                                                                |
| Last shift adherence %           | `last_shift_adherence_pct`         | Number            |                                                                                                                                 |
| Last shift dials                 | `last_shift_dials`                 | Number            |                                                                                                                                 |
| Last shift connects              | `last_shift_connects`              | Number            |                                                                                                                                 |
| Last shift conversations         | `last_shift_conversations`         | Number            | Connects of at least N seconds. N is set in Team Shifts → Setup; **the default is now 30** (it was 60)                          |
| Last shift sign-ups              | `last_shift_sign_ups`              | Number            | Calls with the "win" outcome (`Yes - Build Profile`)                                                                            |
| Last shift connect rate %        | `last_shift_connect_rate_pct`      | Number            | Connects ÷ dials. Cleared when there were no dials                                                                              |
| Last shift conversion rate %     | `last_shift_conversion_rate_pct`   | Number            | Sign-ups ÷ conversations. Cleared when there were no conversations. Can exceed 100% (see section 8)                             |
| Last shift talk minutes          | `last_shift_talk_minutes`          | Number            |                                                                                                                                 |
| Last shift longest idle minutes  | `last_shift_longest_idle_minutes`  | Number            |                                                                                                                                 |
| Last shift late start minutes    | `last_shift_late_start_minutes`    | Number            | First dial versus shift start                                                                                                   |
| Last shift flags                 | `last_shift_flags`                 | Single Line       | Comma list: `late_start`, `long_idle`, `left_early`, `low_adherence`, `late_clock_in`, `no_clock_in`, `no_clock_out`, `no_show` |
| Last shift scheduled start       | `last_shift_scheduled_start`       | Single Line       | The shift's scheduled start, time with offset in the org time zone (e.g. `2026-11-01T01:00:00-05:00`)                           |
| Last shift scheduled end         | `last_shift_scheduled_end`         | Single Line       | The shift's scheduled end, same format. Compare with the clock-in/out times for scheduled vs actual                             |
| Last shift clock-in at           | `last_shift_clock_in_at`           | Single Line       | Time with offset, empty if the intern never started                                                                             |
| Last shift clock-out at          | `last_shift_clock_out_at`          | Single Line       | Time with offset, empty if never ended                                                                                          |
| Last shift clock-in late minutes | `last_shift_clock_in_late_minutes` | Number            | 0 = on time                                                                                                                     |

**End-of-shift survey** (sent only for dialing shifts that have a survey; a shift ended without one leaves the previous values)

| Field name                | Key                         | Type              | Options                                                                                             |
| ------------------------- | --------------------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| Last shift top objection  | `last_shift_top_objection`  | Dropdown (single) | `Too busy`, `Has enough work`, `Fees`, `Does not trust apps`, `Not interested in app jobs`, `Other` |
| Last shift objection note | `last_shift_objection_note` | Large Text        | How they handled it                                                                                 |
| Last shift what worked    | `last_shift_what_worked`    | Large Text        |                                                                                                     |
| Last shift slowed by      | `last_shift_slowed_by`      | Dropdown (single) | `Bad numbers`, `Dialer issue`, `Did not know the answer`, `Script felt off`, `Nothing`              |
| Last shift slowed note    | `last_shift_slowed_note`    | Large Text        | Empty when the answer is `Nothing`                                                                  |
| Last shift list quality   | `last_shift_list_quality`   | Number            | 1 to 5                                                                                              |

**Weekly rollup** (week so far, final after Week closed)

| Field name            | Key                       | Type              | Notes                                                                                                                   |
| --------------------- | ------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Week dial minutes     | `week_dial_minutes`       | Number            | Active dialing minutes                                                                                                  |
| Week power dial min.  | `week_power_dial_minutes` | Number            |                                                                                                                         |
| Week power dial %     | `week_power_dial_pct`     | Number            |                                                                                                                         |
| Week dials            | `week_dials`              | Number            |                                                                                                                         |
| Week connects         | `week_connects`           | Number            |                                                                                                                         |
| Week conversations    | `week_conversations`      | Number            |                                                                                                                         |
| Week sign-ups         | `week_sign_ups`           | Number            | Sum of the week's shift sign-ups                                                                                        |
| Week adherence %      | `week_adherence_pct`      | Number            |                                                                                                                         |
| Week missed shifts    | `week_missed_shifts`      | Number            |                                                                                                                         |
| Week hours vs minimum | `week_hours_vs_min`       | Number            | Actual dialing hours minus the week's minimum (8, or the light-week override). **Negative = short.** Set at Week closed |
| Week under minimum    | `week_under_minimum`      | Dropdown (single) | `Yes`, `No`. `Yes` = actual dialing hours below the minimum. Set at Week closed. It does **not** add a tag              |
| Week power week       | `week_power_week`         | Dropdown (single) | `Yes`, `No`                                                                                                             |
| Week power summary    | `week_power_summary`      | Single Line       |                                                                                                                         |
| Power weeks total     | `power_weeks_total`       | Number            |                                                                                                                         |
| Shifts missed total   | `shifts_missed_total`     | Number            |                                                                                                                         |

**Schedule and requests** (what is booked, change requests). These are the original Shifts fields; the full list with types is in [shifts-setup.md](shifts-setup.md) step 2.3 and also includes: `shift_hours_this_week`, `shift_hours_next_week`, `shift_min_hours_this_week`, `shift_power_hours_this_week`, `shift_power_hours_next_week`, `shift_week_submitted`, `shift_light_week`, `shift_schedule_this_week`, `shift_schedule_next_week`, `shift_next_shift_at`, `shift_requests_pending`, `shift_last_request_type`, `shift_last_request_reason`, `shift_last_request_note`, `shift_last_request_status`, `shift_last_request_late`, `hyper_dialer_user_id`.

## 3. Hours, sign-ups and the "Yes - Build Profile" outcome

- A **sign-up** is a call whose outcome is a "win" outcome. Out of the box that is `Yes - Build Profile` (it adds the `signed up` tag in GHL). If you want a separate "Signed up" outcome later, tell the HyperDial team: it changes what counts as a sign-up in the shift numbers.
- A **conversation** is a connected call of at least 30 seconds by default.
- **Hours versus the 8-hour minimum**: two checks exist. The Sunday check (after the pick deadline) looks at **scheduled** hours and adds `shift-evt-under-minimum`. The new Week closed check looks at **actual dialing hours** and fills `week_hours_vs_min` and `week_under_minimum`. Use `week_under_minimum = Yes` in your Monday workflow for the coaching flag.

## 4. Map the provider fields in HyperDial

1. Sign in as an owner or admin. Open **Settings → Integrations** (GoHighLevel must be connected).
2. In the card **Scheduled pull + field mapping**, find **Custom field mapping**.
3. Press **Suggest from GHL**. HyperDial reads your GHL custom fields and matches them to the keys by name. Check each match, fix any wrong ones, and paste the field id for any it missed.
4. Save. From the next call on, each mapped field is filled. Unmapped keys are skipped.

Optional, per outcome: **Settings → Dispositions** lets you set a **GHL tag** and a **pipeline and stage** for each outcome. This is how "each disposition maps to a stage or a tag so your workflows fire". Tags are set for every outcome out of the box (section 5); stages are empty until you pick them.

**Check your setup.** Still in **Settings → Integrations**, the **Field coverage** card (owner or admin) lists every field HyperDial sends, for provider contacts and for intern contacts, and says for each whether it is ready, not mapped (provider), or missing in GHL (intern), with an "N of M ready" count. It also warns when a GHL field's type cannot hold what we send or a dropdown is missing some of the exact options. Press **Create N missing fields in GoHighLevel** and HyperDial creates every missing field for you (in a folder called "HyperDial", with the exact dropdown options) and maps the call fields; the card shows what was created, mapped or failed. It is safe to press again: it only creates what is still missing. If it says the token needs the **Custom Fields write permission**, open GoHighLevel → Settings → Private Integrations → your integration → Scopes, tick Custom Fields (view and edit), and press the button again. It cannot tell how GHL stores a value (see section 8). `Last Call Outcome` may be a text field or a dropdown without a warning.

The intern fields (section 2b) need no mapping. Connect Team Shifts as described in [shifts-setup.md](shifts-setup.md): calendar id, Henry's GHL user id, and each intern's GHL contact id.

## 5. Tags HyperDial adds

**Provider contact (after calls)**

| Tag                                                                        | When                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `signed up`                                                                | Outcome `Yes - Build Profile`                             |
| `Callback`, `Not Interested`, `Already On Platform`, `Wrong Number`, `DNC` | The matching outcome                                      |
| `call:gatekeeper`, `call:voicemail_left`, `call:no_answer`                 | Those outcomes                                            |
| `call:no-answer-N`, `call:voicemail-N`                                     | Automatic no-answer or voicemail call, N = running count  |
| `nurture`                                                                  | The lead used up its maximum attempts                     |
| `call:inbound`                                                             | An inbound call                                           |
| Your DNC tag (default `DNC`), plus Do Not Disturb switched on              | The contact became Do Not Call in HyperDial, by any route |

Every tag is editable per outcome in Settings → Dispositions. A Callback outcome also creates a GHL task due at the callback time, assigned to the intern when their GHL user id is known.

**Intern contact (shifts)** — all start with `shift-evt-`:
`submitted`, `not-submitted`, `under-minimum`, `request-created`, `request-late`, `request-approved`, `request-denied`, `request-withdrawn`, `admin-edit`, `completed`, `missed`, `flagged`, `off-shift-dialing`, `power-week`, `week-closed`, and the new `late-start`.

- `shift-evt-late-start` is added together with `shift-evt-completed` when the shift started late by first dial or by clock-in. Use it for Henry's follow-up.
- `shift-evt-completed` / `-missed` fire once, when the shift is finalized, not at End shift.
- There is deliberately **no** tag for "under the 8-hour minimum at week close": use the `week_under_minimum` field. The existing `shift-evt-under-minimum` tag belongs to the Sunday scheduled-hours check, and reusing it would trigger that workflow at the wrong time.

## 6. From GHL back into HyperDial

Contacts that are linked to GHL and still waiting on a call list are checked **every 5 minutes**. Per org, up to about 100 contacts per check (up to 300 if raised), oldest-checked first, so a very long list takes a while to come around.

| In GHL                                                                                                  | What HyperDial does                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Do Not Disturb is on for calls, or the contact has a Do Not Call tag                                    | The contact becomes Do Not Call in HyperDial and its waiting leads leave every call list. **It is not sent back to GHL** (no echo) |
| The contact has a **signed-up / active tag** or is in a **signed-up / active pipeline stage** you chose | Its waiting leads are marked completed and leave the call lists                                                                    |
| The contact has a paused tag (default `paused`, `pause`)                                                | Its waiting leads are paused                                                                                                       |

**Contacts that are not in GHL yet.** A contact imported from a CSV is not linked to GHL until its first call is wrapped up, so the check above cannot read it. While **Remove from call lists** is on, each 5-minute check first looks up to 25 such waiting contacts per org in GHL **by phone number**: if exactly one GHL contact has that number (after normalising the format) it is linked and checked right away; if none, nothing happens and that contact is searched again only after 3 days; if several share the number, none is linked (HyperDial cannot tell which person it is) and the case is logged. HyperDial never creates contacts in GHL for this. Raise or turn off the batch with the `GHL_LOOKUP_BATCH` secret (0 = off). The GHL search by phone was not tried against a live location yet.

**Owner routing.** When the contact's GHL **Owner** is a user whose id is saved on a HyperDial team member (Settings → Team, the "GHL user id" on the member), that member is an active team member, and they are on the campaign, the contact's **callback** leads are handed to that member, so callbacks go back to the intern who owns the contact in GHL. HyperDial never changes the GHL Owner. It only applies to callbacks that are waiting (not other leads, not a call in progress). If the owner is not mapped, not active, or not on that campaign, nothing changes. GHL wins: a callback an intern created in HyperDial is handed to the GHL owner at the next check (within about 5 minutes) when the two differ. Clearing the owner in GHL does not unassign anyone. It runs in the same 5-minute check, so it needs **Remove from call lists** switched on below.

**Who can clear Do Not Call.** Anyone who can see a contact can mark it Do Not Call, but only an **owner or admin** can clear it (an agent sees the control locked, with the reason). If GHL still has Do Not Disturb on for that person, the next check or instant update marks the contact Do Not Call again.

The Do Not Call tags and paused tags are in **Settings → Integrations → Blocked tags** (defaults: `do not call`, `dnc`, `do-not-call` and `paused`, `pause`).

**Turn it on** (owner or admin): **Settings → Integrations → Remove from call lists**.

1. **Remove these contacts from call lists** is already ticked for a newly connected GHL account, with the **Signed-up / active tags** `signed up` and `active`. Untick it if you do not want leads removed.
2. Change the tags if your GHL uses other names, and pick the **Signed-up / active stages** from the list read from your GHL pipelines.
3. Save. The card then shows the last run (how many were checked and how many leads removed).

**Tags are created in GHL for you.** When you connect, and every time you save tags here or under **Blocked tags**, HyperDial creates any of these tags that do not exist yet in your GHL account (the exclude tags, the Do Not Call and paused tags, and the tag of each outcome). In both tag boxes you can search the tags that already exist in GHL, or type a new one and choose **Create in GHL**. If the token has no Tags permission, the page says which tags could not be created; they are then created in GHL the first time they are used on a contact. Give the token the **Tags** read and write permission to avoid this.

It is **on by default for a newly connected account** (accounts that were connected before keep their setting) and removes leads only while it is ticked. A call that is already in progress is never touched, only leads waiting in the queue. Removal is one way: if you later remove the tag in GHL, the lead stays completed.

The existing 5-minute pull (importing contacts by tag) is separate and also off by default; it is controlled in the same Integrations tab.

### Instant updates (webhook)

The 5-minute check can take a while to come around on a long list. **Settings → Integrations → Instant updates from GoHighLevel** (owner or admin) lets GHL tell HyperDial the moment a contact's Do Not Disturb, tags, pipeline stage or owner changes. HyperDial never believes the message itself: it only uses it as a nudge, reads that one contact from GHL and applies exactly the same rules as the 5-minute check. The 5-minute check keeps running as the safety net, and the webhook does nothing while **Remove from call lists** is off. Contacts that are not linked to GHL yet are ignored.

Two ways to connect it (use either):

- **Workflow webhook** (works with the Integration token you already use): on the card press **Create secret** (shown once, copy it), then in GHL create a workflow per trigger (Contact DND, Contact Tag added/removed, Pipeline Stage Changed) with the action **Custom Webhook**: POST to the Webhook URL on the card, header `X-HyperDial-Webhook-Secret` = the secret, custom data `contact_id` = `{{contact.id}}` and `location_id` = `{{location.id}}`. Replacing or deleting the secret on the card stops the old one immediately.
- **Marketplace app** (signed by GHL, no secret): create a private app, install it on the location, set its webhook URL to the Webhook URL on the card and subscribe to ContactDndUpdate, ContactTagUpdate, ContactUpdate and OpportunityStageUpdate. It is not known yet whether a plain Integration token can receive these events; the workflow route avoids the question.

Limits: duplicate deliveries within 10 minutes are ignored, and at most 60 events per minute per org are acted on (the rest wait for the 5-minute check). The card shows when the last update arrived.

## 7. Checks to run once it is live

- [ ] Open **Settings → Integrations → Field coverage**. Expect every provider field you want to be ready (not "not mapped") and every intern field ready (not "missing"); fix the rest before testing.
- [ ] Map the provider fields (section 4). Wrap up one test call as `Callback` and one as `Yes - Build Profile`; the test contact shows the outcome, attempts, callback time, duration, recording link, called by, lead list, the tag, and (for Callback) a task.
- [ ] Pick a Top Objection at wrap-up on a test call; the dropdown field matches one of your options.
- [ ] Let one automatic no-answer happen: attempt count and last call time update, a `call:no-answer-N` tag is added, and there is no new note.
- [ ] Mark a test contact Do Not Call in HyperDial; within about a minute it has Do Not Disturb on and the DNC tag.
- [ ] Give a test contact a GHL Owner that matches an intern's GHL user id, with a waiting callback on a campaign that intern is on; within about 5 minutes the callback is assigned to that intern.
- [ ] Turn on Do Not Disturb for a test contact in GHL that is on a call list; within about 5 minutes (after turning on Remove from call lists) the card's last run shows a lead removed and the lead is gone from the queue.
- [ ] With Instant updates set up (Settings → Integrations), turn on Do Not Disturb for a linked test contact in GHL; within a few seconds the contact is Do Not Call in HyperDial and **Last update received** on the card moves. A request with a wrong or missing secret is refused (401) and changes nothing.
- [ ] Press End shift on a test intern; within about a minute the clock-in and clock-out fields, survey fields and counts are on the intern contact.
- [ ] After the shift is finalized, `shift-evt-completed` (and `shift-evt-late-start` for a late one) appear.
- [ ] Close a test week; `week_hours_vs_min` and `week_under_minimum` are set.

## 8. What is not built yet

- **List name on old leads.** Leads and contacts imported before the list name existed (2026-10-19) carry no list name, so `Lead List / Batch ID` shows the campaign name for them. Contacts added to a campaign later from the Contacts screen use the list name of the contact's first import. The scheduled GHL pull (by tag or stage) does not record a list name yet.
- **Instant removal needs a one-time GHL setup.** Do Not Disturb and tag changes are instant only after you connect a workflow webhook or Marketplace app (see _Instant updates_ in section 6); otherwise they wait for the 5-minute check. The webhook was not tested against a live GHL account: whether GHL signs the raw body or the re-serialised body, and whether an Integration token can receive Marketplace events, are still to be confirmed on first use.
- **Backfills.** Contacts that were already Do Not Call in HyperDial before this release were not pushed to GHL; that can be done as a one-off on request. Shifts finalized before the sign-up counting went live get their sign-ups (and conversion rate, where there were conversations) filled in once, from the calls of that shift, when the update is applied. Those past shifts are **not re-sent to GHL**: their GHL fields keep the old values until the shift is pushed again.
- **Unlinked contacts.** A contact that has no GHL contact id yet is not created in GHL just to carry a Do Not Call flag.
- **Skipped fields are only logged.** If an intern field does not exist in GHL it is skipped and noted in the function logs; the screen under Team Shifts → Setup does not list skipped fields yet.
- **Conversion rate** is sign-ups divided by conversations, so it can go above 100% if a short call was a sign-up. Tell us if you prefer a cap.
- **Not verified against a live GHL location:** how GHL stores a number or time sent as text, whether a dropdown rejects text that is not an exact option, and how an empty value clears a field. Use Single Line for times and check the first live updates (section 7).
