# HyperDial public API: read-only Calls API

Pull the calls your team has finished, with who was on the call, the outcome, a callback time and a link to the recording. It is read-only: a key can never change anything in HyperDial.

## 1. Get a key (owner or admin)

Settings → **API keys** → name the key (for example "Call review script") → **Create key**. The key is shown **once**. Copy it then. HyperDial stores only a fingerprint of it, so a lost key cannot be shown again: revoke it and create a new one. Revoke a key from the same list at any time; it stops working immediately.

Treat the key like a password. Anyone who has it can read your calls and download recordings.

## 2. Make a request

```bash
curl -H "x-api-key: hd_live_YOUR_KEY" \
  "https://hyperdial.myhomebasesolutions.com/api/v1/calls?since=2026-11-19T00:00:00Z"
```

- **URL:** `GET https://hyperdial.myhomebasesolutions.com/api/v1/calls`
- **Header:** `x-api-key: <your key>`
- **`since`:** ISO 8601 timestamp (`2026-11-19T17:00:00Z`). Returns calls that **changed after** it (see "A call can come back" below). Required on the first request.
- **`cursor`:** the `next_cursor` from the previous page. When you send a cursor you do not need `since`.
- **Order and size:** oldest change first, at most 200 calls per page. `has_more` is `true` when the page was full.

The same endpoint is also reachable at `https://lahordgefwsiqzvbfpyp.supabase.co/functions/v1/public-api/v1/calls` with the same header.

Which calls are included: calls the agent had a live conversation on (a campaign contact who was connected to an agent) that have ended. **Manual calls (an agent dialling a number by hand) are not included.**

## 3. Response

```json
{
  "calls": [
    {
      "id": "6a1f0c0e-...",
      "ended_at": "2026-11-19T17:47:53Z",
      "updated_at": "2026-11-19T17:52:10Z",
      "status": "complete",
      "duration_seconds": 1793,
      "agent": { "name": "Rayan Chakir", "email": "rayan@repuvance.com" },
      "campaign": "Repuvance | Cold Calling Script V1",
      "disposition": "Not interested",
      "disposition_reason": null,
      "contact": {
        "name": "Jane Doe",
        "business": "Doe Roofing",
        "phone": "+12145550123",
        "email": "jane@example.com",
        "timezone": "America/Chicago",
        "notes": "..."
      },
      "callback_at": "2026-11-21T15:00:00Z",
      "recording_url": "https://...signed...",
      "recording_status": "saved",
      "recording_channels": 2,
      "recording_channel_map": { "left": "contact", "right": "agent" }
    }
  ],
  "next_cursor": "opaque-string",
  "has_more": false
}
```

| Field                   | Meaning                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | The call's id. Stable: use it to dedupe.                                                                                                                                                            |
| `ended_at`              | When the call ended (UTC).                                                                                                                                                                          |
| `updated_at`            | When anything about the call last changed: the call ending, the agent choosing the outcome, the recording being saved. This is the time `since` and the cursor follow.                              |
| `status`                | `complete` when the agent has chosen the outcome **and** the recording is settled (saved, deleted, or there is none). `pending` otherwise: the outcome or the recording is still on its way.        |
| `duration_seconds`      | Length of the call.                                                                                                                                                                                 |
| `agent`                 | The HyperDial user who took the call.                                                                                                                                                               |
| `campaign`              | Campaign name.                                                                                                                                                                                      |
| `disposition`           | The outcome label the agent chose after the call (for example "Not interested" or "Booked"). `null` until the agent has chosen one.                                                                 |
| `disposition_reason`    | `null` normally. `"removed"` means the agent did choose an outcome but that outcome was deleted from the settings afterwards, so `disposition` is `null` and the call is still `complete`.          |
| `contact`               | Who was called. `timezone` is the contact's own timezone, so you can show a callback at their local time. `email` is the one from the latest close form when there is one. Any field can be `null`. |
| `callback_at`           | When the contact asked to be called back (UTC), or `null`.                                                                                                                                          |
| `recording_url`         | A temporary signed link to the MP3, valid for 6 hours. Download it within that time. `null` while there is no recording yet, or when the link could not be made (see `recording_error`).            |
| `recording_status`      | State of the recording (`saved`, or why it is missing).                                                                                                                                             |
| `recording_error`       | Only present when it applies: `"signing_failed"` means the recording exists but a link could not be made right now. The call is still returned; it comes back again later with a link.              |
| `recording_channels`    | `2` when the recording is two-channel, `null` when there is no recording.                                                                                                                           |
| `recording_channel_map` | Which side is on which channel: **left = the contact, right = the agent**. `null` when there is no recording.                                                                                       |
| `next_cursor`           | Pass it as `cursor` for the next page.                                                                                                                                                              |
| `has_more`              | `true` when more changed calls are waiting.                                                                                                                                                         |

Missing information is always `null`, never an empty string. All times are ISO 8601 in UTC with a trailing `Z` (for example `2026-11-19T17:47:53.000Z`).

**Late changes to contact details.** `contact.email` (from the latest close form), `contact.notes` and `callback_at` are read when the call is returned. A close form saved later does not make an already-`complete` call come back; the new value shows up only if the call is returned again for another reason. All timestamps are ISO 8601 in UTC, ending in `Z`.

The contact `email` and `notes` are read when the call is returned. A close form or note added **later** does not make the call come back, so you will not be sent the new email or notes for a call you already have.

## 4. A call can come back (dedupe by `id`, keep the newest)

The outcome and the recording are added **after** the call ends, so a call can appear more than once: first as `status: "pending"` (just ended, outcome or recording not there yet), then again as `status: "complete"` once they are. Each appearance has a newer `updated_at`.

In your script, store calls by `id` and **replace** the stored one with whichever has the newest `updated_at`. Treat a call as final when its `status` is `complete`. A recording that fails or is deleted also moves `updated_at` (the call comes back with `recording_status` showing why and no `recording_url`).

## 5. Polling every 15 minutes

1. First run: `since=` the time you want to start from.
2. Follow `next_cursor` while `has_more` is `true`.
3. When a run finishes, remember the largest `updated_at` you saw and use it as the next run's `since`. **Rule: subtract one minute from it and dedupe by `id`.** An empty page with no cursor returns `next_cursor: null`, so keep your own `since` rather than relying on the cursor.
4. Keep a `pending` call until it comes back as `complete`; do not process its recording or outcome before that.

## 6. Errors and limits

| Status | Meaning                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------ |
| `401`  | Missing, wrong or revoked key.                                                                         |
| `400`  | `since` or `cursor` is not valid.                                                                      |
| `429`  | More than 60 requests per minute for the key. Wait (the `Retry-After` header says how long) and retry. |
| `405`  | The request was not a GET.                                                                             |
| `404`  | Any path other than `/v1/calls`.                                                                       |
| `500`  | The calls could not be loaded: retry.                                                                  |
| `503`  | Temporarily unavailable: retry in a few seconds.                                                       |
| `404`  | The path is not `/v1/calls`.                                                                           |
| `405`  | The request was not a `GET`.                                                                           |
| `500`  | The calls could not be loaded. Retry in a moment.                                                      |

The key only ever sees your own organisation's calls.
