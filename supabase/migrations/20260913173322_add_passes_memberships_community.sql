-- Volta passes, fixed-term memberships and privacy-safe community profiles.

create table public.vp_loyalty_products (
  id text primary key check (id ~ '^[a-z0-9-]{2,50}$'),
  name text not null check (char_length(name) between 2 and 100),
  description text not null default '' check (char_length(description) <= 500),
  kind text not null check (kind in ('multi_pass','membership')),
  price_cents integer not null check (price_cents >= 0),
  credits integer not null default 0 check (credits between 0 and 1000),
  validity_days integer not null check (validity_days between 1 and 3650),
  discount_basis_points integer not null default 0 check (discount_basis_points between 0 and 10000),
  benefits text[] not null default '{}',
  active boolean not null default true,
  featured boolean not null default false,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind='multi_pass' and credits>0) or (kind='membership' and credits=0))
);

create table public.vp_loyalty_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null references public.vp_loyalty_products(id),
  amount_cents integer not null check (amount_cents >= 0),
  status text not null default 'pending' check (status in ('pending','paid','failed','expired')),
  checkout_id text unique,
  status_token_hash bytea not null,
  provider_payload jsonb not null default '{}',
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.vp_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null references public.vp_loyalty_products(id),
  source_order_id uuid references public.vp_loyalty_orders(id),
  kind text not null check (kind in ('multi_pass','membership')),
  credits_total integer not null default 0 check (credits_total >= 0),
  credits_remaining integer not null default 0 check (credits_remaining between 0 and credits_total),
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null,
  status text not null default 'active' check (status in ('active','used','expired','revoked')),
  created_at timestamptz not null default now()
);

create table public.vp_credit_transactions (
  id bigint generated always as identity primary key,
  entitlement_id uuid not null references public.vp_entitlements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  booking_id uuid references public.vp_bookings(id) on delete set null,
  amount integer not null check (amount <> 0),
  transaction_type text not null check (transaction_type in ('purchase','redemption','refund','adjustment')),
  note text not null default '',
  created_at timestamptz not null default now()
);

create unique index vp_credit_one_redemption_per_entitlement_booking
  on public.vp_credit_transactions(entitlement_id,booking_id)
  where transaction_type='redemption';
create unique index vp_credit_one_refund_per_entitlement_booking
  on public.vp_credit_transactions(entitlement_id,booking_id)
  where transaction_type='refund';
create index vp_loyalty_orders_user_idx on public.vp_loyalty_orders(user_id,created_at desc);
create index vp_entitlements_user_idx on public.vp_entitlements(user_id,valid_until desc);
create index vp_credit_transactions_user_idx on public.vp_credit_transactions(user_id,created_at desc);
create index vp_credit_transactions_booking_idx on public.vp_credit_transactions(booking_id);

create table public.vp_community_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  bio text not null default '' check (char_length(bio) <= 280),
  discoverable boolean not null default false,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vp_loyalty_products enable row level security;
alter table public.vp_loyalty_orders enable row level security;
alter table public.vp_entitlements enable row level security;
alter table public.vp_credit_transactions enable row level security;
alter table public.vp_community_profiles enable row level security;
revoke all on public.vp_loyalty_products,public.vp_loyalty_orders,public.vp_entitlements,public.vp_credit_transactions,public.vp_community_profiles from anon,authenticated;

insert into public.vp_loyalty_products(id,name,description,kind,price_cents,credits,validity_days,discount_basis_points,benefits,active,featured,sort_order) values
 ('fuenfer-pass','5er-Pass','Fünf flexible Tischstunden zum Vorteilspreis.','multi_pass',8000,5,180,0,array['Übertragbar auf jede eigene Buchung','Sechs Monate gültig'],true,false,10),
 ('zehner-pass','10er-Pass','Zehn flexible Tischstunden für regelmässige Runden.','multi_pass',15000,10,365,0,array['Zehn Tischstunden','Ein Jahr gültig'],true,true,20),
 ('community-jahr','Volta Community','Ein Jahr Community-Mitgliedschaft mit Vorteilen auf Spielzeiten.','membership',12000,0,365,1000,array['10 % auf Spielzeiten','Community-Status im Profil','Zugang zu künftigen Member-Events'],true,true,30);

create or replace function public.vp_loyalty_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); result jsonb;
begin
  if uid is null then raise exception 'Anmeldung erforderlich'; end if;
  select jsonb_build_object(
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'kind',p.kind,'price_cents',p.price_cents,'credits',p.credits,'validity_days',p.validity_days,'discount_basis_points',p.discount_basis_points,'benefits',p.benefits,'featured',p.featured) order by p.sort_order,p.name) from public.vp_loyalty_products p where p.active),'[]'::jsonb),
    'entitlements',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'product_id',e.product_id,'product_name',p.name,'kind',e.kind,'credits_total',e.credits_total,'credits_remaining',e.credits_remaining,'valid_from',e.valid_from,'valid_until',e.valid_until,'status',case when e.valid_until<=now() then 'expired' else e.status end,'discount_basis_points',p.discount_basis_points,'benefits',p.benefits) order by e.valid_until desc) from public.vp_entitlements e join public.vp_loyalty_products p on p.id=e.product_id where e.user_id=uid),'[]'::jsonb),
    'credit_balance',coalesce((select sum(e.credits_remaining) from public.vp_entitlements e where e.user_id=uid and e.kind='multi_pass' and e.status='active' and e.valid_until>now()),0),
    'membership',coalesce((select jsonb_build_object('id',e.id,'product_name',p.name,'valid_until',e.valid_until,'discount_basis_points',p.discount_basis_points,'benefits',p.benefits) from public.vp_entitlements e join public.vp_loyalty_products p on p.id=e.product_id where e.user_id=uid and e.kind='membership' and e.status='active' and e.valid_until>now() order by p.discount_basis_points desc,e.valid_until desc limit 1),'null'::jsonb),
    'community',coalesce((select jsonb_build_object('display_name',c.display_name,'bio',c.bio,'discoverable',c.discoverable,'joined_at',c.joined_at) from public.vp_community_profiles c where c.user_id=uid),jsonb_build_object('display_name','','bio','','discoverable',false,'joined_at',null)),
    'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'product_name',p.name,'amount_cents',o.amount_cents,'status',o.status,'created_at',o.created_at) order by o.created_at desc) from public.vp_loyalty_orders o join public.vp_loyalty_products p on p.id=o.product_id where o.user_id=uid),'[]'::jsonb)
  ) into result;
  return result;
end; $$;

create or replace function public.vp_update_community_profile(p_display_name text,p_bio text,p_discoverable boolean)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); has_membership boolean;
begin
  if uid is null then raise exception 'Anmeldung erforderlich'; end if;
  select exists(select 1 from public.vp_entitlements where user_id=uid and kind='membership' and status='active' and valid_until>now()) into has_membership;
  if p_discoverable and not has_membership then raise exception 'Ein sichtbares Community-Profil benötigt eine aktive Mitgliedschaft'; end if;
  insert into public.vp_community_profiles(user_id,display_name,bio,discoverable) values(uid,trim(coalesce(p_display_name,'')),trim(coalesce(p_bio,'')),coalesce(p_discoverable,false))
  on conflict(user_id) do update set display_name=excluded.display_name,bio=excluded.bio,discoverable=excluded.discoverable,updated_at=now();
end; $$;

create or replace function public.vp_admin_loyalty_catalog(p_pin text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  return jsonb_build_object(
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'description',p.description,'kind',p.kind,'price_cents',p.price_cents,'credits',p.credits,'validity_days',p.validity_days,'discount_basis_points',p.discount_basis_points,'benefits',p.benefits,'active',p.active,'featured',p.featured,'sort_order',p.sort_order,'sales',coalesce((select count(*) from public.vp_loyalty_orders o where o.product_id=p.id and o.status='paid'),0)) order by p.sort_order,p.name) from public.vp_loyalty_products p),'[]'::jsonb),
    'paid_orders',coalesce((select count(*) from public.vp_loyalty_orders where status='paid'),0),
    'revenue_cents',coalesce((select sum(amount_cents) from public.vp_loyalty_orders where status='paid'),0),
    'active_members',coalesce((select count(distinct user_id) from public.vp_entitlements where kind='membership' and status='active' and valid_until>now()),0),
    'credits_open',coalesce((select sum(credits_remaining) from public.vp_entitlements where kind='multi_pass' and status='active' and valid_until>now()),0)
  );
end; $$;

create or replace function public.vp_admin_save_loyalty_product(p_pin text,p_product jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare pid text:=lower(trim(p_product->>'id')); product_kind text:=p_product->>'kind'; product_credits int:=coalesce((p_product->>'credits')::int,0);
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  if pid !~ '^[a-z0-9-]{2,50}$' or product_kind not in ('multi_pass','membership') then raise exception 'Ungültiges Produkt'; end if;
  if product_kind='membership' then product_credits:=0; elsif product_credits<1 then raise exception 'Eine Mehrfachkarte benötigt Einheiten'; end if;
  insert into public.vp_loyalty_products(id,name,description,kind,price_cents,credits,validity_days,discount_basis_points,benefits,active,featured,sort_order)
  values(pid,trim(p_product->>'name'),trim(coalesce(p_product->>'description','')),product_kind,(p_product->>'price_cents')::int,product_credits,(p_product->>'validity_days')::int,coalesce((p_product->>'discount_basis_points')::int,0),coalesce(array(select jsonb_array_elements_text(coalesce(p_product->'benefits','[]'::jsonb))),'{}'),coalesce((p_product->>'active')::boolean,true),coalesce((p_product->>'featured')::boolean,false),coalesce((p_product->>'sort_order')::int,100))
  on conflict(id) do update set name=excluded.name,description=excluded.description,kind=excluded.kind,price_cents=excluded.price_cents,credits=excluded.credits,validity_days=excluded.validity_days,discount_basis_points=excluded.discount_basis_points,benefits=excluded.benefits,active=excluded.active,featured=excluded.featured,sort_order=excluded.sort_order,updated_at=now();
  return pid;
end; $$;

create or replace function public.vp_prepare_loyalty_order(p_user_id uuid,p_product_id text,p_status_token text)
returns table(order_id uuid,amount_cents integer,expires_at timestamptz) language plpgsql security definer set search_path='' as $$
declare p public.vp_loyalty_products; oid uuid:=gen_random_uuid(); expiry timestamptz:=now()+interval '10 minutes';
begin
  if p_user_id is null or length(p_status_token)<32 then raise exception 'Ungültige Bestellung'; end if;
  select * into p from public.vp_loyalty_products where id=p_product_id and active for update;
  if not found then raise exception 'Dieses Produkt ist nicht verfügbar'; end if;
  insert into public.vp_loyalty_orders(id,user_id,product_id,amount_cents,status,status_token_hash,expires_at) values(oid,p_user_id,p.id,p.price_cents,case when p.price_cents=0 then 'paid' else 'pending' end,extensions.digest(p_status_token,'sha256'),case when p.price_cents=0 then null else expiry end);
  if p.price_cents=0 then perform public.vp_fulfill_loyalty_order(oid); end if;
  return query select oid,p.price_cents,case when p.price_cents=0 then null else expiry end;
end; $$;

create or replace function public.vp_fulfill_loyalty_order(p_order_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare o public.vp_loyalty_orders; p public.vp_loyalty_products; eid uuid; start_at timestamptz:=now();
begin
  select * into o from public.vp_loyalty_orders where id=p_order_id and status='paid' for update;
  if not found or exists(select 1 from public.vp_entitlements where source_order_id=o.id) then return; end if;
  select * into p from public.vp_loyalty_products where id=o.product_id;
  if p.kind='membership' then
    select greatest(now(),max(valid_until)) into start_at from public.vp_entitlements where user_id=o.user_id and kind='membership' and status='active';
  end if;
  insert into public.vp_entitlements(user_id,product_id,source_order_id,kind,credits_total,credits_remaining,valid_from,valid_until)
  values(o.user_id,p.id,o.id,p.kind,p.credits,p.credits,start_at,start_at+make_interval(days=>p.validity_days)) returning id into eid;
  if p.kind='multi_pass' then insert into public.vp_credit_transactions(entitlement_id,user_id,amount,transaction_type,note) values(eid,o.user_id,p.credits,'purchase','Kauf '||p.name); end if;
  if p.kind='membership' then insert into public.vp_community_profiles(user_id) values(o.user_id) on conflict(user_id) do nothing; end if;
end; $$;

create or replace function public.vp_attach_loyalty_checkout(p_order_id uuid,p_checkout_id text,p_payload jsonb)
returns void language sql security definer set search_path='' as $$ update public.vp_loyalty_orders set checkout_id=p_checkout_id,provider_payload=coalesce(p_payload,'{}') where id=p_order_id and status='pending' $$;

create or replace function public.vp_reconcile_loyalty_order(p_checkout_id text,p_provider_status text,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare o public.vp_loyalty_orders; normalized text:=upper(coalesce(p_provider_status,''));
begin
  select * into o from public.vp_loyalty_orders where checkout_id=p_checkout_id for update;
  if not found then return; end if;
  if normalized='PAID' and o.status<>'paid' then
    update public.vp_loyalty_orders set status='paid',paid_at=now(),provider_payload=coalesce(p_payload,'{}') where id=o.id;
    perform public.vp_fulfill_loyalty_order(o.id);
  elsif normalized in ('FAILED','EXPIRED') and o.status='pending' then
    update public.vp_loyalty_orders set status=lower(normalized),provider_payload=coalesce(p_payload,'{}') where id=o.id;
  end if;
end; $$;

create or replace function public.vp_loyalty_order_result(p_user_id uuid,p_order_id uuid,p_status_token text)
returns table(status text,amount_cents integer,checkout_id text) language sql stable security definer set search_path='' as $$
  select o.status,o.amount_cents,o.checkout_id from public.vp_loyalty_orders o where o.id=p_order_id and o.user_id=p_user_id and o.status_token_hash=extensions.digest(p_status_token,'sha256')
$$;

create or replace function public.vp_apply_account_benefits(p_user_id uuid,p_booking_id uuid,p_use_credits boolean)
returns table(price_cents integer,expires_at timestamptz,credits_used integer,membership_discount_cents integer) language plpgsql security definer set search_path='' as $$
declare b public.vp_bookings; base_amount int; extras_amount int; member_rate int:=0; member_discount int:=0; needed int; remaining int; e public.vp_entitlements; take_count int; new_total int;
begin
  select * into b from public.vp_bookings where id=p_booking_id and user_id=p_user_id for update;
  if not found or b.status<>'request' then raise exception 'Buchung nicht gefunden'; end if;
  select coalesce(sum(a.price_cents),0) into extras_amount from unnest(coalesce(b.addon_ids,'{}')) aid join public.vp_addons a on a.id=aid;
  base_amount:=greatest(0,coalesce(b.subtotal_cents,b.price_cents,0)-extras_amount);
  select coalesce(max(p.discount_basis_points),0) into member_rate from public.vp_entitlements x join public.vp_loyalty_products p on p.id=x.product_id where x.user_id=p_user_id and x.kind='membership' and x.status='active' and x.valid_until>now();
  if coalesce(p_use_credits,false) then
    if b.discount_code_id is not null then raise exception 'Mehrfachkarte und Rabattcode können nicht kombiniert werden'; end if;
    needed:=greatest(1,round(extract(epoch from (b.ends_at-b.starts_at))/3600)::int)*(select count(*) from public.vp_allocations where booking_id=b.id and active);
    select coalesce(sum(credits_remaining),0) into remaining from public.vp_entitlements where user_id=p_user_id and kind='multi_pass' and status='active' and valid_until>now();
    if remaining<needed then raise exception 'Nicht genügend Tischstunden auf deiner Mehrfachkarte'; end if;
    for e in select * from public.vp_entitlements where user_id=p_user_id and kind='multi_pass' and status='active' and valid_until>now() and credits_remaining>0 order by valid_until,id for update loop
      exit when needed=0; take_count:=least(needed,e.credits_remaining);
      update public.vp_entitlements set credits_remaining=credits_remaining-take_count,status=case when credits_remaining-take_count=0 then 'used' else status end where id=e.id;
      insert into public.vp_credit_transactions(entitlement_id,user_id,booking_id,amount,transaction_type,note) values(e.id,p_user_id,b.id,-take_count,'redemption','Buchung '||b.reference);
      needed:=needed-take_count;
    end loop;
    new_total:=extras_amount;
    update public.vp_bookings set price_cents=new_total,discount_cents=coalesce(subtotal_cents,0)-new_total,payment_provider=case when new_total=0 then 'pass' else payment_provider end,payment_status=case when new_total=0 then 'paid' else payment_status end,payment_expires_at=case when new_total=0 then null else payment_expires_at end,payment_verified_at=case when new_total=0 then now() else payment_verified_at end,updated_at=now() where id=b.id;
    return query select new_total,(select payment_expires_at from public.vp_bookings where id=b.id),round(extract(epoch from (b.ends_at-b.starts_at))/3600)::int*(select count(*) from public.vp_allocations where booking_id=b.id and active),0;
  else
    member_discount:=round(greatest(0,coalesce(b.price_cents,0)-extras_amount)*member_rate/10000.0)::int;
    new_total:=greatest(0,coalesce(b.price_cents,0)-member_discount);
    update public.vp_bookings set price_cents=new_total,discount_cents=coalesce(discount_cents,0)+member_discount,payment_provider=case when new_total=0 then 'membership' else payment_provider end,payment_status=case when new_total=0 then 'paid' else payment_status end,payment_expires_at=case when new_total=0 then null else payment_expires_at end,payment_verified_at=case when new_total=0 then now() else payment_verified_at end,updated_at=now() where id=b.id;
    if new_total=0 and b.discount_code_id is not null then update public.vp_discount_redemptions set status='redeemed',redeemed_at=now() where booking_id=b.id and status='reserved'; end if;
    return query select new_total,(select payment_expires_at from public.vp_bookings where id=b.id),0,member_discount;
  end if;
end; $$;

create or replace function public.vp_refund_booking_credits()
returns trigger language plpgsql security definer set search_path='' as $$
declare t record;
begin
  if (new.status='cancelled' and old.status is distinct from 'cancelled') or (new.payment_status in ('failed','expired') and old.payment_status is distinct from new.payment_status) then
    for t in select entitlement_id,user_id,-sum(amount)::int as refund from public.vp_credit_transactions where booking_id=new.id and transaction_type='redemption' group by entitlement_id,user_id loop
      if t.refund>0 and not exists(select 1 from public.vp_credit_transactions where entitlement_id=t.entitlement_id and booking_id=new.id and transaction_type='refund') then
        update public.vp_entitlements set credits_remaining=least(credits_total,credits_remaining+t.refund),status='active' where id=t.entitlement_id;
        insert into public.vp_credit_transactions(entitlement_id,user_id,booking_id,amount,transaction_type,note) values(t.entitlement_id,t.user_id,new.id,t.refund,'refund','Automatische Rückgabe '||new.reference);
      end if;
    end loop;
  end if;
  return new;
end; $$;
drop trigger if exists vp_refund_booking_credits_trigger on public.vp_bookings;
create trigger vp_refund_booking_credits_trigger after update of status,payment_status on public.vp_bookings for each row execute function public.vp_refund_booking_credits();

revoke execute on function public.vp_loyalty_snapshot(),public.vp_update_community_profile(text,text,boolean) from public,anon;
grant execute on function public.vp_loyalty_snapshot(),public.vp_update_community_profile(text,text,boolean) to authenticated;
revoke execute on function public.vp_admin_loyalty_catalog(text),public.vp_admin_save_loyalty_product(text,jsonb) from public,authenticated;
grant execute on function public.vp_admin_loyalty_catalog(text),public.vp_admin_save_loyalty_product(text,jsonb) to anon;
revoke execute on function public.vp_prepare_loyalty_order(uuid,text,text),public.vp_fulfill_loyalty_order(uuid),public.vp_attach_loyalty_checkout(uuid,text,jsonb),public.vp_reconcile_loyalty_order(text,text,jsonb),public.vp_loyalty_order_result(uuid,uuid,text),public.vp_apply_account_benefits(uuid,uuid,boolean),public.vp_refund_booking_credits() from public,anon,authenticated;
grant execute on function public.vp_prepare_loyalty_order(uuid,text,text),public.vp_fulfill_loyalty_order(uuid),public.vp_attach_loyalty_checkout(uuid,text,jsonb),public.vp_reconcile_loyalty_order(text,text,jsonb),public.vp_loyalty_order_result(uuid,uuid,text),public.vp_apply_account_benefits(uuid,uuid,boolean),public.vp_refund_booking_credits() to service_role;
