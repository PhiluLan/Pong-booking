import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cors, db, json, merchantCode, sumupKey } from "../_shared/sumup.ts";
import { assertAnnyAvailability, cancelAnnyBooking, rescheduleAnnyBooking } from "../_shared/anny.ts";

const siteUrl = (Deno.env.get("SITE_URL") || "https://nuknuk.ch").replace(/\/$/, "");

async function authenticatedUser(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Anmeldung erforderlich");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new Error("Sitzung abgelaufen. Bitte erneut anmelden.");
  return data.user;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Methode nicht erlaubt" }, 405);
  try {
    const user = await authenticatedUser(req);
    const body = await req.json();

    if (body.action === "update") {
      const { error } = await db.rpc("vp_update_my_booking", {
        p_user_id: user.id, p_booking_id: body.booking_id,
        p_guest_count: Number(body.guest_count), p_phone: String(body.phone || ""),
        p_notes: String(body.notes || ""),
      });
      if (error) throw error;
      return json(req, { ok: true });
    }

    if (body.action === "cancel") {
      const { data: booking } = await db.from("vp_bookings").select("anny_booking_id").eq("id", body.booking_id).maybeSingle();
      const { error } = await db.rpc("vp_cancel_my_booking", { p_user_id: user.id, p_booking_id: body.booking_id });
      if (error) throw error;
      let externalSynced = true;
      if (booking?.anny_booking_id) {
        try { await cancelAnnyBooking(body.booking_id); }
        catch (syncError) {
          externalSynced = false;
          await db.from("vp_bookings").update({ anny_sync_status: "failed", anny_last_error: syncError instanceof Error ? syncError.message : "Stornierung nicht synchronisiert" }).eq("id", body.booking_id);
        }
      }
      return json(req, { ok: true, external_synced: externalSynced });
    }

    if (body.action === "reschedule") {
      const { data: booking, error: bookingError } = await db.from("vp_bookings")
        .select("starts_at,ends_at,anny_booking_id,organization_id")
        .eq("id", body.booking_id).maybeSingle();
      if (bookingError || !booking) throw new Error("Buchung nicht gefunden");
      const hours = Math.round((new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) / 3600000);
      const { count } = await db.from("vp_allocations").select("resource_id", { count: "exact", head: true }).eq("booking_id", body.booking_id).eq("active", true);
      const tables = Math.max(1, count || 0);
      const { data: settings } = await db.from("vp_settings").select("anny_enabled").eq("id", true).single();
      if (settings?.anny_enabled) await assertAnnyAvailability(String(body.date), String(body.time), hours, tables);
      const { error } = await db.rpc("vp_reschedule_my_booking", {
        p_user_id: user.id, p_booking_id: body.booking_id, p_date: body.date, p_time: body.time,
      });
      if (error) throw error;
      let externalSynced = true;
      if (booking.anny_booking_id && settings?.anny_enabled) {
        try { await rescheduleAnnyBooking(body.booking_id); }
        catch (syncError) {
          externalSynced = false;
          await db.from("vp_bookings").update({ anny_sync_status: "failed", anny_last_error: syncError instanceof Error ? syncError.message : "Umbuchung nicht synchronisiert" }).eq("id", body.booking_id);
        }
      }
      return json(req, { ok: true, external_synced: externalSynced });
    }

    if (body.action === "add_extras") {
      const statusToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const { data, error } = await db.rpc("vp_prepare_account_addons", {
        p_user_id: user.id, p_booking_id: body.booking_id,
        p_addons: Array.isArray(body.addons) ? body.addons : [], p_status_token: statusToken,
      });
      if (error || !data?.[0]) throw new Error(error?.message || "Extras konnten nicht vorbereitet werden");
      const order = data[0];
      const params = new URLSearchParams({ addon_order: order.order_id, addon_token: statusToken });
      if (Number(order.amount_cents) === 0) return json(req, { checkout_url: `${siteUrl}/konto?${params}`, paid: true });
      const { data: settings } = await db.from("vp_settings").select("sumup_enabled").eq("id", true).single();
      if (!settings?.sumup_enabled) {
        const checkoutId = `manual-${order.order_id}`;
        await db.rpc("vp_attach_account_addon_checkout", { p_order_id: order.order_id, p_checkout_id: checkoutId, p_payload: { mode: "manual" } });
        await db.rpc("vp_reconcile_account_addon_order", { p_checkout_id: checkoutId, p_provider_status: "PAID", p_payload: { mode: "manual" } });
        return json(req, { checkout_url: `${siteUrl}/konto?${params}`, paid: true });
      }
      const checkoutReference = `SUMUP-EXTRA-${String(order.order_id).slice(0, 8)}-${Date.now()}`;
      const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/vp-sumup-webhook`;
      const response = await fetch("https://api.sumup.com/v0.1/checkouts", {
        method: "POST",
        headers: { Authorization: `Bearer ${sumupKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout_reference: checkoutReference,
          amount: Number((Number(order.amount_cents) / 100).toFixed(2)), currency: "CHF",
          merchant_code: merchantCode(), description: "Volta Pong · zusätzliche Extras",
          return_url: webhookUrl, redirect_url: `${siteUrl}/konto?${params}`,
          valid_until: order.expires_at, hosted_checkout: { enabled: true },
        }),
      });
      const checkout = await response.json();
      if (!response.ok || !checkout.id || !checkout.hosted_checkout_url) throw new Error(checkout?.message || "Zahlung konnte nicht gestartet werden");
      const attached = await db.rpc("vp_attach_account_addon_checkout", { p_order_id: order.order_id, p_checkout_id: checkout.id, p_payload: checkout });
      if (attached.error) throw attached.error;
      return json(req, { checkout_url: checkout.hosted_checkout_url, paid: false });
    }

    if (body.action === "addon_status") {
      let result = await db.rpc("vp_account_addon_result", { p_user_id: user.id, p_order_id: body.order_id, p_status_token: body.status_token });
      if (result.error || !result.data?.[0]) throw new Error("Zusatzbestellung nicht gefunden");
      let row = result.data[0];
      if (row.status === "pending" && row.checkout_id && !String(row.checkout_id).startsWith("manual-")) {
        const response = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(row.checkout_id)}`, { headers: { Authorization: `Bearer ${sumupKey()}` } });
        const checkout = await response.json();
        if (response.ok) await db.rpc("vp_reconcile_account_addon_order", { p_checkout_id: row.checkout_id, p_provider_status: checkout.status, p_payload: checkout });
        result = await db.rpc("vp_account_addon_result", { p_user_id: user.id, p_order_id: body.order_id, p_status_token: body.status_token });
        row = result.data?.[0] || row;
      }
      return json(req, row);
    }

    if (body.action === "buy_loyalty_product") {
      const statusToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const { data, error } = await db.rpc("vp_prepare_loyalty_order", {
        p_user_id: user.id, p_product_id: String(body.product_id || ""), p_status_token: statusToken,
      });
      if (error || !data?.[0]) throw new Error(error?.message || "Produkt konnte nicht bestellt werden");
      const order = data[0];
      const params = new URLSearchParams({ loyalty_order: order.order_id, loyalty_token: statusToken });
      if (Number(order.amount_cents) === 0) return json(req, { checkout_url: `${siteUrl}/konto?${params}`, paid: true });
      const { data: settings } = await db.from("vp_settings").select("sumup_enabled").eq("id", true).single();
      if (!settings?.sumup_enabled) {
        const checkoutId = `manual-loyalty-${order.order_id}`;
        await db.rpc("vp_attach_loyalty_checkout", { p_order_id: order.order_id, p_checkout_id: checkoutId, p_payload: { mode: "manual" } });
        await db.rpc("vp_reconcile_loyalty_order", { p_checkout_id: checkoutId, p_provider_status: "PAID", p_payload: { mode: "manual" } });
        return json(req, { checkout_url: `${siteUrl}/konto?${params}`, paid: true });
      }
      const response = await fetch("https://api.sumup.com/v0.1/checkouts", {
        method: "POST",
        headers: { Authorization: `Bearer ${sumupKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout_reference: `SUMUP-LOYALTY-${String(order.order_id).slice(0, 8)}-${Date.now()}`,
          amount: Number((Number(order.amount_cents) / 100).toFixed(2)), currency: "CHF",
          merchant_code: merchantCode(), description: "Volta Pong · Pass oder Mitgliedschaft",
          return_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/vp-sumup-webhook`,
          redirect_url: `${siteUrl}/konto?${params}`, valid_until: order.expires_at,
          hosted_checkout: { enabled: true },
        }),
      });
      const checkout = await response.json();
      if (!response.ok || !checkout.id || !checkout.hosted_checkout_url) throw new Error(checkout?.message || "Zahlung konnte nicht gestartet werden");
      const attached = await db.rpc("vp_attach_loyalty_checkout", { p_order_id: order.order_id, p_checkout_id: checkout.id, p_payload: checkout });
      if (attached.error) throw attached.error;
      return json(req, { checkout_url: checkout.hosted_checkout_url, paid: false });
    }

    if (body.action === "loyalty_status") {
      let result = await db.rpc("vp_loyalty_order_result", { p_user_id: user.id, p_order_id: body.order_id, p_status_token: body.status_token });
      if (result.error || !result.data?.[0]) throw new Error("Bestellung nicht gefunden");
      let row = result.data[0];
      if (row.status === "pending" && row.checkout_id && !String(row.checkout_id).startsWith("manual-")) {
        const response = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(row.checkout_id)}`, { headers: { Authorization: `Bearer ${sumupKey()}` } });
        const checkout = await response.json();
        if (response.ok) await db.rpc("vp_reconcile_loyalty_order", { p_checkout_id: row.checkout_id, p_provider_status: checkout.status, p_payload: checkout });
        result = await db.rpc("vp_loyalty_order_result", { p_user_id: user.id, p_order_id: body.order_id, p_status_token: body.status_token });
        row = result.data?.[0] || row;
      }
      return json(req, row);
    }

    return json(req, { error: "Unbekannte Aktion" }, 400);
  } catch (error) {
    return json(req, { error: error instanceof Error ? error.message : "Aktion fehlgeschlagen" }, 400);
  }
});
