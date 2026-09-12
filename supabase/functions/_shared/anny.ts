/* eslint-disable @typescript-eslint/no-explicit-any */
import { db } from "./sumup.ts";

const API = "https://b.anny.co/api/v1";
const PEOPLE_FIELD = "0339fead-c616-4f3c-9a6e-88696e26b9d5";

const token = () => Deno.env.get("ANNY_API_TOKEN")!;
const org = () => Deno.env.get("ANNY_ORG_ID")!;
const resource = () => Deno.env.get("ANNY_RESOURCE_ID")!;
const service = () => Deno.env.get("ANNY_SERVICE_ID")!;

async function isAnnyEnabled() {
  const { data, error } = await db.from("vp_settings").select("anny_enabled").eq("id", true).single();
  if (error) throw error;
  return Boolean(data.anny_enabled);
}

async function anny(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}o=${encodeURIComponent(org())}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/vnd.api+json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
  if (!response.ok) {
    const message = body?.message || body?.error || body?.errors?.[0]?.detail || `Anny API ${response.status}`;
    const error = new Error(`${path.split("?")[0]}: ${message}`) as Error & { status?: number; payload?: unknown };
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  return body;
}

function personName(fullName: string) {
  const parts = fullName.trim().split(/\s+/);
  return {
    given_name: parts.shift() || "Volta",
    family_name: parts.join(" ") || "Gast",
  };
}

async function findOrCreateCustomer(booking: any) {
  const query = await anny(`/customers?filter[email]=${encodeURIComponent(booking.customer_email)}`);
  const matches = Array.isArray(query?.data) ? query.data : Array.isArray(query) ? query : [];
  let customer = matches[0];
  if (!customer) {
    const names = personName(booking.customer_name);
    const created = await anny("/customers", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "customers",
          attributes: {
            ...names,
            email: booking.customer_email,
            mobile: booking.customer_phone,
            company: booking.company || null,
            locale: "de-CH",
          },
        },
      }),
    });
    customer = created?.data || created;
  }
  const attributes = customer?.attributes || customer || {};
  return {
    id: String(customer?.id || attributes.id),
    accountId: attributes.account_id ? String(attributes.account_id) : null,
  };
}

export async function getPublicAvailability(date: string, durationMinutes: number) {
  const params = new URLSearchParams({
    service_id: service(), resource_id: resource(), date,
    duration: String(durationMinutes), timezone: "Europe/Zurich",
  });
  const response = await fetch(`${API}/availability/start?${params}`);
  if (!response.ok) throw new Error(`Anny-Verfügbarkeit ${response.status}`);
  const slots = await response.json();
  return (Array.isArray(slots) ? slots : []).map((slot: any) => ({
    start_time: String(slot.start_date || slot.date_time).slice(11, 19),
    available_tables: Math.max(0, Number(slot.remaining_number_available ?? slot.number_available ?? 0)),
  }));
}

export async function assertAnnyAvailability(date: string, time: string, hours: number, tables: number) {
  const slots = await getPublicAvailability(date, hours * 60);
  const wanted = slots.find((slot: any) => slot.start_time.slice(0, 5) === time.slice(0, 5));
  if (!wanted || wanted.available_tables < tables) {
    throw new Error("Diese Auswahl wurde gerade bei Anny vergeben. Bitte neu wählen.");
  }
}

function safeProviderPayload(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const data = (value as any).data || value;
  return {
    type: data?.type || null,
    id: data?.id ? String(data.id) : null,
    status: data?.attributes?.status || data?.status || null,
    created_at: data?.attributes?.created_at || data?.created_at || null,
  };
}

export async function refreshAnnyAccess(bookingId: string) {
  if (!await isAnnyEnabled()) return;
  const { data: booking } = await db.from("vp_bookings").select(
    "id,starts_at,ends_at,anny_booking_id,anny_customer_account_id,access_status"
  ).eq("id", bookingId).maybeSingle();
  if (!booking?.anny_booking_id) return;

  if (booking.anny_customer_account_id) {
    try {
      const grants = await anny(`/customer-accounts/${encodeURIComponent(booking.anny_customer_account_id)}/access-control-grants`);
      const rows = Array.isArray(grants?.data) ? grants.data : [];
      const start = new Date(booking.starts_at).getTime();
      const end = new Date(booking.ends_at).getTime();
      const pins = rows.map((row: any) => row.attributes || row).filter((grant: any) => {
        const from = Date.parse(grant.valid_from);
        const until = Date.parse(grant.valid_until);
        return grant.access_type === "pin" && grant.access_value && from <= start && until >= end && !grant.is_removed;
      });
      if (pins.length) {
        const first = pins[0];
        await db.rpc("vp_set_access_result", {
          p_booking_id: bookingId, p_status: "active", p_code: String(first.access_value),
          p_valid_from: first.valid_from, p_valid_until: first.valid_until,
        });
        return;
      }
    } catch {
      // This internal customer endpoint may require a customer OAuth token.
    }
  }

  await db.rpc("vp_set_access_result", {
    p_booking_id: bookingId,
    p_status: booking.access_status === "issued" ? "issued" : "provisioning",
    p_code: null, p_valid_from: null, p_valid_until: null,
  });
}

async function requestSmartlockAccess(bookingId: string, remoteBookingId: string, startsAt: string, endsAt: string) {
  // This is the same Anny action as “Zugänge neu erstellen” in the booking detail.
  // Anny then provisions the configured, organization-owned SALTO KS integration.
  await anny(`/bookings/${encodeURIComponent(remoteBookingId)}/recreate-access-grants`);
  const validFrom = new Date(new Date(startsAt).getTime() - 60 * 60 * 1000).toISOString();
  const validUntil = new Date(new Date(endsAt).getTime() + 2 * 60 * 60 * 1000).toISOString();
  await db.rpc("vp_set_access_result", {
    p_booking_id: bookingId,
    p_status: "issued",
    p_code: null,
    p_valid_from: validFrom,
    p_valid_until: validUntil,
  });
}

async function createPaidExternalOrder(remoteBookingId: string, customerId: string) {
  const created = await anny("/orders", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "orders",
        attributes: { currency: "CHF", status: "completed" },
        relationships: {
          customer: { data: { type: "customers", id: customerId } },
          bookings: { data: [{ type: "bookings", id: remoteBookingId }] },
        },
        meta: {},
      },
    }),
  });
  const remote = created?.data || created;
  return String(remote?.id || "");
}

export async function provisionAnnyBooking(bookingId: string) {
  if (!await isAnnyEnabled()) return;
  const { data: existing } = await db.from("vp_bookings").select("anny_booking_id,payment_status").eq("id", bookingId).maybeSingle();
  if (!existing || !["paid", "invoice"].includes(existing.payment_status)) return;
  if (existing.anny_booking_id) {
    await refreshAnnyAccess(bookingId);
    return;
  }

  const claim = await db.rpc("vp_claim_anny_fulfillment", { p_booking_id: bookingId });
  const booking = claim.data?.[0];
  if (!booking) return;
  try {
    const customer = await findOrCreateCustomer(booking);
    const addons = Array.isArray(booking.addon_ids) && booking.addon_ids.length
      ? ` Extras: ${booking.addon_ids.join(", ")}.` : "";
    const created = await anny("/bookings?check_availability=1", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "bookings",
          attributes: {
            status: "accepted",
            is_blocker: false,
            description: `${booking.customer_name} · Volta Portal ${booking.reference}`,
            weight: Number(booking.table_count),
            currency: "CHF",
            total: Number(booking.price_cents) / 100,
            custom_price: Number(booking.price_cents) / 100,
            is_net_total: false,
            custom_entry_map: { [PEOPLE_FIELD]: Number(booking.guest_count) },
            manually_created: true,
            is_sub_booking: false,
            start_date: booking.starts_at,
            end_date: booking.ends_at,
            blocker_start_date: booking.starts_at,
            blocker_end_date: booking.ends_at,
            external_uuid: String(booking.id),
            skip_notification: false,
            note: existing.payment_status === "paid"
              ? `Über das Volta-Portal bezahlt CHF ${(booking.price_cents / 100).toFixed(2)}. ${booking.discount_code ? `Rabattcode ${booking.discount_code}. ` : ""}${booking.notes || ""}${addons}`
              : `Über das Volta-Portal gebucht · Zahlung separat/offen CHF ${(booking.price_cents / 100).toFixed(2)}. ${booking.discount_code ? `Rabattcode ${booking.discount_code}. ` : ""}${booking.notes || ""}${addons}`,
            customer_note: `Buchung über volta-pong.ch · ${booking.reference}`,
          },
          relationships: {
            resource: { data: { id: resource(), type: "resources" } },
            service: { data: { id: service(), type: "services" } },
            customer: { data: { id: customer.id, type: "customers" } },
            order: { data: null },
          },
          meta: {},
        },
      }),
    });
    const remote = created?.data || created;
    const remoteBookingId = String(remote?.id || "");
    if (!remoteBookingId) throw new Error("Anny hat keine Buchungs-ID zurückgegeben");
    await anny(`/bookings/${encodeURIComponent(remoteBookingId)}/edit/customer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: customer.id }),
    });
    let remoteOrderId = "";
    if (existing.payment_status === "paid") {
      try {
        // The SumUp charge is already verified. The completed Anny order groups the
        // operational booking and enables Anny's own confirmation-mail workflow.
        remoteOrderId = await createPaidExternalOrder(remoteBookingId, customer.id);
      } catch {
        // Access provisioning is more important than the optional Anny order shell.
      }
    }
    await db.rpc("vp_complete_anny_fulfillment", {
      p_booking_id: bookingId,
      p_order_id: remoteOrderId,
      p_anny_booking_id: remoteBookingId,
      p_booking_number: String(remote?.number || remoteBookingId),
      p_customer_id: customer.id,
      p_customer_account_id: customer.accountId,
      p_payload: safeProviderPayload(created),
    });
    await requestSmartlockAccess(bookingId, remoteBookingId, booking.starts_at, booking.ends_at);
    if (remoteOrderId) {
      try { await anny(`/orders/${encodeURIComponent(remoteOrderId)}/resend-mail`); } catch { /* non-fatal */ }
    }
    await refreshAnnyAccess(bookingId);
  } catch (error) {
    const err = error as Error & { payload?: unknown };
    await db.rpc("vp_fail_anny_fulfillment", {
      p_booking_id: bookingId,
      p_message: err.message || "Anny-Buchung fehlgeschlagen",
      p_payload: safeProviderPayload(err.payload),
    });
    throw error;
  }
}
