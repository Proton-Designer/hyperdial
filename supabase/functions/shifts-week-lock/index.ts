// TASK-S05: cron (hourly). Once per org per week after the pick deadline: Not submitted (+ a notification)
// for interns who have not submitted next week, Under minimum for those below their minimum. The work and
// the once-per-week guard (shift_settings.last_locked_week) live in shifts_week_lock_run.
import { handleCronJob } from '../_shared/shifts-io.ts';

Deno.serve((req) => handleCronJob(req, 'shifts-week-lock', 'shifts_week_lock_run'));
