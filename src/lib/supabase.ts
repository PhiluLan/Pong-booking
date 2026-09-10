import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  "https://gdgnhxjpsgwdzmhicrbd.supabase.co",
  "sb_publishable_mYIIWNBKghaCw-W5a1tu7A_eUUi4Gwb",
  { auth: { persistSession: false } },
);
