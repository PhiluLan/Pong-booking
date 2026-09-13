-- Cover account foreign keys used by joins and cascade checks.
create index if not exists vp_booking_addon_orders_user_idx on public.vp_booking_addon_orders(user_id);
create index if not exists vp_booking_audit_booking_idx on public.vp_booking_audit(booking_id);
create index if not exists vp_booking_audit_actor_idx on public.vp_booking_audit(actor_user_id);
create index if not exists vp_organizations_created_by_idx on public.vp_organizations(created_by);
create index if not exists vp_organization_invitations_invited_by_idx on public.vp_organization_invitations(invited_by);
create index if not exists vp_staff_members_created_by_idx on public.vp_staff_members(created_by);
create index if not exists vp_staff_invitations_invited_by_idx on public.vp_staff_invitations(invited_by);
