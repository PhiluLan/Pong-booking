create or replace function public.vp_create_sumup_hold(
  p_date date,p_time time,p_hours smallint,p_tables smallint,p_people smallint,
  p_name text,p_email text,p_phone text,p_company text default null,p_notes text default null,
  p_addons text[] default '{}',p_website text default '',p_status_token text default null,p_discount_code text default null
)
returns table(booking_id uuid,reference text,price_cents integer,expires_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare
  st timestamptz; en timestamptz; bid uuid:=gen_random_uuid(); ref text:='VP-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  res record; allocated smallint:=0; subtotal integer; discount integer:=0; total integer; expiry timestamptz; cfg public.vp_settings; svc public.vp_services; horizon int;
  promo public.vp_discount_codes; consumed integer;
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
  if cardinality(coalesce(p_addons,'{}'))>100 then raise exception 'Zu viele Extras ausgewählt'; end if;
  if exists(select 1 from unnest(coalesce(p_addons,'{}')) addon_id group by addon_id having count(*)>20) then raise exception 'Maximal 20 Stück pro Extra'; end if;
  if exists(select 1 from unnest(coalesce(p_addons,'{}')) addon_id where not exists(select 1 from public.vp_addons a where a.id=addon_id and a.active)) then raise exception 'Ein ausgewähltes Extra ist nicht verfügbar'; end if;
  if (select count(*) from public.vp_bookings where lower(customer_email)=lower(trim(p_email)) and payment_status='pending' and created_at>now()-interval '30 minutes')>=3 then raise exception 'Zu viele offene Zahlungsvorgänge. Bitte später erneut versuchen.'; end if;
  st:=(p_date+p_time) at time zone cfg.timezone; en:=st+(p_hours||' hours')::interval;
  if st<=now()+make_interval(mins=>svc.min_notice_minutes) then raise exception 'Diese Startzeit liegt innerhalb der Vorlaufzeit'; end if;
  select sum(case when p_time+(h||' hours')::interval>=svc.late_starts_at then coalesce(svc.late_price_cents,svc.price_cents) else svc.price_cents end)*p_tables
    +coalesce((select sum(a.price_cents) from unnest(coalesce(p_addons,'{}')) addon_id join public.vp_addons a on a.id=addon_id and a.active),0)
    into subtotal from generate_series(0,p_hours-1) h;
  if nullif(trim(coalesce(p_discount_code,'')),'') is not null then
    select * into promo from public.vp_discount_codes d where d.code=upper(trim(p_discount_code)) for update;
    if not found or not promo.active or current_date not between promo.valid_from and promo.valid_until then raise exception 'Dieser Rabattcode ist nicht gültig'; end if;
    select count(*) into consumed from public.vp_discount_redemptions where discount_id=promo.id and status in ('reserved','redeemed');
    if consumed>=promo.max_redemptions then raise exception 'Dieser Rabattcode ist nicht mehr verfügbar'; end if;
    discount:=case when promo.discount_type='percent' then round(subtotal*promo.discount_value/100.0)::integer else least(subtotal,promo.discount_value) end;
  end if;
  total:=greatest(0,subtotal-discount); expiry:=case when total=0 then null else now()+interval '30 minutes' end;
  insert into public.vp_bookings(id,reference,service_id,starts_at,ends_at,guest_count,customer_name,customer_email,customer_phone,company,notes,status,payment_status,payment_provider,price_cents,pin_code,addon_ids,payment_expires_at,payment_verified_at,payment_status_token_hash,discount_code_id,discount_code,subtotal_cents,discount_cents)
  values(bid,ref,svc.id,st,en,p_people,trim(p_name),lower(trim(p_email)),trim(p_phone),nullif(trim(p_company),''),nullif(trim(p_notes),''),'request',case when total=0 then 'paid' else 'pending' end,case when total=0 then 'discount' else 'sumup' end,total,'0000',p_addons,expiry,case when total=0 then now() else null end,extensions.digest(p_status_token,'sha256'),promo.id,promo.code,subtotal,discount);
  if promo.id is not null then insert into public.vp_discount_redemptions(booking_id,discount_id,status,redeemed_at) values(bid,promo.id,case when total=0 then 'redeemed' else 'reserved' end,case when total=0 then now() else null end); end if;
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

revoke execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text,text) from public,anon,authenticated;
grant execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text,text) to service_role;
