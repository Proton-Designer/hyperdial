# Inviting an intern and setting up their campaign

How an owner/admin gets a new intern (role `agent`) onto exactly one campaign,
calling out from an org number that isn't necessarily their own. This is the
manager-side half of TASK-L4 (ADM-3, UI-4) -- the launch-blockers phase that
closed open self-signup and made the app nav role-based.

## 1. Send the invite

Settings → Team → Invite. Enter the intern's email, pick role **Agent**, and
copy the generated link (email delivery isn't built -- see the Out of scope
note in the task file; you send it yourself, Slack/email/whatever).

The intern opens that link (`?invite=<token>`), which lands on
`InviteLanding.tsx` -- not the normal sign-in screen. From
`20260925000300_invite_only_signup.sql` onward there is no other way to create
an account: the signup trigger rejects any signup without a real, unexpired,
unaccepted invite token, so this link is the only door in.

## 2. Set the campaign's caller ID to any org number

Campaigns → \[campaign\] → Manage → Settings tab → **Caller ID Number**. The
dropdown lists every number the _org_ has purchased
(`telnyx-list-numbers`/`user_phone_numbers` is queried by `org_id`, not by
whoever happened to buy it), so picking a number a different member bought
works with no extra step.

## 3. Assign the campaign to the intern

Same Manage modal → **Assigned Agents** → check the intern's name → **Save
Assignment**. Check only that one box for a "one intern, one campaign" setup
-- the checkbox list itself allows assigning more than one agent (or one agent
to more than one campaign), the "exactly one" part is just what you, the
manager, choose to check.

Once assigned, `listCampaigns()` (called by the Dialer's stats panel and
everywhere else campaigns are listed for an agent) filters to only the
campaigns that agent is assigned to -- an intern signed in as `agent` never
sees any other campaign, even though the underlying RLS on `campaigns` itself
is org-wide (design §2; see `.brain/known-issues.md`).

## 4. The intern starts their own dial session

**Fixed by TASK-L7** (this section originally documented it as an open gap
right after TASK-L4 landed -- it no longer is). The intern opens their own
**Dialer** tab, where a "Start a session" panel lists every campaign they're
assigned to (with name, lines, caller ID, and queued-lead count) and a Start
button per campaign -- no need for a manager to click anything on their
behalf. Starting runs a pre-flight (mic permission, WebRTC registration)
first; a manager's own **Start Session** button in Campaign Manage now just
navigates to the Dialer with that campaign preselected instead of starting
anything itself, so there's exactly one WebRTC client per browser tab either
way. See `docs/guides/intern-quick-start.md` for the intern-facing version of
this step, and `docs/validation/launch-live-test.md` section B1 for the live
verification.
