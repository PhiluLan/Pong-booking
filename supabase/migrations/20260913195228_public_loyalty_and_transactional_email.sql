-- Public pass shop, explicit loyalty payment modes, member directory and
-- idempotent transactional-email delivery state.

alter table public.vp_settings
  add column if not exists loyalty_payment_mode text not null default 'live'
    check (loyalty_payment_mode in ('live','test','disabled')),
  add column if not exists email_enabled boolean not null default true,
  add column if not exists email_from text not null default 'Volta Pong <buchung@nuknuk.ch>',
  add column if not exists email_reply_to text not null default 'philipplanger@yahoo.com';

create table if not exists public.vp_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique check (char_length(event_key) between 3 and 180),
  message_type text not null check (message_type in ('booking_confirmation','loyalty_purchase')),
  recipient text not null check (char_length(recipient) between 5 and 254),
  status text not null default 'processing' check (status in ('processing','sent','failed','skipped')),
  provider_message_id text,
  attempts integer not null default 1 check (attempts between 1 and 20),
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists vp_email_deliveries_status_idx
  on public.vp_email_deliveries(status,updated_at desc);

alter table public.vp_email_deliveries enable row level security;
revoke all on public.vp_email_deliveries from anon,authenticated;

create or replace function public.vp_public_loyalty_catalog()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'products',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'name',p.name,'description',p.description,'kind',p.kind,
        'price_cents',p.price_cents,'credits',p.credits,'validity_days',p.validity_days,
        'discount_basis_points',p.discount_basis_points,'benefits',p.benefits,
        'featured',p.featured
      ) order by p.sort_order,p.name)
      from public.vp_loyalty_products p where p.active
    ),'[]'::jsonb),
    'payment_mode',(select s.loyalty_payment_mode from public.vp_settings s where s.id=true)
  );
$$;

create or replace function public.vp_admin_loyalty_payment_settings(p_pin text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then
    raise exception 'Falscher Admin-PIN';
  end if;
  return (select jsonb_build_object(
    'payment_mode',s.loyalty_payment_mode,'email_enabled',s.email_enabled,
    'email_from',s.email_from,'email_reply_to',s.email_reply_to
  ) from public.vp_settings s where s.id=true);
end; $$;

create or replace function public.vp_admin_save_loyalty_payment_settings(
  p_pin text,p_payment_mode text,p_email_enabled boolean,p_email_from text,p_email_reply_to text
)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then
    raise exception 'Falscher Admin-PIN';
  end if;
  if p_payment_mode not in ('live','test','disabled') then raise exception 'Ungültiger Zahlungsmodus'; end if;
  if char_length(trim(p_email_from))<5 or char_length(trim(p_email_reply_to))<5 then raise exception 'E-Mail-Absender fehlt'; end if;
  update public.vp_settings set loyalty_payment_mode=p_payment_mode,
    email_enabled=coalesce(p_email_enabled,false),email_from=trim(p_email_from),
    email_reply_to=lower(trim(p_email_reply_to)),updated_at=now() where id=true;
  return public.vp_admin_loyalty_payment_settings(p_pin);
end; $$;

create or replace function public.vp_community_directory()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=(select auth.uid());
begin
  if uid is null or not exists(
    select 1 from public.vp_entitlements e where e.user_id=uid and e.kind='membership'
      and e.status='active' and e.valid_from<=now() and e.valid_until>now()
  ) then raise exception 'Nur für aktive Community-Mitglieder'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'display_name',c.display_name,'bio',c.bio,'joined_at',c.joined_at,
    'membership',p.name
  ) order by c.joined_at,c.display_name)
  from public.vp_community_profiles c
  join lateral (
    select p.name from public.vp_entitlements e
    join public.vp_loyalty_products p on p.id=e.product_id
    where e.user_id=c.user_id and e.kind='membership' and e.status='active'
      and e.valid_from<=now() and e.valid_until>now()
    order by e.valid_until desc limit 1
  ) p on true
  where c.discoverable and char_length(trim(c.display_name))>0),'[]'::jsonb);
end; $$;

create or replace function public.vp_claim_email_delivery(
  p_event_key text,p_message_type text,p_recipient text,p_payload jsonb default '{}'::jsonb
)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  insert into public.vp_email_deliveries(event_key,message_type,recipient,payload)
  values(p_event_key,p_message_type,lower(trim(p_recipient)),coalesce(p_payload,'{}'::jsonb))
  on conflict(event_key) do update set status='processing',attempts=public.vp_email_deliveries.attempts+1,
    last_error=null,payload=excluded.payload,updated_at=now()
  where public.vp_email_deliveries.status='failed' and public.vp_email_deliveries.attempts<20;
  get diagnostics changed=row_count;
  return changed=1;
end; $$;

create or replace function public.vp_finish_email_delivery(
  p_event_key text,p_status text,p_provider_message_id text default null,p_error text default null
)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_status not in ('sent','failed','skipped') then raise exception 'Ungültiger E-Mail-Status'; end if;
  update public.vp_email_deliveries set status=p_status,provider_message_id=p_provider_message_id,
    last_error=left(p_error,1000),sent_at=case when p_status='sent' then now() else sent_at end,
    updated_at=now() where event_key=p_event_key and status='processing';
end; $$;

revoke execute on function public.vp_public_loyalty_catalog() from public;
grant execute on function public.vp_public_loyalty_catalog() to anon,authenticated;
revoke execute on function public.vp_community_directory() from public,anon;
grant execute on function public.vp_community_directory() to authenticated;
revoke execute on function public.vp_admin_loyalty_payment_settings(text),
  public.vp_admin_save_loyalty_payment_settings(text,text,boolean,text,text) from public,authenticated;
grant execute on function public.vp_admin_loyalty_payment_settings(text),
  public.vp_admin_save_loyalty_payment_settings(text,text,boolean,text,text) to anon;
revoke execute on function public.vp_claim_email_delivery(text,text,text,jsonb),
  public.vp_finish_email_delivery(text,text,text,text) from public,anon,authenticated;
grant execute on function public.vp_claim_email_delivery(text,text,text,jsonb),
  public.vp_finish_email_delivery(text,text,text,text) to service_role;
