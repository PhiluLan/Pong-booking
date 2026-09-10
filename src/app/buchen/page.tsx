"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Addon, Slot, dateLabel, isoDate, money } from "@/lib/volta";

type Confirmation = { reference:string; pin_code:string; status:string; price_cents:number|null };
const dates = Array.from({ length:21 },(_,i)=>{ const d=new Date(); d.setDate(d.getDate()+i); return isoDate(d); });
const durations = [1,2,3];
const steps = ["Zeit","Tische","Extras","Checkout"];

function basePrice(time:string,hours:number,tables:number){
  const start=Number(time.slice(0,2));
  return Array.from({length:hours},(_,i)=>start+i>=16?2200:1800).reduce((a,b)=>a+b,0)*tables;
}

export default function BookingPage(){
  const [step,setStep]=useState(1),[date,setDate]=useState(dates[0]),[hours,setHours]=useState(1),[time,setTime]=useState("");
  const [slots,setSlots]=useState<Slot[]>([]),[tables,setTables]=useState(1),[addons,setAddons]=useState<Addon[]>([]),[selectedAddons,setSelectedAddons]=useState<string[]>([]);
  const [people,setPeople]=useState(2),[name,setName]=useState(""),[email,setEmail]=useState(""),[phone,setPhone]=useState(""),[company,setCompany]=useState(""),[notes,setNotes]=useState(""),[accepted,setAccepted]=useState(false);
  const [loading,setLoading]=useState(true),[slotLoading,setSlotLoading]=useState(false),[error,setError]=useState(""),[confirmation,setConfirmation]=useState<Confirmation|null>(null);
  const selectedSlot=slots.find(s=>s.start_time.slice(0,5)===time),available=selectedSlot?.available_tables||0;
  const extrasPrice=addons.filter(a=>selectedAddons.includes(a.id)).reduce((n,a)=>n+a.price_cents,0);
  const total=useMemo(()=>time?basePrice(time,hours,tables)+extrasPrice:0,[time,hours,tables,extrasPrice]);
  const endTime=time?`${String(Number(time.slice(0,2))+hours).padStart(2,"0")}:00`:"";

  useEffect(()=>{ supabase.from("vp_addons").select("*").order("sort_order").then(({data,error:e})=>{if(e)setError("Extras konnten nicht geladen werden.");else setAddons(data||[]);setLoading(false)}) },[]);
  // A changed day or duration invalidates the previously selected live slot.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{ let live=true;setSlotLoading(true);setTime("");supabase.rpc("vp_available_slots",{p_date:date,p_service:"single-flex",p_hours:hours}).then(({data,error:e})=>{if(!live)return;if(e)setError("Die freien Zeiten konnten nicht geladen werden.");else setSlots(data||[]);setSlotLoading(false)});return()=>{live=false} },[date,hours]);
  function chooseTime(value:string){setTime(value);setTables(1);setError("")}
  function toggleAddon(id:string){setSelectedAddons(x=>x.includes(id)?x.filter(v=>v!==id):[...x,id])}
  async function submit(e:FormEvent){
    e.preventDefault(); if(!time)return; setLoading(true);setError("");
    const {data,error:err}=await supabase.rpc("vp_create_simple_booking",{p_date:date,p_time:time,p_hours:hours,p_tables:tables,p_people:people,p_name:name,p_email:email,p_phone:phone,p_company:company,p_notes:notes,p_addons:selectedAddons,p_website:""});
    setLoading(false); if(err){setError(err.message.includes("vergeben")?"Diese Auswahl wurde gerade vergeben. Bitte wähle nochmals eine Zeit.":err.message);setStep(1);return} setConfirmation(data?.[0]);setStep(5);
  }
  if(loading&&!addons.length&&!confirmation)return <main className="simple-booking simple-loading"><div className="loader"/><p>Freie Tische werden geladen …</p></main>;

  return <main className="simple-booking">
    <header className="simple-header"><Link href="/buchen" className="booking-brand">VOLTA <span>PONG!</span></Link><span>Voltastrasse 30 · Basel</span></header>
    <section className="simple-shell">
      <aside className="simple-rail"><div><p>Tisch buchen</p><h1>Wann wollt ihr spielen?</h1></div><ol>{steps.map((label,i)=><li key={label} className={step===i+1?"active":step>i+1?"done":""}><i>{step>i+1?"✓":i+1}</i><span>{label}<small>{i===0?"Datum & Spielzeit":i===1?"Freie Tische":i===2?"Essen & Getränke":"Kontaktdaten"}</small></span></li>)}</ol><div className="rail-facts"><span>Täglich 09:00–00:00</span><span>Schläger & Bälle inklusive</span></div></aside>
      <div className="simple-card">
        {error&&<div className="form-error">{error}</div>}
        {step===1&&<section className="flow-step"><p className="flow-kicker">1 von 4 · Zeit wählen</p><h2>Wann passt es euch?</h2>
          <label className="flow-label">Datum</label><div className="flow-dates">{dates.map(d=><button key={d} className={date===d?"selected":""} onClick={()=>setDate(d)}><small>{new Intl.DateTimeFormat("de-CH",{weekday:"short"}).format(new Date(`${d}T12:00:00`))}</small><strong>{new Date(`${d}T12:00:00`).getDate()}</strong><span>{new Intl.DateTimeFormat("de-CH",{month:"short"}).format(new Date(`${d}T12:00:00`))}</span></button>)}</div>
          <label className="flow-label">Wie lange?</label><div className="flow-duration">{durations.map(h=><button key={h} className={hours===h?"selected":""} onClick={()=>setHours(h)}><strong>{h} Stunde{h>1?"n":""}</strong><span>bis {h===1?"1":h} × 60 Min.</span></button>)}</div>
          <div className="tariff-note"><span><i/>09–16 Uhr</span><strong>CHF 18 / Tisch & Stunde</strong><span><i/>ab 16 Uhr</span><strong>CHF 22 / Tisch & Stunde</strong></div>
          <label className="flow-label">Startzeit</label>{slotLoading?<div className="slots-loading">Freie Zeiten werden geprüft …</div>:<div className="flow-times">{slots.map(s=><button key={s.start_time} className={time===s.start_time.slice(0,5)?"selected":""} onClick={()=>chooseTime(s.start_time.slice(0,5))}><strong>{s.start_time.slice(0,5)}</strong><span>{s.available_tables===1?"1 Tisch frei":`${s.available_tables} Tische frei`}</span></button>)}</div>}
          {!slotLoading&&!slots.length&&<p className="empty-message">An diesem Tag ist für diese Dauer leider nichts mehr frei.</p>}
          <div className="sticky-next"><div>{time?<><small>{dateLabel(date)} · {time}–{endTime}</small><strong>ab {money(basePrice(time,hours,1))}</strong></>:<span>Wähle eine Startzeit</span>}</div><button disabled={!time} onClick={()=>setStep(2)}>Weiter</button></div>
        </section>}
        {step===2&&<section className="flow-step"><button className="flow-back" onClick={()=>setStep(1)}>← Zeit ändern</button><p className="flow-kicker">2 von 4 · Tische wählen</p><h2>Wie viele Tische?</h2><p className="flow-copy">Wir weisen euch automatisch die nächsten freien Tische zu.</p><div className="table-options">{Array.from({length:available},(_,i)=>i+1).map(n=><button key={n} className={tables===n?"selected":""} onClick={()=>setTables(n)}><span className="table-number">{n}</span><span><strong>{n===1?"1 Tisch":`${n} Tische`}</strong><small>für bis zu {n*8} Personen</small></span><b>{money(basePrice(time,hours,n))}</b></button>)}</div><div className="friendly-note"><strong>Keine Tischnummer nötig.</strong><span>Deine Tische werden beim Abschluss automatisch reserviert.</span></div><div className="sticky-next"><div><small>{dateLabel(date)} · {time}–{endTime}</small><strong>{tables} {tables===1?"Tisch":"Tische"} · {money(basePrice(time,hours,tables))}</strong></div><button onClick={()=>setStep(3)}>Weiter</button></div></section>}
        {step===3&&<section className="flow-step"><button className="flow-back" onClick={()=>setStep(2)}>← Tische ändern</button><p className="flow-kicker">3 von 4 · Extras</p><h2>Darf’s noch etwas sein?</h2><p className="flow-copy">Optional – du kannst diesen Schritt einfach überspringen.</p><div className="extras-list">{addons.map(a=><label key={a.id} className={selectedAddons.includes(a.id)?"selected":""}><input type="checkbox" checked={selectedAddons.includes(a.id)} onChange={()=>toggleAddon(a.id)}/><span><strong>{a.name}</strong><small>{a.id==="pickup"?"Wir räumen nach eurer Spielzeit auf.":"Direkt zu eurer Buchung vorbereitet."}</small></span><b>{a.price_cents?`+ ${money(a.price_cents)}`:"kostenlos"}</b><i>{selectedAddons.includes(a.id)?"✓":"+"}</i></label>)}</div><div className="sticky-next"><div><small>{selectedAddons.length?`${selectedAddons.length} Extras ausgewählt`:"Keine Extras"}</small><strong>Gesamt {money(total)}</strong></div><button onClick={()=>setStep(4)}>Zum Checkout</button></div></section>}
        {step===4&&<form className="flow-step checkout" onSubmit={submit}><button type="button" className="flow-back" onClick={()=>setStep(3)}>← Extras ändern</button><p className="flow-kicker">4 von 4 · Checkout</p><h2>Fast geschafft.</h2><div className="checkout-summary"><div><span>{dateLabel(date)}</span><strong>{time}–{endTime}</strong></div><div><span>{tables===1?"1 Tisch":`${tables} Tische`} · {hours} Std.</span><strong>{money(total)}</strong></div></div><div className="checkout-grid"><label>Vor- und Nachname<input required minLength={2} value={name} onChange={e=>setName(e.target.value)}/></label><label>Personen<input required type="number" min="1" max={tables*8} value={people} onChange={e=>setPeople(Number(e.target.value))}/></label><label>E-Mail<input required type="email" value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Telefon<input required type="tel" minLength={7} value={phone} onChange={e=>setPhone(e.target.value)}/></label><label>Firma / Team <small>optional</small><input value={company} onChange={e=>setCompany(e.target.value)}/></label><label>Notiz <small>optional</small><input value={notes} onChange={e=>setNotes(e.target.value)}/></label></div><label className="flow-check"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/><span>Ich akzeptiere die Buchungs- und Stornobedingungen.</span></label><button className="checkout-button" disabled={!accepted||loading}>{loading?"Wird reserviert …":`${money(total)} · Verbindlich reservieren`}</button><p className="payment-note">Die Zahlungsschnittstelle wird separat verbunden. Bis dahin erscheint die Buchung mit offenem Zahlungsstatus.</p></form>}
        {step===5&&confirmation&&<section className="flow-step flow-confirm"><div className="confirm-mark">✓</div><p className="flow-kicker">Reserviert</p><h2>Der Tisch gehört euch.</h2><p>{dateLabel(date)} von <strong>{time} bis {endTime}</strong>. Die freien Tische wurden automatisch für euch blockiert.</p><div className="confirm-ticket"><div><span>Buchungsnummer</span><strong>{confirmation.reference}</strong></div><div><span>Check-in-PIN</span><strong>{confirmation.pin_code}</strong></div><div><span>Gesamt</span><strong>{money(confirmation.price_cents)}</strong></div></div><button className="checkout-button" onClick={()=>location.reload()}>Weitere Buchung</button></section>}
      </div>
    </section>
  </main>;
}
