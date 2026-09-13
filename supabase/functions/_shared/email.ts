/* eslint-disable @typescript-eslint/no-explicit-any */
import { db } from "./sumup.ts";

const siteUrl = (Deno.env.get("SITE_URL") || "https://nuknuk.ch").replace(/\/$/, "");

function esc(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character] || character);
}

function money(cents: number) {
  return new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF" }).format(cents / 100);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("de-CH", {
    timeZone: "Europe/Zurich", weekday: "long", day: "2-digit", month: "long",
    year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function shell(preheader: string, title: string, body: string, cta?: { label: string; href: string }) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
  <body style="margin:0;background:#f6ecee;color:#12335b;font-family:Arial,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6ecee"><tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fff;border-radius:24px;overflow:hidden">
        <tr><td style="padding:27px 34px;background:#14549a;color:#fff;font-size:25px;letter-spacing:-1px">VOLTA <span style="color:#ff3213">PONG!</span></td></tr>
        <tr><td style="padding:38px 34px 18px"><div style="color:#ff3213;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase">VOLTA PONG · ZÜRICH</div><h1 style="margin:13px 0 20px;font-family:Georgia,serif;font-size:42px;line-height:1;color:#14549a;font-weight:400">${esc(title)}</h1>${body}</td></tr>
        ${cta ? `<tr><td style="padding:10px 34px 40px"><a href="${esc(cta.href)}" style="display:inline-block;padding:16px 25px;border-radius:12px;background:#ff3213;color:#fff;text-decoration:none;font-weight:700">${esc(cta.label)} →</a></td></tr>` : ""}
        <tr><td style="padding:22px 34px;background:#14549a;color:#dce8f4;font-size:12px;line-height:1.6">Volta Pong · Hardturmstrasse 253, Zürich<br>Fragen? Antworte einfach auf diese E-Mail.</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

async function deliver(eventKey: string, messageType: "booking_confirmation" | "loyalty_purchase", to: string, subject: string, html: string, payload: Record<string, unknown>) {
  const { data: settings, error: settingsError } = await db.from("vp_settings")
    .select("email_enabled,email_from,email_reply_to").eq("id", true).single();
  if (settingsError || !settings?.email_enabled) return;
  const { data: claimed, error: claimError } = await db.rpc("vp_claim_email_delivery", {
    p_event_key: eventKey, p_message_type: messageType, p_recipient: to, p_payload: payload,
  });
  if (claimError || !claimed) return;
  try {
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) throw new Error("RESEND_API_KEY ist nicht konfiguriert");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": eventKey },
      body: JSON.stringify({
        from: settings.email_from, to: [to], reply_to: settings.email_reply_to,
        subject, html, tags: [{ name: "message_type", value: messageType }],
      }),
    });
    const result = await response.json();
    if (!response.ok || !result?.id) throw new Error(result?.message || `E-Mail-Anbieter ${response.status}`);
    await db.rpc("vp_finish_email_delivery", { p_event_key: eventKey, p_status: "sent", p_provider_message_id: result.id, p_error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "E-Mail-Versand fehlgeschlagen";
    await db.rpc("vp_finish_email_delivery", { p_event_key: eventKey, p_status: "failed", p_provider_message_id: null, p_error: message });
    throw error;
  }
}

export async function sendBookingConfirmation(bookingId: string) {
  const { data: booking, error } = await db.from("vp_bookings").select("*").eq("id", bookingId).single();
  if (error || !booking || !["paid", "invoice"].includes(booking.payment_status)) return;
  const [{ data: allocations }, { data: addonRows }, { data: settings }] = await Promise.all([
    db.from("vp_allocations").select("resource_id").eq("booking_id", bookingId).eq("active", true),
    booking.addon_ids?.length ? db.from("vp_addons").select("id,name,price_cents").in("id", [...new Set(booking.addon_ids)]) : Promise.resolve({ data: [] as any[] }),
    db.from("vp_settings").select("vat_enabled,vat_rate_basis_points,vat_number").eq("id", true).single(),
  ]);
  const quantities = (booking.addon_ids || []).reduce((map: Record<string, number>, id: string) => ({ ...map, [id]: (map[id] || 0) + 1 }), {});
  const extras = (addonRows || []).map((addon: any) => `${quantities[addon.id]}× ${addon.name}`).join(", ") || "Keine Extras";
  const total = Number(booking.price_cents || 0);
  const vat = settings?.vat_enabled ? Math.round(total * Number(settings.vat_rate_basis_points) / (10000 + Number(settings.vat_rate_basis_points))) : 0;
  const title = booking.status === "confirmed" ? "Eure Spielzeit steht." : "Zahlung erhalten.";
  const access = booking.access_code ? `<div style="margin-top:18px;padding:17px;border-radius:14px;background:#e8f4ff"><small style="display:block;color:#6f8297">ZUGANGSCODE</small><strong style="font-size:28px;letter-spacing:4px">${esc(booking.access_code)}</strong></div>` : "";
  const body = `<p style="font-size:17px;line-height:1.55;color:#526a83">Hallo ${esc(booking.customer_name)}, eure Buchung ist ${booking.status === "confirmed" ? "bestätigt" : "bezahlt und wird gerade abschliessend eingerichtet"}.</p>
    <div style="margin:24px 0;padding:22px;border-radius:16px;background:#14549a;color:#fff;line-height:1.7">
      <strong style="font-size:21px">${esc(dateTime(booking.starts_at))}</strong><br>
      ${esc((allocations || []).length)} Tisch${(allocations || []).length === 1 ? "" : "e"} · bis ${esc(new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" }).format(new Date(booking.ends_at)))} Uhr<br>
      ${esc(extras)}
    </div>
    <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px"><tr><td style="padding:8px 0;color:#6f8297">Buchungsnummer</td><td align="right"><strong>${esc(booking.reference)}</strong></td></tr><tr><td style="padding:8px 0;color:#6f8297">Bezahlt</td><td align="right"><strong>${esc(money(total))}</strong></td></tr>${settings?.vat_enabled ? `<tr><td style="padding:8px 0;color:#6f8297">darin MWST (${Number(settings.vat_rate_basis_points) / 100} %)</td><td align="right">${esc(money(vat))}</td></tr><tr><td style="padding:8px 0;color:#6f8297">MWST-Nr.</td><td align="right">${esc(settings.vat_number)}</td></tr>` : ""}</table>${access}`;
  await deliver(`booking-confirmation:${booking.id}:${booking.payment_status}`, "booking_confirmation", booking.customer_email, `Volta Pong · Buchung ${booking.reference}`, shell(`Buchung ${booking.reference} bestätigt`, title, body, { label: "Buchung verwalten", href: `${siteUrl}/konto` }), { booking_id: booking.id, reference: booking.reference });
}

export async function sendLoyaltyConfirmation(orderId: string) {
  const { data: order, error } = await db.from("vp_loyalty_orders").select("id,user_id,product_id,amount_cents,status,paid_at").eq("id", orderId).single();
  if (error || !order || order.status !== "paid") return;
  const [{ data: product }, userResult] = await Promise.all([
    db.from("vp_loyalty_products").select("name,kind,credits,validity_days,discount_basis_points,benefits").eq("id", order.product_id).single(),
    db.auth.admin.getUserById(order.user_id),
  ]);
  const recipient = userResult.data.user?.email;
  if (!product || !recipient) return;
  const isPass = product.kind === "multi_pass";
  const benefit = isPass ? `${product.credits} Tischstunden` : `${Number(product.discount_basis_points) / 100} % Mitgliedervorteil`;
  const body = `<p style="font-size:17px;line-height:1.55;color:#526a83">Dein ${esc(product.name)} ist ab sofort aktiv.</p>
    <div style="margin:24px 0;padding:22px;border-radius:16px;background:#14549a;color:#fff"><span style="opacity:.75">DEIN VORTEIL</span><br><strong style="font-size:28px">${esc(benefit)}</strong><br><span>gültig für ${esc(product.validity_days)} Tage</span></div>
    <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px"><tr><td style="padding:8px 0;color:#6f8297">Produkt</td><td align="right"><strong>${esc(product.name)}</strong></td></tr><tr><td style="padding:8px 0;color:#6f8297">Bezahlt</td><td align="right"><strong>${esc(money(Number(order.amount_cents)))}</strong></td></tr></table>`;
  await deliver(`loyalty-purchase:${order.id}`, "loyalty_purchase", recipient, `Volta Pong · ${product.name} ist aktiv`, shell(`${product.name} wurde aktiviert`, "Mehr Volta für dich.", body, { label: isPass ? "Tisch buchen" : "Community öffnen", href: isPass ? `${siteUrl}/buchen` : `${siteUrl}/konto?bereich=paesse` }), { order_id: order.id, product_id: order.product_id });
}
