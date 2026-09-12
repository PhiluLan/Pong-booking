-- Connect paid Volta bookings to Anny and the existing SALTO KS integration.
alter table public.vp_bookings
  add column if not exists anny_order_id text,
  add column if not exists anny_booking_id text,
  add column if not exists anny_booking_number text,
  add column if not exists anny_customer_id text,
  add column if not exists anny_customer_account_id text,
  add column if not exists anny_sync_status text not null default 'not_started',
  add column if not exists anny_sync_attempts smallint not null default 0,
  add column if not exists anny_last_error text,
  add column if not exists anny_synced_at timestamptz,
  add column if not exists anny_provider_payload jsonb not null default '{}'::jsonb,
  add column if not exists access_status text not null default 'pending',
  add column if not exists access_code text,
  add column if not exists access_valid_from timestamptz,
  add column if not exists access_valid_until timestamptz;

alter table public.vp_bookings drop constraint if exists vp_bookings_anny_sync_status_check;
alter table public.vp_bookings add constraint vp_bookings_anny_sync_status_check
  check (anny_sync_status in ('not_started','processing','confirmed','failed'));
alter table public.vp_bookings drop constraint if exists vp_bookings_access_status_check;
alter table public.vp_bookings add constraint vp_bookings_access_status_check
  check (access_status in ('pending','provisioning','issued','active','failed'));

create unique index if not exists vp_bookings_anny_booking_idx
  on public.vp_bookings(anny_booking_id) where anny_booking_id is not null;

-- SumUp payment confirms the money, while Anny confirms the operational booking.
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
    update public.vp_bookings set payment_status='paid',status=case when anny_sync_status='confirmed' then 'confirmed' else 'request' end,
      payment_verified_at=coalesce(payment_verified_at,now()),payment_provider_payload=coalesce(p_payload,'{}'::jsonb),updated_at=now()
    where id=bid;
  elsif normalized in ('FAILED','EXPIRED') then
    update public.vp_bookings set payment_status=lower(normalized),status='cancelled',
      payment_provider_payload=coalesce(p_payload,'{}'::jsonb),updated_at=now()
      where id=bid and payment_status<>'paid';
    update public.vp_allocations set active=false where booking_id=bid and exists(
      select 1 from public.vp_bookings where id=bid and payment_status in ('failed','expired')
    );
  end if;
end; $$;

create or replace function public.vp_claim_anny_fulfillment(p_booking_id uuid)
returns table(
  id uuid,reference text,starts_at timestamptz,ends_at timestamptz,guest_count smallint,
  customer_name text,customer_email text,customer_phone text,company text,notes text,
  price_cents integer,addon_ids text[],table_count bigint
)
language plpgsql security definer set search_path='' as $$
begin
  return query
  with claimed as (
    update public.vp_bookings b set anny_sync_status='processing',anny_sync_attempts=b.anny_sync_attempts+1,
      anny_last_error=null,access_status='provisioning',updated_at=now()
    where b.id=p_booking_id and b.payment_status='paid' and b.anny_booking_id is null
      and (b.anny_sync_status='not_started' or (b.anny_sync_status='processing' and b.updated_at<now()-interval '2 minutes'))
    returning b.*
  )
  select c.id,c.reference,c.starts_at,c.ends_at,c.guest_count,c.customer_name,c.customer_email,
    c.customer_phone,c.company,c.notes,c.price_cents,c.addon_ids,count(a.id)
  from claimed c join public.vp_allocations a on a.booking_id=c.id and a.active
  group by c.id,c.reference,c.starts_at,c.ends_at,c.guest_count,c.customer_name,c.customer_email,
    c.customer_phone,c.company,c.notes,c.price_cents,c.addon_ids;
end; $$;

create or replace function public.vp_complete_anny_fulfillment(
  p_booking_id uuid,p_order_id text,p_anny_booking_id text,p_booking_number text,
  p_customer_id text,p_customer_account_id text,p_payload jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.vp_bookings set anny_order_id=p_order_id,anny_booking_id=p_anny_booking_id,
    anny_booking_number=p_booking_number,anny_customer_id=p_customer_id,
    anny_customer_account_id=p_customer_account_id,anny_sync_status='confirmed',anny_synced_at=now(),
    anny_provider_payload=coalesce(p_payload,'{}'::jsonb),access_status='provisioning',status='confirmed',updated_at=now()
  where id=p_booking_id and payment_status='paid';
end; $$;

create or replace function public.vp_fail_anny_fulfillment(p_booking_id uuid,p_message text,p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.vp_bookings set anny_sync_status='failed',anny_last_error=left(coalesce(p_message,'Unbekannter Anny-Fehler'),500),
    anny_provider_payload=coalesce(p_payload,'{}'::jsonb),access_status='failed',status='request',updated_at=now()
  where id=p_booking_id and payment_status='paid' and anny_booking_id is null;
end; $$;

create or replace function public.vp_set_access_result(
  p_booking_id uuid,p_status text,p_code text default null,p_valid_from timestamptz default null,p_valid_until timestamptz default null
)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_status not in ('pending','provisioning','issued','active','failed') then raise exception 'Ungültiger Zugangsstatus'; end if;
  update public.vp_bookings set access_status=p_status,
    access_code=case when p_code is not null then p_code else access_code end,
    access_valid_from=coalesce(p_valid_from,access_valid_from),access_valid_until=coalesce(p_valid_until,access_valid_until),updated_at=now()
  where id=p_booking_id;
end; $$;

drop function if exists public.vp_sumup_payment_result(uuid,text);
create function public.vp_sumup_payment_result(p_booking_id uuid,p_status_token text)
returns table(
  reference text,payment_status text,booking_status public.vp_booking_status,price_cents integer,checkout_id text,
  anny_sync_status text,anny_booking_number text,access_status text,access_code text,
  access_valid_from timestamptz,access_valid_until timestamptz,anny_last_error text
)
language sql stable security definer set search_path='' as $$
  select b.reference,b.payment_status,b.status,b.price_cents,b.payment_checkout_id,b.anny_sync_status,
    b.anny_booking_number,b.access_status,b.access_code,b.access_valid_from,b.access_valid_until,
    case when b.anny_sync_status='failed' then 'Die automatische Bestätigung wird geprüft.' else null end
  from public.vp_bookings b
  where b.id=p_booking_id and b.payment_status_token_hash=extensions.digest(p_status_token,'sha256');
$$;

revoke execute on function public.vp_claim_anny_fulfillment(uuid) from public,anon,authenticated;
revoke execute on function public.vp_complete_anny_fulfillment(uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke execute on function public.vp_fail_anny_fulfillment(uuid,text,jsonb) from public,anon,authenticated;
revoke execute on function public.vp_set_access_result(uuid,text,text,timestamptz,timestamptz) from public,anon,authenticated;
revoke execute on function public.vp_sumup_payment_result(uuid,text) from public,anon,authenticated;
grant execute on function public.vp_claim_anny_fulfillment(uuid) to service_role;
grant execute on function public.vp_complete_anny_fulfillment(uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.vp_fail_anny_fulfillment(uuid,text,jsonb) to service_role;
grant execute on function public.vp_set_access_result(uuid,text,text,timestamptz,timestamptz) to service_role;
grant execute on function public.vp_sumup_payment_result(uuid,text) to service_role;
