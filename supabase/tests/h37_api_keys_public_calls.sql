do $$
declare v_u uuid; v_o uuid := 'd58885d2-2433-47cf-ad7d-acebc5106962'; r jsonb; k text; h text; c record; res jsonb;
begin
  select m.user_id into v_u from public.org_members m where m.org_id=v_o and m.role in ('owner','admin') limit 1;
  update public.profiles set active_org_id=v_o where user_id=v_u;
  perform set_config('request.jwt.claims', json_build_object('sub',v_u,'role','authenticated')::text, true);
  r := public.create_org_api_key('proof');
  k := r->>'key';
  h := encode(extensions.digest(convert_to(k,'UTF8'),'sha256'),'hex');
  perform set_config('proof.out', jsonb_build_object('keylen',length(k),'prefix',r->>'key_prefix','chk',(select to_jsonb(x) from public.public_api_check_key(h) x),
    'bad',(select count(*) from public.public_api_check_key(repeat('0',64))),
    'page',(select jsonb_agg(to_jsonb(y)) from (select * from public.public_api_list_calls(v_o,'-infinity',null,null,3)) y),
    'total',(select count(*) from public.public_api_list_calls(v_o,'-infinity',null,null,500)),
    'other_org_leak',(select count(*) from public.public_api_list_calls(v_o,'-infinity',null,null,500) z where z.id in (select id from public.call_legs where org_id<>v_o)))::text, true);
end $$;
select current_setting('proof.out');
