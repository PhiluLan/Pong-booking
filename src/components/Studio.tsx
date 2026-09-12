"use client";

import { DragEvent, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { defaultStudioConfig, mergeStudioConfig, StudioBlockId, StudioConfig, studioBlockLabels } from "@/lib/studio";

type Tab = "booking" | "design" | "builder";
const steps = ["Zeit", "Tische", "Extras", "Checkout"];

export default function Studio({ pin }: { pin: string }) {
  const [config, setConfig] = useState<StudioConfig>(defaultStudioConfig);
  const [tab, setTab] = useState<Tab>("booking");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [dragged, setDragged] = useState<StudioBlockId | null>(null);

  useEffect(() => {
    supabase.rpc("vp_admin_get_studio", { p_pin: pin }).then(({ data, error: loadError }) => {
      if (loadError) setError(loadError.message);
      else setConfig(mergeStudioConfig(data));
      setLoading(false);
    });
  }, [pin]);

  function operation<K extends keyof StudioConfig["operations"]>(key: K, value: StudioConfig["operations"][K]) {
    setConfig((current) => ({ ...current, operations: { ...current.operations, [key]: value } }));
  }
  function content<K extends keyof StudioConfig["content"]>(key: K, value: StudioConfig["content"][K]) {
    setConfig((current) => ({ ...current, content: { ...current.content, [key]: value } }));
  }
  function design<K extends keyof StudioConfig["design"]>(key: K, value: StudioConfig["design"][K]) {
    setConfig((current) => ({ ...current, design: { ...current.design, [key]: value } }));
  }
  function move(id: StudioBlockId, direction: -1 | 1) {
    setConfig((current) => {
      const blocks = [...current.blocks], index = blocks.findIndex((block) => block.id === id), target = index + direction;
      if (target < 0 || target >= blocks.length) return current;
      [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
      return { ...current, blocks };
    });
  }
  function drop(event: DragEvent, target: StudioBlockId) {
    event.preventDefault();
    if (!dragged || dragged === target) return;
    setConfig((current) => {
      const blocks = [...current.blocks], from = blocks.findIndex((block) => block.id === dragged), to = blocks.findIndex((block) => block.id === target);
      const [item] = blocks.splice(from, 1); blocks.splice(to, 0, item);
      return { ...current, blocks };
    });
    setDragged(null);
  }
  async function save() {
    setSaving(true); setSaved(false); setError("");
    const { data, error: saveError } = await supabase.rpc("vp_admin_save_studio", { p_pin: pin, p_config: config });
    if (saveError) setError(saveError.message); else { setConfig(mergeStudioConfig(data)); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    setSaving(false);
  }

  const d = config.design, radius = d.buttonStyle === "pill" ? 999 : d.buttonStyle === "square" ? 4 : Math.min(18, d.radius);
  if (loading) return <section className="studio-loading"><div className="loader"/><span>Studio wird geladen …</span></section>;

  return <section className="studio">
    <div className="studio-toolbar">
      <div className="studio-tabs">
        <button className={tab === "booking" ? "active" : ""} onClick={() => setTab("booking")}>Buchung</button>
        <button className={tab === "design" ? "active" : ""} onClick={() => setTab("design")}>Design</button>
        <button className={tab === "builder" ? "active" : ""} onClick={() => setTab("builder")}>Seitenaufbau</button>
      </div>
      <div className="studio-actions"><a href="/buchen" target="_blank">Live-Seite ↗</a><button onClick={save} disabled={saving}>{saving ? "Speichert …" : saved ? "Gespeichert ✓" : "Änderungen speichern"}</button></div>
    </div>
    {error && <div className="form-error">{error}</div>}
    <div className="studio-workspace">
      <div className="studio-controls">
        {tab === "booking" && <>
          <div className="studio-section"><p className="eyebrow">BETRIEB</p><h2>Wann und wo?</h2><div className="studio-form two">
            <label>Name<input value={config.operations.venueName} onChange={(e) => operation("venueName", e.target.value)}/></label>
            <label>Adresse<input value={config.operations.address} onChange={(e) => operation("address", e.target.value)}/></label>
            <label>Öffnet um<input type="time" value={config.operations.opensAt} onChange={(e) => operation("opensAt", e.target.value)}/></label>
            <label>Schliesst um<input type="time" value={config.operations.closesAt} onChange={(e) => operation("closesAt", e.target.value)}/></label>
            <label>Buchbar für Tage<input type="number" min="7" max="365" value={config.operations.horizonDays} onChange={(e) => operation("horizonDays", Number(e.target.value))}/></label>
            <label>Maximale Dauer<input type="number" min="1" max="6" value={config.operations.maxDurationHours} onChange={(e) => operation("maxDurationHours", Number(e.target.value))}/></label>
          </div></div>
          <div className="studio-section"><p className="eyebrow">PREISE</p><h2>Dynamische Tarife</h2><div className="studio-form three">
            <label>Tagestarif CHF<input type="number" min="0" step="1" value={config.operations.morningPriceCents / 100} onChange={(e) => operation("morningPriceCents", Math.round(Number(e.target.value) * 100))}/></label>
            <label>Abendtarif CHF<input type="number" min="0" step="1" value={config.operations.eveningPriceCents / 100} onChange={(e) => operation("eveningPriceCents", Math.round(Number(e.target.value) * 100))}/></label>
            <label>Abendtarif ab<input type="time" value={config.operations.eveningStartsAt} onChange={(e) => operation("eveningStartsAt", e.target.value)}/></label>
          </div><p className="studio-help">Preisänderungen gelten nach dem Speichern direkt im sichtbaren Rechner und im serverseitigen SumUp-Checkout.</p></div>
          <div className="studio-section integration-strip"><div><i className="ok"/><span><strong>SumUp</strong><small>Checkout verbunden</small></span></div><div><i className="ok"/><span><strong>Anny</strong><small>Verfügbarkeit synchronisiert</small></span></div><div><i className="ok"/><span><strong>SALTO KS</strong><small>Zugang über Anny</small></span></div><p>Zugangszeitraum und Türkonfiguration werden weiterhin in Anny/SALTO verwaltet.</p></div>
        </>}
        {tab === "design" && <>
          <div className="studio-section"><p className="eyebrow">MARKENFARBEN</p><h2>Look & Feel</h2><div className="color-grid">
            {([['primary','Primärfarbe'],['accent','Akzentfarbe'],['background','Seitenfläche'],['surface','Kartenfläche'],['text','Textfarbe']] as const).map(([key,label]) => <label key={key}><span><input type="color" value={d[key]} onChange={(e) => design(key, e.target.value)}/>{label}</span><input value={d[key]} onChange={(e) => design(key, e.target.value)}/></label>)}
          </div></div>
          <div className="studio-section"><p className="eyebrow">FORMEN</p><h2>Ecken & Buttons</h2><label className="range-label">Kartenradius <strong>{d.radius}px</strong><input type="range" min="8" max="42" value={d.radius} onChange={(e) => design("radius", Number(e.target.value))}/></label><div className="segmented"><button className={d.buttonStyle === "square" ? "active" : ""} onClick={() => design("buttonStyle", "square")}>Kompakt</button><button className={d.buttonStyle === "rounded" ? "active" : ""} onClick={() => design("buttonStyle", "rounded")}>Rund</button><button className={d.buttonStyle === "pill" ? "active" : ""} onClick={() => design("buttonStyle", "pill")}>Pill</button></div></div>
        </>}
        {tab === "builder" && <>
          <div className="studio-section"><p className="eyebrow">INHALTE</p><h2>Texte bearbeiten</h2><div className="studio-form">
            <label>Kleine Überschrift<input value={config.content.eyebrow} onChange={(e) => content("eyebrow", e.target.value)}/></label>
            <label>Hauptüberschrift<textarea value={config.content.headline} onChange={(e) => content("headline", e.target.value)}/></label>
            <label>Vorteil 1<input value={config.content.benefits[0] || ""} onChange={(e) => content("benefits", [e.target.value, config.content.benefits[1] || ""])}/></label>
            <label>Vorteil 2<input value={config.content.benefits[1] || ""} onChange={(e) => content("benefits", [config.content.benefits[0] || "", e.target.value])}/></label>
            <label>Bedingungen<textarea value={config.content.termsLabel} onChange={(e) => content("termsLabel", e.target.value)}/></label>
            <label>Hinweis unter Zahlung<textarea value={config.content.paymentNote} onChange={(e) => content("paymentNote", e.target.value)}/></label>
          </div></div>
          <div className="studio-section"><p className="eyebrow">DRAG & DROP</p><h2>Elemente anordnen</h2><p className="studio-help">Am Griff ziehen oder mit den Pfeilen verschieben. Der Schalter blendet ein Element aus.</p><div className="block-list">{config.blocks.map((block, index) => <div key={block.id} draggable onDragStart={() => setDragged(block.id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, block.id)}>
            <span className="drag-handle">⠿</span><span><strong>{studioBlockLabels[block.id].title}</strong><small>{studioBlockLabels[block.id].hint}</small></span><div className="block-buttons"><button disabled={index === 0} onClick={() => move(block.id, -1)} aria-label="Nach oben">↑</button><button disabled={index === config.blocks.length - 1} onClick={() => move(block.id, 1)} aria-label="Nach unten">↓</button><label className="switch"><input type="checkbox" checked={block.visible} onChange={(e) => setConfig((current) => ({ ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, visible: e.target.checked } : item) }))}/><i/></label></div>
          </div>)}</div></div>
        </>}
      </div>
      <div className="studio-preview-wrap"><div className="preview-label"><span>Live-Vorschau</span><small>Desktop</small></div><div className="studio-preview" style={{ "--preview-primary": d.primary, "--preview-accent": d.accent, "--preview-bg": d.background, "--preview-surface": d.surface, "--preview-text": d.text, "--preview-radius": `${d.radius}px`, "--preview-button-radius": `${radius}px` } as React.CSSProperties}>
        <header><b>VOLTA <em>PONG!</em></b><span>{config.operations.address}</span></header><div className="preview-shell"><aside>{config.blocks.filter((block) => block.visible).map((block) => block.id === "intro" ? <div className="preview-intro" key={block.id}><small>{config.content.eyebrow}</small><h3>{config.content.headline}</h3></div> : block.id === "steps" ? <ol key={block.id}>{steps.map((label, i) => <li key={label} className={i === 0 ? "active" : ""}><i>{i + 1}</i>{label}</li>)}</ol> : block.id === "benefits" ? <div className="preview-benefits" key={block.id}>{config.content.benefits.filter(Boolean).map((benefit) => <span key={benefit}>✓ {benefit}</span>)}</div> : <div className="preview-tariffs" key={block.id}><span>{config.operations.opensAt}–{config.operations.eveningStartsAt}<b>CHF {(config.operations.morningPriceCents / 100).toFixed(0)}</b></span><span>ab {config.operations.eveningStartsAt}<b>CHF {(config.operations.eveningPriceCents / 100).toFixed(0)}</b></span></div>)}</aside><main><small>1 VON 4 · ZEIT WÄHLEN</small><h3>Wann passt es euch?</h3><label>Datum</label><div className="preview-days"><button>MI<br/><b>16</b></button><button className="selected">DO<br/><b>17</b></button><button>FR<br/><b>18</b></button></div><label>Startzeit</label><div className="preview-times"><button>14:00</button><button className="selected">16:00</button><button>17:00</button></div><button className="preview-cta">Weiter</button></main></div>
      </div></div>
    </div>
  </section>;
}
