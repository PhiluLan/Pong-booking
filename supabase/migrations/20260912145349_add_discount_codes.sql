create table if not exists public.vp_discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  internal_name text not null,
  discount_type text not null check (discount_type in ('percent','fixed')),
  discount_value integer not null check (discount_value > 0),
  valid_from date not null,
  valid_until date not null,
  max_redemptions integer not null check (max_redemptions > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vp_discount_codes_dates_check check (valid_until >= valid_from),
  constraint vp_discount_codes_value_check check (
    (discount_type = 'percent' and discount_value between 1 and 100)
    or (discount_type = 'fixed' and discount_value between 1 and 1000000)
  )
);

create table if not exists public.vp_discount_redemptions (
  booking_id uuid primary key references public.vp_bookings(id) on delete cascade,
  discount_id uuid not null references public.vp_discount_codes(id) on delete restrict,
  status text not null check (status in ('reserved','redeemed','released')),
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  released_at timestamptz
);

create index if not exists vp_discount_redemptions_discount_status_idx
  on public.vp_discount_redemptions(discount_id,status);

alter table public.vp_discount_codes enable row level security;
alter table public.vp_discount_redemptions enable row level security;
revoke all on public.vp_discount_codes from anon,authenticated;
revoke all on public.vp_discount_redemptions from anon,authenticated;
grant all on public.vp_discount_codes to service_role;
grant all on public.vp_discount_redemptions to service_role;

alter table public.vp_bookings
  add column if not exists discount_code_id uuid references public.vp_discount_codes(id) on delete set null,
  add column if not exists discount_code text,
  add column if not exists subtotal_cents integer,
  add column if not exists discount_cents integer not null default 0;

update public.vp_bookings set subtotal_cents=price_cents where subtotal_cents is null;

create or replace function public.vp_admin_catalog(p_pin text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  select jsonb_build_object(
    'services',coalesce((select jsonb_agg(to_jsonb(s) order by s.sort_order,s.short_name) from public.vp_services s),'[]'::jsonb),
    'resources',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('schedules',coalesce((select jsonb_agg(to_jsonb(sc) order by sc.weekday) from public.vp_resource_schedules sc where sc.resource_id=r.id),'[]'::jsonb)) order by r.sort_order,r.id) from public.vp_resources r),'[]'::jsonb),
    'addons',coalesce((select jsonb_agg(to_jsonb(a) order by a.sort_order,a.name) from public.vp_addons a),'[]'::jsonb),
    'discounts',coalesce((select jsonb_agg(to_jsonb(d)||jsonb_build_object(
      'used_redemptions',(select count(*) from public.vp_discount_redemptions x where x.discount_id=d.id and x.status='redeemed'),
      'reserved_redemptions',(select count(*) from public.vp_discount_redemptions x where x.discount_id=d.id and x.status='reserved'),
      'remaining_redemptions',greatest(0,d.max_redemptions-(select count(*) from public.vp_discount_redemptions x where x.discount_id=d.id and x.status in ('reserved','redeemed')))
    ) order by d.active desc,d.valid_until desc,d.code) from public.vp_discount_codes d),'[]'::jsonb),
    'rules',(select jsonb_build_object('venue_name',v.venue_name,'address',v.address,'timezone',v.timezone,'currency',v.currency,'opens_at',to_char(v.opens_at,'HH24:MI'),'closes_at',to_char(v.closes_at,'HH24:MI'),'slot_minutes',v.slot_minutes,'booking_horizon_days',v.booking_horizon_days,'cancellation_hours',v.cancellation_hours,'cancellation_fee_24h',v.cancellation_fee_24h,'cancellation_fee_12h',v.cancellation_fee_12h,'auto_confirm',v.auto_confirm,'reminders_hours',to_jsonb(v.reminders_hours)) from public.vp_settings v where v.id=true)
  ) into result;
  return result;
end; $$;

create or replace function public.vp_admin_save_discount(p_pin text,p_discount jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  did uuid:=coalesce(nullif(p_discount->>'id','')::uuid,gen_random_uuid());
  normalized_code text:=upper(trim(coalesce(p_discount->>'code','')));
  dtype text:=p_discount->>'discount_type';
  dvalue integer:=(p_discount->>'discount_value')::integer;
  maximum integer:=(p_discount->>'max_redemptions')::integer;
  active_uses integer;
  saved jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  if normalized_code !~ '^[A-Z0-9][A-Z0-9-]{2,31}$' then raise exception 'Der Rabattcode benötigt 3–32 Buchstaben, Zahlen oder Bindestriche'; end if;
  if length(trim(coalesce(p_discount->>'internal_name',''))) not between 2 and 100 then raise exception 'Der interne Name fehlt'; end if;
  if dtype not in ('percent','fixed') or (dtype='percent' and dvalue not between 1 and 100) or (dtype='fixed' and dvalue not between 1 and 1000000) then raise exception 'Der Rabatt ist ungültig'; end if;
  if (p_discount->>'valid_until')::date < (p_discount->>'valid_from')::date then raise exception 'Das Enddatum liegt vor dem Startdatum'; end if;
  if maximum not between 1 and 1000000 then raise exception 'Die Anzahl Verwendungen ist ungültig'; end if;
  if exists(select 1 from public.vp_discount_codes where code=normalized_code and id<>did) then raise exception 'Dieser Rabattcode existiert bereits'; end if;
  select count(*) into active_uses from public.vp_discount_redemptions where discount_id=did and status in ('reserved','redeemed');
  if maximum<active_uses then raise exception 'Die Anzahl kann nicht unter bereits verwendete oder reservierte Codes gesetzt werden'; end if;
  insert into public.vp_discount_codes(id,code,internal_name,discount_type,discount_value,valid_from,valid_until,max_redemptions,active)
  values(did,normalized_code,left(trim(p_discount->>'internal_name'),100),dtype,dvalue,(p_discount->>'valid_from')::date,(p_discount->>'valid_until')::date,maximum,coalesce((p_discount->>'active')::boolean,true))
  on conflict(id) do update set code=excluded.code,internal_name=excluded.internal_name,discount_type=excluded.discount_type,discount_value=excluded.discount_value,valid_from=excluded.valid_from,valid_until=excluded.valid_until,max_redemptions=excluded.max_redemptions,active=excluded.active,updated_at=now();
  select to_jsonb(d)||jsonb_build_object(
    'used_redemptions',(select count(*) from public.vp_discount_redemptions x where x.discount_id=d.id and x.status='redeemed'),
    'reserved_redemptions',(select count(*) from public.vp_discount_redemptions x where x.discount_id=d.id and x.status='reserved'),
    'remaining_redemptions',greatest(0,d.max_redemptions-(select count(*) from public.vp_discount_redemptions x where x.discount_id=d.id and x.status in ('reserved','redeemed')))
  ) into saved from public.vp_discount_codes d where d.id=did;
  return saved;
end; $$;

create or replace function public.vp_discount_quote(p_code text,p_subtotal integer)
returns table(code text,discount_cents integer,total_cents integer,remaining_redemptions integer)
language plpgsql security definer set search_path='' as $$
declare d public.vp_discount_codes; consumed integer; amount integer;
begin
  if p_subtotal is null or p_subtotal<0 then raise exception 'Ungültiger Buchungsbetrag'; end if;
  select * into d from public.vp_discount_codes x where x.code=upper(trim(coalesce(p_code,'')));
  if not found or not d.active or current_date not between d.valid_from and d.valid_until then raise exception 'Dieser Rabattcode ist nicht gültig'; end if;
  select count(*) into consumed from public.vp_discount_redemptions where discount_id=d.id and status in ('reserved','redeemed');
  if consumed>=d.max_redemptions then raise exception 'Dieser Rabattcode ist nicht mehr verfügbar'; end if;
  amount:=case when d.discount_type='percent' then round(p_subtotal*d.discount_value/100.0)::integer else least(p_subtotal,d.discount_value) end;
  return query select d.code,amount,greatest(0,p_subtotal-amount),d.max_redemptions-consumed;
end; $$;

create or replace function public.vp_release_expired_payment_holds()
returns integer language plpgsql security definer set search_path='' as $$
declare released integer;
begin
  with expired as (
    update public.vp_bookings set payment_status='expired',status='cancelled',updated_at=now()
    where payment_status='pending' and payment_expires_at<=now() returning id
  ), release_codes as (
    update public.vp_discount_redemptions d set status='released',released_at=now()
    where d.status='reserved' and d.booking_id in (select id from expired) returning d.booking_id
  ) select count(*) into released from expired;
  update public.vp_allocations a set active=false where a.active and exists(select 1 from public.vp_bookings b where b.id=a.booking_id and b.payment_status in ('failed','expired'));
  return released;
end; $$;

drop function if exists public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text);
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
  if (select count(*) from public.vp_bookings where lower(customer_email)=lower(trim(p_email)) and payment_status='pending' and created_at>now()-interval '30 minutes')>=3 then raise exception 'Zu viele offene Zahlungsvorgänge. Bitte später erneut versuchen.'; end if;
  st:=(p_date+p_time) at time zone cfg.timezone; en:=st+(p_hours||' hours')::interval;
  if st<=now()+make_interval(mins=>svc.min_notice_minutes) then raise exception 'Diese Startzeit liegt innerhalb der Vorlaufzeit'; end if;
  select sum(case when p_time+(h||' hours')::interval>=svc.late_starts_at then coalesce(svc.late_price_cents,svc.price_cents) else svc.price_cents end)*p_tables+coalesce((select sum(a.price_cents) from public.vp_addons a where a.active and a.id=any(coalesce(p_addons,'{}'))),0) into subtotal from generate_series(0,p_hours-1) h;
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

create or replace function public.vp_fail_sumup_hold(p_booking_id uuid,p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  with failed as (
    update public.vp_bookings set payment_status='failed',status='cancelled',payment_provider_payload=coalesce(p_payload,'{}'::jsonb),updated_at=now()
    where id=p_booking_id and payment_status='pending' returning id
  ) update public.vp_discount_redemptions d set status='released',released_at=now() where d.status='reserved' and d.booking_id in(select id from failed);
  update public.vp_allocations set active=false where booking_id=p_booking_id and exists(select 1 from public.vp_bookings where id=p_booking_id and payment_status='failed');
end; $$;

create or replace function public.vp_reconcile_sumup_checkout(p_checkout_id text,p_provider_status text,p_event_key text,p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare bid uuid; normalized text:=upper(coalesce(p_provider_status,''));
begin
  insert into public.vp_payment_events(provider,event_key,checkout_id,status,payload) values('sumup',p_event_key,p_checkout_id,normalized,coalesce(p_payload,'{}'::jsonb)) on conflict(provider,event_key) do nothing;
  select id into bid from public.vp_bookings where payment_checkout_id=p_checkout_id for update;
  if bid is null then raise exception 'Unbekannter SumUp-Checkout'; end if;
  if normalized='PAID' then
    update public.vp_bookings set payment_status='paid',status=case when anny_sync_status='confirmed' then 'confirmed' else 'request' end,payment_verified_at=coalesce(payment_verified_at,now()),payment_provider_payload=coalesce(p_payload,'{}'::jsonb),updated_at=now() where id=bid;
    update public.vp_discount_redemptions set status='redeemed',redeemed_at=coalesce(redeemed_at,now()) where booking_id=bid and status='reserved';
  elsif normalized in ('FAILED','EXPIRED') then
    update public.vp_bookings set payment_status=lower(normalized),status='cancelled',payment_provider_payload=coalesce(p_payload,'{}'::jsonb),updated_at=now() where id=bid and payment_status<>'paid';
    update public.vp_discount_redemptions d set status='released',released_at=now() where d.booking_id=bid and d.status='reserved' and exists(select 1 from public.vp_bookings where id=bid and payment_status in ('failed','expired'));
    update public.vp_allocations set active=false where booking_id=bid and exists(select 1 from public.vp_bookings where id=bid and payment_status in ('failed','expired'));
  end if;
end; $$;

revoke execute on function public.vp_admin_save_discount(text,jsonb) from public;
revoke execute on function public.vp_discount_quote(text,integer) from public,anon,authenticated;
revoke execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text,text) from public,anon,authenticated;
grant execute on function public.vp_admin_save_discount(text,jsonb) to anon,authenticated;
grant execute on function public.vp_discount_quote(text,integer) to service_role;
grant execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text,text) to service_role;
