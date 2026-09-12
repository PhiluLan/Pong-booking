alter table public.vp_settings
  add column if not exists anny_enabled boolean not null default true,
  add column if not exists sumup_enabled boolean not null default true;

update public.vp_settings
set studio_config=jsonb_set(
  studio_config,
  '{operations}',
  coalesce(studio_config->'operations','{}'::jsonb)||jsonb_build_object(
    'annyEnabled',anny_enabled,
    'sumupEnabled',sumup_enabled
  )
)
where id=true;

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
    'integrations',(select jsonb_build_object('anny_enabled',v.anny_enabled,'sumup_enabled',v.sumup_enabled) from public.vp_settings v where v.id=true),
    'rules',(select jsonb_build_object(
      'venue_name',v.venue_name,'address',v.address,'timezone',v.timezone,'currency',v.currency,
      'opens_at',to_char(v.opens_at,'HH24:MI'),'closes_at',to_char(v.closes_at,'HH24:MI'),
      'slot_minutes',v.slot_minutes,'booking_horizon_days',v.booking_horizon_days,
      'cancellation_hours',v.cancellation_hours,'cancellation_fee_24h',v.cancellation_fee_24h,
      'cancellation_fee_12h',v.cancellation_fee_12h,'auto_confirm',v.auto_confirm,
      'reminders_hours',to_jsonb(v.reminders_hours),'vat_enabled',v.vat_enabled,
      'vat_rate_basis_points',v.vat_rate_basis_points,'vat_number',v.vat_number
    ) from public.vp_settings v where v.id=true)
  ) into result;
  return result;
end; $$;

create or replace function public.vp_admin_save_integrations(p_pin text,p_anny_enabled boolean,p_sumup_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare saved jsonb;
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  update public.vp_settings set
    anny_enabled=coalesce(p_anny_enabled,false),
    sumup_enabled=coalesce(p_sumup_enabled,false),
    studio_config=jsonb_set(studio_config,'{operations}',coalesce(studio_config->'operations','{}'::jsonb)||jsonb_build_object(
      'annyEnabled',coalesce(p_anny_enabled,false),'sumupEnabled',coalesce(p_sumup_enabled,false)
    )),updated_at=now()
  where id=true;
  select jsonb_build_object('anny_enabled',anny_enabled,'sumup_enabled',sumup_enabled) into saved from public.vp_settings where id=true;
  return saved;
end; $$;

create or replace function public.vp_public_booking_config()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_set(v.studio_config,'{operations}',coalesce(v.studio_config->'operations','{}'::jsonb)||jsonb_build_object(
    'venueName',v.venue_name,'address',v.address,'opensAt',to_char(v.opens_at,'HH24:MI'),'closesAt',to_char(v.closes_at,'HH24:MI'),
    'horizonDays',coalesce(s.booking_horizon_days,v.booking_horizon_days),'maxDurationHours',s.max_duration_hours,
    'morningPriceCents',s.price_cents,'eveningPriceCents',coalesce(s.late_price_cents,s.price_cents),
    'eveningStartsAt',to_char(s.late_starts_at,'HH24:MI'),'vatEnabled',v.vat_enabled,
    'vatRateBasisPoints',v.vat_rate_basis_points,'vatNumber',v.vat_number,
    'annyEnabled',v.anny_enabled,'sumupEnabled',v.sumup_enabled
  ))
  from public.vp_settings v cross join public.vp_services s where v.id=true and s.id='single-flex';
$$;

create or replace function public.vp_finalize_without_sumup(p_booking_id uuid,p_status_token text)
returns void language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if not exists(select 1 from public.vp_settings where id=true and sumup_enabled=false) then
    raise exception 'SumUp ist aktiv';
  end if;
  update public.vp_bookings b set
    payment_status='invoice',payment_provider='manual',payment_expires_at=null,
    status=case when (select anny_enabled from public.vp_settings where id=true) then 'request'::public.vp_booking_status else 'confirmed'::public.vp_booking_status end,
    updated_at=now()
  where b.id=p_booking_id and b.payment_status='pending'
    and b.payment_status_token_hash=extensions.digest(p_status_token,'sha256');
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Buchung konnte nicht ohne SumUp bestätigt werden'; end if;
  update public.vp_discount_redemptions set status='redeemed',redeemed_at=now()
  where booking_id=p_booking_id and status='reserved';
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
    where b.id=p_booking_id and b.payment_status in ('paid','invoice') and b.anny_booking_id is null
      and exists(select 1 from public.vp_settings where id=true and anny_enabled=true)
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
  update public.vp_bookings set anny_order_id=nullif(p_order_id,''),anny_booking_id=p_anny_booking_id,
    anny_booking_number=p_booking_number,anny_customer_id=p_customer_id,
    anny_customer_account_id=p_customer_account_id,anny_sync_status='confirmed',anny_synced_at=now(),
    anny_provider_payload=coalesce(p_payload,'{}'::jsonb),access_status='provisioning',status='confirmed',updated_at=now()
  where id=p_booking_id and payment_status in ('paid','invoice');
end; $$;

create or replace function public.vp_fail_anny_fulfillment(p_booking_id uuid,p_message text,p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.vp_bookings set anny_sync_status='failed',anny_last_error=left(coalesce(p_message,'Unbekannter Anny-Fehler'),500),
    anny_provider_payload=coalesce(p_payload,'{}'::jsonb),access_status='failed',status='request',updated_at=now()
  where id=p_booking_id and payment_status in ('paid','invoice') and anny_booking_id is null;
end; $$;

revoke execute on function public.vp_admin_save_integrations(text,boolean,boolean) from public;
grant execute on function public.vp_admin_save_integrations(text,boolean,boolean) to anon,authenticated;
revoke execute on function public.vp_finalize_without_sumup(uuid,text) from public,anon,authenticated;
grant execute on function public.vp_finalize_without_sumup(uuid,text) to service_role;
