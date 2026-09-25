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

Your Telnyx account balance is currently **$5**. A low balance never blocks
dialing by itself — you'll only see a warning once it drops below your
low-balance alert threshold ($2 by default, step 7 below). Fund it anyway
before your team's first real day: Telnyx itself will decline calls once the
balance actually hits zero, and you don't want that discovered mid-campaign.
Go to your Telnyx portal (`portal.telnyx.com`) → Billing → add a payment
method (card, PayPal, or bank account) and add funds. There's no fixed
"right" amount; a rough rule of thumb is a few weeks of expected spend so
you're not topping up every few days. You'll set a spend cap and low-balance
alert inside HyperDial itself in step 7 below — the spend cap is the only
thing that actually blocks dialing.

This first top-up has to happen in the Telnyx portal directly — there's no
API to add a payment method itself. Every top-up AFTER this one can be done
without leaving HyperDial: once Telnyx is connected (step 3) and a payment
method is on file, Settings → Telephony → Spend & Billing → **Add funds**
charges that same saved payment method directly (owner or admin, either can
do it) — see step 7 below.

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

**How many do you need?** A number that hits its daily cap doesn't come back
the next day — it rests for `rest_days` (2 by default, step 5 below), so a
number dialed at the cap is only usable 1 day out of every `1 + rest_days` = 3. A number that stays BELOW the cap never rests at all, so a light team
genuinely needs fewer numbers, not just proportionally fewer dials.

**Formula, per intern:**

```
numbers per intern = ceil(dials per intern per day ÷ daily cap) × (1 + rest_days)
```

With the default cap (100) and rest period (2 days), that's ×3 once an
intern's volume reaches the cap. Multiply by the number of interns dialing
at once, then add 10–20% pool headroom (a number can be temporarily
unavailable — provisioning delay, carrier issue, manual pause — and you
don't want that to block anyone).

| Interns (M) | Dials/intern/day          | Numbers/intern | Pool (M × that) | + 15% headroom |
| ----------- | ------------------------- | -------------- | --------------- | -------------- |
| 1           | 100                       | 3              | 3               | 4              |
| 1           | 200                       | 6              | 6               | 7              |
| 1           | 400 (parallel, 3–5 lines) | 12             | 12              | 14             |
| 3           | 100                       | 3              | 9               | 11             |
| 3           | 200                       | 6              | 18              | 21             |
| 3           | 400 (parallel, 3–5 lines) | 12             | 36              | 42             |
| 5           | 100                       | 3              | 15              | 18             |
| 5           | 200                       | 6              | 30              | 35             |
| 5           | 400 (parallel, 3–5 lines) | 12             | 60              | 69             |

**Alternative to buying more numbers:** raise the daily cap or shorten the
rest period in Settings → Telephony (step 5). Both push a number's real-world
call volume higher, which is a genuine carrier-reputation tradeoff — carriers
flag/deprioritize numbers that suddenly dial far more than a normal person
would, which can hurt your answer rate. Buying more numbers to stay under a
conservative cap is the safer lever; loosening the cap/rest is the cheaper
one. Don't do both blindly — pick one and watch your connect rate after.

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

## 7. Set the spend cap and low-balance alert, and set up ongoing funding

Settings → Telephony → scroll to "Spend & Billing" (only appears once step 3
is done). Set:

- **Low-balance alert** ($2 by default) — a low balance never blocks
  dialing by itself. Once the balance drops below this, everyone gets
  warned three ways: a toast when an intern hits Go Ready, an in-app
  notification to every owner/admin (checked hourly), and a banner on the
  Dashboard. Set it to whatever balance means "go top up soon" for you.
- **Monthly spend cap** (optional) — the only thing that actually blocks.
  Once this month's estimated spend hits it, Go Ready and buying new
  numbers are both refused. Leave blank for no cap.

For ongoing funding, the same card (owner OR admin, either can do this) has:

- **Add funds** — presets ($10/$25/$50/$100) or a custom amount ($5-$1,000
  per charge), charged to the payment method you already added in step 1.
  A confirm step shows the exact amount before anything is charged. At most
  one successful charge every 60 seconds and $2,000 total per rolling 24
  hours, so a mis-click can't run away.
- **Auto-recharge** — turn it on to skip manual top-ups entirely: set "When
  my balance drops below $X, add $Y" and a payment source (card/PayPal or
  bank/ACH). Telnyx tops up automatically once the balance crosses your
  threshold — the actual amount added is whatever it takes to reach the
  threshold, PLUS the "add" amount (that's Telnyx's own math, not a flat
  top-up).
- **Recent billing activity** — the last 10 add-funds charges and
  auto-recharge changes, who did each one and when.

**Expect:** the current balance and this month's estimated spend both show
real numbers (not errors); your saved values persist on reload; an Add Funds
charge shows up in the Telnyx portal's own transaction history within a
minute.

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
5. **Section B17** — the manager Team page: live board updates within 5s,
   the daily numbers match the Dashboard/Analytics for the same intern, the
   range/sort controls, and that an intern still can't reach `/team`. Run
   this alongside B14 (needs 2 real interns actively dialing).
6. **Section B16** — inbound callback routing, if your numbers are set up
   to receive calls back from prospects. Needs a real inbound call from a
   personal cell phone to the org's own number.
7. **Section B18** — one real Add Funds charge at the smallest amount, and
   turning auto-recharge on/off, confirmed against the Telnyx portal's own
   balance and settings (this is the direct real-money version of step 7
   above). Real money — do this once, not repeatedly.

Do these as the actual org owner/admin and an actual intern, not the QA
sandbox accounts — real Telnyx calls, real balance, real GHL contacts if
applicable (never use a real MyHomeBase contact for anything destructive,
same caution the build team followed).
