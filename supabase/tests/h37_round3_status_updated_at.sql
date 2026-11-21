do $$
declare v_o uuid := 'd58885d2-2433-47cf-ad7d-acebc5106962'; v_leg uuid; r jsonb := '{}'; b jsonb;
begin
  select id into v_leg from public.call_legs where org_id=v_o and kind='contact' and outcome='connected' and disposition_id is not null limit 1;
  select to_jsonb(x) into b from public.public_api_list_calls(v_o,'-infinity',null,null,500) x where x.id=v_leg; r := r || jsonb_build_object('before',jsonb_build_object('upd',b->'updated_at','st',b->'status'));
  update public.call_legs set recording_status='paused' where id=v_leg;
  select to_jsonb(x) into b from public.public_api_list_calls(v_o,'-infinity',null,null,500) x where x.id=v_leg; r := r || jsonb_build_object('paused',jsonb_build_object('upd',b->'updated_at','st',b->'status'));
  update public.call_legs set recording_status='recording_failed' where id=v_leg;
  select to_jsonb(x) into b from public.public_api_list_calls(v_o,'-infinity',null,null,500) x where x.id=v_leg; r := r || jsonb_build_object('failed',jsonb_build_object('upd',b->'updated_at','st',b->'status'),'now',now());
  r := r || jsonb_build_object('removed',(select jsonb_agg(jsonb_build_object('d',x.disposition,'why',x.disposition_reason,'st',x.status)) from public.public_api_list_calls(v_o,'-infinity',null,null,500) x where x.disposition_reason is not null),'total',(select count(*) from public.public_api_list_calls(v_o,'-infinity',null,null,500)));
  perform set_config('proof.out', r::text, true);
end $$;
select current_setting('proof.out');
