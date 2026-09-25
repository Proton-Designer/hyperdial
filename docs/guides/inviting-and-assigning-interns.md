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

## 4. Start the dial session -- **known gap, not yet fixed**

`dialer-session-start` sets the new session's `agent_id` to whoever calls it,
and the _only_ UI that calls it today is CampaignManageModal's **Start
Session** button, which only exists behind the Campaigns screen. TASK-L4
intentionally hides the Campaigns tab for agents (UI-4) -- which means, as of
this task, **an intern has no way to start their own parallel-dial session**;
a manager clicking Start Session on their behalf would start it under the
_manager's_ `agent_id`, not the intern's, so the intern's Dialer tab would
never pick it up via `getActiveDialerSession`.

This is a real, currently-open gap, not a documentation nicety -- see
`.brain/memory/known-issues.md` for the write-up and the fix direction (a
lightweight "start dialing my assigned campaign" control inside `Dialer.tsx`
itself, in the dialer lane, calling the same `dialer-session-start` endpoint).
Until that lands, per-intern dialing needs a temporary workaround chosen by
whoever picks this up next -- do not paper over it by granting the intern a
higher role just to click one button, since that defeats the point of the
role split this task just built.
