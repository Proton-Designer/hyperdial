# Shifts: setup and GoHighLevel go-live

For the people turning Shifts on for a real team. Four parts: switch it on in HyperDial, set up GoHighLevel (GHL), verify the sync,
and know what runs by itself. How the feature works is in `.brain/domains/shifts.md`; this page is only the steps.

Shifts is off for every org until an owner or admin turns it on. Interns (role `agent`) pick weekly shifts, the team manager
("Henry" below, role `manager`) approves changes, and everything is mirrored to each intern's GHL contact.

## 1. Turn it on in HyperDial (owner or admin)

1. **Settings → Team → Pods.** Create the pod Henry will run (for example "Interns"), put each intern in it (the Pod column on the roster), and tick that pod
   under Henry's name. Henry must have the role `manager`; a manager only sees the interns of their own pods. Use `admin` instead if Henry should see everyone.
2. **Team Shifts → Setup → Turn on Shifts.** The Shifts tab then appears for interns and the Team Shifts tab shows the Coverage, Requests and Shift KPIs views.
3. Still in **Setup**, check the defaults (they follow the original spec):
   - **Open hours**: Mon to Fri 7 AM to 9 PM, Saturday until noon, Sunday closed.
   - **High leverage windows**: Morning 7 to 10, Lunch 11 to 2, After work 4 to 6 (weekdays).
   - **Settings**: 8 hour weekly minimum, picks close Sunday 6 PM, 12 hours change notice, 10 minute grace, 60 second conversation, 20 minute idle flag,
     75% adherence, 2 people coverage alert, 80% for a Power week. The time zone is America/Chicago and is not editable on this screen.
4. **Interns** list in Setup: leave "Takes part" on for each intern, off for anyone who should not have shifts (managers and admins are off by default).
   These open hours, windows and settings are one config for the whole org.

Check: sign in as an intern. The Shifts tab shows Pick Next Week with the high leverage times highlighted.

## 2. GoHighLevel setup (Kareem)

HyperDial uses the GHL connection the org already has (Settings → Integrations). There are no extra secrets to set.

1. **Token scopes.** The private integration behind that connection needs these scopes, or the sync stops with "GHL denied access (403)":
   `calendars.readonly`, `calendars/events.readonly`, `calendars/events.write`, `contacts.readonly`, `contacts.write`, `locations/customFields.readonly`.
   Add any that are missing in GHL (Settings → Private Integrations), then reconnect in Settings → Integrations.
2. **Calendar.** Create a calendar named **Intern Shifts**, type **Class Booking**, Henry as the only team member, seats per slot 100 (any number of interns can
   work the same time). Turn **off** Allow reschedule and Allow cancellation. Do not publish its booking link anywhere. Copy its calendar id.
3. **Custom fields.** Create these in a contact field folder named **Intern Shifts**. The key must match exactly (GHL shows it as `contact.<key>`).

   | Key                                                                                                                                                                                                                                                              | Type                                                |
   | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
   | `shift_hours_this_week`, `shift_hours_next_week`, `shift_min_hours_this_week`, `shift_power_hours_this_week`, `shift_power_hours_next_week`, `shift_requests_pending`                                                                                            | Number                                              |
   | `shift_week_submitted`, `shift_light_week`, `shift_last_request_late`, `week_power_week`                                                                                                                                                                         | Single option: Yes, No                              |
   | `shift_schedule_this_week`, `shift_schedule_next_week`, `shift_last_request_reason`, `shift_last_request_note`                                                                                                                                                   | Large text                                          |
   | `shift_last_request_type`, `last_shift_flags`, `week_power_summary`, `hyper_dialer_user_id`                                                                                                                                                                      | Text                                                |
   | `shift_last_request_status`                                                                                                                                                                                                                                      | Single option: pending, approved, denied, withdrawn |
   | `shift_next_shift_at`, `last_shift_date`                                                                                                                                                                                                                         | Date                                                |
   | `last_shift_status`                                                                                                                                                                                                                                              | Single option: completed, missed                    |
   | `last_shift_active_minutes`, `last_shift_power_active_minutes`, `last_shift_adherence_pct`, `last_shift_dials`, `last_shift_connects`, `last_shift_conversations`, `last_shift_talk_minutes`, `last_shift_longest_idle_minutes`, `last_shift_late_start_minutes` | Number                                              |
   | `week_dial_minutes`, `week_power_dial_minutes`, `week_power_dial_pct`, `week_dials`, `week_conversations`, `week_adherence_pct`, `week_missed_shifts`, `power_weeks_total`, `shifts_missed_total`                                                                | Number                                              |

   HyperDial finds each field by its key at sync time. If a field is missing, that row stays in error naming it under **Setup → GoHighLevel sync** and none of that row's fields are written.
   Creating it and pressing Retry fixes it; nothing is lost.

4. **Event tags.** Create these 15 tags (every event adds one, which is what fires your workflows):
   `shift-evt-submitted`, `shift-evt-not-submitted`, `shift-evt-under-minimum`, `shift-evt-request-created`, `shift-evt-request-late`,
   `shift-evt-request-approved`, `shift-evt-request-denied`, `shift-evt-request-withdrawn`, `shift-evt-admin-edit`, `shift-evt-completed`,
   `shift-evt-missed`, `shift-evt-flagged`, `shift-evt-off-shift-dialing`, `shift-evt-power-week`, `shift-evt-week-closed`.
5. **Back in HyperDial: Team Shifts → Setup.**
   - Settings → GoHighLevel: paste the **Calendar ID** and Henry's **GHL user ID** (the owner of the appointments).
   - Interns list: paste each intern's **GHL contact id**, or press **Find in GHL** to look them up by email (exact match; it shows what it found before you save).
     An intern without a contact id gets a sync row error ("intern has no GHL contact id") until you add it.
6. **Workflows** (optional, built in GHL, starting points): shift reminder 30 minutes before start (trigger Customer Booked Appointment on Intern Shifts), and
   one workflow per tag (not submitted, under minimum, new request, late request, decided, missed, flagged, Power week, week closed).
   Rule while there is no GHL → app sync: change shifts in HyperDial only, never in GHL.

## 3. Go-live checks

Use a real test intern with a GHL contact id. Tick each off; "Setup → GoHighLevel sync" should stay empty throughout.

- [ ] Picking 2:00 to 2:30 and 2:30 to 3:00 PM (same activity) gives one 2 to 3 PM shift and one appointment on Intern Shifts.
- [ ] Approving a **move** changes the same appointment (same id, new time). Approving a **drop** shows it Cancelled in GHL.
- [ ] Shifts in the week of Nov 2 land at the right local time after daylight saving ends (-06:00).
- [ ] Each event on the contact shows fields updated, a note added and the tag: week submitted, not submitted, under minimum, request created / late / approved / denied / withdrawn, admin edit, shift completed, missed, flagged, off-shift dialing, Power week, week closed.
- [ ] The same event twice (two requests, two missed shifts) fires the workflow both times.
- [ ] A workflow triggered by a tag reads the new field values, not the old ones.
- [ ] A shift with zero dials is marked missed, the appointment goes to No Show, and `shift-evt-missed` is added.
- [ ] A dial session with no shift in progress adds `shift-evt-off-shift-dialing`.
- [ ] Disconnect or break the token: rows wait with "GHL token rejected" (Setup shows a Reconnect callout). Restore it, press **Retry all**, rows clear.

## 4. What runs by itself, and where to look

Times are in the org time zone (Central by default). Nothing here needs a person.

| What                | When                                    | Does                                                                                                                |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GoHighLevel sync    | every minute, and right after a change  | sends queued appointments, fields, notes, tags                                                                      |
| Shift results       | every 15 minutes                        | computes live numbers; a shift that ended more than 2 hours ago is finalized as completed (or missed with no dials) |
| Pick deadline check | hourly, acts once after Sunday 6 PM     | notifies interns who have not submitted; flags anyone under their minimum                                           |
| Week close          | hourly, acts once after Monday 12:30 AM | final weekly numbers, Power week, Week closed                                                                       |
| Cleanup             | daily 3:40 AM UTC                       | removes finished sync rows older than 14 days                                                                       |

When something looks off:

1. **Team Shifts → Setup → GoHighLevel sync.** "GoHighLevel isn't connected" means connect it in Settings → Integrations (updates wait, nothing is lost).
   A list of errors shows the reason per item; fix it (missing field, missing contact id, calendar id) and press Retry.
2. No Shift KPIs for a shift: results appear once dialing happened inside the shift (the Dialer session must have run with the intern signed in).
3. Updates sit "waiting" for more than a few minutes with GHL connected: check the token scopes (step 2.1), then Retry all.
