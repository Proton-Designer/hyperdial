-- MISSION-5 B4 follow-up (SHOULD): the two settings tables TASK-M5-B4 added
-- (org_supervisor_alert_settings, user_notification_preferences) are both directly writable by an
-- authenticated client through RLS (owner/admin for the former; self or owner/admin for the
-- latter) with no edge function or audit call in between -- exactly the shape
-- 20260927080000_org_audit_log.sql's generic `private.audit_log_settings_change_trigger()` exists
-- to cover, and which org_spend_settings/org_reliability_alert_settings/org_recording_settings/
-- org_transfer_settings already use. Reuses that same trigger function unmodified (append-only:
-- this migration only ADDS two more `create trigger`s, it does not touch the function body or any
-- existing trigger).
--
-- user_notification_preferences is per-(org, user, alert_type) rather than a single per-org row,
-- but the generic trigger only ever needs `new.org_id`/`old.org_id` to exist (both true here), and
-- the row it embeds in `details` (via to_jsonb(new/old)) already carries user_id + alert_type, so
-- the audit entry says exactly which user's preference for which alert type changed -- no
-- table-specific logic needed.

create trigger org_supervisor_alert_settings_audit
  after insert or update on public.org_supervisor_alert_settings
  for each row execute function private.audit_log_settings_change_trigger('settings.supervisor_alerts.update', 'org_supervisor_alert_settings');

create trigger user_notification_preferences_audit
  after insert or update on public.user_notification_preferences
  for each row execute function private.audit_log_settings_change_trigger('settings.notification_preferences.update', 'user_notification_preferences');
