create or replace function public.vp_reconcile_sumup_checkout(
  p_checkout_id text,p_provider_status text,p_event_key text,p_payload jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path='' as $$
declare bid uuid; normalized text:=upper(coalesce(p_provider_status,'')); use_anny boolean;
begin
  insert into public.vp_payment_events(provider,event_key,checkout_id,status,payload)
  values('sumup',p_event_key,p_checkout_id,normalized,coalesce(p_payload,'{}'::jsonb))
  on conflict(provider,event_key) do nothing;
  select id into bid from public.vp_bookings where payment_checkout_id=p_checkout_id for update;
  if bid is null then raise exception 'Unbekannter SumUp-Checkout'; end if;
  select anny_enabled into use_anny from public.vp_settings where id=true;
  if normalized='PAID' then
    update public.vp_bookings set payment_status='paid',
      status=case when not coalesce(use_anny,true) or anny_sync_status='confirmed' then 'confirmed'::public.vp_booking_status else 'request'::public.vp_booking_status end,
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

revoke execute on function public.vp_reconcile_sumup_checkout(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.vp_reconcile_sumup_checkout(text,text,text,jsonb) to service_role;
