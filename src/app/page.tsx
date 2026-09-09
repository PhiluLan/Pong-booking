"use client";

import { useEffect, useMemo, useState } from "react";

type Booking = {
  id: string; start: string; table: number; name: string; people: number;
  status: "Bestätigt" | "Eingecheckt" | "Ausstehend"; source: "Online" | "Walk-in";
};

const initialBookings: Booking[] = [
  { id: "VP-1842", start: "17:00", table: 1, name: "Anna Meier", people: 4, status: "Bestätigt", source: "Online" },
  { id: "VP-1843", start: "18:00", table: 3, name: "Noah Keller", people: 2, status: "Eingecheckt", source: "Walk-in" },
  { id: "VP-1844", start: "19:00", table: 2, name: "Team Baloise", people: 8, status: "Bestätigt", source: "Online" },
  { id: "VP-1845", start: "20:00", table: 4, name: "Lea Zimmermann", people: 3, status: "Ausstehend", source: "Online" },
  { id: "VP-1846", start: "21:00", table: 1, name: "Die Rückhand", people: 6, status: "Bestätigt", source: "Online" },
];

const hours = ["16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00"];
const tables = [1, 2, 3, 4];
const week = [
  { day: "MO", date: "7" }, { day: "DI", date: "8" }, { day: "MI", date: "9" },
  { day: "DO", date: "10" }, { day: "FR", date: "11" }, { day: "SA", date: "12" }, { day: "SO", date: "13" },
];

function Icon({ name }: { name: "calendar" | "booking" | "tables" | "people" | "settings" | "search" | "plus" | "chevron" }) {
  const paths = {
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
    booking: <><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h7M9 17h5"/></>,
    tables: <><rect x="3" y="6" width="18" height="11" rx="2"/><path d="M7 17v4M17 17v4M8 10h8"/></>,
    people: <><circle cx="9" cy="8" r="4"/><path d="M2 21c.6-4.2 2.8-6 7-6s6.4 1.8 7 6M16 4a4 4 0 0 1 0 8M18 15c2.4.8 3.7 2.8 4 6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, plus: <path d="M12 5v14M5 12h14"/>, chevron: <path d="m9 18 6-6-6-6"/>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export default function Home() {
  const [selectedDay, setSelectedDay] = useState("9");
  const [query, setQuery] = useState("");
  const [activeBooking, setActiveBooking] = useState<Booking | null>(null);
  const [notice, setNotice] = useState("");
  const [bookings, setBookings] = useState<Booking[]>(initialBookings);

  useEffect(() => {
    const saved = window.localStorage.getItem("volta-pong-demo-bookings");
    if (!saved) return;
    try { setBookings([...JSON.parse(saved), ...initialBookings]); } catch { /* keep the demo schedule */ }
  }, []);
  const filtered = useMemo(() => bookings.filter((b) => `${b.name} ${b.id} ${b.start}`.toLowerCase().includes(query.toLowerCase())), [query]);
  function showNotice(message: string) { setNotice(message); window.setTimeout(() => setNotice(""), 2600); }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">VOLTA<br/><span>PONG!</span></div>
        <nav aria-label="Hauptnavigation">
          <a className="nav-item active" href="#kalender"><Icon name="calendar"/>Kalender</a>
          <a className="nav-item" href="#buchungen"><Icon name="booking"/>Buchungen <span className="nav-count">12</span></a>
          <a className="nav-item" href="#tische"><Icon name="tables"/>Tische</a>
          <a className="nav-item" href="#gaeste"><Icon name="people"/>Gäste</a>
        </nav>
        <div className="sidebar-bottom">
          <a className="nav-item" href="#einstellungen"><Icon name="settings"/>Einstellungen</a>
          <div className="profile"><div className="avatar">PM</div><div><strong>Philipp Meier</strong><small>Administrator</small></div><button aria-label="Profil öffnen">•••</button></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><p className="eyebrow">SPIELBETRIEB</p><h1>Mittwoch, 9. September</h1></div>
          <div className="topbar-actions">
            <label className="search"><Icon name="search"/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buchung suchen" aria-label="Buchung suchen"/></label>
            <a className="primary-button" href="/buchen"><Icon name="plus"/>Neue Buchung</a>
          </div>
        </header>

        <section className="stats" aria-label="Tagesübersicht">
          <article className="stat-card"><div><span>Buchungen heute</span><strong>12</strong></div><span className="trend">+20%</span></article>
          <article className="stat-card"><div><span>Spieler:innen</span><strong>47</strong></div><span className="muted">Ø 3,9 / Buchung</span></article>
          <article className="stat-card accent"><div><span>Auslastung</span><strong>68%</strong></div><div className="mini-progress"><i /></div></article>
          <article className="stat-card"><div><span>Umsatz heute</span><strong>CHF 312</strong></div><span className="muted">inkl. Walk-ins</span></article>
        </section>

        <section className="workspace" id="kalender">
          <div className="calendar-panel">
            <div className="panel-heading">
              <div className="date-nav"><button aria-label="Vorherige Woche">‹</button><h2>7.–13. September 2026</h2><button aria-label="Nächste Woche">›</button><button className="today-button">Heute</button></div>
              <div className="legend"><span><i className="dot confirmed"/>Bestätigt</span><span><i className="dot checked"/>Eingecheckt</span><span><i className="dot pending"/>Ausstehend</span></div>
            </div>
            <div className="week-strip">
              {week.map((item) => <button key={item.date} className={selectedDay === item.date ? "selected" : ""} onClick={() => setSelectedDay(item.date)}><small>{item.day}</small><strong>{item.date}</strong>{["9","11","12"].includes(item.date) && <i/>}</button>)}
            </div>
            <div className="schedule" role="grid" aria-label="Tischbelegung">
              <div className="schedule-head"><span/><span>Tisch 1</span><span>Tisch 2</span><span>Tisch 3</span><span>Tisch 4</span></div>
              {hours.map((hour) => <div className="schedule-row" key={hour}><time>{hour}</time>{tables.map((table) => {
                const booking = filtered.find((item) => item.start === hour && item.table === table);
                return <div className="slot" key={table}>{booking ? <button className={`booking ${booking.status === "Eingecheckt" ? "checked" : booking.status === "Ausstehend" ? "pending" : "confirmed"}`} onClick={() => setActiveBooking(booking)}><strong>{booking.name}</strong><span>{booking.people} Pers. · {booking.id}</span></button> : <button className="empty-slot" onClick={() => showNotice(`${hour} · Tisch ${table} ausgewählt`)} aria-label={`${hour}, Tisch ${table} buchen`}>+</button>}</div>;
              })}</div>)}
            </div>
          </div>

          <aside className="day-panel" id="buchungen">
            <div className="day-panel-head"><div><p className="eyebrow">HEUTE</p><h2>Nächste Buchungen</h2></div><button aria-label="Alle Buchungen öffnen"><Icon name="chevron"/></button></div>
            <div className="booking-list">{filtered.slice(0, 4).map((b) => <button key={b.id} onClick={() => setActiveBooking(b)} className="booking-row"><time>{b.start}</time><span className={`status-line ${b.status === "Eingecheckt" ? "checked" : b.status === "Ausstehend" ? "pending" : "confirmed"}`}/><div><strong>{b.name}</strong><span>Tisch {b.table} · {b.people} Personen</span></div><small>{b.source}</small></button>)}</div>
            <div className="capacity-card"><div className="ball"/><p><strong>17 freie Tischstunden</strong><span>Heute noch verfügbar</span></p><a href="/buchen">Buchungsseite öffnen</a></div>
          </aside>
        </section>
      </main>

      {activeBooking && <div className="modal-backdrop" role="presentation" onMouseDown={() => setActiveBooking(null)}><section className="booking-modal" role="dialog" aria-modal="true" aria-label="Buchungsdetails" onMouseDown={(e) => e.stopPropagation()}><button className="modal-close" onClick={() => setActiveBooking(null)} aria-label="Schliessen">×</button><p className="eyebrow">{activeBooking.id}</p><h2>{activeBooking.name}</h2><div className="modal-grid"><span><small>Zeit</small>{activeBooking.start}–{String(Number(activeBooking.start.slice(0,2))+1).padStart(2,"0")}:00</span><span><small>Tisch</small>Tisch {activeBooking.table}</span><span><small>Gruppe</small>{activeBooking.people} Personen</span><span><small>Status</small>{activeBooking.status}</span></div><button className="primary-button wide" onClick={() => showNotice("Check-in vorbereitet")}>Check-in starten</button></section></div>}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
