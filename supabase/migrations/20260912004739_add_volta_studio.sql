-- Admin-configurable booking portal. The public RPC returns only presentation
-- settings; protected mutations keep using the existing team PIN.
alter table public.vp_settings
  add column if not exists studio_config jsonb not null default jsonb_build_object(
    'operations', jsonb_build_object(
      'venueName','Volta Pong','address','Voltastrasse 30 · Basel','opensAt','09:00','closesAt','00:00',
      'horizonDays',120,'maxDurationHours',3,'morningPriceCents',1800,'eveningPriceCents',2200,'eveningStartsAt','16:00'
    ),
    'content', jsonb_build_object(
      'eyebrow','Tisch buchen','headline','Wann wollt ihr spielen?',
      'benefits',jsonb_build_array('Schläger & Bälle inklusive','Tisch wird automatisch zugeteilt'),
      'termsLabel','Ich akzeptiere die Buchungs- und Stornobedingungen.',
      'paymentNote','Sicher mit SumUp bezahlen. Dein Tisch bleibt während des Checkouts 30 Minuten reserviert.'
    ),
    'design', jsonb_build_object(
      'primary','#144e94','accent','#fd2e02','surface','#ffffff','background','#f5e3e4','text','#15304e',
      'radius',28,'buttonStyle','rounded'
    ),
    'blocks', jsonb_build_array(
      jsonb_build_object('id','intro','visible',true),jsonb_build_object('id','steps','visible',true),
      jsonb_build_object('id','benefits','visible',true),jsonb_build_object('id','tariffs','visible',true)
    )
  );

create or replace function public.vp_public_booking_config()
returns jsonb language sql stable security definer set search_path='' as $$
  select studio_config from public.vp_settings where id=true;
$$;

create or replace function public.vp_admin_get_studio(p_pin text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then
    raise exception 'Falscher Admin-PIN';
  end if;
  select studio_config into result from public.vp_settings where id=true;
  return result;
end; $$;

create or replace function public.vp_admin_save_studio(p_pin text,p_config jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o jsonb:=p_config->'operations'; c jsonb:=p_config->'content'; d jsonb:=p_config->'design'; b jsonb:=p_config->'blocks'; clean jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  if jsonb_typeof(o)<>'object' or jsonb_typeof(c)<>'object' or jsonb_typeof(d)<>'object' or jsonb_typeof(b)<>'array' then raise exception 'Unvollständige Studio-Einstellungen'; end if;
  if length(coalesce(o->>'venueName','')) not between 2 and 80 or length(coalesce(o->>'address','')) not between 2 and 160 then raise exception 'Name oder Adresse ist ungültig'; end if;
  if (o->>'horizonDays')::int not between 7 and 365 or (o->>'maxDurationHours')::int not between 1 and 6 then raise exception 'Buchungszeitraum oder Dauer ist ungültig'; end if;
  if (o->>'morningPriceCents')::int not between 0 and 100000 or (o->>'eveningPriceCents')::int not between 0 and 100000 then raise exception 'Preis ist ungültig'; end if;
  if coalesce(o->>'opensAt','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(o->>'closesAt','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(o->>'eveningStartsAt','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Zeitangabe ist ungültig'; end if;
  if length(coalesce(c->>'eyebrow',''))>60 or length(coalesce(c->>'headline','')) not between 2 and 120 or length(coalesce(c->>'termsLabel',''))>300 or length(coalesce(c->>'paymentNote',''))>400 then raise exception 'Ein Text ist zu lang oder fehlt'; end if;
  if jsonb_typeof(c->'benefits')<>'array' or jsonb_array_length(c->'benefits')>4 then raise exception 'Vorteile sind ungültig'; end if;
  if coalesce(d->>'primary','') !~ '^#[0-9a-fA-F]{6}$' or coalesce(d->>'accent','') !~ '^#[0-9a-fA-F]{6}$' or coalesce(d->>'surface','') !~ '^#[0-9a-fA-F]{6}$' or coalesce(d->>'background','') !~ '^#[0-9a-fA-F]{6}$' or coalesce(d->>'text','') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Farbwert ist ungültig'; end if;
  if (d->>'radius')::int not between 8 and 42 or coalesce(d->>'buttonStyle','') not in ('rounded','pill','square') then raise exception 'Formeinstellung ist ungültig'; end if;
  if jsonb_array_length(b)<>4 or (select count(distinct value->>'id') from jsonb_array_elements(b))<>4 or exists(select 1 from jsonb_array_elements(b) where value->>'id' not in ('intro','steps','benefits','tariffs')) then raise exception 'Seitenaufbau ist ungültig'; end if;
  clean:=jsonb_build_object(
    'operations',jsonb_build_object('venueName',left(o->>'venueName',80),'address',left(o->>'address',160),'opensAt',o->>'opensAt','closesAt',o->>'closesAt','horizonDays',(o->>'horizonDays')::int,'maxDurationHours',(o->>'maxDurationHours')::int,'morningPriceCents',(o->>'morningPriceCents')::int,'eveningPriceCents',(o->>'eveningPriceCents')::int,'eveningStartsAt',o->>'eveningStartsAt'),
    'content',jsonb_build_object('eyebrow',left(coalesce(c->>'eyebrow',''),60),'headline',left(c->>'headline',120),'benefits',c->'benefits','termsLabel',left(coalesce(c->>'termsLabel',''),300),'paymentNote',left(coalesce(c->>'paymentNote',''),400)),
    'design',jsonb_build_object('primary',lower(d->>'primary'),'accent',lower(d->>'accent'),'surface',lower(d->>'surface'),'background',lower(d->>'background'),'text',lower(d->>'text'),'radius',(d->>'radius')::int,'buttonStyle',d->>'buttonStyle'),
    'blocks',b
  );
  update public.vp_settings set studio_config=clean,venue_name=o->>'venueName',address=o->>'address',opens_at=(o->>'opensAt')::time,closes_at=(o->>'closesAt')::time,booking_horizon_days=(o->>'horizonDays')::smallint,updated_at=now() where id=true;
  update public.vp_services set price_cents=(o->>'morningPriceCents')::int,late_price_cents=(o->>'eveningPriceCents')::int where id='single-flex';
  return clean;
end; $$;

create or replace function public.vp_create_sumup_hold(
  p_date date,p_time time,p_hours smallint,p_tables smallint,p_people smallint,
  p_name text,p_email text,p_phone text,p_company text default null,p_notes text default null,
  p_addons text[] default '{}',p_website text default '',p_status_token text default null
)
returns table(booking_id uuid,reference text,price_cents integer,expires_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare
  st timestamptz; en timestamptz; bid uuid:=gen_random_uuid(); ref text:='VP-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  rid smallint; allocated smallint:=0; total integer; expiry timestamptz:=now()+interval '30 minutes'; cfg jsonb; opens time; closes time; cutoff time; horizon int; max_hours int; day_price int; evening_price int;
begin
  perform public.vp_release_expired_payment_holds();
  select studio_config into cfg from public.vp_settings where id=true;
  opens:=(cfg#>>'{operations,opensAt}')::time; closes:=(cfg#>>'{operations,closesAt}')::time; cutoff:=(cfg#>>'{operations,eveningStartsAt}')::time;
  horizon:=(cfg#>>'{operations,horizonDays}')::int; max_hours:=(cfg#>>'{operations,maxDurationHours}')::int; day_price:=(cfg#>>'{operations,morningPriceCents}')::int; evening_price:=(cfg#>>'{operations,eveningPriceCents}')::int;
  if coalesce(p_website,'')<>'' or p_status_token is null or length(p_status_token)<32 then raise exception 'Ungültige Anfrage'; end if;
  if p_hours not between 1 and max_hours or p_tables not between 1 and 8 then raise exception 'Ungültige Dauer oder Tischanzahl'; end if;
  if p_people not between 1 and p_tables*8 then raise exception 'Bitte passende Personenzahl angeben'; end if;
  if p_date<current_date or p_date>current_date+horizon or p_time<opens or (closes=time '00:00' and extract(hour from p_time)+p_hours>24) or (closes<>time '00:00' and p_time+(p_hours||' hours')::interval>closes) then raise exception 'Zeitpunkt nicht buchbar'; end if;
  if length(trim(p_name))<2 or p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(trim(p_phone))<7 then raise exception 'Bitte vollständige Kontaktdaten angeben'; end if;
  if (select count(*) from public.vp_bookings where lower(customer_email)=lower(trim(p_email)) and payment_status='pending' and created_at>now()-interval '30 minutes')>=3 then raise exception 'Zu viele offene Zahlungsvorgänge. Bitte später erneut versuchen.'; end if;
  st:=(p_date+p_time) at time zone 'Europe/Zurich'; en:=st+(p_hours||' hours')::interval; if st<=now() then raise exception 'Diese Startzeit ist bereits vorbei'; end if;
  select sum(case when p_time+(h||' hours')::interval>=cutoff then evening_price else day_price end)*p_tables+coalesce((select sum(a.price_cents) from public.vp_addons a where a.active and a.id=any(coalesce(p_addons,'{}'))),0) into total from generate_series(0,p_hours-1) h;
  insert into public.vp_bookings(id,reference,service_id,starts_at,ends_at,guest_count,customer_name,customer_email,customer_phone,company,notes,status,payment_status,payment_provider,price_cents,pin_code,addon_ids,payment_expires_at,payment_status_token_hash)
  values(bid,ref,'single-flex',st,en,p_people,trim(p_name),lower(trim(p_email)),trim(p_phone),nullif(trim(p_company),''),nullif(trim(p_notes),''),'request','pending','sumup',total,'0000',p_addons,expiry,extensions.digest(p_status_token,'sha256'));
  for rid in select r.id from public.vp_resources r where r.active and not exists(select 1 from public.vp_allocations a where a.resource_id=r.id and a.active and a.occupied&&tstzrange(st,en,'[)')) and not exists(select 1 from public.vp_blocks b where (b.resource_id is null or b.resource_id=r.id) and tstzrange(b.starts_at,b.ends_at,'[)')&&tstzrange(st,en,'[)')) order by r.id limit p_tables loop insert into public.vp_allocations(booking_id,resource_id,occupied) values(bid,rid,tstzrange(st,en,'[)')); allocated:=allocated+1; end loop;
  if allocated<p_tables then raise exception 'Diese Auswahl wurde gerade vergeben. Bitte neu wählen.'; end if;
  return query select bid,ref,total,expiry;
end; $$;

revoke execute on function public.vp_public_booking_config() from public,authenticated;
revoke execute on function public.vp_admin_get_studio(text) from public;
revoke execute on function public.vp_admin_save_studio(text,jsonb) from public;
revoke execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text) from public,anon,authenticated;
grant execute on function public.vp_public_booking_config() to anon;
grant execute on function public.vp_admin_get_studio(text) to anon,authenticated;
grant execute on function public.vp_admin_save_studio(text,jsonb) to anon,authenticated;
grant execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text) to service_role;
