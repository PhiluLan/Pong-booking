"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabasePublishableKey, supabaseUrl } from "@/lib/supabase";
import { money } from "@/lib/volta";

type Product = {
  id: string; name: string; description: string; kind: "multi_pass" | "membership";
  price_cents: number; credits: number; validity_days: number;
  discount_basis_points: number; benefits: string[]; featured: boolean;
};
type Catalog = { products: Product[]; payment_mode: "live" | "test" | "disabled" };

export default function PassShop() {
  const [catalog, setCatalog] = useState<Catalog>({ products: [], payment_mode: "live" });
  const [session, setSession] = useState<Session | null>(null);
  const [selected, setSelected] = useState("");
  const [email, setEmail] = useState("");
  const [mailSent, setMailSent] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const product = useMemo(() => catalog.products.find((item) => item.id === selected) || null, [catalog.products, selected]);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams(location.search);
    setSelected(query.get("produkt") || "");
    Promise.all([supabase.rpc("vp_public_loyalty_catalog"), supabase.auth.getSession()]).then(([catalogResult, authResult]) => {
      if (!active) return;
      if (catalogResult.error) setError(catalogResult.error.message);
      else setCatalog(catalogResult.data as Catalog);
      setSession(authResult.data.session);
      setEmail(authResult.data.session?.user.email || "");
      setBusy(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      if (next?.user.email) setEmail(next.user.email);
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!session) return;
    const query = new URLSearchParams(location.search);
    const orderId = query.get("loyalty_order"), token = query.get("loyalty_token");
    if (!orderId || !token) return;
    void action({ action: "loyalty_status", order_id: orderId, status_token: token }).then((result) => {
      if (result?.status === "paid") {
        setMessage("Dein Angebot ist aktiv und kann sofort verwendet werden.");
        history.replaceState({}, "", "/paesse?erfolg=1");
      } else if (result?.status) setError(`Zahlungsstatus: ${result.status}`);
    });
    // The payment parameters are consumed once for the current authenticated session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function action(body: Record<string, unknown>) {
    if (!session) return null;
    setBusy(true); setError("");
    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/vp-account-booking`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: supabasePublishableKey, Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Aktion fehlgeschlagen");
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Aktion fehlgeschlagen");
      return null;
    } finally { setBusy(false); }
  }

  async function requestLink(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const redirect = new URL("/paesse", location.origin);
    if (selected) redirect.searchParams.set("produkt", selected);
    redirect.searchParams.set("kauf", "1");
    const { error: loginError } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirect.toString() } });
    setBusy(false);
    if (loginError) setError(loginError.message); else setMailSent(true);
  }

  async function buy() {
    if (!product) return;
    const result = await action({ action: "buy_loyalty_product", product_id: product.id, return_path: "/paesse" });
    if (result?.checkout_url) location.assign(result.checkout_url);
  }

  return <main className="pass-shop">
    <header className="pass-shop-nav"><Link href="/buchen" className="pass-logo">VOLTA <span>PONG!</span></Link><nav><Link href="/buchen">Tisch buchen</Link><Link href="/konto">Mein Konto</Link></nav></header>
    <section className="pass-hero"><p className="eyebrow">MEHR SPIELEN · MEHR VOLTA</p><h1>Pässe &<br/>Community.</h1><p>Tischstunden zum Vorteilspreis oder ein Jahr voller Community-Vorteile. Direkt kaufen und sofort verwenden.</p></section>
    {catalog.payment_mode === "test" && <div className="shop-mode test">Testbetrieb · Käufe sind nur für freigeschaltete Teamkonten möglich.</div>}
    {catalog.payment_mode === "disabled" && <div className="shop-mode">Der Verkauf ist momentan pausiert. Bereits gekaufte Pässe bleiben gültig.</div>}
    {error && <div className="form-error shop-message">{error}</div>}
    {message && <section className="purchase-success"><span>✓</span><div><strong>Willkommen!</strong><p>{message}</p></div><Link href="/buchen">Jetzt Tisch buchen →</Link></section>}
    <section className="public-products" aria-busy={busy}>
      {catalog.products.map((item) => <article key={item.id} className={`${item.featured ? "featured" : ""} ${selected === item.id ? "selected" : ""}`}>
        {item.featured && <em>Volta Empfehlung</em>}
        <p>{item.kind === "multi_pass" ? `${item.credits} Tischstunden` : "Community Membership"}</p>
        <h2>{item.name}</h2><span>{item.description}</span>
        <ul>{item.benefits.map((benefit) => <li key={benefit}>✓ {benefit}</li>)}</ul>
        <div><strong>{money(item.price_cents)}</strong><small>{item.kind === "multi_pass" ? `${money(Math.round(item.price_cents / item.credits))} pro Tischstunde` : `${item.validity_days} Tage gültig`}</small></div>
        <button disabled={busy || catalog.payment_mode === "disabled"} onClick={() => { setSelected(item.id); setError(""); document.getElementById("purchase")?.scrollIntoView({ behavior: "smooth" }); }}>Auswählen →</button>
      </article>)}
    </section>
    {product && catalog.payment_mode !== "disabled" && <section className="purchase-panel" id="purchase">
      <div><p className="eyebrow">DEINE AUSWAHL</p><h2>{product.name}</h2><p>{product.kind === "multi_pass" ? `${product.credits} Tischstunden werden nach der Zahlung deinem Konto gutgeschrieben.` : `Deine Membership und der Mitgliedervorteil werden nach der Zahlung sofort aktiviert.`}</p></div>
      {!session ? <form onSubmit={requestLink}>
        {!mailSent ? <><label>E-Mail-Adresse<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="du@beispiel.ch"/></label><button disabled={busy}>{busy ? "Wird gesendet …" : "Mit Magic Link weiter"}</button><small>Kein Passwort nötig. Deine Auswahl bleibt erhalten.</small></> : <div className="mail-sent"><strong>Schau in dein Postfach.</strong><p>Öffne den Magic Link auf diesem Gerät. Danach kannst du direkt bezahlen.</p><button type="button" onClick={() => setMailSent(false)}>Andere E-Mail verwenden</button></div>}
      </form> : <div className="purchase-action"><span>Angemeldet als <strong>{session.user.email}</strong></span><button disabled={busy} onClick={() => void buy()}>{busy ? "Wird vorbereitet …" : catalog.payment_mode === "test" ? "Testkauf aktivieren" : `${money(product.price_cents)} mit SumUp bezahlen`}</button><small>Nach erfolgreicher Zahlung wird dein Vorteil automatisch aktiviert.</small></div>}
    </section>}
    <section className="pass-explainer"><article><b>1</b><h3>Auswählen</h3><p>Pass oder Membership aussuchen.</p></article><article><b>2</b><h3>Sicher bezahlen</h3><p>Über den SumUp-Checkout bezahlen.</p></article><article><b>3</b><h3>Sofort spielen</h3><p>Guthaben beim Checkout einsetzen.</p></article></section>
  </main>;
}
