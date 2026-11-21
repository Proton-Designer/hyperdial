-- TASK-H23 G: wrap-up showed "Left voicemail" twice and "Do not call" twice. Existing orgs carry the original seed keys
-- ('voicemail', 'dnc') AND the keys dispositions_v2 added ('voicemail_left', 'do_not_call'); the originals are the ones with
-- history (call_legs rows) and the retry rules, so the newer duplicate is switched off where its twin is active.
-- Data only: no row is deleted, no call_legs / campaign_retry_rules row is touched (call_legs.outcome 'voicemail_left' is a
-- different thing and is not involved). seed_default_dispositions is left alone: a new org only gets the new-name pair, so it
-- never has two. Idempotent. Re-enable from Settings > Dispositions if ever wanted.
update public.dispositions d
   set active = false,
       updated_at = now()
 where d.active
   and ((d.key = 'voicemail_left' and exists (
           select 1 from public.dispositions c
            where c.org_id = d.org_id and c.key = 'voicemail' and c.active))
     or (d.key = 'do_not_call' and exists (
           select 1 from public.dispositions c
            where c.org_id = d.org_id and c.key = 'dnc' and c.active)));
