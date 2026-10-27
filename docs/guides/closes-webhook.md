# Closes: Log Close form and the closes webhook

When an intern closes a provider they press **Log close** (on the live-call card, or in the wrap-up window), fill a short form and submit. HyperDial then:

1. saves the close (`contact_closes`) and marks the contact **Closed** (Contacts shows a `Closed` status; bulk-add to a campaign skips Closed contacts);
2. sends the form as JSON to your **closes webhook**: a Google Apps Script web app that appends a row to the closes Sheet, or a GoHighLevel inbound webhook;
3. if GoHighLevel is connected, tags the contact `closed` (through the normal GHL outbox).

Delivery is tried right away; if the receiver is down it retries every 5 minutes (waits of 5 min, 15 min, 1 h, 3 h, 6 h; six tries), then shows as **failed** in Settings with a **Retry** button. A close is never lost because the sheet was down.

## 1. One-time setup (owner/admin) — Settings → Integrations → Closes

- **Service categories**: add the list interns pick "Services offered" from. Until you do, the form says "No service categories yet — ask an admin to add them in Settings".
- **Closes webhook**: paste the URL (must be `https://`), tick _Send closes to this webhook_, **Save webhook**, then **Send test**.

Operator steps (not in the UI): apply migrations `20261027133819_h03_contact_closes.sql` and `20261027133820_h03_close_delivery_cron.sql`; deploy `log-contact-close`, `close-webhook-settings`, `close-delivery-worker` and `ghl-sync-worker`; set the secret `CLOSE_DELIVERY_WORKER_SECRET` and call `private.set_close_delivery_worker_config('<close-delivery-worker URL>', '<same secret>')` (until then the 5-minute retry cron does nothing; the first attempt still works).

## 2. Google Apps Script (the closes Sheet)

1. Open the closes Google Sheet → **Extensions → Apps Script**. Replace the code with the script below. Set `SHEET_NAME` to your tab.
2. **Deploy → New deployment → type "Web app"**: _Execute as: Me_, _Who has access: Anyone_. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
3. Paste that URL into Settings → Closes → **Save webhook**, then **Send test**. The test sends `{"event":"ping"}`; the script ignores it and answers OK.
4. Each later change to the script needs **Deploy → Manage deployments → Edit → New version**, or the URL keeps running the old code.

```javascript
const SHEET_NAME = 'Closes';
const HEADERS = [
  'Closed at',
  'Close ID',
  'Closed by',
  'Business name',
  'Owner name',
  'Mobile',
  'Email',
  'Services',
  'Cities',
  'Frequencies',
  'Insured',
  'Best time / way to reach',
  'Starting price',
  'New clients capacity',
  'Years in business',
];

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.event !== 'contact.closed') return reply({ ok: true, ignored: body.event });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet =
      SpreadsheetApp.getActive().getSheetByName(SHEET_NAME) ||
      SpreadsheetApp.getActive().insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

    // HyperDial can deliver the same close twice (a retry after a slow answer): skip a close_id already present.
    const ids =
      sheet.getLastRow() > 1
        ? sheet
            .getRange(2, 2, sheet.getLastRow() - 1, 1)
            .getValues()
            .flat()
        : [];
    if (ids.indexOf(body.close_id) !== -1) return reply({ ok: true, duplicate: true });

    const f = body.form;
    sheet.appendRow([
      body.closed_at,
      body.close_id,
      (body.agent && body.agent.name) || '',
      f.business_name,
      f.owner_name,
      f.mobile,
      f.email || '',
      f.services.join(', '),
      f.cities.join(', '),
      f.frequencies.join(', '),
      f.insured ? 'Yes' : 'No',
      f.best_contact || '',
      f.starting_price,
      f.capacity,
      f.years_in_business,
    ]);
    return reply({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
```

Notes:

- Apps Script answers a POST with a **302 redirect** to `script.googleusercontent.com` _after the script has run_. HyperDial treats that redirect as delivered and never follows it. A redirect to any other host counts as a failure.
- Apps Script cannot read request headers, so it cannot check HyperDial's signature. Leave **signing secret** unset for Apps Script and keep the web-app URL private (anyone with the URL can add rows).
- Phone numbers: the Sheet may turn `+1512…` into a formula or number. Format the Mobile column as **Plain text** first.

## 3. GoHighLevel instead

In GoHighLevel create a **Workflow** with the trigger **Inbound Webhook**; copy its URL into Settings → Closes. Use _Send test_ once so GoHighLevel captures a sample, then publish the workflow and map the fields (`form.owner_name`, `form.business_name`, `form.mobile`, …) in its next steps. GoHighLevel also receives the `closed` tag if the GHL integration is connected.

## 4. What the webhook receives

`POST` with `Content-Type: application/json` and a body like:

```json
{
  "event": "contact.closed",
  "version": 1,
  "close_id": "uuid",
  "closed_at": "2026-10-27T18:30:00Z",
  "contact_id": "uuid",
  "agent": { "id": "uuid", "name": "Ann Lee" },
  "form": {
    "owner_name": "Pat Doe",
    "business_name": "Sparkle LLC",
    "mobile": "+15125550100",
    "email": null,
    "services": ["Window Cleaning"],
    "cities": ["Austin"],
    "frequencies": ["weekly", "monthly"],
    "insured": true,
    "best_contact": "text after 5pm",
    "starting_price": 85.5,
    "capacity": 4,
    "years_in_business": 7
  }
}
```

If you set a signing secret, each request also carries `X-Softdial-Timestamp` (unix seconds) and `X-Softdial-Signature: sha256=<hex>`, the HMAC-SHA256 of `"<timestamp>.<raw body>"` with the secret. Your receiver should de-duplicate on `close_id`.

## 5. Rules worth knowing

- Required in the form: owner name, business name, mobile, at least one service, one city and one frequency, and Insured Y/N. Email, best time/way, price, capacity and years are optional.
- Cities autofill from the contact's city, else a best-effort parse of its address; always editable.
- Closing twice within 60 seconds (double click) returns the first close. After that, closing again creates a new close (latest wins).
- Agents can see their own closes; owners/admins see all. Only the webhook URL's host is logged in the audit trail, never the secret.
- The URL must be `https://`, a real hostname (no IP addresses, `localhost`, internal names or trailing dots) on the default port.
