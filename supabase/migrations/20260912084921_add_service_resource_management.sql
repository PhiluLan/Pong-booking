alter table public.vp_services
  add column if not exists late_starts_at time not null default '16:00',
  add column if not exists slot_interval_minutes smallint not null default 60 check (slot_interval_minutes between 15 and 240),
  add column if not exists buffer_before_minutes smallint not null default 0 check (buffer_before_minutes between 0 and 240),
  add column if not exists buffer_after_minutes smallint not null default 0 check (buffer_after_minutes between 0 and 240),
  add column if not exists min_notice_minutes integer not null default 0 check (min_notice_minutes between 0 and 525600),
  add column if not exists booking_horizon_days smallint check (booking_horizon_days between 1 and 730),
  add column if not exists auto_confirm boolean not null default true,
  add column if not exists payment_required boolean not null default true,
  add column if not exists featured boolean not null default false,
  add column if not exists color text not null default '#144e94' check (color ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists cancellation_hours smallint not null default 24 check (cancellation_hours between 0 and 720),
  add column if not exists cancellation_fee_percent smallint not null default 100 check (cancellation_fee_percent between 0 and 100);

update public.vp_services set featured=true where id='single-flex';

alter table public.vp_resources
  add column if not exists description text not null default '',
  add column if not exists capacity smallint not null default 8 check (capacity between 1 and 30),
  add column if not exists sort_order smallint not null default 0,
  add column if not exists anny_id bigint,
  add column if not exists buffer_before_minutes smallint not null default 0 check (buffer_before_minutes between 0 and 240),
  add column if not exists buffer_after_minutes smallint not null default 0 check (buffer_after_minutes between 0 and 240);

update public.vp_resources set sort_order=id where sort_order=0;

create table if not exists public.vp_resource_schedules (
  resource_id smallint not null references public.vp_resources(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  enabled boolean not null default true,
  opens_at time not null default '09:00',
  closes_at time not null default '00:00',
  primary key(resource_id,weekday),
  check(opens_at<>closes_at)
);
alter table public.vp_resource_schedules enable row level security;
revoke all on public.vp_resource_schedules from anon,authenticated;

insert into public.vp_resource_schedules(resource_id,weekday,enabled,opens_at,closes_at)
select r.id,d,true,time '09:00',time '00:00' from public.vp_resources r cross join generate_series(0,6) d
on conflict(resource_id,weekday) do nothing;

create or replace function public.vp_admin_catalog(p_pin text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  select jsonb_build_object(
    'services',coalesce((select jsonb_agg(to_jsonb(s) order by s.sort_order,s.short_name) from public.vp_services s),'[]'::jsonb),
    'resources',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('schedules',coalesce((select jsonb_agg(to_jsonb(sc) order by sc.weekday) from public.vp_resource_schedules sc where sc.resource_id=r.id),'[]'::jsonb)) order by r.sort_order,r.id) from public.vp_resources r),'[]'::jsonb),
    'addons',coalesce((select jsonb_agg(to_jsonb(a) order by a.sort_order,a.name) from public.vp_addons a),'[]'::jsonb),
    'rules',(select jsonb_build_object('venue_name',v.venue_name,'address',v.address,'timezone',v.timezone,'currency',v.currency,'opens_at',to_char(v.opens_at,'HH24:MI'),'closes_at',to_char(v.closes_at,'HH24:MI'),'slot_minutes',v.slot_minutes,'booking_horizon_days',v.booking_horizon_days,'cancellation_hours',v.cancellation_hours,'cancellation_fee_24h',v.cancellation_fee_24h,'cancellation_fee_12h',v.cancellation_fee_12h,'auto_confirm',v.auto_confirm,'reminders_hours',to_jsonb(v.reminders_hours)) from public.vp_settings v where v.id=true)
  ) into result;
  return result;
end; $$;

create or replace function public.vp_admin_save_service(p_pin text,p_service jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare sid text:=lower(trim(p_service->>'id')); billing_value text:=p_service->>'billing'; visibility_value text:=p_service->>'visibility'; saved jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  if sid !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or length(sid)>50 then raise exception 'Interner Schlüssel ist ungültig'; end if;
  if length(trim(coalesce(p_service->>'name',''))) not between 2 and 140 or length(trim(coalesce(p_service->>'short_name',''))) not between 2 and 60 then raise exception 'Name oder Kurzname fehlt'; end if;
  if billing_value not in ('hourly','fixed','request') or visibility_value not in ('public','internal') then raise exception 'Abrechnung oder Sichtbarkeit ist ungültig'; end if;
  if (p_service->>'min_people')::int not between 1 and 80 or coalesce((p_service->>'max_people')::int,80) not between (p_service->>'min_people')::int and 80 then raise exception 'Personenzahl ist ungültig'; end if;
  if (p_service->>'min_duration_hours')::int not between 1 and 24 or (p_service->>'max_duration_hours')::int not between (p_service->>'min_duration_hours')::int and 24 then raise exception 'Dauer ist ungültig'; end if;
  if (p_service->>'required_tables')::int not between 1 and 8 or (p_service->>'slot_interval_minutes')::int not between 15 and 240 then raise exception 'Tischanzahl oder Intervall ist ungültig'; end if;
  if coalesce(p_service->>'color','') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Farbe ist ungültig'; end if;
  insert into public.vp_services(id,anny_id,name,short_name,description,min_people,max_people,min_duration_hours,max_duration_hours,required_tables,available_from,price_cents,late_price_cents,billing,visibility,active,sort_order,late_starts_at,slot_interval_minutes,buffer_before_minutes,buffer_after_minutes,min_notice_minutes,booking_horizon_days,auto_confirm,payment_required,featured,color,cancellation_hours,cancellation_fee_percent)
  values(sid,nullif(p_service->>'anny_id','')::bigint,left(trim(p_service->>'name'),140),left(trim(p_service->>'short_name'),60),left(coalesce(p_service->>'description',''),1000),(p_service->>'min_people')::smallint,nullif(p_service->>'max_people','')::smallint,(p_service->>'min_duration_hours')::smallint,(p_service->>'max_duration_hours')::smallint,(p_service->>'required_tables')::smallint,(p_service->>'available_from')::time,nullif(p_service->>'price_cents','')::int,nullif(p_service->>'late_price_cents','')::int,billing_value,visibility_value,coalesce((p_service->>'active')::boolean,true),coalesce((p_service->>'sort_order')::smallint,100),(p_service->>'late_starts_at')::time,(p_service->>'slot_interval_minutes')::smallint,coalesce((p_service->>'buffer_before_minutes')::smallint,0),coalesce((p_service->>'buffer_after_minutes')::smallint,0),coalesce((p_service->>'min_notice_minutes')::int,0),nullif(p_service->>'booking_horizon_days','')::smallint,coalesce((p_service->>'auto_confirm')::boolean,true),coalesce((p_service->>'payment_required')::boolean,true),coalesce((p_service->>'featured')::boolean,false),lower(p_service->>'color'),coalesce((p_service->>'cancellation_hours')::smallint,24),coalesce((p_service->>'cancellation_fee_percent')::smallint,100))
  on conflict(id) do update set anny_id=excluded.anny_id,name=excluded.name,short_name=excluded.short_name,description=excluded.description,min_people=excluded.min_people,max_people=excluded.max_people,min_duration_hours=excluded.min_duration_hours,max_duration_hours=excluded.max_duration_hours,required_tables=excluded.required_tables,available_from=excluded.available_from,price_cents=excluded.price_cents,late_price_cents=excluded.late_price_cents,billing=excluded.billing,visibility=excluded.visibility,active=excluded.active,sort_order=excluded.sort_order,late_starts_at=excluded.late_starts_at,slot_interval_minutes=excluded.slot_interval_minutes,buffer_before_minutes=excluded.buffer_before_minutes,buffer_after_minutes=excluded.buffer_after_minutes,min_notice_minutes=excluded.min_notice_minutes,booking_horizon_days=excluded.booking_horizon_days,auto_confirm=excluded.auto_confirm,payment_required=excluded.payment_required,featured=excluded.featured,color=excluded.color,cancellation_hours=excluded.cancellation_hours,cancellation_fee_percent=excluded.cancellation_fee_percent;
  select to_jsonb(s) into saved from public.vp_services s where s.id=sid;
  return saved;
end; $$;

create or replace function public.vp_admin_save_resource(p_pin text,p_resource jsonb,p_schedules jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid smallint:=(p_resource->>'id')::smallint; item jsonb; saved jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  if rid not between 1 and 8 or not exists(select 1 from public.vp_resources where id=rid) then raise exception 'Ressource ist ungültig'; end if;
  if length(trim(coalesce(p_resource->>'name',''))) not between 2 and 80 or p_resource->>'area' not in ('Nord','Süd') then raise exception 'Name oder Bereich ist ungültig'; end if;
  if jsonb_typeof(p_schedules)<>'array' or jsonb_array_length(p_schedules)<>7 then raise exception 'Wochenplan ist unvollständig'; end if;
  update public.vp_resources set name=left(trim(p_resource->>'name'),80),description=left(coalesce(p_resource->>'description',''),500),area=p_resource->>'area',active=(p_resource->>'active')::boolean,capacity=(p_resource->>'capacity')::smallint,sort_order=(p_resource->>'sort_order')::smallint,anny_id=nullif(p_resource->>'anny_id','')::bigint,buffer_before_minutes=coalesce((p_resource->>'buffer_before_minutes')::smallint,0),buffer_after_minutes=coalesce((p_resource->>'buffer_after_minutes')::smallint,0) where id=rid;
  for item in select value from jsonb_array_elements(p_schedules) loop
    if (item->>'weekday')::int not between 0 and 6 then raise exception 'Wochentag ist ungültig'; end if;
    insert into public.vp_resource_schedules(resource_id,weekday,enabled,opens_at,closes_at) values(rid,(item->>'weekday')::smallint,(item->>'enabled')::boolean,(item->>'opens_at')::time,(item->>'closes_at')::time)
    on conflict(resource_id,weekday) do update set enabled=excluded.enabled,opens_at=excluded.opens_at,closes_at=excluded.closes_at;
  end loop;
  select to_jsonb(r)||jsonb_build_object('schedules',(select jsonb_agg(to_jsonb(sc) order by sc.weekday) from public.vp_resource_schedules sc where sc.resource_id=rid)) into saved from public.vp_resources r where r.id=rid;
  return saved;
end; $$;

create or replace function public.vp_admin_save_addon(p_pin text,p_addon jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare aid text:=lower(trim(p_addon->>'id')); saved jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  if aid !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or length(aid)>50 or length(trim(coalesce(p_addon->>'name',''))) not between 2 and 100 then raise exception 'Extra ist ungültig'; end if;
  insert into public.vp_addons(id,name,price_cents,active,sort_order) values(aid,left(trim(p_addon->>'name'),100),(p_addon->>'price_cents')::int,coalesce((p_addon->>'active')::boolean,true),coalesce((p_addon->>'sort_order')::smallint,100))
  on conflict(id) do update set name=excluded.name,price_cents=excluded.price_cents,active=excluded.active,sort_order=excluded.sort_order;
  select to_jsonb(a) into saved from public.vp_addons a where a.id=aid; return saved;
end; $$;

create or replace function public.vp_admin_save_rules(p_pin text,p_rules jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare saved jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  if length(trim(coalesce(p_rules->>'venue_name',''))) not between 2 and 80 or length(trim(coalesce(p_rules->>'address',''))) not between 2 and 160 then raise exception 'Betriebsdaten sind ungültig'; end if;
  if (p_rules->>'slot_minutes')::int not in (15,30,45,60,90,120) or (p_rules->>'booking_horizon_days')::int not between 1 and 730 then raise exception 'Intervall oder Horizont ist ungültig'; end if;
  update public.vp_settings set venue_name=left(trim(p_rules->>'venue_name'),80),address=left(trim(p_rules->>'address'),160),opens_at=(p_rules->>'opens_at')::time,closes_at=(p_rules->>'closes_at')::time,slot_minutes=(p_rules->>'slot_minutes')::smallint,booking_horizon_days=(p_rules->>'booking_horizon_days')::smallint,cancellation_hours=(p_rules->>'cancellation_hours')::smallint,cancellation_fee_24h=(p_rules->>'cancellation_fee_24h')::smallint,cancellation_fee_12h=(p_rules->>'cancellation_fee_12h')::smallint,auto_confirm=(p_rules->>'auto_confirm')::boolean,reminders_hours=array(select jsonb_array_elements_text(p_rules->'reminders_hours')::smallint),studio_config=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(studio_config,'{operations,venueName}',to_jsonb(p_rules->>'venue_name')),'{operations,address}',to_jsonb(p_rules->>'address')),'{operations,opensAt}',to_jsonb(p_rules->>'opens_at')),'{operations,closesAt}',to_jsonb(p_rules->>'closes_at')),'{operations,horizonDays}',to_jsonb((p_rules->>'booking_horizon_days')::int)),updated_at=now() where id=true;
  select jsonb_build_object('venue_name',venue_name,'address',address,'timezone',timezone,'currency',currency,'opens_at',to_char(opens_at,'HH24:MI'),'closes_at',to_char(closes_at,'HH24:MI'),'slot_minutes',slot_minutes,'booking_horizon_days',booking_horizon_days,'cancellation_hours',cancellation_hours,'cancellation_fee_24h',cancellation_fee_24h,'cancellation_fee_12h',cancellation_fee_12h,'auto_confirm',auto_confirm,'reminders_hours',to_jsonb(reminders_hours)) into saved from public.vp_settings where id=true;
  return saved;
end; $$;

create or replace function public.vp_public_booking_config()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_set(v.studio_config,'{operations}',(v.studio_config->'operations')||jsonb_build_object(
    'venueName',v.venue_name,'address',v.address,'opensAt',to_char(v.opens_at,'HH24:MI'),'closesAt',to_char(v.closes_at,'HH24:MI'),
    'horizonDays',coalesce(s.booking_horizon_days,v.booking_horizon_days),'maxDurationHours',s.max_duration_hours,
    'morningPriceCents',s.price_cents,'eveningPriceCents',coalesce(s.late_price_cents,s.price_cents),'eveningStartsAt',to_char(s.late_starts_at,'HH24:MI')
  ))
  from public.vp_settings v cross join public.vp_services s where v.id=true and s.id='single-flex';
$$;

create or replace function public.vp_capacity_for_slot(p_date date,p_time time,p_hours smallint)
returns integer language sql stable security definer set search_path='' as $$
  with bounds as (select (p_date+p_time) at time zone 'Europe/Zurich' st,((p_date+p_time) at time zone 'Europe/Zurich')+(p_hours||' hours')::interval en,extract(dow from p_date)::smallint dow,(extract(hour from p_time)*60+extract(minute from p_time))::int start_min,(extract(hour from p_time)*60+extract(minute from p_time))::int+p_hours*60 end_min),svc as (select * from public.vp_services where id='single-flex')
  select count(*)::int from public.vp_resources r cross join bounds x cross join svc s join public.vp_resource_schedules sc on sc.resource_id=r.id and sc.weekday=x.dow
  where r.active and sc.enabled and x.start_min>=(extract(hour from sc.opens_at)*60+extract(minute from sc.opens_at)) and x.end_min<=case when sc.closes_at=time '00:00' then 1440 else (extract(hour from sc.closes_at)*60+extract(minute from sc.closes_at)) end
    and not exists(select 1 from public.vp_allocations a where a.resource_id=r.id and a.active and a.occupied&&tstzrange(x.st-make_interval(mins=>greatest(s.buffer_before_minutes,r.buffer_before_minutes)),x.en+make_interval(mins=>greatest(s.buffer_after_minutes,r.buffer_after_minutes)),'[)'))
    and not exists(select 1 from public.vp_blocks b where (b.resource_id is null or b.resource_id=r.id) and tstzrange(b.starts_at,b.ends_at,'[)')&&tstzrange(x.st,x.en,'[)'));
$$;

create or replace function public.vp_create_sumup_hold(
  p_date date,p_time time,p_hours smallint,p_tables smallint,p_people smallint,
  p_name text,p_email text,p_phone text,p_company text default null,p_notes text default null,
  p_addons text[] default '{}',p_website text default '',p_status_token text default null
)
returns table(booking_id uuid,reference text,price_cents integer,expires_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare
  st timestamptz; en timestamptz; bid uuid:=gen_random_uuid(); ref text:='VP-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  res record; allocated smallint:=0; total integer; expiry timestamptz:=now()+interval '30 minutes'; cfg public.vp_settings; svc public.vp_services; horizon int;
begin
  perform public.vp_release_expired_payment_holds();
  select * into cfg from public.vp_settings where id=true;
  select * into svc from public.vp_services where id='single-flex' and active;
  if not found then raise exception 'Die Online-Buchungsoption ist deaktiviert'; end if;
  horizon:=coalesce(svc.booking_horizon_days,cfg.booking_horizon_days);
  if coalesce(p_website,'')<>'' or p_status_token is null or length(p_status_token)<32 then raise exception 'Ungültige Anfrage'; end if;
  if p_hours not between svc.min_duration_hours and svc.max_duration_hours or p_tables not between 1 and 8 then raise exception 'Ungültige Dauer oder Tischanzahl'; end if;
  if p_people not between greatest(1,svc.min_people) and p_tables*svc.max_people then raise exception 'Bitte passende Personenzahl angeben'; end if;
  if p_date<current_date or p_date>current_date+horizon or p_time<cfg.opens_at or (cfg.closes_at=time '00:00' and extract(hour from p_time)+p_hours>24) or (cfg.closes_at<>time '00:00' and p_time+(p_hours||' hours')::interval>cfg.closes_at) then raise exception 'Zeitpunkt nicht buchbar'; end if;
  if length(trim(p_name))<2 or p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(trim(p_phone))<7 then raise exception 'Bitte vollständige Kontaktdaten angeben'; end if;
  if (select count(*) from public.vp_bookings where lower(customer_email)=lower(trim(p_email)) and payment_status='pending' and created_at>now()-interval '30 minutes')>=3 then raise exception 'Zu viele offene Zahlungsvorgänge. Bitte später erneut versuchen.'; end if;
  st:=(p_date+p_time) at time zone cfg.timezone; en:=st+(p_hours||' hours')::interval;
  if st<=now()+make_interval(mins=>svc.min_notice_minutes) then raise exception 'Diese Startzeit liegt innerhalb der Vorlaufzeit'; end if;
  select sum(case when p_time+(h||' hours')::interval>=svc.late_starts_at then coalesce(svc.late_price_cents,svc.price_cents) else svc.price_cents end)*p_tables+coalesce((select sum(a.price_cents) from public.vp_addons a where a.active and a.id=any(coalesce(p_addons,'{}'))),0) into total from generate_series(0,p_hours-1) h;
  insert into public.vp_bookings(id,reference,service_id,starts_at,ends_at,guest_count,customer_name,customer_email,customer_phone,company,notes,status,payment_status,payment_provider,price_cents,pin_code,addon_ids,payment_expires_at,payment_status_token_hash)
  values(bid,ref,svc.id,st,en,p_people,trim(p_name),lower(trim(p_email)),trim(p_phone),nullif(trim(p_company),''),nullif(trim(p_notes),''),'request','pending','sumup',total,'0000',p_addons,expiry,extensions.digest(p_status_token,'sha256'));
  for res in select r.* from public.vp_resources r join public.vp_resource_schedules sc on sc.resource_id=r.id and sc.weekday=extract(dow from p_date)::smallint where r.active and sc.enabled
    and (extract(hour from p_time)*60+extract(minute from p_time)) >= (extract(hour from sc.opens_at)*60+extract(minute from sc.opens_at))
    and (extract(hour from p_time)*60+extract(minute from p_time)+p_hours*60) <= case when sc.closes_at=time '00:00' then 1440 else (extract(hour from sc.closes_at)*60+extract(minute from sc.closes_at)) end
    and not exists(select 1 from public.vp_allocations a where a.resource_id=r.id and a.active and a.occupied&&tstzrange(st-make_interval(mins=>greatest(svc.buffer_before_minutes,r.buffer_before_minutes)),en+make_interval(mins=>greatest(svc.buffer_after_minutes,r.buffer_after_minutes)),'[)'))
    and not exists(select 1 from public.vp_blocks b where (b.resource_id is null or b.resource_id=r.id) and tstzrange(b.starts_at,b.ends_at,'[)')&&tstzrange(st,en,'[)')) order by r.sort_order,r.id limit p_tables
  loop
    insert into public.vp_allocations(booking_id,resource_id,occupied) values(bid,res.id,tstzrange(st-make_interval(mins=>greatest(svc.buffer_before_minutes,res.buffer_before_minutes)),en+make_interval(mins=>greatest(svc.buffer_after_minutes,res.buffer_after_minutes)),'[)'));
    allocated:=allocated+1;
  end loop;
  if allocated<p_tables then raise exception 'Diese Auswahl wurde gerade vergeben. Bitte neu wählen.'; end if;
  return query select bid,ref,total,expiry;
end; $$;

revoke execute on function public.vp_admin_catalog(text) from public;
revoke execute on function public.vp_admin_save_service(text,jsonb) from public;
revoke execute on function public.vp_admin_save_resource(text,jsonb,jsonb) from public;
revoke execute on function public.vp_admin_save_addon(text,jsonb) from public;
revoke execute on function public.vp_admin_save_rules(text,jsonb) from public;
revoke execute on function public.vp_capacity_for_slot(date,time,smallint) from public,anon,authenticated;
grant execute on function public.vp_admin_catalog(text) to anon,authenticated;
grant execute on function public.vp_admin_save_service(text,jsonb) to anon,authenticated;
grant execute on function public.vp_admin_save_resource(text,jsonb,jsonb) to anon,authenticated;
grant execute on function public.vp_admin_save_addon(text,jsonb) to anon,authenticated;
grant execute on function public.vp_admin_save_rules(text,jsonb) to anon,authenticated;
grant execute on function public.vp_capacity_for_slot(date,time,smallint) to service_role;
revoke execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text) from public,anon,authenticated;
grant execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text) to service_role;
