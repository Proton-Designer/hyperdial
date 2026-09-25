# Go-live runbook

For the org owner. One ordered checklist from where things stand today to the
team's first real dialing day. Plain steps, each with what you should see
before moving to the next one. If something doesn't match, stop and ask
before continuing — several later steps assume the org is in the state the
earlier ones left it in.

This is **not** the same document as `launch-live-test.md` — that's the
build team's own pass/fail verification script (already run once). This is
the checklist for actually turning the lights on for your own team. The last
section of this runbook tells you which parts of that other document are
worth re-running yourself and in what order.

---

## 1. Fund Telnyx

Your Telnyx account balance is currently **$5** — too low to dial with. Go to
your Telnyx portal (`portal.telnyx.com`) → Billing → add funds. There's no
fixed "right" amount; a rough rule of thumb is a few weeks of expected spend
so you're not topping up every few days. You'll set a spend cap and
low-balance alert inside HyperDial itself in step 6 below, so a top-up
mistake here isn't the only safety net.

**Expect:** Telnyx's own dashboard shows the new balance immediately.

## 2. Rotate the Supabase Personal Access Token

A Personal Access Token (PAT) was used during development for read-only
database checks (Supabase Management API queries) — it's a developer
convenience, not something any deployed function or the app itself depends
on. Before real customer/lead data flows through this project, rotate it:
Supabase dashboard → your account (top-right avatar) → **Access Tokens** →
revoke the old token → generate a new one. If you don't have the old token
recorded anywhere yourself, you can just revoke everything you don't
recognize — nothing in the running app breaks either way.

**Expect:** the old token no longer works for API calls; the app itself is
completely unaffected (it never used it).

## 3. Connect your Telnyx account

Settings → Telephony → **Connect Telnyx** (owner only — an admin can't do
this step). Paste your Telnyx API key.

**Expect:** the card shows "Connected", no error. The key itself is never
shown again in plaintext after this.

## 4. Buy your phone numbers

Settings → Telephony → Phone Numbers → search by area code → purchase.

**How many do you need?** Each number can be dialed from up to its daily cap
(100 calls/day by default, step 5 below) before it "rests" for a couple of
days. For **M interns**, each making up to 100 dials/day:

- **Minimum workable**: 1 number per intern who'll be actively dialing at
  the same time, so nobody's ever waiting on someone else's number.
- **Recommended**: 1.5–2× that — extra numbers sit in the shared team pool
  and automatically cover a number that's resting, so an intern isn't
  suddenly stuck mid-day. For M = 3 interns dialing 100/day each, that's
  4–6 numbers, not 3.
- If your team won't hit 100 dials/intern/day, you need fewer — the cap is
  a ceiling, not a target.

Buy a few more than the bare minimum; it's cheap insurance against a resting
number blocking someone.

**Expect:** each purchased number appears in the list, status "Active", cap
matching whatever the org default was at purchase time (see step 5 — set the
default BEFORE buying if you want it to apply automatically).

## 5. Set pool settings (daily cap, rest days)

Settings → Telephony → Phone Numbers → "Default daily cap" / "Rest days
after cap" (top of that section, before the number list). 100 dials/day and
2 rest days are the built-in defaults — change them here if you want
something different for every NEW number going forward (existing numbers
keep whatever cap they already have; edit a number's own row to change just
that one).

**Expect:** values save immediately (no separate Save button); reloading the
page shows what you just set.

## 6. Assign numbers to interns (optional)

Still on Settings → Telephony → Phone Numbers: each number's "Assigned to"
column lets you dedicate it to one intern (their caller ID always comes from
their own number(s) first) or leave it "Team pool" (shared, picked
automatically). You don't have to assign anything up front — an unassigned
pool of numbers works fine and is simpler to manage; assign later if a
specific intern needs a dedicated line (e.g. for callback consistency).

**Expect:** the row updates immediately; reload confirms it persisted.

## 7. Set the spend cap and low-balance alert

Settings → Telephony → scroll to "Spend & Billing" (only appears once step 3
is done). Set:

- **Minimum balance to dial** — below this, Go Ready is refused org-wide
  until you top up. A safety floor, not your working balance.
- **Low-balance alert** — an in-app notification to every owner/admin once
  the balance drops below this (checked hourly). Set it comfortably above
  the minimum-to-dial value so you get warned before anyone's actually
  blocked.
- **Monthly spend cap** (optional) — once this month's estimated spend hits
  it, Go Ready and buying new numbers are both refused. Leave blank for no
  cap.

**Expect:** the current balance and this month's estimated spend both show
real numbers (not errors); your saved values persist on reload.

## 8. Connect GHL and set the tag lists (optional — skip if you don't use GHL)

Settings → Integrations → **Connect GHL** (owner only), paste the sub-account
Location ID and API key. Once connected, scroll to "Blocked tags" and check
the two lists (Do-not-call / Paused) match how your GHL contacts are
actually tagged — add or remove tags, then Save. Any contact imported with
one of these tags is automatically kept out of the dial queue.

**Expect:** "Connected", no error; the tag lists show your saved values on
reload, and each list rejects being saved completely empty.

## 9. Invite your interns

Settings → Team → **Invite member**, role **Agent**, send them the generated
link yourself (email delivery isn't built — Slack/text/email it manually).
Full walkthrough: `docs/guides/inviting-and-assigning-interns.md`.

**Expect:** the intern's invite link lands them on a "set your password"
screen, not the normal sign-in page. Once signed in, their sidebar shows only
Dashboard / Dialer / Contacts — no Campaigns/Analytics/Settings/Team.

## 10. Assign each intern to a campaign

Campaigns → \[campaign\] → Manage → **Assigned Agents** → check the intern →
Save. An intern only sees campaigns they've been assigned to on their own
Dialer screen.

**Expect:** the campaign now appears in that intern's "Start a session"
list.

## 11. Each intern sets up their mic and browser

Point every intern at `docs/guides/intern-quick-start.md` before their first
session. The two things that trip people up:

- **Allow microphone access** the first time the browser asks — decline it
  and the app can't put them on a call.
- **One tab only.** HyperDial locks the phone line to a single tab; a second
  tab or window just shows a "already active elsewhere" message instead of
  quietly breaking anything.

**Expect:** each intern can click **Start dialing** on their assigned
campaign and the session moves from "registering" to actually dialing
within a few seconds.

---

## 12. Re-verify with real calls, in this order

`docs/validation/launch-live-test.md` is the full build-verification runbook
(already run once by the build team against a QA sandbox). You don't need to
re-run all of it, but running these sections for real, against YOUR org, is
worth the half hour before your team's first real day — they're the
behaviors that most affect what an intern actually experiences:

1. **Section B12** — Stop-session confirmation and ring timeouts. Confirms
   nobody can accidentally hang up on a live prospect, and an unanswered
   call doesn't ring forever.
2. **Section B13** — GHL do-not-call/paused tags are actually respected (if
   you connected GHL in step 8).
3. **Section B14** — the number pool: caps, rest days, and manager
   assignment actually apply to real dials (this is the direct real-call
   version of steps 4–6 above).
4. **Section B15** — the spend cap and low-balance alert actually fire
   (this is the direct real-call version of step 7 above).
5. **Team page** (Dashboard sidebar → Team, owner/admin only) — after your
   interns' first real session, confirm the live board and daily numbers
   table show real per-intern activity, not zeros. This page has no
   dedicated `launch-live-test.md` section (it's a pure read, no live
   Telnyx call needed to prove it works) — just look at it after a real
   session and confirm the numbers match what actually happened.
6. **Section B16** — inbound callback routing, if your numbers are set up
   to receive calls back from prospects. Needs a real inbound call from a
   personal cell phone to the org's own number.

Do these as the actual org owner/admin and an actual intern, not the QA
sandbox accounts — real Telnyx calls, real balance, real GHL contacts if
applicable (never use a real MyHomeBase contact for anything destructive,
same caution the build team followed).
