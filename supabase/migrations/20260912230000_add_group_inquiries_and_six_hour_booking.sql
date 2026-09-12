update public.vp_services
set max_duration_hours = 6
where id = 'single-flex';

update public.vp_settings
set studio_config = jsonb_set(studio_config, '{operations,maxDurationHours}', '6'::jsonb),
    updated_at = now()
where id = true;

create table public.vp_group_inquiries (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  desired_date date not null,
  preferred_time time,
  guest_count smallint not null check (guest_count between 25 and 1000),
  first_name text not null check (char_length(first_name) between 1 and 80),
  last_name text not null check (char_length(last_name) between 1 and 80),
  email text not null check (char_length(email) between 5 and 254),
  phone text not null check (char_length(phone) between 7 and 40),
  company text not null default '' check (char_length(company) <= 160),
  message text not null default '' check (char_length(message) <= 2000),
  status text not null default 'new' check (status in ('new','contacted','accepted','declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vp_group_inquiries enable row level security;
revoke all on table public.vp_group_inquiries from anon, authenticated;

create or replace function public.vp_submit_group_inquiry(
  p_desired_date date,
  p_preferred_time time,
  p_guest_count smallint,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone text,
  p_company text default '',
  p_message text default '',
  p_website text default ''
)
returns table(reference text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_reference text;
begin
  if trim(coalesce(p_website, '')) <> '' then raise exception 'Anfrage konnte nicht gesendet werden'; end if;
  if p_desired_date < (now() at time zone 'Europe/Zurich')::date or p_desired_date > (now() at time zone 'Europe/Zurich')::date + 730 then raise exception 'Das gewünschte Datum ist ungültig'; end if;
  if p_guest_count not between 25 and 1000 then raise exception 'Gruppenanfragen sind ab 25 Personen möglich'; end if;
  if char_length(trim(coalesce(p_first_name, ''))) not between 1 and 80 or char_length(trim(coalesce(p_last_name, ''))) not between 1 and 80 then raise exception 'Vor- und Nachname fehlen'; end if;
  if char_length(v_email) not between 5 and 254 or position('@' in v_email) < 2 then raise exception 'E-Mail-Adresse ist ungültig'; end if;
  if char_length(trim(coalesce(p_phone, ''))) not between 7 and 40 then raise exception 'Telefonnummer ist ungültig'; end if;
  if char_length(trim(coalesce(p_company, ''))) > 160 or char_length(trim(coalesce(p_message, ''))) > 2000 then raise exception 'Die Anfrage enthält zu viel Text'; end if;
  if (select count(*) from public.vp_group_inquiries where email = v_email and created_at > now() - interval '30 minutes') >= 3 then raise exception 'Bitte versuche es in 30 Minuten nochmals'; end if;

  loop
    v_reference := 'VG-' || upper(substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 8));
    exit when not exists (select 1 from public.vp_group_inquiries where reference = v_reference);
  end loop;

  insert into public.vp_group_inquiries(reference, desired_date, preferred_time, guest_count, first_name, last_name, email, phone, company, message)
  values(v_reference, p_desired_date, p_preferred_time, p_guest_count, trim(p_first_name), trim(p_last_name), v_email, trim(p_phone), trim(coalesce(p_company, '')), trim(coalesce(p_message, '')));
  return query select v_reference;
end;
$$;

create or replace function public.vp_admin_group_inquiries(p_pin text)
returns table(
  id uuid,
  reference text,
  desired_date date,
  preferred_time time,
  guest_count smallint,
  first_name text,
  last_name text,
  email text,
  phone text,
  company text,
  message text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash = extensions.crypt(p_pin, admin_pin_hash)) then
    raise exception 'Falscher Admin-PIN';
  end if;
  return query
  select g.id, g.reference, g.desired_date, g.preferred_time, g.guest_count, g.first_name, g.last_name,
    g.email, g.phone, g.company, g.message, g.status, g.created_at
  from public.vp_group_inquiries g
  order by g.created_at desc
  limit 250;
end;
$$;

revoke execute on function public.vp_submit_group_inquiry(date,time,smallint,text,text,text,text,text,text,text) from public, authenticated;
grant execute on function public.vp_submit_group_inquiry(date,time,smallint,text,text,text,text,text,text,text) to anon;
revoke execute on function public.vp_admin_group_inquiries(text) from public, anon, authenticated;
grant execute on function public.vp_admin_group_inquiries(text) to anon, authenticated;

comment on table public.vp_group_inquiries is 'Specific Volta Pong group inquiries submitted through the public booking portal.';
