-- Volta accounts, company workspaces, role-based access and self-service bookings.

create table if not exists public.vp_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null default '' check (char_length(first_name) <= 80),
  last_name text not null default '' check (char_length(last_name) <= 80),
  phone text not null default '' check (char_length(phone) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vp_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 160),
  billing_email text not null check (char_length(billing_email) between 5 and 254),
  billing_address text not null default '' check (char_length(billing_address) <= 500),
  vat_number text not null default '' check (char_length(vat_number) <= 40),
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vp_organization_members (
  organization_id uuid not null references public.vp_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','billing')),
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (organization_id,user_id)
);

create table if not exists public.vp_organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.vp_organizations(id) on delete cascade,
  email text not null check (char_length(email) between 5 and 254),
  role text not null check (role in ('admin','member','billing')),
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (organization_id,email)
);

create table if not exists public.vp_staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','staff','accounting')),
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.vp_staff_invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (char_length(email) between 5 and 254),
  role text not null check (role in ('admin','staff','accounting')),
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

alter table public.vp_bookings
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists organization_id uuid references public.vp_organizations(id) on delete set null;

create index if not exists vp_bookings_user_idx on public.vp_bookings(user_id,starts_at desc);
create index if not exists vp_bookings_organization_idx on public.vp_bookings(organization_id,starts_at desc);
create index if not exists vp_org_members_user_idx on public.vp_organization_members(user_id) where active;
create index if not exists vp_org_invites_email_idx on public.vp_organization_invitations(lower(email)) where status='pending';

create table if not exists public.vp_booking_audit (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.vp_bookings(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('profile_update','booking_update','reschedule','cancel','addons')),
  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.vp_booking_addon_orders (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.vp_bookings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  addon_ids text[] not null,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null default 'pending' check (status in ('pending','paid','failed','expired')),
  checkout_id text unique,
  status_token_hash bytea not null,
  provider_payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists vp_booking_addon_orders_booking_idx on public.vp_booking_addon_orders(booking_id,created_at desc);

alter table public.vp_profiles enable row level security;
alter table public.vp_organizations enable row level security;
alter table public.vp_organization_members enable row level security;
alter table public.vp_organization_invitations enable row level security;
alter table public.vp_staff_members enable row level security;
alter table public.vp_staff_invitations enable row level security;
alter table public.vp_booking_audit enable row level security;
alter table public.vp_booking_addon_orders enable row level security;

revoke all on public.vp_profiles,public.vp_organizations,public.vp_organization_members,
  public.vp_organization_invitations,public.vp_staff_members,public.vp_staff_invitations,
  public.vp_booking_audit,public.vp_booking_addon_orders from anon,authenticated;
grant select on public.vp_profiles to authenticated;

drop policy if exists "vp profile self read" on public.vp_profiles;
create policy "vp profile self read" on public.vp_profiles for select to authenticated
  using ((select auth.uid())=user_id);

create or replace function public.vp_claim_account()
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); mail text;
begin
  if uid is null then raise exception 'Anmeldung erforderlich'; end if;
  select lower(email) into mail from auth.users where id=uid;
  if mail is null then raise exception 'E-Mail-Adresse fehlt'; end if;
  insert into public.vp_profiles(user_id) values(uid) on conflict(user_id) do nothing;
  update public.vp_bookings set user_id=uid,updated_at=now()
    where user_id is null and lower(customer_email)=mail;
  insert into public.vp_organization_members(organization_id,user_id,role)
    select i.organization_id,uid,i.role from public.vp_organization_invitations i
    where lower(i.email)=mail and i.status='pending'
    on conflict(organization_id,user_id) do update set role=excluded.role,active=true;
  update public.vp_organization_invitations set status='accepted',accepted_at=now()
    where lower(email)=mail and status='pending';
  insert into public.vp_staff_members(user_id,role,created_by)
    select uid,i.role,i.invited_by from public.vp_staff_invitations i
    where lower(i.email)=mail and i.status='pending'
    on conflict(user_id) do update set role=excluded.role,active=true;
  update public.vp_staff_invitations set status='accepted',accepted_at=now()
    where lower(email)=mail and status='pending';
end; $$;

create or replace function public.vp_account_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); result jsonb;
begin
  if uid is null then raise exception 'Anmeldung erforderlich'; end if;
  select jsonb_build_object(
    'profile',jsonb_build_object('user_id',p.user_id,'email',u.email,'first_name',p.first_name,'last_name',p.last_name,'phone',p.phone),
    'bookings',coalesce((select jsonb_agg(x order by (x->>'starts_at')::timestamptz desc) from (
      select jsonb_build_object('id',b.id,'reference',b.reference,'starts_at',b.starts_at,'ends_at',b.ends_at,
        'guest_count',b.guest_count,'customer_name',b.customer_name,'customer_email',b.customer_email,
        'customer_phone',b.customer_phone,'company',b.company,'notes',b.notes,'status',b.status,
        'payment_status',b.payment_status,'price_cents',b.price_cents,'addon_ids',b.addon_ids,
        'access_code',b.access_code,'access_valid_from',b.access_valid_from,'access_valid_until',b.access_valid_until,
        'table_ids',coalesce((select jsonb_agg(a.resource_id order by a.resource_id) from public.vp_allocations a where a.booking_id=b.id and a.active),'[]'::jsonb),
        'organization_id',b.organization_id) x
      from public.vp_bookings b where b.user_id=uid or b.organization_id in (
        select m.organization_id from public.vp_organization_members m where m.user_id=uid and m.active and m.role in ('owner','admin','billing')
      )) q),'[]'::jsonb),
    'organizations',coalesce((select jsonb_agg(jsonb_build_object(
      'id',o.id,'name',o.name,'billing_email',o.billing_email,'billing_address',o.billing_address,'vat_number',o.vat_number,'role',m.role,
      'members',case when m.role in ('owner','admin') then coalesce((select jsonb_agg(jsonb_build_object('user_id',mm.user_id,'email',au.email,'first_name',pp.first_name,'last_name',pp.last_name,'role',mm.role,'active',mm.active) order by au.email) from public.vp_organization_members mm join auth.users au on au.id=mm.user_id left join public.vp_profiles pp on pp.user_id=mm.user_id where mm.organization_id=o.id),'[]'::jsonb) else '[]'::jsonb end,
      'invitations',case when m.role in ('owner','admin') then coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'status',i.status) order by i.created_at desc) from public.vp_organization_invitations i where i.organization_id=o.id and i.status='pending'),'[]'::jsonb) else '[]'::jsonb end
    ) order by o.name) from public.vp_organization_members m join public.vp_organizations o on o.id=m.organization_id where m.user_id=uid and m.active and o.active),'[]'::jsonb),
    'staff',coalesce((select jsonb_build_object('role',s.role,'members',case when s.role in ('owner','admin') then coalesce((select jsonb_agg(jsonb_build_object('user_id',sm.user_id,'email',au.email,'first_name',pp.first_name,'last_name',pp.last_name,'role',sm.role,'active',sm.active) order by au.email) from public.vp_staff_members sm join auth.users au on au.id=sm.user_id left join public.vp_profiles pp on pp.user_id=sm.user_id),'[]'::jsonb) else '[]'::jsonb end,'invitations',case when s.role in ('owner','admin') then coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'status',i.status) order by i.created_at desc) from public.vp_staff_invitations i where i.status='pending'),'[]'::jsonb) else '[]'::jsonb end) from public.vp_staff_members s where s.user_id=uid and s.active),'null'::jsonb)
  ) into result from public.vp_profiles p join auth.users u on u.id=p.user_id where p.user_id=uid;
  return coalesce(result,'{}'::jsonb);
end; $$;

create or replace function public.vp_update_my_profile(p_first_name text,p_last_name text,p_phone text)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); full_name text;
begin
  if uid is null then raise exception 'Anmeldung erforderlich'; end if;
  if char_length(trim(p_first_name))<1 or char_length(trim(p_last_name))<1 or char_length(trim(p_phone))<7 then raise exception 'Bitte vollständige Angaben eintragen'; end if;
  full_name:=trim(p_first_name)||' '||trim(p_last_name);
  update public.vp_profiles set first_name=trim(p_first_name),last_name=trim(p_last_name),phone=trim(p_phone),updated_at=now() where user_id=uid;
  update public.vp_bookings set customer_name=full_name,customer_phone=trim(p_phone),updated_at=now() where user_id=uid and starts_at>now();
end; $$;

create or replace function public.vp_update_my_booking(p_user_id uuid,p_booking_id uuid,p_guest_count smallint,p_phone text,p_notes text)
returns void language plpgsql security definer set search_path='' as $$
declare b public.vp_bookings; table_count int;
begin
  if p_user_id is null then raise exception 'Anmeldung erforderlich'; end if;
  select * into b from public.vp_bookings where id=p_booking_id and (user_id=p_user_id or organization_id in (select organization_id from public.vp_organization_members where user_id=p_user_id and active and role in ('owner','admin'))) for update;
  if not found then raise exception 'Buchung nicht gefunden'; end if;
  if b.starts_at<=now() or b.status not in ('request','confirmed') then raise exception 'Diese Buchung kann nicht mehr geändert werden'; end if;
  select count(*) into table_count from public.vp_allocations where booking_id=b.id and active;
  if p_guest_count<1 or p_guest_count>greatest(1,table_count)*8 or char_length(trim(p_phone))<7 then raise exception 'Personenzahl oder Telefonnummer ist ungültig'; end if;
  update public.vp_bookings set guest_count=p_guest_count,customer_phone=trim(p_phone),notes=nullif(trim(coalesce(p_notes,'')),''),updated_at=now() where id=b.id;
  insert into public.vp_booking_audit(booking_id,actor_user_id,action,before_data,after_data) values(b.id,p_user_id,'booking_update',jsonb_build_object('guest_count',b.guest_count,'phone',b.customer_phone,'notes',b.notes),jsonb_build_object('guest_count',p_guest_count,'phone',trim(p_phone),'notes',p_notes));
end; $$;

create or replace function public.vp_cancel_my_booking(p_user_id uuid,p_booking_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare b public.vp_bookings; cutoff int;
begin
  select * into b from public.vp_bookings where id=p_booking_id and (user_id=p_user_id or organization_id in (select organization_id from public.vp_organization_members where user_id=p_user_id and active and role in ('owner','admin'))) for update;
  if not found then raise exception 'Buchung nicht gefunden'; end if;
  select cancellation_hours into cutoff from public.vp_settings where id=true;
  if b.status not in ('request','confirmed') or b.starts_at<=now()+make_interval(hours=>cutoff) then raise exception 'Die kostenlose Stornofrist ist abgelaufen'; end if;
  update public.vp_bookings set status='cancelled',access_status='pending',access_code=null,updated_at=now() where id=b.id;
  update public.vp_allocations set active=false where booking_id=b.id;
  insert into public.vp_booking_audit(booking_id,actor_user_id,action,before_data,after_data) values(b.id,p_user_id,'cancel',jsonb_build_object('status',b.status),jsonb_build_object('status','cancelled'));
end; $$;

create or replace function public.vp_reschedule_my_booking(p_user_id uuid,p_booking_id uuid,p_date date,p_time time)
returns void language plpgsql security definer set search_path='' as $$
declare b public.vp_bookings; cfg public.vp_settings; svc public.vp_services; duration interval; hours int; table_count int; st timestamptz; en timestamptz; rid smallint; allocated int:=0;
begin
  select * into b from public.vp_bookings where id=p_booking_id and (user_id=p_user_id or organization_id in (select organization_id from public.vp_organization_members where user_id=p_user_id and active and role in ('owner','admin'))) for update;
  if not found then raise exception 'Buchung nicht gefunden'; end if;
  select * into cfg from public.vp_settings where id=true; select * into svc from public.vp_services where id=b.service_id;
  if b.status not in ('request','confirmed') or b.starts_at<=now()+make_interval(hours=>cfg.cancellation_hours) then raise exception 'Die Umbuchungsfrist ist abgelaufen'; end if;
  duration:=b.ends_at-b.starts_at; hours:=extract(epoch from duration)/3600; select count(*) into table_count from public.vp_allocations where booking_id=b.id and active;
  st:=(p_date+p_time) at time zone cfg.timezone; en:=st+duration;
  if st<=now()+make_interval(mins=>svc.min_notice_minutes) or p_date>current_date+coalesce(svc.booking_horizon_days,cfg.booking_horizon_days) then raise exception 'Der neue Termin ist nicht buchbar'; end if;
  update public.vp_allocations set active=false where booking_id=b.id;
  for rid in select r.id from public.vp_resources r join public.vp_resource_schedules sc on sc.resource_id=r.id and sc.weekday=extract(dow from p_date)::smallint where r.active and sc.enabled
    and p_time>=sc.opens_at and (extract(hour from p_time)*60+extract(minute from p_time)+hours*60)<=case when sc.closes_at=time '00:00' then 1440 else extract(hour from sc.closes_at)*60+extract(minute from sc.closes_at) end
    and not exists(select 1 from public.vp_allocations a where a.resource_id=r.id and a.active and a.occupied&&tstzrange(st-make_interval(mins=>greatest(svc.buffer_before_minutes,r.buffer_before_minutes)),en+make_interval(mins=>greatest(svc.buffer_after_minutes,r.buffer_after_minutes)),'[)'))
    and not exists(select 1 from public.vp_blocks bl where (bl.resource_id is null or bl.resource_id=r.id) and tstzrange(bl.starts_at,bl.ends_at,'[)')&&tstzrange(st,en,'[)')) order by r.sort_order,r.id limit table_count
  loop insert into public.vp_allocations(booking_id,resource_id,occupied) values(b.id,rid,tstzrange(st-make_interval(mins=>greatest(svc.buffer_before_minutes,(select buffer_before_minutes from public.vp_resources where id=rid))),en+make_interval(mins=>greatest(svc.buffer_after_minutes,(select buffer_after_minutes from public.vp_resources where id=rid))),'[)')); allocated:=allocated+1; end loop;
  if allocated<table_count then raise exception 'Für diesen Termin sind nicht genügend Tische frei'; end if;
  update public.vp_bookings set starts_at=st,ends_at=en,access_status='pending',access_code=null,access_valid_from=null,access_valid_until=null,updated_at=now() where id=b.id;
  insert into public.vp_booking_audit(booking_id,actor_user_id,action,before_data,after_data) values(b.id,p_user_id,'reschedule',jsonb_build_object('starts_at',b.starts_at,'ends_at',b.ends_at),jsonb_build_object('starts_at',st,'ends_at',en));
end; $$;

create or replace function public.vp_create_my_organization(p_name text,p_billing_email text)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); oid uuid:=gen_random_uuid();
begin
  if uid is null then raise exception 'Anmeldung erforderlich'; end if;
  insert into public.vp_organizations(id,name,billing_email,created_by) values(oid,trim(p_name),lower(trim(p_billing_email)),uid);
  insert into public.vp_organization_members(organization_id,user_id,role) values(oid,uid,'owner'); return oid;
end; $$;

create or replace function public.vp_update_my_organization(p_organization_id uuid,p_name text,p_billing_email text,p_billing_address text,p_vat_number text)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid());
begin
  if not exists(select 1 from public.vp_organization_members where organization_id=p_organization_id and user_id=uid and active and role in ('owner','admin')) then raise exception 'Keine Berechtigung'; end if;
  update public.vp_organizations set name=trim(p_name),billing_email=lower(trim(p_billing_email)),billing_address=trim(coalesce(p_billing_address,'')),vat_number=trim(coalesce(p_vat_number,'')),updated_at=now() where id=p_organization_id;
end; $$;

create or replace function public.vp_invite_organization_member(p_organization_id uuid,p_email text,p_role text)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid());
begin
  if p_role not in ('admin','member','billing') then raise exception 'Ungültige Rolle'; end if;
  if not exists(select 1 from public.vp_organization_members where organization_id=p_organization_id and user_id=uid and active and role in ('owner','admin')) then raise exception 'Keine Berechtigung'; end if;
  insert into public.vp_organization_invitations(organization_id,email,role,invited_by) values(p_organization_id,lower(trim(p_email)),p_role,uid)
  on conflict(organization_id,email) do update set role=excluded.role,status='pending',invited_by=uid,created_at=now(),accepted_at=null;
end; $$;

create or replace function public.vp_set_organization_member_role(p_organization_id uuid,p_member_user_id uuid,p_role text,p_active boolean)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); actor_role text;
begin
  select role into actor_role from public.vp_organization_members where organization_id=p_organization_id and user_id=uid and active;
  if actor_role is null or actor_role not in ('owner','admin') or p_role not in ('owner','admin','member','billing') then raise exception 'Keine Berechtigung'; end if;
  if actor_role<>'owner' and p_role='owner' then raise exception 'Nur Eigentümer dürfen Eigentümer ernennen'; end if;
  if p_member_user_id=uid and (p_role<>'owner' or not p_active) and actor_role='owner' and (select count(*) from public.vp_organization_members where organization_id=p_organization_id and active and role='owner')=1 then raise exception 'Der letzte Eigentümer kann nicht entfernt werden'; end if;
  update public.vp_organization_members set role=p_role,active=p_active where organization_id=p_organization_id and user_id=p_member_user_id;
end; $$;

create or replace function public.vp_claim_staff_access(p_pin text)
returns text language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); assigned text;
begin
  if uid is null then raise exception 'Anmeldung erforderlich'; end if;
  if not exists(select 1 from public.vp_settings where id=true and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  assigned:=case when not exists(select 1 from public.vp_staff_members where active) then 'owner' else 'admin' end;
  insert into public.vp_staff_members(user_id,role,active,created_by) values(uid,assigned,true,uid) on conflict(user_id) do update set active=true;
  return (select role from public.vp_staff_members where user_id=uid);
end; $$;

create or replace function public.vp_invite_staff_member(p_email text,p_role text)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); actor_role text;
begin
  select role into actor_role from public.vp_staff_members where user_id=uid and active;
  if actor_role is null or actor_role not in ('owner','admin') or p_role not in ('admin','staff','accounting') or (p_role='admin' and actor_role<>'owner') then raise exception 'Keine Berechtigung'; end if;
  insert into public.vp_staff_invitations(email,role,invited_by) values(lower(trim(p_email)),p_role,uid) on conflict(email) do update set role=excluded.role,status='pending',invited_by=uid,created_at=now(),accepted_at=null;
end; $$;

create or replace function public.vp_set_staff_member_role(p_member_user_id uuid,p_role text,p_active boolean)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); actor_role text;
begin
  select role into actor_role from public.vp_staff_members where user_id=uid and active;
  if actor_role is null or actor_role<>'owner' or p_role not in ('owner','admin','staff','accounting') then raise exception 'Nur Eigentümer dürfen Teamrollen ändern'; end if;
  if p_member_user_id=uid and (p_role<>'owner' or not p_active) and (select count(*) from public.vp_staff_members where active and role='owner')=1 then raise exception 'Der letzte Eigentümer kann nicht entfernt werden'; end if;
  update public.vp_staff_members set role=p_role,active=p_active where user_id=p_member_user_id;
end; $$;

create or replace function public.vp_prepare_account_addons(p_user_id uuid,p_booking_id uuid,p_addons text[],p_status_token text)
returns table(order_id uuid,amount_cents integer,expires_at timestamptz) language plpgsql security definer set search_path='' as $$
declare b public.vp_bookings; oid uuid:=gen_random_uuid(); amount int; expiry timestamptz:=now()+interval '10 minutes';
begin
  select * into b from public.vp_bookings where id=p_booking_id and (user_id=p_user_id or organization_id in (select organization_id from public.vp_organization_members where user_id=p_user_id and active and role in ('owner','admin'))) for update;
  if not found or b.status<>'confirmed' or b.starts_at<=now()+interval '2 hours' then raise exception 'Extras können für diese Buchung nicht mehr ergänzt werden'; end if;
  if cardinality(coalesce(p_addons,'{}'))<1 or cardinality(p_addons)>100 or length(p_status_token)<32 then raise exception 'Ungültige Extras'; end if;
  if exists(select 1 from unnest(p_addons) a where not exists(select 1 from public.vp_addons x where x.id=a and x.active)) then raise exception 'Ein Extra ist nicht verfügbar'; end if;
  select coalesce(sum(x.price_cents),0) into amount from unnest(p_addons) a join public.vp_addons x on x.id=a;
  insert into public.vp_booking_addon_orders(id,booking_id,user_id,addon_ids,amount_cents,status_token_hash,expires_at) values(oid,b.id,p_user_id,p_addons,amount,extensions.digest(p_status_token,'sha256'),expiry);
  if amount=0 then
    update public.vp_booking_addon_orders set status='paid',paid_at=now() where id=oid;
    update public.vp_bookings set addon_ids=addon_ids||p_addons,updated_at=now() where id=b.id;
  end if;
  return query select oid,amount,case when amount=0 then null else expiry end;
end; $$;

create or replace function public.vp_attach_account_addon_checkout(p_order_id uuid,p_checkout_id text,p_payload jsonb)
returns void language sql security definer set search_path='' as $$ update public.vp_booking_addon_orders set checkout_id=p_checkout_id,provider_payload=coalesce(p_payload,'{}'::jsonb) where id=p_order_id and status='pending' $$;

create or replace function public.vp_reconcile_account_addon_order(p_checkout_id text,p_provider_status text,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare o public.vp_booking_addon_orders; normalized text:=upper(coalesce(p_provider_status,''));
begin
  select * into o from public.vp_booking_addon_orders where checkout_id=p_checkout_id for update;
  if not found then return; end if;
  if normalized='PAID' and o.status<>'paid' then
    update public.vp_booking_addon_orders set status='paid',paid_at=now(),provider_payload=coalesce(p_payload,'{}'::jsonb) where id=o.id;
    update public.vp_bookings set addon_ids=addon_ids||o.addon_ids,price_cents=coalesce(price_cents,0)+o.amount_cents,subtotal_cents=coalesce(subtotal_cents,price_cents,0)+o.amount_cents,updated_at=now() where id=o.booking_id;
    insert into public.vp_booking_audit(booking_id,actor_user_id,action,after_data) values(o.booking_id,o.user_id,'addons',jsonb_build_object('addon_ids',o.addon_ids,'amount_cents',o.amount_cents));
  elsif normalized in ('FAILED','EXPIRED') and o.status='pending' then
    update public.vp_booking_addon_orders set status=lower(normalized),provider_payload=coalesce(p_payload,'{}'::jsonb) where id=o.id;
  end if;
end; $$;

create or replace function public.vp_account_addon_result(p_user_id uuid,p_order_id uuid,p_status_token text)
returns table(status text,amount_cents integer,booking_id uuid,checkout_id text) language sql stable security definer set search_path='' as $$
  select o.status,o.amount_cents,o.booking_id,o.checkout_id from public.vp_booking_addon_orders o where o.id=p_order_id and o.user_id=p_user_id and o.status_token_hash=extensions.digest(p_status_token,'sha256')
$$;

revoke execute on function public.vp_claim_account(),public.vp_account_snapshot(),public.vp_update_my_profile(text,text,text),
  public.vp_create_my_organization(text,text),public.vp_update_my_organization(uuid,text,text,text,text),
  public.vp_invite_organization_member(uuid,text,text),public.vp_set_organization_member_role(uuid,uuid,text,boolean),
  public.vp_claim_staff_access(text),public.vp_invite_staff_member(text,text),public.vp_set_staff_member_role(uuid,text,boolean)
  from public,anon;
grant execute on function public.vp_claim_account(),public.vp_account_snapshot(),public.vp_update_my_profile(text,text,text),
  public.vp_create_my_organization(text,text),public.vp_update_my_organization(uuid,text,text,text,text),
  public.vp_invite_organization_member(uuid,text,text),public.vp_set_organization_member_role(uuid,uuid,text,boolean),
  public.vp_claim_staff_access(text),public.vp_invite_staff_member(text,text),public.vp_set_staff_member_role(uuid,text,boolean)
  to authenticated;

revoke execute on function public.vp_update_my_booking(uuid,uuid,smallint,text,text),public.vp_cancel_my_booking(uuid,uuid),
  public.vp_reschedule_my_booking(uuid,uuid,date,time),public.vp_prepare_account_addons(uuid,uuid,text[],text),
  public.vp_attach_account_addon_checkout(uuid,text,jsonb),public.vp_reconcile_account_addon_order(text,text,jsonb),
  public.vp_account_addon_result(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.vp_update_my_booking(uuid,uuid,smallint,text,text),public.vp_cancel_my_booking(uuid,uuid),
  public.vp_reschedule_my_booking(uuid,uuid,date,time),public.vp_prepare_account_addons(uuid,uuid,text[],text),
  public.vp_attach_account_addon_checkout(uuid,text,jsonb),public.vp_reconcile_account_addon_order(text,text,jsonb),
  public.vp_account_addon_result(uuid,uuid,text) to service_role;

grant usage on schema public to authenticated;
grant select on public.vp_addons to authenticated;
