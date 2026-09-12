import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cors, db, getSumupCheckout, json, merchantCode } from "../_shared/sumup.ts";
import { provisionAnnyBooking, refreshAnnyAccess } from "../_shared/anny.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Methode nicht erlaubt" }, 405);
  try {
    const { booking_id, status_token } = await req.json();
    let result = await db.rpc("vp_sumup_payment_result", { p_booking_id: booking_id, p_status_token: status_token });
    if (result.error || !result.data?.[0]) return json(req, { error: "Zahlungsvorgang nicht gefunden" }, 404);
    let payment = result.data[0];
    if (payment.payment_status === "pending" && payment.checkout_id) {
      const checkout = await getSumupCheckout(payment.checkout_id);
      if (checkout.merchant_code !== merchantCode()) throw new Error("Falsches Händlerkonto");
      await db.rpc("vp_reconcile_sumup_checkout", {
        p_checkout_id: checkout.id, p_provider_status: checkout.status,
        p_event_key: `status-${checkout.id}-${checkout.status}`, p_payload: checkout,
      });
      result = await db.rpc("vp_sumup_payment_result", { p_booking_id: booking_id, p_status_token: status_token });
      payment = result.data?.[0];
    }
    if (payment?.payment_status === "paid") {
      try {
        await provisionAnnyBooking(booking_id);
        await refreshAnnyAccess(booking_id);
      } catch {
        // The customer-facing status response remains available; the DB records the fulfillment error.
      }
      result = await db.rpc("vp_sumup_payment_result", { p_booking_id: booking_id, p_status_token: status_token });
      payment = result.data?.[0];
    }
    return json(req, payment);
  } catch (error) {
    return json(req, { error: error instanceof Error ? error.message : "Statusprüfung fehlgeschlagen" }, 400);
  }
});
