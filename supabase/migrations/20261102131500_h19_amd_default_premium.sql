-- TASK-H19: new campaigns default to premium answering-machine detection (was 'off'). Existing rows are NOT rewritten;
-- 'off' stays selectable per campaign.
alter table public.campaigns alter column amd_mode set default 'premium';
