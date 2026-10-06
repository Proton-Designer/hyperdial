// TASK-S05: cron (hourly). Once per org per week after Monday 00:30 local: power_dial_pct + power_week,
// Power week for the winners and Week closed for everyone (shifts_week_close_run; guard
// shift_settings.last_closed_week).
import { handleCronJob } from '../_shared/shifts-io.ts';

Deno.serve((req) => handleCronJob(req, 'shifts-week-close', 'shifts_week_close_run'));
