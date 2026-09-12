"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase, supabasePublishableKey, supabaseUrl } from "@/lib/supabase";
import { Addon, Slot, dateLabel, isoDate, money } from "@/lib/volta";
import { defaultStudioConfig, mergeStudioConfig, StudioConfig } from "@/lib/studio";

type Confirmation = {
  reference:string; payment_status:string; booking_status:string; price_cents:number|null;
  anny_sync_status:string; anny_booking_number:string|null; access_status:string;
  access_code:string|null; access_valid_from:string|null; access_valid_until:string|null; anny_last_error:string|null;
};
type DiscountQuote={code:string;discount_cents:number;total_cents:number;remaining_redemptions:number};
const steps = ["Zeit","Tische","Extras","Checkout"];

function basePrice(time:string,hours:number,tables:number,config:StudioConfig){
  const start=Number(time.slice(0,2))*60+Number(time.slice(3,5)), evening=Number(config.operations.eveningStartsAt.slice(0,2))*60+Number(config.operations.eveningStartsAt.slice(3,5));
  return Array.from({length:hours},(_,i)=>start+i*60>=evening?config.operations.eveningPriceCents:config.operations.morningPriceCents).reduce((a,b)=>a+b,0)*tables;
}

export default function BookingPage(){
  const [config,setConfig]=useState<StudioConfig>(defaultStudioConfig);
  const [step,setStep]=useState(1),[date,setDate]=useState(isoDate(new Date())),[hours,setHours]=useState(1),[time,setTime]=useState("");
  const [slots,setSlots]=useState<Slot[]>([]),[tables,setTables]=useState(1),[addons,setAddons]=useState<Addon[]>([]),[selectedAddons,setSelectedAddons]=useState<string[]>([]);
  const [people,setPeople]=useState(2),[name,setName]=useState(""),[email,setEmail]=useState(""),[phone,setPhone]=useState(""),[company,setCompany]=useState(""),[notes,setNotes]=useState(""),[accepted,setAccepted]=useState(false);
  const [discountCode,setDiscountCode]=useState(""),[discount,setDiscount]=useState<DiscountQuote|null>(null),[discountBusy,setDiscountBusy]=useState(false),[discountError,setDiscountError]=useState("");
  const [loading,setLoading]=useState(true),[slotLoading,setSlotLoading]=useState(false),[error,setError]=useState(""),[confirmation,setConfirmation]=useState<Confirmation|null>(null);
  const selectedSlot=slots.find(s=>s.start_time.slice(0,5)===time),available=selectedSlot?.available_tables||0;
  const extrasPrice=addons.filter(a=>selectedAddons.includes(a.id)).reduce((n,a)=>n+a.price_cents,0);
  const dates=useMemo(()=>Array.from({length:Math.min(config.operations.horizonDays,60)},(_,i)=>{const d=new Date();d.setDate(d.getDate()+i);return isoDate(d)}),[config.operations.horizonDays]);
  const durations=useMemo(()=>Array.from({length:config.operations.maxDurationHours},(_,i)=>i+1),[config.operations.maxDurationHours]);
  const subtotal=useMemo(()=>time?basePrice(time,hours,tables,config)+extrasPrice:0,[time,hours,tables,extrasPrice,config]);
  const total=discount?.total_cents??subtotal;
  const endTime=time?`${String(Number(time.slice(0,2))+hours).padStart(2,"0")}:00`:"";

  useEffect(()=>{ Promise.all([supabase.from("vp_addons").select("*").order("sort_order"),supabase.rpc("vp_public_booking_config")]).then(([addonsResult,configResult])=>{if(addonsResult.error)setError("Extras konnten nicht geladen werden.");else setAddons(addonsResult.data||[]);if(!configResult.error)setConfig(mergeStudioConfig(configResult.data));setLoading(false)}) },[]);
  useEffect(()=>{
    const params=new URLSearchParams(location.search),bookingId=params.get("payment_booking"),token=params.get("payment_token");
    if(!bookingId||!token)return;
    setLoading(true);setStep(5);
    let active=true,timer:ReturnType<typeof setTimeout>|undefined,attempts=0;
    const check=async()=>{
      try{
        const r=await fetch(`${supabaseUrl}/functions/v1/vp-sumup-status`,{method:"POST",headers:{"Content-Type":"application/json",apikey:supabasePublishableKey},body:JSON.stringify({booking_id:bookingId,status_token:token})});
        const data=await r.json();if(!r.ok)throw new Error(data.error||"Zahlungsstatus konnte nicht geprüft werden");
        if(!active)return;setConfirmation(data);setLoading(false);attempts++;
        const settled=data.payment_status==="paid"&&(data.access_status==="active"||data.access_status==="issued"||data.anny_sync_status==="failed");
        if(!settled&&attempts<30)timer=setTimeout(check,2500);
      }catch(e){if(active){setError(e instanceof Error?e.message:"Statusprüfung fehlgeschlagen");setLoading(false)}}
    };
    check();return()=>{active=false;if(timer)clearTimeout(timer)};
  },[]);
  // A changed day or duration invalidates the previously selected live slot.
  useEffect(()=>{ let live=true;setSlotLoading(true);setTime("");fetch(`${supabaseUrl}/functions/v1/vp-anny-availability`,{method:"POST",headers:{"Content-Type":"application/json",apikey:supabasePublishableKey},body:JSON.stringify({date,hours})}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error||"Verfügbarkeit fehlgeschlagen");if(live)setSlots(data||[])}).catch(()=>{if(live)setError("Die freien Zeiten konnten nicht direkt mit Anny abgeglichen werden.")}).finally(()=>{if(live)setSlotLoading(false)});return()=>{live=false} },[date,hours]);
  function clearDiscount(){setDiscount(null);setDiscountError("")}
  function goToStep(next:number){setStep(next);requestAnimationFrame(()=>window.scrollTo({top:0,behavior:"smooth"}))}
  function chooseTime(value:string){setTime(value);setTables(1);clearDiscount();setError("")}
  function toggleAddon(id:string){clearDiscount();setSelectedAddons(x=>x.includes(id)?x.filter(v=>v!==id):[...x,id])}
  async function applyDiscount(){
    if(discount){setDiscount(null);setDiscountCode("");setDiscountError("");return}
    if(!discountCode.trim()){setDiscountError("Bitte gib zuerst einen Rabattcode ein.");return}
    setDiscountBusy(true);setDiscountError("");
    try{const response=await fetch(`${supabaseUrl}/functions/v1/vp-sumup-create-checkout`,{method:"POST",headers:{"Content-Type":"application/json",apikey:supabasePublishableKey},body:JSON.stringify({action:"validate_discount",code:discountCode,subtotal})});const data=await response.json();if(!response.ok)throw new Error(data.error||"Rabattcode konnte nicht geprüft werden");setDiscount(data);setDiscountCode(data.code)}catch(e){setDiscount(null);setDiscountError(e instanceof Error?e.message:"Rabattcode ist nicht gültig")}finally{setDiscountBusy(false)}
  }
  async function submit(e:FormEvent){
    e.preventDefault(); if(!time)return; setLoading(true);setError("");
    try{
      const response=await fetch(`${supabaseUrl}/functions/v1/vp-sumup-create-checkout`,{method:"POST",headers:{"Content-Type":"application/json",apikey:supabasePublishableKey},body:JSON.stringify({date,time,hours,tables,people,name,email,phone,company,notes,addons:selectedAddons,discount_code:discount?.code||"",website:""})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"Zahlung konnte nicht gestartet werden");
      location.assign(data.checkout_url);
    }catch(e){setLoading(false);const message=e instanceof Error?e.message:"Checkout fehlgeschlagen";setError(message.includes("vergeben")?"Diese Auswahl wurde gerade vergeben. Bitte wähle nochmals eine Zeit.":message);if(message.includes("vergeben"))goToStep(1)}
  }
  if(loading&&!addons.length&&!confirmation)return <main className="simple-booking simple-loading"><div className="loader"/><p>Freie Tische werden geladen …</p></main>;

  const buttonRadius=config.design.buttonStyle==="pill"?"999px":config.design.buttonStyle==="square"?"4px":`${Math.min(18,config.design.radius)}px`;
  const style={"--blue":config.design.primary,"--orange":config.design.accent,"--pink":config.design.background,"--ink":config.design.text,"--studio-surface":config.design.surface,"--studio-radius":`${config.design.radius}px`,"--studio-button-radius":buttonRadius} as React.CSSProperties;
  return <main className="simple-booking" style={style}>
    <header className="simple-header"><Link href="/buchen" className="booking-brand">VOLTA <span>PONG!</span></Link><span>{config.operations.address}</span></header>
    <section className="simple-shell">
      <aside className="simple-rail">{config.blocks.filter(block=>block.visible).map(block=>block.id==="intro"?<div className="rail-intro" key={block.id}><p>{config.content.eyebrow}</p><h1>{config.content.headline}</h1></div>:block.id==="steps"?<ol key={block.id}>{steps.map((label,i)=><li key={label} className={step===i+1?"active":step>i+1?"done":""}><i>{step>i+1?"✓":i+1}</i><span>{label}<small>{i===0?"Datum & Spielzeit":i===1?"Freie Tische":i===2?"Essen & Getränke":"Kontaktdaten"}</small></span></li>)}</ol>:block.id==="benefits"?<div className="rail-facts" key={block.id}><span>Täglich {config.operations.opensAt}–{config.operations.closesAt}</span>{config.content.benefits.filter(Boolean).map(benefit=><span key={benefit}>{benefit}</span>)}</div>:<div className="rail-tariffs" key={block.id}><span>Bis {config.operations.eveningStartsAt}<strong>{money(config.operations.morningPriceCents)} / h</strong></span><span>Ab {config.operations.eveningStartsAt}<strong>{money(config.operations.eveningPriceCents)} / h</strong></span></div>)}</aside>
      <div className="simple-card">
        {error&&<div className="form-error">{error}</div>}
        {step===1&&<section className="flow-step"><button className="flow-back" onClick={()=>window.history.back()}>← Zurück</button><p className="flow-kicker">1 von 4 · Zeit wählen</p><h2>Wann passt es euch?</h2>
          <label className="flow-label">Datum</label><div className="flow-dates">{dates.map(d=><button key={d} className={date===d?"selected":""} onClick={()=>{setDate(d);clearDiscount()}}><small>{new Intl.DateTimeFormat("de-CH",{weekday:"short"}).format(new Date(`${d}T12:00:00`))}</small><strong>{new Date(`${d}T12:00:00`).getDate()}</strong><span>{new Intl.DateTimeFormat("de-CH",{month:"short"}).format(new Date(`${d}T12:00:00`))}</span></button>)}</div>
          <label className="flow-label">Wie lange?</label><div className="flow-duration">{durations.map(h=><button key={h} className={hours===h?"selected":""} onClick={()=>{setHours(h);clearDiscount()}}><strong>{h} Stunde{h>1?"n":""}</strong><span>bis {h===1?"1":h} × 60 Min.</span></button>)}</div>
          {config.blocks.find(block=>block.id==="tariffs")?.visible&&<div className="tariff-note"><span><i/>{config.operations.opensAt}–{config.operations.eveningStartsAt} Uhr</span><strong>{money(config.operations.morningPriceCents)} / Tisch & Stunde</strong><span><i/>ab {config.operations.eveningStartsAt} Uhr</span><strong>{money(config.operations.eveningPriceCents)} / Tisch & Stunde</strong></div>}
          <label className="flow-label">Startzeit</label>{slotLoading?<div className="slots-loading">Freie Zeiten werden geprüft …</div>:<div className="flow-times">{slots.map(s=><button key={s.start_time} className={time===s.start_time.slice(0,5)?"selected":""} onClick={()=>chooseTime(s.start_time.slice(0,5))}><strong>{s.start_time.slice(0,5)}</strong><span>{s.available_tables===1?"1 Tisch frei":`${s.available_tables} Tische frei`}</span></button>)}</div>}
          {!slotLoading&&!slots.length&&<p className="empty-message">An diesem Tag ist für diese Dauer leider nichts mehr frei.</p>}
          <div className="sticky-next"><div>{time?<><small>{dateLabel(date)} · {time}–{endTime}</small><strong>ab {money(basePrice(time,hours,1,config))}</strong></>:<span>Wähle eine Startzeit</span>}</div><button disabled={!time} onClick={()=>goToStep(2)}>Weiter</button></div>
        </section>}
        {step===2&&<section className="flow-step"><button className="flow-back" onClick={()=>goToStep(1)}>← Zeit ändern</button><p className="flow-kicker">2 von 4 · Tische wählen</p><h2>Wie viele Tische?</h2><p className="flow-copy">Wir weisen euch automatisch die nächsten freien Tische zu.</p><div className="table-options">{Array.from({length:available},(_,i)=>i+1).map(n=><button key={n} className={tables===n?"selected":""} onClick={()=>{setTables(n);clearDiscount()}}><span className="table-number">{n}</span><span><strong>{n===1?"1 Tisch":`${n} Tische`}</strong><small>für bis zu {n*8} Personen</small></span><b>{money(basePrice(time,hours,n,config))}</b></button>)}</div><div className="friendly-note"><strong>Keine Tischnummer nötig.</strong><span>Deine Tische werden beim Abschluss automatisch reserviert.</span></div><div className="sticky-next"><button className="secondary-back" onClick={()=>goToStep(1)}>← Zurück</button><div><small>{dateLabel(date)} · {time}–{endTime}</small><strong>{tables} {tables===1?"Tisch":"Tische"} · {money(basePrice(time,hours,tables,config))}</strong></div><button onClick={()=>goToStep(3)}>Weiter</button></div></section>}
        {step===3&&<section className="flow-step"><button className="flow-back" onClick={()=>goToStep(2)}>← Tische ändern</button><p className="flow-kicker">3 von 4 · Extras</p><h2>Darf’s noch etwas sein?</h2><p className="flow-copy">Optional – du kannst diesen Schritt einfach überspringen.</p><div className="extras-list">{addons.map(a=><label key={a.id} className={selectedAddons.includes(a.id)?"selected":""}><input type="checkbox" checked={selectedAddons.includes(a.id)} onChange={()=>toggleAddon(a.id)}/><span><strong>{a.name}</strong><small>{a.id==="pickup"?"Wir räumen nach eurer Spielzeit auf.":"Direkt zu eurer Buchung vorbereitet."}</small></span><b>{a.price_cents?`+ ${money(a.price_cents)}`:"kostenlos"}</b><i>{selectedAddons.includes(a.id)?"✓":"+"}</i></label>)}</div><div className="sticky-next"><button className="secondary-back" onClick={()=>goToStep(2)}>← Zurück</button><div><small>{selectedAddons.length?`${selectedAddons.length} Extras ausgewählt`:"Keine Extras"}</small><strong>Gesamt {money(subtotal)}</strong></div><button onClick={()=>goToStep(4)}>Zum Checkout</button></div></section>}
        {step===4&&<form className="flow-step checkout" onSubmit={submit}>
          <button type="button" className="flow-back" onClick={()=>goToStep(3)}>← Extras ändern</button><p className="flow-kicker">4 von 4 · Checkout</p><h2>Fast geschafft.</h2>
          <div className="checkout-summary"><div><span>{dateLabel(date)}</span><strong>{time}–{endTime}</strong></div><div><span>{tables===1?"1 Tisch":`${tables} Tische`} · {hours} Std.</span><strong>{money(total)}</strong></div></div>
          <div className="discount-entry"><div><label>Rabattcode <small>optional</small><input value={discountCode} disabled={Boolean(discount)} placeholder="Code eingeben" onChange={e=>{setDiscountCode(e.target.value.toUpperCase());setDiscountError("")}}/></label><button type="button" disabled={discountBusy} className={discount?'remove':''} onClick={applyDiscount}>{discountBusy?'Prüft …':discount?'Entfernen':'Einlösen'}</button></div>{discountError&&<p className="discount-error">{discountError}</p>}{discount&&<div className="discount-success"><span>✓ {discount.code} wurde angewendet</span><strong>− {money(discount.discount_cents)}</strong></div>}</div>
          {discount&&<div className="price-breakdown"><span>Zwischensumme <b>{money(subtotal)}</b></span><span>Rabatt <b>− {money(discount.discount_cents)}</b></span><strong>Gesamt <b>{money(total)}</b></strong></div>}
          <div className="checkout-grid"><label>Vor- und Nachname<input required minLength={2} value={name} onChange={e=>setName(e.target.value)}/></label><label>Personen<input required type="number" min="1" max={tables*8} value={people} onChange={e=>setPeople(Number(e.target.value))}/></label><label>E-Mail<input required type="email" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Telefon<input required type="tel" minLength={7} value={phone} onChange={e=>setPhone(e.target.value)}/></label><label>Firma / Team <small>optional</small><input value={company} onChange={e=>setCompany(e.target.value)}/></label><label>Notiz <small>optional</small><input value={notes} onChange={e=>setNotes(e.target.value)}/></label></div>
          <label className="flow-check"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/><span>{config.content.termsLabel}</span></label>
          <div className="checkout-actions"><button type="button" className="secondary-back" onClick={()=>goToStep(3)}>← Zurück</button><button className="checkout-button" disabled={!accepted||loading}>{loading?(total===0?"Buchung wird bestätigt …":"SumUp wird geöffnet …"):(total===0?"Kostenlos buchen":`${money(total)} · Mit SumUp bezahlen`)}</button></div><p className="payment-note">{total===0?"Kein Zahlungsprozess nötig. Deine Buchung wird direkt bestätigt.":config.content.paymentNote}</p>
        </form>}
        {step===5&&<section className="flow-step flow-confirm">
          <div className={`confirm-mark ${confirmation?.anny_sync_status==="failed"?"failed":""}`}>{confirmation?.access_status==="active"||confirmation?.access_status==="issued"?"✓":confirmation?.anny_sync_status==="failed"?"!":"…"}</div>
          <p className="flow-kicker">SumUp · Anny · SALTO KS</p>
          <h2>{confirmation?.access_status==="active"||confirmation?.access_status==="issued"?"Alles bereit.":confirmation?.anny_sync_status==="failed"?"Zahlung bestätigt.":confirmation?.payment_status==="paid"?"Zugang wird erstellt.":"Zahlung wird geprüft."}</h2>
          {confirmation?.access_status==="active"?<p>Dein Tisch ist in Anny gebucht und der zeitlich begrenzte SALTO-Zugang ist aktiv.</p>:confirmation?.access_status==="issued"?<p>Dein Tisch ist bestätigt und der zeitlich begrenzte SALTO-Zugang ist bei Anny eingeplant. Den persönlichen Türcode stellt Anny rechtzeitig in der Buchungsbestätigung bereit.</p>:confirmation?.anny_sync_status==="failed"?<p>Die Zahlung ist angekommen. Die automatische Anny-Bestätigung konnte noch nicht abgeschlossen werden und wird von Volta geprüft.</p>:confirmation?.payment_status==="paid"?<p>Deine Zahlung ist bestätigt. Wir legen gerade die Anny-Buchung an und warten auf die SALTO-Freigabe.</p>:<p>Wir gleichen den endgültigen Status direkt mit SumUp ab. Das dauert normalerweise nur wenige Sekunden.</p>}
          {confirmation?.access_code&&<div className="access-code"><span>Dein Türcode</span><strong>{confirmation.access_code}</strong><small>Nur im angegebenen Zugangszeitraum gültig</small></div>}
          {confirmation&&<div className="confirm-ticket"><div><span>Volta-Buchung</span><strong>{confirmation.reference}</strong></div>{confirmation.anny_booking_number&&<div><span>Anny-Buchung</span><strong>{confirmation.anny_booking_number}</strong></div>}<div><span>Zahlung</span><strong>{confirmation.payment_status==="paid"?"Bezahlt":"In Prüfung"}</strong></div><div><span>Zugang</span><strong>{confirmation.access_status==="active"?"SALTO aktiv":confirmation.access_status==="issued"?"Bei Anny eingeplant":confirmation.anny_sync_status==="failed"?"Manuelle Prüfung":"Wird erstellt"}</strong></div>{confirmation.access_valid_from&&<div><span>Gültig</span><strong>{new Intl.DateTimeFormat("de-CH",{dateStyle:"short",timeStyle:"short"}).format(new Date(confirmation.access_valid_from))} – {new Intl.DateTimeFormat("de-CH",{timeStyle:"short"}).format(new Date(confirmation.access_valid_until!))}</strong></div>}<div><span>Gesamt</span><strong>{money(confirmation.price_cents)}</strong></div></div>}
          <button className="checkout-button" onClick={()=>confirmation?.access_status==="active"||confirmation?.access_status==="issued"?location.assign("/buchen"):location.reload()}>{confirmation?.access_status==="active"||confirmation?.access_status==="issued"?"Weitere Buchung":"Status erneut prüfen"}</button>
        </section>}
      </div>
    </section>
  </main>;
}
