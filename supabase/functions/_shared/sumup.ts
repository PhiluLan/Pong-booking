import { createClient } from "npm:@supabase/supabase-js@2";

export const allowedOrigins = new Set([
  "https://nuknuk.ch",
  "https://pong-booking.vercel.app",
  "https://volta-pong-buchungen.philipplanger.chatgpt.site",
  "http://localhost:3000",
]);

export function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://nuknuk.ch",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

function adminKey() {
  const current = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (current) return JSON.parse(current).default as string;
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

export const db = createClient(Deno.env.get("SUPABASE_URL")!, adminKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const sumupKey = () => Deno.env.get("SUMUP_API_KEY")!;
export const merchantCode = () => Deno.env.get("SUMUP_MERCHANT_CODE")!;

export async function getSumupCheckout(id: string) {
  const response = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${sumupKey()}` },
  });
  if (!response.ok) throw new Error(`SumUp status ${response.status}`);
  return response.json();
}

export function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors(req) });
}
