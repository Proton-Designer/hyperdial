# Instant new leads from GoHighLevel (and n8n)

A GoHighLevel workflow can send each NEW lead to HyperDial the moment it is created or tagged. HyperDial reads the contact back from GoHighLevel (it never trusts the ping itself), applies the same rules as the 5-minute check, and queues it on a campaign, so interns can dial it within seconds. The 5-minute check is also the backup for a ping that is missed, and instant intake only runs while it is switched on.

This guide is for the GoHighLevel admin and for whoever runs the n8n flow that creates the contacts.

## How a lead picks its campaign

By the **Tag/stage → campaign mappings** card in Settings → Integrations → GoHighLevel: "when a GoHighLevel contact has tag `hd-frisco`, add it to campaign Frisco Roofers", or the same for a pipeline stage. A lead whose tags match no rule is not added (the Recent leads list shows "No rule for its tags"). Matching to an existing HyperDial contact (GoHighLevel id, then phone), do-not-call numbers, paused tags and "already active in another campaign" work exactly as for the 5-minute check.

## One-time setup in HyperDial (owner or admin)

1. Settings → Integrations → GoHighLevel, connected.
2. **Tag/stage → campaign mappings**: add one rule per tag (or stage), for example `hd-frisco` → Frisco Roofers.
3. **Instant new leads from GoHighLevel** card: **Create secret**. Copy the secret now; it is shown once. Copy the **Webhook URL** too.
4. **Required:** switch on **Also check GHL every 5 minutes, in case an instant update is missed** (in the "Backup check + field mapping" card). Instant intake only runs while it is on and at least one rule exists; with it off, pings are ignored for new leads.

## Setup in GoHighLevel (about 5 minutes)

1. **Automation → Workflows → Create workflow → Start from scratch.** Name it, for example, "Send new leads to HyperDial".
2. **Trigger**:
   - **Contact Tag**, filter **Tag Added**, set to the tags in your rules (`hd-frisco`, `hd-mckinney`, ...). Tag triggers only fire for tags added after the workflow is published.
   - Or **Contact Created** if every new contact should be considered (it then needs a tag that matches a rule at the time HyperDial reads it, so prefer the tag trigger).
3. **Action: Custom Webhook.** Method **POST**, URL = the Webhook URL from HyperDial, authorization **No auth**.
4. **Headers**: add `X-HyperDial-Webhook-Secret` with the secret as the value.
5. **Custom data** (key/value): `contact_id` = `{{contact.id}}` and `location_id` = `{{location.id}}`.
6. **Save and publish** the workflow.
7. Test: add the tag to one test contact. Within seconds the contact appears under **Recent leads** in the HyperDial card with what happened to it. Re-testing the same contact within 10 minutes is ignored (an identical ping is dropped as a duplicate): wait 10 minutes or test another contact.

The same URL and secret also carry the instant do-not-call, signed-up-stage and owner-change updates, which use their own workflows (triggers Contact DND, Contact Tag added/removed, Pipeline Stage Changed). See the card's steps and [ghl-first-connect-checklist.md](ghl-first-connect-checklist.md).

## n8n: add the tag when creating the contact

Your n8n flow creates the GoHighLevel contact. Make the same step set the tag so the workflow above fires:

- In the GoHighLevel node (Create contact), put the tag in **Tags**, for example `hd-frisco` (one tag per campaign or city, matching your rules).
- Or, if the contact is created by an HTTP Request node, send `"tags": ["hd-frisco"]` in the body of the create-contact call.
- Make sure the phone number is filled in **before** the tag is added (the workflow reads the contact at that moment). A contact without a usable phone number is never added, by the instant path or the 5-minute check, until the phone is fixed in GoHighLevel.

Nothing else changes in n8n: it does not call HyperDial.

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
