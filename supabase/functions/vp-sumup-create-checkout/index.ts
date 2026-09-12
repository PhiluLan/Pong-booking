import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cors, db, json, merchantCode, sumupKey } from "../_shared/sumup.ts";
import { assertAnnyAvailability, provisionAnnyBooking } from "../_shared/anny.ts";

const siteUrl = "https://volta-pong-buchungen.philipplanger.chatgpt.site";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Methode nicht erlaubt" }, 405);
  try {
    const body = await req.json();
    if (body.action === "validate_discount") {
      const { data, error } = await db.rpc("vp_discount_quote", {
        p_code: String(body.code || ""), p_subtotal: Number(body.subtotal),
      });
      if (error || !data?.[0]) throw new Error(error?.message || "Dieser Rabattcode ist nicht gültig");
      return json(req, data[0]);
    }
    const { data: settings, error: settingsError } = await db.from("vp_settings")
      .select("anny_enabled,sumup_enabled").eq("id", true).single();
    if (settingsError) throw settingsError;
    if (settings.anny_enabled) {
      await assertAnnyAvailability(body.date, body.time, Number(body.hours), Number(body.tables));
    }
    const statusToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const { data, error } = await db.rpc("vp_create_sumup_hold", {
      p_date: body.date, p_time: body.time, p_hours: body.hours, p_tables: body.tables,
      p_people: body.people, p_name: body.name, p_email: body.email, p_phone: body.phone,
      p_company: body.company || null, p_notes: body.notes || null, p_addons: body.addons || [],
      p_website: body.website || "", p_status_token: statusToken, p_discount_code: body.discount_code || null,
    });
    if (error || !data?.[0]) throw new Error(error?.message || "Reservierung konnte nicht gehalten werden");
    const hold = data[0];
    const paymentReference = `SUMUP-${hold.reference}-${Date.now()}`;
    const statusQuery = new URLSearchParams({ payment_booking: hold.booking_id, payment_token: statusToken });
    if (Number(hold.price_cents) === 0) {
      if (settings.anny_enabled) {
        try { await provisionAnnyBooking(hold.booking_id); } catch { /* The status endpoint retries fulfillment. */ }
      }
      return json(req, {
        checkout_url: `${siteUrl}/buchen?${statusQuery.toString()}`,
        booking_id: hold.booking_id, reference: hold.reference,
        status_token: statusToken, expires_at: null,
      });
    }
    if (!settings.sumup_enabled) {
      const { error: finalizeError } = await db.rpc("vp_finalize_without_sumup", {
        p_booking_id: hold.booking_id, p_status_token: statusToken,
      });
      if (finalizeError) throw finalizeError;
      if (settings.anny_enabled) {
        try { await provisionAnnyBooking(hold.booking_id); } catch { /* The status endpoint retries fulfillment. */ }
      }
      return json(req, {
        checkout_url: `${siteUrl}/buchen?${statusQuery.toString()}`,
        booking_id: hold.booking_id, reference: hold.reference,
        status_token: statusToken, expires_at: null,
      });
    }
    const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/vp-sumup-webhook`;
    const checkoutResponse = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: { Authorization: `Bearer ${sumupKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        checkout_reference: paymentReference,
        amount: Number((hold.price_cents / 100).toFixed(2)),
        currency: "CHF",
        merchant_code: merchantCode(),
        description: `Volta Pong ${hold.reference}`,
        return_url: webhookUrl,
        redirect_url: `${siteUrl}/buchen?${statusQuery.toString()}`,
        valid_until: hold.expires_at,
        hosted_checkout: { enabled: true },
      }),
    });
    const checkout = await checkoutResponse.json();
    if (!checkoutResponse.ok || !checkout.id || !checkout.hosted_checkout_url) {
      await db.rpc("vp_fail_sumup_hold", { p_booking_id: hold.booking_id, p_payload: checkout });
      throw new Error(checkout?.message || "SumUp-Checkout konnte nicht erstellt werden");
    }
    const { error: attachError } = await db.rpc("vp_attach_sumup_checkout", {
      p_booking_id: hold.booking_id, p_checkout_id: checkout.id,
      p_payment_reference: paymentReference, p_payload: checkout,
    });
    if (attachError) throw new Error(attachError.message);
    return json(req, {
      checkout_url: checkout.hosted_checkout_url,
      booking_id: hold.booking_id,
      reference: hold.reference,
      status_token: statusToken,
      expires_at: hold.expires_at,
    });
  } catch (error) {
    return json(req, { error: error instanceof Error ? error.message : "Checkout fehlgeschlagen" }, 400);
  }
});
