alter table public.vp_addons
  add column if not exists image_url text not null default ''
  check (char_length(image_url) <= 500);

update public.vp_addons
set image_url = case id
  when 'pickup' then '/addons/pickup.png'
  when 'apero' then '/addons/apero.png'
  when 'hummus' then '/addons/hummus.png'
  when 'pizza-bufala' then '/addons/pizza-bufala.png'
  when 'pizza-margherita' then '/addons/pizza-margherita.png'
  else image_url
end;

create or replace function public.vp_admin_save_addon(p_pin text,p_addon jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare aid text:=lower(trim(p_addon->>'id')); saved jsonb; image_value text:=trim(coalesce(p_addon->>'image_url',''));
begin
  if not exists(select 1 from public.vp_settings where admin_pin_hash is not null and admin_pin_hash=extensions.crypt(p_pin,admin_pin_hash)) then raise exception 'Falscher Admin-PIN'; end if;
  if aid !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or length(aid)>50 or length(trim(coalesce(p_addon->>'name',''))) not between 2 and 100 then raise exception 'Extra ist ungültig'; end if;
  if length(image_value)>500 or (image_value<>'' and image_value !~ '^(https://|/)') then raise exception 'Bildadresse ist ungültig'; end if;
  insert into public.vp_addons(id,name,price_cents,active,sort_order,image_url)
  values(aid,left(trim(p_addon->>'name'),100),(p_addon->>'price_cents')::int,coalesce((p_addon->>'active')::boolean,true),coalesce((p_addon->>'sort_order')::smallint,100),image_value)
  on conflict(id) do update set name=excluded.name,price_cents=excluded.price_cents,active=excluded.active,sort_order=excluded.sort_order,image_url=excluded.image_url;
  select to_jsonb(a) into saved from public.vp_addons a where a.id=aid; return saved;
end; $$;

revoke execute on function public.vp_admin_save_addon(text,jsonb) from public;
grant execute on function public.vp_admin_save_addon(text,jsonb) to anon,authenticated;
