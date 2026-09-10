-- Volta Pong Reservations MVP. All objects are namespaced with vp_.
create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create type public.vp_booking_status as enum ('request','confirmed','checked_in','completed','cancelled','no_show','waitlist');
exception when duplicate_object then null; end $$;

create table if not exists public.vp_settings (
  id boolean primary key default true check (id), venue_name text not null,
  address text not null, timezone text not null default 'Europe/Zurich', currency text not null default 'CHF',
  opens_at time not null default '09:00', closes_at time not null default '00:00',
  slot_minutes smallint not null default 60, booking_horizon_days smallint not null default 120,
  cancellation_hours smallint not null default 12, cancellation_fee_24h smallint not null default 25,
  cancellation_fee_12h smallint not null default 100, auto_confirm boolean not null default true,
  reminders_hours smallint[] not null default '{24,2}', admin_pin_hash text,
  updated_at timestamptz not null default now()
);
create table if not exists public.vp_resources (
  id smallint primary key check (id between 1 and 8), name text not null unique,
  area text not null check (area in ('Nord','Süd')), active boolean not null default true
);
create table if not exists public.vp_services (
  id text primary key, anny_id bigint, name text not null, short_name text not null,
  description text not null, min_people smallint not null, max_people smallint,
  min_duration_hours smallint not null, max_duration_hours smallint not null,
  required_tables smallint not null, available_from time not null default '09:00',
  price_cents integer, late_price_cents integer, billing text not null check (billing in ('hourly','fixed','request')),
  visibility text not null default 'public' check (visibility in ('public','internal')),
  active boolean not null default true, sort_order smallint not null
);
create table if not exists public.vp_addons (
  id text primary key, name text not null, price_cents integer not null default 0,
  active boolean not null default true, sort_order smallint not null
);
create table if not exists public.vp_bookings (
  id uuid primary key default gen_random_uuid(), reference text not null unique,
  service_id text not null references public.vp_services(id), starts_at timestamptz not null,
  ends_at timestamptz not null, guest_count smallint not null check (guest_count between 1 and 80),
  customer_name text not null, customer_email text not null, customer_phone text not null,
  company text, notes text, status public.vp_booking_status not null,
  source text not null default 'online' check (source in ('online','walk_in','admin')),
  payment_status text not null default 'open' check (payment_status in ('open','paid','refunded','invoice')),
  price_cents integer, currency text not null default 'CHF', pin_code text not null,
  addon_ids text[] not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at > starts_at), check (pin_code ~ '^[0-9]{4}$')
);
create table if not exists public.vp_allocations (
  id bigint generated always as identity primary key, booking_id uuid not null references public.vp_bookings(id) on delete cascade,
  resource_id smallint not null references public.vp_resources(id), occupied tstzrange not null, active boolean not null default true,
  exclude using gist (resource_id with =, occupied with &&) where (active)
);
create index if not exists vp_bookings_starts_idx on public.vp_bookings(starts_at);
create index if not exists vp_bookings_service_idx on public.vp_bookings(service_id);
create index if not exists vp_allocations_booking_idx on public.vp_allocations(booking_id);
create table if not exists public.vp_blocks (
  id uuid primary key default gen_random_uuid(), resource_id smallint references public.vp_resources(id),
  starts_at timestamptz not null, ends_at timestamptz not null, reason text not null, created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists vp_blocks_resource_idx on public.vp_blocks(resource_id);

insert into public.vp_settings(id,venue_name,address) values(true,'Volta Pong','Voltastrasse 30, 4056 Basel') on conflict(id) do nothing;
insert into public.vp_resources(id,name,area) values
 (1,'Tisch 1','Nord'),(2,'Tisch 2','Nord'),(3,'Tisch 3','Nord'),(4,'Tisch 4','Nord'),
 (5,'Tisch 5','Süd'),(6,'Tisch 6','Süd'),(7,'Tisch 7','Süd'),(8,'Tisch 8','Süd')
on conflict(id) do update set name=excluded.name,area=excluded.area;
insert into public.vp_services(id,anny_id,name,short_name,description,min_people,max_people,min_duration_hours,max_duration_hours,required_tables,available_from,price_cents,late_price_cents,billing,visibility,sort_order) values
 ('single-flex',82490,'1 bis 8 Personen (Montag–Sonntag)','Freies Spiel','Ein Tisch inklusive Schläger und Bälle. Zusätzliche Tische und bis zu drei Stunden Spielzeit sind möglich.',1,8,1,3,1,'09:00',1800,2200,'hourly','public',1),
 ('single-evening',81987,'2 bis 8 Personen (ab 16 Uhr)','Abendspiel','Ein Tisch am Abend inklusive Schläger und Bälle.',2,8,1,3,1,'16:00',2200,null,'hourly','public',2),
 ('apero-small',83445,'9 bis 16 Personen (ab 16 Uhr) Play & Apéro','Play & Apéro S','Zwei Tische für eure Gruppe; Apéro kann ergänzt werden.',9,16,2,4,2,'16:00',4400,null,'hourly','public',3),
 ('apero-large',83891,'17 bis 26 Personen (ab 16 Uhr) Play & Apéro','Play & Apéro L','Drei Tische für eure Gruppe; Apéro kann ergänzt werden.',17,26,2,4,3,'16:00',6600,null,'hourly','public',4),
 ('group-xl',83892,'27 bis 35 Personen (ab 16 Uhr)','Grossgruppe','Vier Tische für zwei Stunden.',27,35,2,2,4,'16:00',27600,null,'fixed','public',5),
 ('play-food',83895,'Ab 9 Personen Play & Food (ab 16 Uhr)','Play & Food','Spiel und Food für Gruppen – wir bestätigen das passende Angebot persönlich.',9,null,1,6,2,'16:00',null,null,'request','public',6),
 ('full-venue',null,'Volta Pong Nord oder Süd / Komplett','Bereich oder Komplett','Exklusive Nutzung eines Bereichs oder des gesamten Volta Pong.',1,null,1,8,4,'09:00',null,null,'request','public',7),
 ('voltabrau-1',84282,'Gruppen Volta Bräu 1 Tisch','Volta Bräu · 1 Tisch','Interne Gruppenbuchung für Volta Bräu.',1,null,1,10,1,'09:00',null,null,'request','internal',20),
 ('voltabrau-2',84281,'Gruppen Volta Bräu 2 Tische','Volta Bräu · 2 Tische','Interne Gruppenbuchung für Volta Bräu.',1,null,1,16,2,'09:00',null,null,'request','internal',21),
 ('voltabrau-3',84279,'Gruppen Volta Bräu 3 Tische','Volta Bräu · 3 Tische','Interne Gruppenbuchung für Volta Bräu.',1,null,1,10,3,'09:00',null,null,'request','internal',22),
 ('voltabrau-4',83985,'Gruppen Volta Bräu 4 Tische','Volta Bräu · 4 Tische','Interne Gruppenbuchung für Volta Bräu.',1,null,1,16,4,'09:00',null,null,'request','internal',23),
 ('wm-night',null,'WM Night Games','WM Night Games','Sonderformat für WM Night Games.',1,null,1,3,1,'09:00',null,null,'request','internal',24)
on conflict(id) do update set name=excluded.name,description=excluded.description,active=true;
insert into public.vp_addons(id,name,price_cents,sort_order) values
 ('pickup','Abholung nach deiner Spielzeit',0,1),('apero','Apéroplatte',4500,2),
 ('hummus','Hummus mit Brot',1100,3),('pizza-bufala','Pizza Bufala',2600,4),('pizza-margherita','Pizza Margherita',2300,5)
on conflict(id) do update set name=excluded.name,price_cents=excluded.price_cents;

alter table public.vp_settings enable row level security; alter table public.vp_resources enable row level security;
alter table public.vp_services enable row level security; alter table public.vp_addons enable row level security;
alter table public.vp_bookings enable row level security; alter table public.vp_allocations enable row level security;
alter table public.vp_blocks enable row level security;
revoke all on public.vp_settings,public.vp_resources,public.vp_services,public.vp_addons,public.vp_bookings,public.vp_allocations,public.vp_blocks from anon,authenticated;
grant select on public.vp_resources,public.vp_services,public.vp_addons to anon,authenticated;
drop policy if exists "vp public resources" on public.vp_resources; create policy "vp public resources" on public.vp_resources for select to anon,authenticated using(active);
drop policy if exists "vp public services" on public.vp_services; create policy "vp public services" on public.vp_services for select to anon,authenticated using(active and visibility='public');
drop policy if exists "vp public addons" on public.vp_addons; create policy "vp public addons" on public.vp_addons for select to anon,authenticated using(active);

create or replace function public.vp_price(p_service text,p_time time,p_hours smallint,p_addons text[]) returns integer language sql stable security invoker set search_path='' as $$
 select case s.billing when 'request' then null when 'fixed' then s.price_cents else
   (case when s.late_price_cents is not null and p_time >= '16:00' then s.late_price_cents else s.price_cents end)*p_hours end
   + coalesce((select sum(a.price_cents) from public.vp_addons a where a.id=any(coalesce(p_addons,'{}'))),0)
 from public.vp_services s where s.id=p_service;
$$;
create or replace function public.vp_available_slots(p_date date,p_service text,p_hours smallint default 1)
returns table(start_time time,available_tables bigint) language sql stable security definer set search_path='' as $$
 with svc as (select * from public.vp_services where id=p_service and active and visibility='public'),
 slots as (select make_time(h,0,0) t,(p_date+make_time(h,0,0)) at time zone 'Europe/Zurich' z from svc,generate_series(9,23) h where make_time(h,0,0)>=available_from and (p_date+make_time(h,0,0)) at time zone 'Europe/Zurich'>now()),
 free as (select sl.t,count(r.id) n from slots sl cross join public.vp_resources r where r.active
   and not exists(select 1 from public.vp_allocations a where a.resource_id=r.id and a.active and a.occupied && tstzrange(sl.z,sl.z+(p_hours||' hours')::interval,'[)'))
   and not exists(select 1 from public.vp_blocks b where (b.resource_id is null or b.resource_id=r.id) and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(sl.z,sl.z+(p_hours||' hours')::interval,'[)')) group by sl.t)
 select free.t,free.n from free,svc where free.n>=svc.required_tables and extract(hour from free.t)+p_hours<=24 order by free.t;
$$;
create or replace function public.vp_create_booking(p_service text,p_date date,p_time time,p_hours smallint,p_people smallint,p_name text,p_email text,p_phone text,p_company text default null,p_notes text default null,p_addons text[] default '{}',p_website text default '')
returns table(booking_id uuid,reference text,pin_code text,status public.vp_booking_status,price_cents integer)
language plpgsql security definer set search_path='' as $$
declare s public.vp_services; st timestamptz; en timestamptz; bid uuid:=gen_random_uuid(); ref text:='VP-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)); pin text:=lpad((floor(random()*9000)+1000)::int::text,4,'0'); rid smallint; total integer; stat public.vp_booking_status;
begin
 if coalesce(p_website,'')<>'' then raise exception 'Ungültige Anfrage'; end if;
 select * into s from public.vp_services where id=p_service and active and visibility='public'; if not found then raise exception 'Buchungsoption nicht verfügbar'; end if;
 if p_hours not between s.min_duration_hours and s.max_duration_hours or p_people<s.min_people or (s.max_people is not null and p_people>s.max_people) then raise exception 'Dauer oder Gruppengrösse passt nicht zur Buchungsoption'; end if;
 if p_date<current_date or p_date>current_date+120 or p_time<s.available_from or p_time<time '09:00' or extract(hour from p_time)+p_hours>24 then raise exception 'Zeitpunkt nicht buchbar'; end if;
 if length(trim(p_name))<2 or p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(trim(p_phone))<7 then raise exception 'Bitte vollständige Kontaktdaten angeben'; end if;
 st:=(p_date+p_time) at time zone 'Europe/Zurich'; en:=st+(p_hours||' hours')::interval; total:=public.vp_price(p_service,p_time,p_hours,p_addons); stat:=case when s.billing='request' then 'request'::public.vp_booking_status else 'confirmed'::public.vp_booking_status end;
 insert into public.vp_bookings(id,reference,service_id,starts_at,ends_at,guest_count,customer_name,customer_email,customer_phone,company,notes,status,price_cents,pin_code,addon_ids)
 values(bid,ref,p_service,st,en,p_people,trim(p_name),lower(trim(p_email)),trim(p_phone),nullif(trim(p_company),''),nullif(trim(p_notes),''),stat,total,pin,p_addons);
 for rid in select r.id from public.vp_resources r where r.active and not exists(select 1 from public.vp_allocations a where a.resource_id=r.id and a.active and a.occupied && tstzrange(st,en,'[)')) and not exists(select 1 from public.vp_blocks b where (b.resource_id is null or b.resource_id=r.id) and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(st,en,'[)')) order by r.id limit s.required_tables loop insert into public.vp_allocations(booking_id,resource_id,occupied) values(bid,rid,tstzrange(st,en,'[)')); end loop;
 if (select count(*) from public.vp_allocations a where a.booking_id=bid)<s.required_tables then raise exception 'Dieser Slot wurde gerade vergeben. Bitte neu wählen.'; end if;
 return query select bid,ref,pin,stat,total;
end; $$;

-- Time-first public checkout: customers choose a time and any number of the
-- available tables. Pricing is calculated per occupied hour and table.
create or replace function public.vp_create_simple_booking(
  p_date date,p_time time,p_hours smallint,p_tables smallint,p_people smallint,
  p_name text,p_email text,p_phone text,p_company text default null,p_notes text default null,
  p_addons text[] default '{}',p_website text default ''
)
returns table(booking_id uuid,reference text,pin_code text,status public.vp_booking_status,price_cents integer)
language plpgsql security definer set search_path='' as $$
declare
  st timestamptz; en timestamptz; bid uuid:=gen_random_uuid();
  ref text:='VP-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  pin text:=lpad((floor(random()*9000)+1000)::int::text,4,'0');
  rid smallint; allocated smallint:=0; total integer;
begin
  if coalesce(p_website,'')<>'' then raise exception 'Ungültige Anfrage'; end if;
  if p_hours not between 1 and 3 or p_tables not between 1 and 8 then raise exception 'Ungültige Dauer oder Tischanzahl'; end if;
  if p_people not between 1 and p_tables*8 then raise exception 'Bitte passende Personenzahl angeben'; end if;
  if p_date<current_date or p_date>current_date+120 or p_time<time '09:00' or extract(hour from p_time)+p_hours>24 then raise exception 'Zeitpunkt nicht buchbar'; end if;
  if length(trim(p_name))<2 or p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(trim(p_phone))<7 then raise exception 'Bitte vollständige Kontaktdaten angeben'; end if;
  st:=(p_date+p_time) at time zone 'Europe/Zurich'; en:=st+(p_hours||' hours')::interval;
  if st<=now() then raise exception 'Diese Startzeit ist bereits vorbei'; end if;
  select sum(case when p_time+(h||' hours')::interval>=time '16:00' then 2200 else 1800 end)*p_tables
    +coalesce((select sum(a.price_cents) from public.vp_addons a where a.active and a.id=any(coalesce(p_addons,'{}'))),0)
    into total from generate_series(0,p_hours-1) h;
  insert into public.vp_bookings(id,reference,service_id,starts_at,ends_at,guest_count,customer_name,customer_email,customer_phone,company,notes,status,price_cents,pin_code,addon_ids)
  values(bid,ref,'single-flex',st,en,p_people,trim(p_name),lower(trim(p_email)),trim(p_phone),nullif(trim(p_company),''),nullif(trim(p_notes),''),'confirmed',total,pin,p_addons);
  for rid in select r.id from public.vp_resources r where r.active
    and not exists(select 1 from public.vp_allocations a where a.resource_id=r.id and a.active and a.occupied&&tstzrange(st,en,'[)'))
    and not exists(select 1 from public.vp_blocks b where (b.resource_id is null or b.resource_id=r.id) and tstzrange(b.starts_at,b.ends_at,'[)')&&tstzrange(st,en,'[)'))
    order by r.id limit p_tables
  loop
    insert into public.vp_allocations(booking_id,resource_id,occupied) values(bid,rid,tstzrange(st,en,'[)'));
    allocated:=allocated+1;
  end loop;
  if allocated<p_tables then raise exception 'Diese Auswahl wurde gerade vergeben. Bitte neu wählen.'; end if;
  return query select bid,ref,pin,'confirmed'::public.vp_booking_status,total;
end; $$;

create or replace function public.vp_admin_bookings(p_pin text,p_from date,p_to date)
returns table(id uuid,reference text,service_id text,starts_at timestamptz,ends_at timestamptz,guest_count smallint,customer_name text,customer_email text,customer_phone text,company text,notes text,status public.vp_booking_status,payment_status text,price_cents integer,pin_code text,table_ids smallint[])
language plpgsql security definer set search_path='' as $$ begin
 if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
 return query select b.id,b.reference,b.service_id,b.starts_at,b.ends_at,b.guest_count,b.customer_name,b.customer_email,b.customer_phone,b.company,b.notes,b.status,b.payment_status,b.price_cents,b.pin_code,array_agg(a.resource_id order by a.resource_id)::smallint[] from public.vp_bookings b left join public.vp_allocations a on a.booking_id=b.id where b.starts_at>=p_from::timestamp at time zone 'Europe/Zurich' and b.starts_at<(p_to+1)::timestamp at time zone 'Europe/Zurich' group by b.id order by b.starts_at;
end; $$;
create or replace function public.vp_admin_update_booking(p_pin text,p_id uuid,p_status public.vp_booking_status default null,p_payment text default null)
returns void language plpgsql security definer set search_path='' as $$ begin
 if not exists(select 1 from public.vp_settings where admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
 if p_payment is not null and p_payment not in ('open','paid','refunded','invoice') then raise exception 'Ungültiger Zahlungsstatus'; end if;
 update public.vp_bookings set status=coalesce(p_status,status),payment_status=coalesce(p_payment,payment_status),updated_at=now() where id=p_id;
 update public.vp_allocations set active=(coalesce(p_status,(select status from public.vp_bookings where id=p_id)) in ('request','confirmed','checked_in')) where booking_id=p_id;
end; $$;
revoke execute on function public.vp_price(text,time,smallint,text[]) from public,anon,authenticated;
revoke execute on function public.vp_available_slots(date,text,smallint) from public; grant execute on function public.vp_available_slots(date,text,smallint) to anon,authenticated;
revoke execute on function public.vp_create_booking(text,date,time,smallint,smallint,text,text,text,text,text,text[],text) from public; grant execute on function public.vp_create_booking(text,date,time,smallint,smallint,text,text,text,text,text,text[],text) to anon,authenticated;
revoke execute on function public.vp_create_simple_booking(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text) from public,anon,authenticated; grant execute on function public.vp_create_simple_booking(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text) to anon;
revoke execute on function public.vp_admin_bookings(text,date,date) from public; grant execute on function public.vp_admin_bookings(text,date,date) to anon,authenticated;
revoke execute on function public.vp_admin_update_booking(text,uuid,public.vp_booking_status,text) from public; grant execute on function public.vp_admin_update_booking(text,uuid,public.vp_booking_status,text) to anon,authenticated;
