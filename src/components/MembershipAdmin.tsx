"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { money } from "@/lib/volta";

type Product = {
  id: string;
  name: string;
  description: string;
  kind: "multi_pass" | "membership";
  price_cents: number;
  credits: number;
  validity_days: number;
  discount_basis_points: number;
  benefits: string[];
  active: boolean;
  featured: boolean;
  sort_order: number;
  sales?: number;
};
type Catalog = {
  products: Product[];
  paid_orders: number;
  revenue_cents: number;
  active_members: number;
  credits_open: number;
};

const blank: Product = {
  id: "",
  name: "",
  description: "",
  kind: "multi_pass",
  price_cents: 0,
  credits: 5,
  validity_days: 365,
  discount_basis_points: 0,
  benefits: [],
  active: true,
  featured: false,
  sort_order: 100,
};

export default function MembershipAdmin({ pin }: { pin: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState<Product>(blank);
  const [benefits, setBenefits] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const editing = useMemo(
    () => catalog?.products.some((product) => product.id === selected.id),
    [catalog, selected.id],
  );

  async function load(preselect?: string) {
    setBusy(true);
    const { data, error } = await supabase.rpc("vp_admin_loyalty_catalog", {
      p_pin: pin,
    });
    setBusy(false);
    if (error) return setMessage(error.message);
    const next = data as Catalog;
    setCatalog(next);
    const chosen = next.products.find((product) => product.id === preselect);
    if (chosen) choose(chosen);
  }

  function choose(product: Product) {
    setSelected({ ...product });
    setBenefits((product.benefits || []).join("\n"));
    setMessage("");
  }

  function createNew(kind: Product["kind"] = "multi_pass") {
    setSelected({ ...blank, kind });
    setBenefits("");
    setMessage("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const product = {
      ...selected,
      id: selected.id
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, ""),
      credits: selected.kind === "membership" ? 0 : selected.credits,
      benefits: benefits
        .split(/\n|,/)
        .map((value) => value.trim())
        .filter(Boolean),
    };
    const { data, error } = await supabase.rpc("vp_admin_save_loyalty_product", {
      p_pin: pin,
      p_product: product,
    });
    setBusy(false);
    if (error) return setMessage(error.message);
    setMessage("Gespeichert – das Angebot ist sofort im Kundenkonto sichtbar.");
    await load(String(data));
  }

  useEffect(() => {
    void load();
    // The admin PIN is stable for this mounted protected view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  if (!catalog)
    return <div className="studio-loading">Angebote werden geladen …</div>;

  return (
    <section className="loyalty-admin">
      <div className="loyalty-admin-stats">
        <article><span>Verkäufe</span><strong>{catalog.paid_orders}</strong></article>
        <article><span>Umsatz</span><strong>{money(catalog.revenue_cents)}</strong></article>
        <article><span>Aktive Mitglieder</span><strong>{catalog.active_members}</strong></article>
        <article><span>Offene Tischstunden</span><strong>{catalog.credits_open}</strong></article>
      </div>
      <div className="loyalty-admin-layout">
        <aside className="loyalty-catalog">
          <header>
            <div><span>Angebotskatalog</span><strong>{catalog.products.length} Produkte</strong></div>
            <button type="button" onClick={() => createNew()}>＋ Neu</button>
          </header>
          {catalog.products.map((product) => (
            <button
              type="button"
              key={product.id}
              className={selected.id === product.id ? "active" : ""}
              onClick={() => choose(product)}
            >
              <span className={`product-kind ${product.kind}`}>
                {product.kind === "multi_pass" ? `${product.credits}×` : "Club"}
              </span>
              <span><strong>{product.name}</strong><small>{money(product.price_cents)} · {product.sales || 0} verkauft</small></span>
              <i>{product.active ? "Aktiv" : "Pausiert"}</i>
            </button>
          ))}
          <button className="new-membership" type="button" onClick={() => createNew("membership")}>＋ Neue Mitgliedschaft</button>
        </aside>
        <form className="loyalty-editor" onSubmit={save}>
          <header>
            <div><span>{editing ? "Angebot bearbeiten" : "Neues Angebot"}</span><h2>{selected.name || "Produkt konfigurieren"}</h2></div>
            <button disabled={busy}>{busy ? "Speichert …" : "Speichern"}</button>
          </header>
          {message && <p className="loyalty-message">{message}</p>}
          <div className="loyalty-form-grid">
            <label>Interner Schlüssel<input required disabled={Boolean(editing)} value={selected.id} placeholder="z-b-zehner-pass" onChange={(e) => setSelected({ ...selected, id: e.target.value })}/></label>
            <label>Typ<select value={selected.kind} onChange={(e) => setSelected({ ...selected, kind: e.target.value as Product["kind"] })}><option value="multi_pass">Mehrfachkarte</option><option value="membership">Mitgliedschaft</option></select></label>
            <label className="wide">Name<input required value={selected.name} onChange={(e) => setSelected({ ...selected, name: e.target.value })}/></label>
            <label className="wide">Beschreibung<textarea rows={3} value={selected.description} onChange={(e) => setSelected({ ...selected, description: e.target.value })}/></label>
            <label>Preis in CHF<input required min="0" step="0.01" type="number" value={(selected.price_cents / 100).toFixed(2)} onChange={(e) => setSelected({ ...selected, price_cents: Math.round(Number(e.target.value) * 100) })}/></label>
            <label>Gültigkeit in Tagen<input required min="1" type="number" value={selected.validity_days} onChange={(e) => setSelected({ ...selected, validity_days: Number(e.target.value) })}/></label>
            {selected.kind === "multi_pass" ? (
              <label>Tischstunden<input required min="1" type="number" value={selected.credits} onChange={(e) => setSelected({ ...selected, credits: Number(e.target.value) })}/></label>
            ) : (
              <label>Mitgliederrabatt in %<input required min="0" max="100" step="0.1" type="number" value={selected.discount_basis_points / 100} onChange={(e) => setSelected({ ...selected, discount_basis_points: Math.round(Number(e.target.value) * 100) })}/></label>
            )}
            <label>Sortierung<input type="number" value={selected.sort_order} onChange={(e) => setSelected({ ...selected, sort_order: Number(e.target.value) })}/></label>
            <label className="wide">Vorteile <small>Ein Vorteil pro Zeile</small><textarea rows={4} value={benefits} onChange={(e) => setBenefits(e.target.value)} placeholder={"Günstiger spielen\nEinladungen zu Community-Events"}/></label>
          </div>
          <div className="loyalty-toggles">
            <label><input type="checkbox" checked={selected.active} onChange={(e) => setSelected({ ...selected, active: e.target.checked })}/><span><strong>Aktiv</strong><small>Im Kundenkonto kaufbar</small></span></label>
            <label><input type="checkbox" checked={selected.featured} onChange={(e) => setSelected({ ...selected, featured: e.target.checked })}/><span><strong>Hervorheben</strong><small>Als Empfehlung markieren</small></span></label>
          </div>
        </form>
      </div>
    </section>
  );
}
