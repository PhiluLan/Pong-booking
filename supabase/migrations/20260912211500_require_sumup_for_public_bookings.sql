-- Prevent callers from bypassing SumUp by invoking the legacy booking RPCs.
revoke execute on function public.vp_create_booking(text,date,time,smallint,smallint,text,text,text,text,text,text[],text) from anon,authenticated;
revoke execute on function public.vp_create_simple_booking(date,time,smallint,smallint,smallint,text,text,text,text,text,text[],text) from anon,authenticated;
