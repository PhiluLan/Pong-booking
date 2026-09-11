-- SumUp sandbox checkout state and server-only booking holds.
alter table public.vp_bookings drop constraint if exists vp_bookings_payment_status_check;
alter table public.vp_bookings
  add constraint vp_bookings_payment_status_check
  check (payment_status in ('open','pending','paid','failed','expired','refunded','invoice'));

alter table public.vp_bookings
  add column if not exists payment_provider text,
  add column if not exists payment_checkout_id text,
  add column if not exists payment_reference text,
  add column if not exists payment_expires_at timestamptz,
  add column if not exists payment_verified_at timestamptz,
  add column if not exists payment_status_token_hash bytea,
  add column if not exists payment_provider_payload jsonb not null default '{}'::jsonb;

create unique index if not exists vp_bookings_payment_checkout_idx
  on public.vp_bookings(payment_checkout_id) where payment_checkout_id is not null;
create index if not exists vp_bookings_pending_expiry_idx
  on public.vp_bookings(payment_expires_at) where payment_status = 'pending';

create table if not exists public.vp_payment_events (
  id bigint generated always as identity primary key,
  provider text not null,
  event_key text not null,
  checkout_id text,
  status text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(provider,event_key)
);
alter table public.vp_payment_events enable row level security;
revoke all on public.vp_payment_events from anon,authenticated;

create or replace function public.vp_release_expired_payment_holds()
returns integer language plpgsql security definer set search_path='' as $$
declare released integer;
begin
  update public.vp_bookings
     set payment_status='expired',status='cancelled',updated_at=now()
   where payment_status='pending' and payment_expires_at<=now();
  get diagnostics released = row_count;
  update public.vp_allocations a set active=false
   where a.active and exists (
     select 1 from public.vp_bookings b where b.id=a.booking_id
       and b.payment_status in ('failed','expired')
   );
  return released;
end; $$;

create or replace function public.vp_create_sumup_hold(
  p_date date,p_time time,p_hours smallint,p_tables smallint,p_people smallint,
  p_name text,p_email text,p_phone text,p_company text default null,p_notes text default null,
  p_addons text[] default '{}',p_website text default '',p_status_token text default null
)
returns table(booking_id uuid,reference text,price_cents integer,expires_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare
  st timestamptz; en timestamptz; bid uuid:=gen_random_uuid();
  ref text:='VP-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  rid smallint; allocated smallint:=0; total integer; expiry timestamptz:=now()+interval '30 minutes';
begin
  perform public.vp_release_expired_payment_holds();
  if coalesce(p_website,'')<>'' or p_status_token is null or length(p_status_token)<32 then raise exception 'Ungültige Anfrage'; end if;
  if p_hours not between 1 and 3 or p_tables not between 1 and 8 then raise exception 'Ungültige Dauer oder Tischanzahl'; end if;
  if p_people not between 1 and p_tables*8 then raise exception 'Bitte passende Personenzahl angeben'; end if;
  if p_date<current_date or p_date>current_date+120 or p_time<time '09:00' or extract(hour from p_time)+p_hours>24 then raise exception 'Zeitpunkt nicht buchbar'; end if;
  if length(trim(p_name))<2 or p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(trim(p_phone))<7 then raise exception 'Bitte vollständige Kontaktdaten angeben'; end if;
  if (select count(*) from public.vp_bookings where lower(customer_email)=lower(trim(p_email)) and payment_status='pending' and created_at>now()-interval '30 minutes')>=3 then
    raise exception 'Zu viele offene Zahlungsvorgänge. Bitte später erneut versuchen.';
  end if;
  st:=(p_date+p_time) at time zone 'Europe/Zurich'; en:=st+(p_hours||' hours')::interval;
  if st<=now() then raise exception 'Diese Startzeit ist bereits vorbei'; end if;
  select sum(case when p_time+(h||' hours')::interval>=time '16:00' then 2200 else 1800 end)*p_tables
    +coalesce((select sum(a.price_cents) from public.vp_addons a where a.active and a.id=any(coalesce(p_addons,'{}'))),0)
    into total from generate_series(0,p_hours-1) h;
  insert into public.vp_bookings(
    id,reference,service_id,starts_at,ends_at,guest_count,customer_name,customer_email,customer_phone,
    company,notes,status,payment_status,payment_provider,price_cents,pin_code,addon_ids,payment_expires_at,payment_status_token_hash
  ) values(
    bid,ref,'single-flex',st,en,p_people,trim(p_name),lower(trim(p_email)),trim(p_phone),
    nullif(trim(p_company),''),nullif(trim(p_notes),''),'request','pending','sumup',total,'0000',p_addons,expiry,
    extensions.digest(p_status_token,'sha256')
  );
  for rid in select r.id from public.vp_resources r where r.active
    and not exists(select 1 from public.vp_allocations a where a.resource_id=r.id and a.active and a.occupied&&tstzrange(st,en,'[)'))
    and not exists(select 1 from public.vp_blocks b where (b.resource_id is null or b.resource_id=r.id) and tstzrange(b.starts_at,b.ends_at,'[)')&&tstzrange(st,en,'[)'))
    order by r.id limit p_tables
  loop
    insert into public.vp_allocations(booking_id,resource_id,occupied) values(bid,rid,tstzrange(st,en,'[)'));
    allocated:=allocated+1;
  end loop;
  if allocated<p_tables then raise exception 'Diese Auswahl wurde gerade vergeben. Bitte neu wählen.'; end if;
  return query select bid,ref,total,expiry;
end; $$;

create or replace function public.vp_attach_sumup_checkout(
  p_booking_id uuid,p_checkout_id text,p_payment_reference text,p_payload jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.vp_bookings set payment_checkout_id=p_checkout_id,payment_reference=p_payment_reference,
    payment_provider_payload=coalesce(p_payload,'{}'::jsonb),updated_at=now()
  where id=p_booking_id and payment_status='pending';
  if not found then raise exception 'Zahlungsvorgang nicht gefunden'; end if;
end; $$;

create or replace function public.vp_fail_sumup_hold(p_booking_id uuid,p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.vp_bookings set payment_status='failed',status='cancelled',
    payment_provider_payload=coalesce(p_payload,'{}'::jsonb),updated_at=now()
  where id=p_booking_id and payment_status='pending';
  update public.vp_allocations set active=false where booking_id=p_booking_id;
end; $$;

create or replace function public.vp_reconcile_sumup_checkout(
  p_checkout_id text,p_provider_status text,p_event_key text,p_payload jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path='' as $$
declare bid uuid; normalized text:=upper(coalesce(p_provider_status,''));
begin
  insert into public.vp_payment_events(provider,event_key,checkout_id,status,payload)
  values('sumup',p_event_key,p_checkout_id,normalized,coalesce(p_payload,'{}'::jsonb))
  on conflict(provider,event_key) do nothing;
  select id into bid from public.vp_bookings where payment_checkout_id=p_checkout_id for update;
  if bid is null then raise exception 'Unbekannter SumUp-Checkout'; end if;
  if normalized='PAID' then
    update public.vp_bookings set payment_status='paid',status='confirmed',payment_verified_at=now(),
      payment_provider_payload=coalesce(p_payload,'{}'::jsonb),updated_at=now() where id=bid;
  elsif normalized in ('FAILED','EXPIRED') then
    update public.vp_bookings set payment_status=lower(normalized),status='cancelled',
      payment_provider_payload=coalesce(p_payload,'{}'::jsonb),updated_at=now()
      where id=bid and payment_status<>'paid';
    update public.vp_allocations set active=false where booking_id=bid and exists(
      select 1 from public.vp_bookings where id=bid and payment_status in ('failed','expired')
    );
  end if;
end; $$;

create or replace function public.vp_sumup_payment_result(p_booking_id uuid,p_status_token text)
returns table(reference text,payment_status text,booking_status public.vp_booking_status,price_cents integer,checkout_id text)
language sql stable security definer set search_path='' as $$
  select b.reference,b.payment_status,b.status,b.price_cents,b.payment_checkout_id
  from public.vp_bookings b
  where b.id=p_booking_id and b.payment_status_token_hash=extensions.digest(p_status_token,'sha256');
$$;

revoke execute on function public.vp_release_expired_payment_holds() from public,anon,authenticated;
revoke execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text) from public,anon,authenticated;
revoke execute on function public.vp_attach_sumup_checkout(uuid,text,text,jsonb) from public,anon,authenticated;
revoke execute on function public.vp_fail_sumup_hold(uuid,jsonb) from public,anon,authenticated;
revoke execute on function public.vp_reconcile_sumup_checkout(text,text,text,jsonb) from public,anon,authenticated;
revoke execute on function public.vp_sumup_payment_result(uuid,text) from public,anon,authenticated;
grant execute on function public.vp_release_expired_payment_holds() to service_role;
grant execute on function public.vp_create_sumup_hold(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text,text) to service_role;
grant execute on function public.vp_attach_sumup_checkout(uuid,text,text,jsonb) to service_role;
grant execute on function public.vp_fail_sumup_hold(uuid,jsonb) to service_role;
grant execute on function public.vp_reconcile_sumup_checkout(text,text,text,jsonb) to service_role;
grant execute on function public.vp_sumup_payment_result(uuid,text) to service_role;
