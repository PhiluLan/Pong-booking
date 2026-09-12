create or replace function public.vp_enforce_short_payment_hold()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.payment_status='pending' and new.payment_provider='sumup' then
    new.payment_expires_at=least(coalesce(new.payment_expires_at,now()+interval '5 minutes'),now()+interval '5 minutes');
  end if;
  return new;
end; $$;

drop trigger if exists vp_short_payment_hold on public.vp_bookings;
create trigger vp_short_payment_hold
before insert or update of payment_status,payment_provider,payment_expires_at on public.vp_bookings
for each row execute function public.vp_enforce_short_payment_hold();

update public.vp_bookings
set payment_expires_at=least(payment_expires_at,created_at+interval '5 minutes')
where payment_status='pending' and payment_provider='sumup' and payment_expires_at is not null;

select public.vp_release_expired_payment_holds();

update public.vp_settings
set studio_config=jsonb_set(
  studio_config,'{content,paymentNote}',
  to_jsonb(replace(coalesce(studio_config #>> '{content,paymentNote}',''),'30 Minuten','5 Minuten'))
),updated_at=now()
where id=true and studio_config #>> '{content,paymentNote}' like '%30 Minuten%';

create or replace function public.vp_admin_bookings(p_pin text,p_from date,p_to date)
returns table(
  id uuid,reference text,service_id text,starts_at timestamptz,ends_at timestamptz,guest_count smallint,
  customer_name text,customer_email text,customer_phone text,company text,notes text,status public.vp_booking_status,
  payment_status text,price_cents integer,pin_code text,table_ids smallint[]
)
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  perform public.vp_release_expired_payment_holds();
  return query
  select b.id,b.reference,b.service_id,b.starts_at,b.ends_at,b.guest_count,b.customer_name,b.customer_email,
    b.customer_phone,b.company,b.notes,b.status,b.payment_status,b.price_cents,b.pin_code,
    array_agg(a.resource_id order by a.resource_id)::smallint[]
  from public.vp_bookings b left join public.vp_allocations a on a.booking_id=b.id
  where b.starts_at>=p_from::timestamp at time zone 'Europe/Zurich'
    and b.starts_at<(p_to+1)::timestamp at time zone 'Europe/Zurich'
  group by b.id order by b.starts_at;
end; $$;

create extension if not exists pg_cron;
select cron.schedule(
  'vp-release-expired-payment-holds',
  '* * * * *',
  'select public.vp_release_expired_payment_holds();'
);

revoke execute on function public.vp_enforce_short_payment_hold() from public,anon,authenticated;
