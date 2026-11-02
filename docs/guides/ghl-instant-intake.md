# Instant new leads from GoHighLevel (and n8n)

A GoHighLevel workflow can send each NEW lead to HyperDial the moment it is created or tagged. HyperDial reads the contact back from GoHighLevel (it never trusts the ping itself), applies the same rules as the 5-minute check, and queues it on a campaign, so interns can dial it within seconds. The 5-minute check is also the backup for a ping that is missed, and instant intake only runs while it is switched on.

This guide is for the GoHighLevel admin and for whoever runs the n8n flow that creates the contacts.

## How a lead picks its campaign

By its **tag**: "when a GoHighLevel contact has tag `hd-frisco`, add it to campaign Frisco Roofers" (or the same for a pipeline stage). The tag is set when you create the campaign (Campaigns → New campaign → **Auto-add GHL leads tagged**, prefilled as `hd-<campaign name>`), shown as a chip on the Campaigns list, and editable in the campaign's **Auto-add from GHL** section or in Settings → Integrations → GoHighLevel → Tag/stage → campaign mappings. A lead whose tags match no rule is not added (the Recent leads list shows "No rule for its tags"). Matching to an existing HyperDial contact (GoHighLevel id, then phone), do-not-call numbers, paused tags and "already active in another campaign" work exactly as for the 5-minute check.

## One-time setup in HyperDial (owner or admin)

1. Settings → Integrations → GoHighLevel, connected.
2. **Each campaign has its tag**: create it with the campaign (Campaigns → New campaign), or add a rule later in the campaign's **Auto-add from GHL** section. Example: `hd-frisco` → Frisco Roofers.
3. **Instant new leads from GoHighLevel** card: **Create secret**. Copy the secret now; it is shown once. Copy the **Webhook URL** too.
4. **Required:** switch on **Also check GHL every 5 minutes, in case an instant update is missed** (in the "Backup check + field mapping" card). Instant intake only runs while it is on and at least one rule exists; with it off, pings are ignored for new leads.

## Setup in GoHighLevel: once, for all campaigns (about 5 minutes)

You build ONE workflow and never edit it again. A new campaign is a new campaign plus its tag in HyperDial; nothing changes in GoHighLevel.

1. **Automation → Workflows → Create workflow → Start from scratch.** Name it, for example, "Send new leads to HyperDial".
2. **Trigger: Contact Created**, no filter. Every new contact pings HyperDial; HyperDial reads the contact's tags and adds it only if a tag matches a campaign's rule. (Contacts without a matching tag are ignored; a contact carrying a tag that starts with `hd-` but matches no rule is listed as "No rule for its tags", which catches typos.)
   - Alternative, only if n8n adds the tag in a separate step after creating the contact: **Contact Tag**, filter **Tag Added**. It must list every campaign tag, so it needs editing for each new campaign: prefer Contact Created, and let the 5-minute check pick up late tags.
3. **Action: Custom Webhook.** Method **POST**, URL = the Webhook URL from HyperDial, authorization **No auth**.
4. **Headers**: add `X-HyperDial-Webhook-Secret` with the secret as the value.
5. **Custom data** (key/value): `contact_id` = `{{contact.id}}` and `location_id` = `{{location.id}}`.
6. **Save and publish** the workflow.
7. Test: create one test contact in GoHighLevel with a campaign tag and a phone number. Within seconds the contact appears under **Recent leads** in the HyperDial card with what happened to it. Re-testing the same contact within 10 minutes is ignored (an identical ping is dropped as a duplicate): wait 10 minutes or test another contact.

The same URL and secret also carry the instant do-not-call, signed-up-stage and owner-change updates, which use their own workflows (triggers Contact DND, Contact Tag added/removed, Pipeline Stage Changed). See the card's steps and [ghl-first-connect-checklist.md](ghl-first-connect-checklist.md).

## n8n: put the campaign's tag on the contact when creating it

Your n8n flow creates the GoHighLevel contact. Look up the tag on the Campaigns list in HyperDial (the chip under the campaign name) and set it in the same create step, so it is on the contact the moment the "Contact Created" workflow fires:

- In the GoHighLevel node (Create contact), put the tag in **Tags**, for example `hd-frisco` (one tag per campaign, exactly as shown in HyperDial).
- Or, if the contact is created by an HTTP Request node, send `"tags": ["hd-frisco"]` in the body of the create-contact call.
- Make sure the phone number is filled in **before** the tag is added (the workflow reads the contact at that moment). A contact without a usable phone number is never added, by the instant path or the 5-minute check, until the phone is fixed in GoHighLevel.

Adding a campaign later: create it in HyperDial (it shows its tag), use that tag in n8n. Nothing changes in GoHighLevel. If n8n adds the tag only after creating the contact, the 5-minute check adds the lead (up to 5 minutes later, and only while "Also check GHL every 5 minutes" is switched on, which instant leads need anyway). n8n does not call HyperDial.

## What "Recent leads" can say

| Shown                               | Meaning                                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Added to _campaign_                 | Queued; interns can dial it now                                                                                                                                                                    |
| Already in a campaign               | It was already queued, nothing changed                                                                                                                                                             |
| Do-not-call, skipped                | The contact or number is on the do-not-call list                                                                                                                                                   |
| Has a paused tag, skipped           | It carries one of the "paused" tags set in HyperDial                                                                                                                                               |
| Active in another campaign, skipped | Another campaign is working it; it is not added twice                                                                                                                                              |
| No rule for its tags                | No mapping matches its tags or stage: add a rule, then tag it again                                                                                                                                |
| Could not be added (error)          | Usually the contact has no usable phone number in GoHighLevel. Fix it there and tag again (after 10 minutes if it is the same ping). Temporary failures are retried by GoHighLevel and show no row |

## If nothing shows up

- No row at all: the workflow did not fire or the call was refused. In GoHighLevel open the workflow's execution log; a `401` means the secret header is missing or wrong (create a new secret and update the header).
- A row saying "No rule for its tags": add the mapping, then add the tag again.
- Leads only show after 5 minutes: the instant path is not working but the backup is; check the workflow and header. Leads added by the 5-minute check appear in the campaign but not in Recent leads (only instant ones are listed).
- Re-testing the same contact within 10 minutes does nothing: an identical ping is ignored. Also, HyperDial takes at most 60 instant updates per minute; during a bulk import into GoHighLevel the rest are picked up by the 5-minute check.
- GoHighLevel can charge for some workflow actions depending on your plan: check the Custom Webhook pricing for yours.

## Sources for the GoHighLevel wording

- Contact Tag trigger (added/removed; only fires for tags changed after the workflow is active): [Workflow Trigger – Contact Tag](https://help.gohighlevel.com/support/solutions/articles/48001213546-standard-triggers-contact-tag)
- Custom Webhook action (method, headers, merge fields such as `{{contact.id}}`): [Workflow Action – Custom webhook](https://help.gohighlevel.com/support/solutions/articles/155000003305-workflow-action-custom-webhook)
- List of triggers (Contact Created, Contact DND, Pipeline Stage Changed): [A List of Workflow Triggers](https://help.gohighlevel.com/support/solutions/articles/155000002292-a-list-of-workflow-triggers)
