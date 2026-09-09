-- Volta Pong booking system - proposed Supabase schema.
-- Review against the existing production schema before applying.

create extension if not exists btree_gist with schema extensions;

create type public.booking_status as enum (
  'reserved', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'
);

create type public.booking_source as enum ('online', 'walk_in', 'admin');

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Europe/Zurich',
  currency text not null default 'CHF' check (char_length(currency) = 3),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  capacity smallint not null default 9 check (capacity between 1 and 30),
  sort_order smallint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (venue_id, name)
);

create index resources_venue_id_idx on public.resources (venue_id);

create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  slot_minutes smallint not null default 60 check (slot_minutes between 15 and 240),
  valid_from date,
  valid_until date,
  check (opens_at <> closes_at),
  check (valid_until is null or valid_from is null or valid_until >= valid_from)
);

create index availability_rules_resource_id_idx on public.availability_rules (resource_id, weekday);

create table public.blocked_times (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.resources(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index blocked_times_resource_starts_idx on public.blocked_times (resource_id, starts_at);
create index blocked_times_created_by_idx on public.blocked_times (created_by);

create table public.app_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'staff')),
  display_name text,
  created_at timestamptz not null default now()
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  reference_code text not null unique,
  resource_id uuid not null references public.resources(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  guest_count smallint not null check (guest_count between 1 and 30),
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  status public.booking_status not null default 'confirmed',
  source public.booking_source not null default 'online',
  price_cents integer not null check (price_cents >= 0),
  currency text not null default 'CHF' check (char_length(currency) = 3),
  pin_code text not null check (pin_code ~ '^[0-9]{4}$'),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  constraint bookings_no_resource_overlap exclude using gist (
    resource_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('reserved', 'confirmed', 'checked_in'))
);

create index bookings_resource_starts_idx on public.bookings (resource_id, starts_at);
create index bookings_status_starts_idx on public.bookings (status, starts_at);
create index bookings_created_by_idx on public.bookings (created_by);
create index bookings_customer_email_idx on public.bookings (lower(customer_email));

alter table public.venues enable row level security;
alter table public.resources enable row level security;
alter table public.availability_rules enable row level security;
alter table public.blocked_times enable row level security;
alter table public.app_members enable row level security;
alter table public.bookings enable row level security;

revoke all on public.venues, public.resources, public.availability_rules,
  public.blocked_times, public.app_members, public.bookings from anon, authenticated;
grant select on public.venues, public.resources to anon, authenticated;
grant select, insert, update, delete on public.venues, public.resources,
  public.availability_rules, public.blocked_times, public.bookings to authenticated;
grant select on public.app_members to authenticated;

create policy "active venues are public"
on public.venues for select to anon, authenticated using (is_active);

create policy "active resources are public"
on public.resources for select to anon, authenticated using (is_active);

create policy "members can read own membership"
on public.app_members for select to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.is_volta_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.app_members
    where user_id = (select auth.uid()) and role in ('admin', 'staff')
  );
$$;

revoke execute on function public.is_volta_staff() from public, anon;
grant execute on function public.is_volta_staff() to authenticated;

create policy "staff manage venues" on public.venues for all to authenticated
using ((select public.is_volta_staff())) with check ((select public.is_volta_staff()));
create policy "staff manage resources" on public.resources for all to authenticated
using ((select public.is_volta_staff())) with check ((select public.is_volta_staff()));
create policy "staff manage availability" on public.availability_rules for all to authenticated
using ((select public.is_volta_staff())) with check ((select public.is_volta_staff()));
create policy "staff manage blocks" on public.blocked_times for all to authenticated
using ((select public.is_volta_staff())) with check ((select public.is_volta_staff()));
create policy "staff manage bookings" on public.bookings for all to authenticated
using ((select public.is_volta_staff())) with check ((select public.is_volta_staff()));

-- Public clients call this function instead of inserting directly. The exclusion
-- constraint is the final protection against two simultaneous bookings.
create or replace function public.create_public_booking(
  requested_resource_id uuid,
  requested_start timestamptz,
  requested_people smallint,
  requested_name text,
  requested_email text,
  requested_phone text
)
returns table (booking_id uuid, reference_code text, pin_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid := gen_random_uuid();
  new_reference text := 'VP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  new_pin text := lpad((floor(random() * 9000) + 1000)::integer::text, 4, '0');
  calculated_price integer;
begin
  if requested_people not between 1 and 9 then
    raise exception 'Gruppen ab 10 Personen benötigen eine Gruppenanfrage';
  end if;
  if requested_start < now() or requested_start > now() + interval '120 days' then
    raise exception 'Ungültiger Buchungszeitpunkt';
  end if;
  if nullif(trim(requested_name), '') is null
    or nullif(trim(requested_email), '') is null
    or nullif(trim(requested_phone), '') is null then
    raise exception 'Kontaktdaten fehlen';
  end if;
  if not exists (
    select 1 from public.resources
    where id = requested_resource_id and is_active and capacity >= requested_people
  ) then
    raise exception 'Tisch nicht verfügbar';
  end if;

  calculated_price := requested_people * case when requested_people <= 5 then 750 else 600 end;

  insert into public.bookings (
    id, reference_code, resource_id, starts_at, ends_at, guest_count,
    customer_name, customer_email, customer_phone, status, source,
    price_cents, currency, pin_code
  ) values (
    new_id, new_reference, requested_resource_id, requested_start,
    requested_start + interval '60 minutes', requested_people,
    trim(requested_name), lower(trim(requested_email)), trim(requested_phone),
    'confirmed', 'online', calculated_price, 'CHF', new_pin
  );

  return query select new_id, new_reference, new_pin;
exception
  when exclusion_violation then
    raise exception 'Dieser Tisch wurde gerade gebucht. Bitte wähle einen anderen Slot.';
end;
$$;

revoke execute on function public.create_public_booking(uuid, timestamptz, smallint, text, text, text) from public;
grant execute on function public.create_public_booking(uuid, timestamptz, smallint, text, text, text) to anon, authenticated;
