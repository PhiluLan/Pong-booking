/* eslint-disable @typescript-eslint/no-explicit-any */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const allowedOrigins = new Set([
  "https://volta-pong-buchungen.philipplanger.chatgpt.site",
  "http://localhost:3000",
]);

function headers(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://volta-pong-buchungen.philipplanger.chatgpt.site",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: headers(req) });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Methode nicht erlaubt" }), { status: 405, headers: headers(req) });
  try {
    const { date, hours } = await req.json();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ![1, 2, 3].includes(Number(hours))) throw new Error("Ungültige Zeitauswahl");
    const params = new URLSearchParams({
      service_id: Deno.env.get("ANNY_SERVICE_ID") || "82490",
      resource_id: Deno.env.get("ANNY_RESOURCE_ID") || "181227",
      date,
      duration: String(Number(hours) * 60),
      timezone: "Europe/Zurich",
    });
    const response = await fetch(`https://b.anny.co/api/v1/availability/start?${params}`);
    if (!response.ok) throw new Error("Anny-Verfügbarkeit konnte nicht geprüft werden");
    const data = await response.json();
    const slots = (Array.isArray(data) ? data : []).map((slot: any) => ({
      start_time: String(slot.start_date || slot.date_time).slice(11, 19),
      available_tables: Math.max(0, Number(slot.remaining_number_available ?? slot.number_available ?? 0)),
    })).filter((slot: any) => slot.available_tables > 0);
    return new Response(JSON.stringify(slots), { headers: headers(req) });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Verfügbarkeit fehlgeschlagen" }), { status: 400, headers: headers(req) });
  }
});
