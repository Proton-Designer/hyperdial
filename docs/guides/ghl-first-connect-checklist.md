# First GoHighLevel connection: checklist

For the owner or admin who connects GoHighLevel (GHL) to HyperDial for the first time (Kareem). It is a short set of tests, in order, that proves each GHL feature works on your real account. Allow about an hour. Each step says what to do, what you should see, what a problem looks like and what to do about it. Use **test** contacts that you control (your own phone number), never real providers. The background for every feature is in [ghl-data-sync-setup.md](ghl-data-sync-setup.md).

Before you start

- You need a GHL **Private Integration token** with these permissions (GHL → Settings → Private Integrations → your integration → Scopes): Contacts (view and edit), Opportunities (view), Locations / Tags (view and edit), Custom Fields (view and edit), and for Shifts also Calendars and Users (view). A missing permission shows up below as a plain message saying which permission is needed.
- Two test records: a **test provider contact** in GHL with a phone number you control (called P1 below), and a **test intern** with a GHL contact (called I1).
- If a step fails and you cannot fix it with the "If it fails" line, stop and send the HyperDial team the exact message you saw (see "For the HyperDial team" at the end). Nothing here can damage real data: every step below only touches your test records.

## 1. Connect and create the tags

Do: **Settings → Integrations**, enter the **Private Integration Token** and **Location ID**, connect.
You should see: the card says connected, and a note under it, "Created in GHL: signed up, active." (nothing is shown if both already existed). In GHL → Settings → Tags the tags `signed up` and `active` exist.
If it fails: a yellow note such as "Couldn't create in GHL: signed up, active. Check the GHL token has the Tags permission." The connection itself still works. Add the Tags permission to the token and press **Save** on the **Remove from call lists** card (every save tries again), or create the two tags by hand in GHL.
Good to know: a newly connected account starts with **Remove from call lists** switched **on** and the exclude tags `signed up` and `active`. That means a GHL contact with either tag leaves the call lists. If you want to hold that back while you test, untick **Remove these contacts from call lists** and Save.

## 2. The tag picker

Do: on **Remove from call lists** click into the tag box.
You should see: a list of your GHL tags. Type a new name such as `hd-test-tag`: the list offers **Create "hd-test-tag" in GHL**. Click it; the tag appears as a chip, and in GHL the tag now exists.
If it fails: "Couldn't load your GHL tags ... You can still type a tag; saving creates it in GHL." Add the Tags permission. Delete `hd-test-tag` in GHL afterwards.

## 3. Create the missing fields

Do: **Settings → Integrations → Field coverage**. Note the "N of M ready" count, then press **Create N missing fields in GoHighLevel** once.
You should see: "Created N fields in GoHighLevel." In GHL → Settings → Custom Fields a folder called **HyperDial** holds the fields, named like the card (for example `Last Call Outcome`, `Call Attempts`, `Shift next shift at`). The card then reads "M of M ready".
Three things to look at:

1. **The field keys were accepted.** The result box has no yellow "GoHighLevel saved it under a different key" list. In GHL open one field: its key is `contact.` plus the name (for example `contact.call_attempts`).
2. **Dropdowns are exact.** Open `Top Objection`: Too busy, Has enough work, Fees, Does not trust apps, Not interested in app jobs, Other. Open `Last shift slowed by`: Bad numbers, Dialer issue, Did not know the answer, Script felt off, Nothing.
3. **Pressing again creates nothing.** Press the button again or reload the card: "Nothing was created", and no duplicate fields in GHL.

If it fails:

- "GoHighLevel saved it under a different key" (with a list): GHL changed our key. Call fields still work. For the intern fields, rename the key in GHL to the one listed as expected. Do not press the button again to fix it.
- "Not created, a field with the same name already exists under another key": a field with that name was already there. Rename its key in GHL, or delete the old field and press again.
- "needs the Custom Fields write permission": add the permission and press again.
- "Not finished: press the button again": just press again; it only creates what is still missing.
- Every field fails with the same message about the key: stop and tell the HyperDial team; create the fields by hand from section 2 of the setup guide instead and use **Suggest from GHL** in the field mapping.

## 4. One test call (provider contact)

Setup: the call fields are mapped (step 3 does it; otherwise **Scheduled pull + field mapping → Suggest from GHL → Save**). Put P1 in a campaign with a test agent.
Do: dial P1, answer, wrap up as **Callback** (set a callback time) and pick a **Top Objection**.
You should see, within about a minute: **Settings → Integrations → Sync status** shows the job done. In GHL on P1: the fields `Last Call Outcome`, `Last Call At`, `Call Attempts`, `Callback Date/Time`, `Call Duration (sec)`, `Recording Link`, `Called By`, `Lead List / Batch ID`, `Top Objection`, the tag `Callback`, a note and a callback task. A **Yes - Build Profile** outcome adds the tag `signed up` instead.
If it fails: the Sync status list shows the error. A "401" means a missing permission; a "422" on a field means the field type or a dropdown option does not match (the Field coverage card shows a warning). Fix it and wait: jobs are retried by themselves with growing waits.

## 5. One test shift (intern)

Setup: Team Shifts is connected as in [shifts-setup.md](shifts-setup.md) (calendar, GHL user, and I1's GHL contact id), and Shifts is on for the account.
Do: as I1, clock in on a scheduled shift, press **End shift**, fill in the survey.
You should see, within about a minute, on I1's contact in GHL: `Last shift date`, `Last shift scheduled start`, `Last shift clock-in at`, `Last shift clock-out at`, the survey answers, `Week dials` and `Shift next shift at`. No tag and no note yet: those arrive about 2 hours after the shift ends.
If it fails: the intern fields say "missing" on the Field coverage card (go back to step 3), or the contact id on I1 is wrong. The weekly updates (`Week submitted`, `Week closed` and their tags) can only be proven at the first real week boundary.

## 6. Instant updates, the workflow way

Do: **Settings → Integrations → Instant updates from GoHighLevel → Create secret**. Copy the secret now (it is shown once). In GHL: Automation → Workflows → create a workflow with the trigger **Contact DND** (make another for **Contact Tag**), action **Custom Webhook**: method POST, URL = the **Webhook URL** on the card, header `X-HyperDial-Webhook-Secret` with the secret as value, custom data `contact_id` = `{{contact.id}}` and `location_id` = `{{location.id}}`. Publish it.
Before testing: P1 must be linked to GHL (it is after step 4) and waiting in a campaign, and **Remove from call lists** must be on.
Do: in GHL switch **Do Not Disturb** on for P1.
You should see, within seconds: the card says "Last update received ..." with a new time; P1 is Do Not Call in HyperDial and its lead has left the queue.
If it fails: look at the workflow's run history in GHL. "401" means the secret is wrong or missing. "ignored: reconcile_off" means **Remove from call lists** is off. "ignored: location_mismatch" means the `location_id` in the body is not this account's. "ignored: no_contact" means the body had no contact id (check the `{{contact.id}}` field). "unlinked" means P1 is not linked to GHL yet. Even if the instant update does not work, the regular 5-minute check still removes the lead within a few minutes.
Also try: press **Create a new secret** and confirm the old secret is refused; **Delete secret** makes the workflow calls refused.

## 7. Instant updates, the signed app way (optional)

Only if you build a GHL Marketplace app. It needs no secret; GHL signs the messages. Create a private app, install it on your location, set its webhook URL to the card's Webhook URL and subscribe to ContactDndUpdate, ContactTagUpdate, ContactUpdate and OpportunityStageUpdate. Switch **Do Not Disturb** on for P1 and expect the same result as step 6. If nothing arrives, or every message is refused, tell the HyperDial team (the signature format has never been tested against a real GHL account); use step 6 meanwhile. Whether a plain Private Integration can receive these app events is also unknown, which is why step 6 exists.

## 8. Contacts that are not in GHL yet

Do: make three test contacts in GHL with phone numbers written differently: `+14155550101`, `(415) 555-0102`, `4155550103`. Import a CSV with those three numbers into a campaign.
You should see, after one 5-minute check: the contacts are linked to GHL (they now behave like any linked contact). Then switch **Do Not Disturb** on for one of them in GHL: it becomes Do Not Call at the next check.
If it fails: contacts that GHL does not find simply stay unlinked and are searched again after 3 days; nothing breaks. If none of the three are found although they exist, tell the HyperDial team which number formats GHL stored.
Status: the database part of this feature is live; the part that runs the lookup is deployed after its final review. Until then this step does nothing.

## 9. Do Not Disturb, tags and owner

With P1 linked and waiting in a campaign:

1. Do Not Disturb in GHL: done in steps 6 and 8 (or wait one 5-minute check). **Remove from call lists** shows the last run.
2. Add the tag `signed up` to a second test contact: its waiting lead is marked completed at the next check. The tag `paused` pauses the lead instead.
3. Give a contact with a waiting **callback** a GHL Owner whose GHL user id is saved on that intern in **Settings → Team**: at the next check the callback is assigned to that intern. HyperDial never changes the GHL owner.

## 10. Do Not Call lock

As an agent open a Do Not Call contact: the **Do not call** control is greyed with "Only an owner or admin can clear do-not-call". As owner or admin it can be cleared. Try it on a test contact only and restore it afterwards.

## Stopping something

| To stop                                     | Do this                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| Everything from GHL into HyperDial          | **Remove from call lists**: untick, Save. (Instant updates are then ignored too.) |
| The workflow webhook only                   | **Instant updates → Delete secret**                                               |
| The signed app webhook only                 | Unsubscribe the events in the Marketplace app                                     |
| Everything HyperDial sends to GHL           | **Settings → Integrations → Disconnect** (queued updates wait)                    |
| The phone lookup of contacts not yet in GHL | Ask the HyperDial team (a setting)                                                |

## For the HyperDial team

Only the HyperDial team needs this part. "SQL" is a read-only query on the live database; replace `:org` with the organisation id (`select id, name from orgs;`). Logs are in the Supabase dashboard → Edge Functions → the function → Logs.

Deployed state to confirm first: migrations `20261019210213`, `20261019210311`, `20261019210936`, `20261019211305` (phone lookup, live), `20261019211410` applied; functions `ghl-connect`, `ghl-reconcile-settings`, `ghl-update-blocked-tags`, `ghl-tags`, `ghl-field-coverage`, `ghl-webhook`, `ghl-webhook-settings`, `ghl-reconcile-worker`, `ghl-sync-worker` deployed (the reconcile worker carries the phone lookup), and the final web build live.

**Step 1.** `select status, location_id, ghl_reconcile_enabled, ghl_exclude_tags, ghl_dnc_tags, ghl_paused_tags from org_integrations where org_id = ':org' and provider = 'ghl';` expect `connected`, the location, `true`, `{"signed up",active}`, `{"do not call",dnc,do-not-call}`, `{paused,pause}`. Log for a tag problem: `[ghl-connect] tag sync incomplete`. The picker: `[ghl-tags] failed`. Audit: `select action, details from org_audit_log where org_id = ':org' and action like 'ghl.%' order by created_at desc limit 5;`.

**Step 3.** Audit rows `ghl.create_missing_fields`; a second press shows `created: []`. If every create fails on the key, the body in `buildCreateFieldBody` (`supabase/functions/_shared/ghl-field-create.ts`) is wrong for standard contacts (GHL's published spec only describes custom objects).

**Step 4.** `select kind, status, attempts, last_error from crm_sync_jobs where org_id = ':org' order by created_at desc limit 5;` expect a `disposition` job `done`. Log prefix `[ghl-sync-worker]`. A `dead` job has no retry button for provider calls; to requeue (a write, needs the usual live approval): `update crm_sync_jobs set status = 'queued', attempts = 0, next_run_at = now() where id = '<job id>';`.

**Step 5.** `select kind, event, status, attempts, last_error from shift_ghl_outbox where org_id = ':org' order by created_at desc limit 8;` expect `contact_fields` / `Shift ended` / `done`.

**Step 6.** `select last_event_at, last_event_type, handled_count, secret_rotated_at from ghl_webhook_state where org_id = ':org';` and `select dnc from contacts where ghl_contact_id = '<P1 ghl id>';` (true), `select source, note from dnc_numbers where org_id = ':org' order by created_at desc limit 3;` (note `GHL reconcile: dnd`), lead status `dnc` in `campaign_leads`. Answers: `401` wrong or missing secret (log `[ghl-webhook] unknown secret`); `200` with `ignored` = `reconcile_off`, `location_mismatch`, `no_contact`, `duplicate`, `rate_limited`, `contact_unreadable`, `unsupported_event`, `unknown_location`, `no_token`; `outcome: unlinked`; `503` transient (GHL retries). `409` and `[ghl-webhook] ambiguous location` mean two connected orgs share a location id.

**Step 7 (signed route).** Log `[ghl-webhook] signature rejected: <reason>`. `signature_mismatch` on every genuine delivery with the right key means GHL signs the re-serialised body: set the function secret `GHL_WEBHOOK_SIGNED_PAYLOAD` = `json` and retry. If a key rotation happened, set `GHL_WEBHOOK_PUBLIC_KEY` (SPKI base64). `only the deprecated X-WH-Signature header was sent` = legacy RSA, unsupported by design.

**Step 8 (phone lookup).** Query-format test with the org's token (never print it): `curl -s -H "Authorization: Bearer $TOKEN" -H "Version: 2021-07-28" "https://services.leadconnectorhq.com/contacts/?locationId=$LOC&query=%2B14155550101&limit=20"`, then `query=4155550101` and `query=%28415%29%20555-0102`; record which find the contact and the format of the returned `phone`. After a check: `select phone_number, ghl_contact_id, ghl_lookup_at, ghl_reconciled_at from contacts where org_id = ':org' and phone_number in ('+14155550101','+14155550102','+14155550103');` and `select ghl_last_reconcile_at, ghl_last_reconcile_counts -> 'lookup' from org_integrations where org_id = ':org' and provider = 'ghl';` (`claimed, linked, noMatch, ambiguous, conflicts, errors, released, deadlineHit`). Logs `[ghl-lookup] ...`. All `noMatch` although the contacts exist means `query` does not match that format: change `query: e164` in `lookupUnlinkedContacts` (`supabase/functions/_shared/ghl-lookup.ts`) to the working format, or set the secret `GHL_LOOKUP_BATCH` = `0` to turn the lookup off (default 25 per organisation per check, maximum 100).

**Step 9.** `select ghl_last_reconcile_counts from org_integrations where org_id = ':org' and provider = 'ghl';` expect `decisions.dnc`, `decisions.exclude`, `applied.leads_moved`, `ownerRouting`; `select assigned_agent_id from campaign_leads where contact_id = '<id>';` for the owner test. Log `[ghl-reconcile] read <id> failed` for read errors.
