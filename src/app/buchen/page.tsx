"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

const dates = [
  { iso:"2026-09-09", day:"Mi", date:"9. Sep" }, { iso:"2026-09-10", day:"Do", date:"10. Sep" },
  { iso:"2026-09-11", day:"Fr", date:"11. Sep" }, { iso:"2026-09-12", day:"Sa", date:"12. Sep" },
  { iso:"2026-09-13", day:"So", date:"13. Sep" },
];
const slots = ["16:00","17:00","18:00","19:00","20:00","21:00","22:00"];

export default function BookingPage() {
  const [step,setStep] = useState(1);
  const [date,setDate] = useState(dates[0]);
  const [time,setTime] = useState("18:00");
  const [people,setPeople] = useState(4);
  const [name,setName] = useState("");
  const [email,setEmail] = useState("");
  const [phone,setPhone] = useState("");
  const [accepted,setAccepted] = useState(false);
  const [reference,setReference] = useState("");
  const price = useMemo(() => people * (people <= 5 ? 7.5 : 6), [people]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const ref = `VP-${Math.floor(2000 + Math.random()*7000)}`;
    const saved = JSON.parse(window.localStorage.getItem("volta-pong-demo-bookings") || "[]");
    saved.unshift({ id:ref, start:time, table:2, name, people, status:"Bestätigt", source:"Online", date:date.iso });
    window.localStorage.setItem("volta-pong-demo-bookings", JSON.stringify(saved));
    setReference(ref); setStep(4);
  }

  return <main className="booking-page">
    <header className="booking-header"><Link href="/" className="booking-brand">VOLTA <span>PONG!</span></Link><div><span>Basel · St. Johann</span><Link href="/">Admin</Link></div></header>
    <div className="booking-balls" aria-hidden="true"><i/><i/><i/></div>
    <section className="booking-layout">
      <div className="booking-intro"><p className="eyebrow">TISCH RESERVIEREN</p><h1>Dein Tisch.<br/>Deine Runde.</h1><p>Wähle deine Spielzeit, schnapp dir deine Leute und leg los. Schläger und Bälle stehen bereit.</p><div className="booking-facts"><span><strong>60 Min.</strong> pro Buchung</span><span><strong>CHF {people <= 5 ? "7.50" : "6.00"}</strong> pro Person</span><span><strong>1–9</strong> Personen</span></div></div>

      <div className="booking-card">
        {step < 4 && <div className="steps" aria-label={`Schritt ${step} von 3`}><span className={step>=1?"done":""}/><span className={step>=2?"done":""}/><span className={step>=3?"done":""}/><small>{step}/3</small></div>}

        {step===1 && <div className="booking-step"><p className="eyebrow">SCHRITT 1</p><h2>Wann wollt ihr spielen?</h2><label className="field-label">Datum</label><div className="date-options">{dates.map((item)=><button key={item.iso} className={date.iso===item.iso?"selected":""} onClick={()=>setDate(item)}><small>{item.day}</small><strong>{item.date}</strong></button>)}</div><label className="field-label">Startzeit</label><div className="time-options">{slots.map((slot)=><button key={slot} className={time===slot?"selected":""} onClick={()=>setTime(slot)}>{slot}<small>{["19:00","20:00"].includes(slot)?"2 frei":"frei"}</small></button>)}</div><button className="booking-next" onClick={()=>setStep(2)}>Weiter</button></div>}

        {step===2 && <div className="booking-step"><button className="back" onClick={()=>setStep(1)}>← Zurück</button><p className="eyebrow">SCHRITT 2</p><h2>Wie gross ist eure Runde?</h2><div className="people-picker"><button onClick={()=>setPeople(Math.max(1,people-1))} aria-label="Eine Person weniger">−</button><div><strong>{people}</strong><span>Personen</span></div><button onClick={()=>setPeople(Math.min(9,people+1))} aria-label="Eine Person mehr">+</button></div><div className="group-note"><span>10+ Personen?</span><p>Für grössere Gruppen stellen wir euch ein passendes Package zusammen.</p><a href="mailto:hallo@voltapong.ch">Gruppenanfrage senden</a></div><div className="selection-summary"><span>{date.day}, {date.date} · {time}</span><strong>CHF {price.toFixed(2)}</strong></div><button className="booking-next" onClick={()=>setStep(3)}>Weiter</button></div>}

        {step===3 && <form className="booking-step" onSubmit={submit}><button type="button" className="back" onClick={()=>setStep(2)}>← Zurück</button><p className="eyebrow">SCHRITT 3</p><h2>Fast geschafft.</h2><label className="text-field">Name<input required value={name} onChange={(e)=>setName(e.target.value)} placeholder="Vor- und Nachname"/></label><label className="text-field">E-Mail<input required type="email" value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="du@beispiel.ch"/></label><label className="text-field">Telefon<input required type="tel" value={phone} onChange={(e)=>setPhone(e.target.value)} placeholder="+41 79 000 00 00"/></label><label className="check-field"><input type="checkbox" checked={accepted} onChange={(e)=>setAccepted(e.target.checked)}/><span>Ich akzeptiere die Buchungsbedingungen und Datenschutzhinweise.</span></label><div className="selection-summary"><span>{date.day}, {date.date} · {time}<small>{people} Personen · 60 Minuten</small></span><strong>CHF {price.toFixed(2)}</strong></div><button className="booking-next" disabled={!accepted}>Kostenpflichtig buchen</button></form>}

        {step===4 && <div className="booking-step confirmation"><div className="confirmation-ball">✓</div><p className="eyebrow">BUCHUNG BESTÄTIGT</p><h2>Bis bald, {name.split(" ")[0]}!</h2><p>Dein Tisch ist reserviert. Die Bestätigung ist unterwegs an <strong>{email}</strong>.</p><div className="ticket"><span>{date.day}, {date.date}</span><strong>{time}–{String(Number(time.slice(0,2))+1).padStart(2,"0")}:00</strong><small>Tisch wird beim Check-in zugeteilt · {people} Personen</small><div><span>Buchung</span><strong>{reference}</strong><span>Check-in PIN</span><strong>{String(Math.floor(1000+Math.random()*8999))}</strong></div></div><Link className="booking-next" href="/">Zur Tagesübersicht</Link></div>}
      </div>
    </section>
  </main>;
}
