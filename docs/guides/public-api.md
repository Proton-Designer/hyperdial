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
- **`since`:** ISO 8601 timestamp (`2026-11-19T17:00:00Z`). Returns calls that **ended after** it. Required on the first request.
- **`cursor`:** the `next_cursor` from the previous page. When you send a cursor you do not need `since`.
- **Order and size:** oldest call first, at most 200 per page.

The same endpoint is also reachable at `https://lahordgefwsiqzvbfpyp.supabase.co/functions/v1/public-api/v1/calls` with the same header.

## 3. Response

```json
{
  "calls": [
    {
      "id": "6a1f0c0e-...",
      "ended_at": "2026-11-19T17:47:53Z",
      "duration_seconds": 1793,
      "agent": { "name": "Rayan Chakir", "email": "rayan@repuvance.com" },
      "campaign": "Repuvance | Cold Calling Script V1",
      "disposition": "Not interested",
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
      "recording_channels": 2,
      "recording_channel_map": { "left": "contact", "right": "agent" },
      "recording_status": "saved"
    }
  ],
  "next_cursor": "opaque-string-or-null"
}
```

| Field                   | Meaning                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | The call's id. Stable: use it to skip calls you already processed.                                                                                                                                     |
| `ended_at`              | When the call ended (UTC).                                                                                                                                                                             |
| `duration_seconds`      | Length of the call.                                                                                                                                                                                    |
| `agent`                 | The HyperDial user who took the call.                                                                                                                                                                  |
| `campaign`              | Campaign name.                                                                                                                                                                                         |
| `disposition`           | The outcome label the agent chose after the call (for example "Callback", "Not interested"). `null` if the agent has not chosen one yet.                                                               |
| `contact`               | Who was called. `timezone` is the contact's own timezone, so you can show a callback at their local time. Any field can be `null`.                                                                     |
| `callback_at`           | When the contact asked to be called back (UTC), or `null`.                                                                                                                                             |
| `recording_url`         | A temporary signed link to the MP3, valid for 6 hours. Download it within that time; request the call again for a fresh link. `null` while there is no recording yet or if the link could not be made. |
| `recording_channels`    | `2` when the recording is two-channel.                                                                                                                                                                 |
| `recording_channel_map` | Which side is on which channel: **left = the contact, right = the agent**.                                                                                                                             |
| `recording_status`      | State of the recording (`saved`, or why it is missing). Check it when `recording_url` is `null`.                                                                                                       |

Missing information is always `null`, never an empty string.

## 4. Polling every 15 minutes

1. First run: `since=` the time you want to start from. Keep every `id` you handle.
2. Follow `next_cursor` until it is `null`.
3. Store the last `ended_at` you saw (or the last cursor) and use it as the next `since` / `cursor`. Overlap by a minute and skip ids you already have, so a call that finished while you were reading is not missed.
4. A call whose recording is not ready (`recording_url` is `null`) appears again later with the link; process it when the link is there.

## 5. Errors and limits

| Status | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| `401`  | Missing, wrong or revoked key.                                   |
| `400`  | `since` or `cursor` is not valid.                                |
| `429`  | Too many requests (about 60 per minute per key). Wait and retry. |

The key only ever sees your own organisation's calls.
