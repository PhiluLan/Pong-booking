/* eslint-disable @typescript-eslint/no-explicit-any */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { db } from "../_shared/sumup.ts";

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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(hours) < 1 || Number(hours) > 24) throw new Error("Ungültige Zeitauswahl");
    const { data: service, error: serviceError } = await db.from("vp_services").select("anny_id,slot_interval_minutes,min_notice_minutes,active").eq("id", "single-flex").single();
    if (serviceError || !service?.active || !service.anny_id) throw new Error("Die Online-Buchungsoption ist nicht vollständig mit Anny verbunden");
    const params = new URLSearchParams({
      service_id: String(service.anny_id),
      resource_id: Deno.env.get("ANNY_RESOURCE_ID") || "181227",
      date,
      duration: String(Number(hours) * 60),
      timezone: "Europe/Zurich",
    });
    const response = await fetch(`https://b.anny.co/api/v1/availability/start?${params}`);
    if (!response.ok) throw new Error("Anny-Verfügbarkeit konnte nicht geprüft werden");
    const data = await response.json();
    const candidates = (Array.isArray(data) ? data : []).map((slot: any) => ({
      start_time: String(slot.start_date || slot.date_time).slice(11, 19),
      available_tables: Math.max(0, Number(slot.remaining_number_available ?? slot.number_available ?? 0)),
    })).filter((slot: any) => slot.available_tables > 0);
    const slots = (await Promise.all(candidates.map(async (slot: any) => {
      const minutes = Number(slot.start_time.slice(0, 2)) * 60 + Number(slot.start_time.slice(3, 5));
      if (minutes % Number(service.slot_interval_minutes || 60) !== 0) return null;
      const { data: localCapacity, error: capacityError } = await db.rpc("vp_capacity_for_slot", { p_date: date, p_time: slot.start_time, p_hours: Number(hours) });
      if (capacityError) throw capacityError;
      return { ...slot, available_tables: Math.min(slot.available_tables, Number(localCapacity || 0)) };
    }))).filter((slot: any) => slot?.available_tables > 0);
    return new Response(JSON.stringify(slots), { headers: headers(req) });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Verfügbarkeit fehlgeschlagen" }), { status: 400, headers: headers(req) });
  }
});
