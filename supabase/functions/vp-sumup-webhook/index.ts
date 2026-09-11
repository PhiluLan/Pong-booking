import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { db, getSumupCheckout, json, merchantCode } from "../_shared/sumup.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(req, { error: "Methode nicht erlaubt" }, 405);
  try {
    const event = await req.json();
    if (event.event_type !== "CHECKOUT_STATUS_CHANGED" || typeof event.id !== "string") {
      return json(req, { error: "Ungültiges Ereignis" }, 400);
    }
    // SumUp webhooks are notifications. The authoritative state is always fetched from SumUp.
    const checkout = await getSumupCheckout(event.id);
    if (checkout.merchant_code !== merchantCode()) return json(req, { error: "Falsches Händlerkonto" }, 403);
    const { error } = await db.rpc("vp_reconcile_sumup_checkout", {
      p_checkout_id: checkout.id, p_provider_status: checkout.status,
      p_event_key: `${event.event_type}-${checkout.id}-${checkout.status}`, p_payload: checkout,
    });
    if (error) throw new Error(error.message);
    return new Response(null, { status: 204 });
  } catch (error) {
    return json(req, { error: error instanceof Error ? error.message : "Webhook fehlgeschlagen" }, 400);
  }
});
