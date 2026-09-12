alter table public.vp_settings
  add column if not exists vat_enabled boolean not null default true,
  add column if not exists vat_rate_basis_points smallint not null default 810,
  add column if not exists vat_number text not null default '';

alter table public.vp_settings drop constraint if exists vp_settings_vat_rate_check;
alter table public.vp_settings add constraint vp_settings_vat_rate_check check (vat_rate_basis_points between 0 and 10000);

update public.vp_settings
set studio_config=jsonb_set(
  studio_config,
  '{operations}',
  coalesce(studio_config->'operations','{}'::jsonb)||jsonb_build_object(
    'vatEnabled',vat_enabled,
    'vatRateBasisPoints',vat_rate_basis_points,
    'vatNumber',vat_number
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

create or replace function public.vp_admin_save_rules(p_pin text,p_rules jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare saved jsonb; vat_rate int:=coalesce((p_rules->>'vat_rate_basis_points')::int,810); vat_on boolean:=coalesce((p_rules->>'vat_enabled')::boolean,true);
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  if length(trim(coalesce(p_rules->>'venue_name',''))) not between 2 and 80 or length(trim(coalesce(p_rules->>'address',''))) not between 2 and 160 then raise exception 'Betriebsdaten sind ungültig'; end if;
  if (p_rules->>'slot_minutes')::int not in (15,30,45,60,90,120) or (p_rules->>'booking_horizon_days')::int not between 1 and 730 then raise exception 'Intervall oder Horizont ist ungültig'; end if;
  if vat_rate not between 0 and 10000 or length(trim(coalesce(p_rules->>'vat_number','')))>40 then raise exception 'MWST-Angaben sind ungültig'; end if;
  update public.vp_settings set
    venue_name=left(trim(p_rules->>'venue_name'),80),address=left(trim(p_rules->>'address'),160),
    opens_at=(p_rules->>'opens_at')::time,closes_at=(p_rules->>'closes_at')::time,
    slot_minutes=(p_rules->>'slot_minutes')::smallint,booking_horizon_days=(p_rules->>'booking_horizon_days')::smallint,
    cancellation_hours=(p_rules->>'cancellation_hours')::smallint,cancellation_fee_24h=(p_rules->>'cancellation_fee_24h')::smallint,
    cancellation_fee_12h=(p_rules->>'cancellation_fee_12h')::smallint,auto_confirm=(p_rules->>'auto_confirm')::boolean,
    reminders_hours=array(select jsonb_array_elements_text(p_rules->'reminders_hours')::smallint),
    vat_enabled=vat_on,vat_rate_basis_points=vat_rate::smallint,vat_number=left(trim(coalesce(p_rules->>'vat_number','')),40),
    studio_config=jsonb_set(studio_config,'{operations}',coalesce(studio_config->'operations','{}'::jsonb)||jsonb_build_object(
      'venueName',p_rules->>'venue_name','address',p_rules->>'address','opensAt',p_rules->>'opens_at',
      'closesAt',p_rules->>'closes_at','horizonDays',(p_rules->>'booking_horizon_days')::int,
      'vatEnabled',vat_on,'vatRateBasisPoints',vat_rate,'vatNumber',left(trim(coalesce(p_rules->>'vat_number','')),40)
    )),updated_at=now()
  where id=true;
  select jsonb_build_object(
    'venue_name',venue_name,'address',address,'timezone',timezone,'currency',currency,
    'opens_at',to_char(opens_at,'HH24:MI'),'closes_at',to_char(closes_at,'HH24:MI'),
    'slot_minutes',slot_minutes,'booking_horizon_days',booking_horizon_days,'cancellation_hours',cancellation_hours,
    'cancellation_fee_24h',cancellation_fee_24h,'cancellation_fee_12h',cancellation_fee_12h,
    'auto_confirm',auto_confirm,'reminders_hours',to_jsonb(reminders_hours),'vat_enabled',vat_enabled,
    'vat_rate_basis_points',vat_rate_basis_points,'vat_number',vat_number
  ) into saved from public.vp_settings where id=true;
  return saved;
end; $$;

create or replace function public.vp_public_booking_config()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_set(v.studio_config,'{operations}',coalesce(v.studio_config->'operations','{}'::jsonb)||jsonb_build_object(
    'venueName',v.venue_name,'address',v.address,'opensAt',to_char(v.opens_at,'HH24:MI'),'closesAt',to_char(v.closes_at,'HH24:MI'),
    'horizonDays',coalesce(s.booking_horizon_days,v.booking_horizon_days),'maxDurationHours',s.max_duration_hours,
    'morningPriceCents',s.price_cents,'eveningPriceCents',coalesce(s.late_price_cents,s.price_cents),
    'eveningStartsAt',to_char(s.late_starts_at,'HH24:MI'),'vatEnabled',v.vat_enabled,
    'vatRateBasisPoints',v.vat_rate_basis_points,'vatNumber',v.vat_number
  ))
  from public.vp_settings v cross join public.vp_services s where v.id=true and s.id='single-flex';
$$;
