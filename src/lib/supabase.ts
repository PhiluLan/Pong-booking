import { createClient } from "@supabase/supabase-js";

export const supabaseUrl = "https://gdgnhxjpsgwdzmhicrbd.supabase.co";
export const supabasePublishableKey = "sb_publishable_mYIIWNBKghaCw-W5a1tu7A_eUUi4Gwb";

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);
