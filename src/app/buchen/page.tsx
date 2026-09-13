"use client";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase, supabasePublishableKey, supabaseUrl } from "@/lib/supabase";
import { Addon, Slot, dateLabel, isoDate, money } from "@/lib/volta";
import {
  defaultStudioConfig,
  mergeStudioConfig,
  StudioConfig,
} from "@/lib/studio";

type Confirmation = {
  reference: string;
  payment_status: string;
  price_cents: number | null;
  anny_sync_status: string;
  anny_booking_number: string | null;
  access_status: string;
  access_code: string | null;
  anny_enabled: boolean;
  sumup_enabled: boolean;
};
type DiscountQuote = {
  code: string;
  discount_cents: number;
  total_cents: number;
};
type BookingOrganization = { id: string; name: string; role: string };
type Mode = "welcome" | "booking" | "group";
const progress = [
  ["Datum", "Spieltag wählen"],
  ["Dauer", "1–6 Stunden"],
  ["Startzeit", "Freie Zeiten"],
  ["Tische", "Freie Tische"],
  ["Extras", "Essen & Getränke"],
  ["Checkout", "Kontaktdaten"],
] as const;
const weekdays = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
function monthKey(v: Date) {
  return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0");
}
function basePrice(
  time: string,
  hours: number,
  tables: number,
  c: StudioConfig,
) {
  const start = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)),
    evening =
      Number(c.operations.eveningStartsAt.slice(0, 2)) * 60 +
      Number(c.operations.eveningStartsAt.slice(3, 5));
  return (
    Array.from({ length: hours }, (_, i) =>
      start + i * 60 >= evening
        ? c.operations.eveningPriceCents
        : c.operations.morningPriceCents,
    ).reduce((a, b) => a + b, 0) * tables
  );
}

export default function BookingPage() {
  const [config, setConfig] = useState(defaultStudioConfig),
    [mode, setMode] = useState<Mode>("welcome"),
    [step, setStep] = useState(1);
  const [date, setDate] = useState(isoDate(new Date())),
    [hours, setHours] = useState(1),
    [time, setTime] = useState(""),
    [calendarMonth, setCalendarMonth] = useState(() => {
      const n = new Date();
      return new Date(n.getFullYear(), n.getMonth(), 1);
    });
  const [slots, setSlots] = useState<Slot[]>([]),
    [tables, setTables] = useState(1),
    [addons, setAddons] = useState<Addon[]>([]),
    [addonQuantities, setAddonQuantities] = useState<Record<string, number>>(
      {},
    );
  const [people, setPeople] = useState(2),
    [firstName, setFirstName] = useState(""),
    [lastName, setLastName] = useState(""),
    [email, setEmail] = useState(""),
    [phone, setPhone] = useState(""),
    [company, setCompany] = useState(""),
    [notes, setNotes] = useState(""),
    [accepted, setAccepted] = useState(false);
  const [organizations, setOrganizations] = useState<BookingOrganization[]>([]),
    [organizationId, setOrganizationId] = useState("");
  const [discountCode, setDiscountCode] = useState(""),
    [discount, setDiscount] = useState<DiscountQuote | null>(null),
    [discountBusy, setDiscountBusy] = useState(false),
    [discountError, setDiscountError] = useState("");
  const [loading, setLoading] = useState(true),
    [slotLoading, setSlotLoading] = useState(false),
    [error, setError] = useState(""),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [groupDate, setGroupDate] = useState(isoDate(new Date())),
    [groupTime, setGroupTime] = useState(""),
    [groupGuests, setGroupGuests] = useState(25),
    [groupMessage, setGroupMessage] = useState(""),
    [groupReference, setGroupReference] = useState(""),
    [groupBusy, setGroupBusy] = useState(false);
  const selectedSlot = slots.find((s) => s.start_time.slice(0, 5) === time),
    available = selectedSlot?.available_tables || 0,
    addonLines = addons.filter((a) => (addonQuantities[a.id] || 0) > 0),
    addonUnits = addonLines.reduce(
      (n, a) => n + (addonQuantities[a.id] || 0),
      0,
    ),
    selectedAddonIds = addonLines.flatMap((a) =>
      Array(addonQuantities[a.id] || 0).fill(a.id),
    ),
    extrasPrice = addonLines.reduce(
      (n, a) => n + a.price_cents * (addonQuantities[a.id] || 0),
      0,
    ),
    addonSummary = addonLines.length
      ? addonLines.map((a) => `${addonQuantities[a.id]}× ${a.name}`).join(", ")
      : "Keine";
  const today = useMemo(() => {
      const n = new Date();
      return new Date(n.getFullYear(), n.getMonth(), n.getDate());
    }, []),
    lastDate = useMemo(() => {
      const d = new Date(today);
      d.setDate(d.getDate() + Math.max(0, config.operations.horizonDays - 1));
      return d;
    }, [config.operations.horizonDays, today]);
  const calendarDays = useMemo(() => {
    const y = calendarMonth.getFullYear(),
      m = calendarMonth.getMonth(),
      offset = (new Date(y, m, 1).getDay() + 6) % 7,
      days = new Date(y, m + 1, 0).getDate();
    return [
      ...Array.from({ length: offset }, () => null),
      ...Array.from({ length: days }, (_, i) => new Date(y, m, i + 1)),
    ];
  }, [calendarMonth]);
  const durations = useMemo(
      () =>
        Array.from(
          {
            length: Math.min(
              6,
              Math.max(1, config.operations.maxDurationHours),
            ),
          },
          (_, i) => i + 1,
        ),
      [config.operations.maxDurationHours],
    ),
    subtotal = time ? basePrice(time, hours, tables, config) + extrasPrice : 0,
    total = discount?.total_cents ?? subtotal;
  const vatCents = config.operations.vatEnabled
      ? Math.round(
          (total * config.operations.vatRateBasisPoints) /
            (10000 + config.operations.vatRateBasisPoints),
        )
      : 0,
    vatRate = (config.operations.vatRateBasisPoints / 100).toLocaleString(
      "de-CH",
      { minimumFractionDigits: 1, maximumFractionDigits: 2 },
    ),
    endTime = time
      ? String(Number(time.slice(0, 2)) + hours).padStart(2, "0") + ":00"
      : "";

  useEffect(() => {
    Promise.all([
      supabase.from("vp_addons").select("*").order("sort_order"),
      supabase.rpc("vp_public_booking_config"),
    ]).then(([a, c]) => {
      if (a.error) setError("Extras konnten nicht geladen werden.");
      else setAddons(a.data || []);
      if (!c.error) setConfig(mergeStudioConfig(c.data));
      setLoading(false);
    });
  }, []);
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      await supabase.rpc("vp_claim_account");
      const { data: account } = await supabase.rpc("vp_account_snapshot");
      const profile = account?.profile;
      if (!profile) return;
      setFirstName((v) => v || profile.first_name || "");
      setLastName((v) => v || profile.last_name || "");
      setEmail((v) => v || profile.email || "");
      setPhone((v) => v || profile.phone || "");
      setOrganizations(account?.organizations || []);
    });
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(location.search),
      id = q.get("payment_booking"),
      token = q.get("payment_token");
    if (!id || !token) return;
    setLoading(true);
    setMode("booking");
    setStep(7);
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      tries = 0;
    const check = async () => {
      try {
        const r = await fetch(supabaseUrl + "/functions/v1/vp-sumup-status", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: supabasePublishableKey,
            },
            body: JSON.stringify({ booking_id: id, status_token: token }),
          }),
          data = await r.json();
        if (!r.ok)
          throw new Error(
            data.error || "Zahlungsstatus konnte nicht geprüft werden",
          );
        if (!active) return;
        setConfirmation(data);
        setLoading(false);
        tries++;
        const paid =
            data.payment_status === "paid" || data.payment_status === "invoice",
          done =
            paid &&
            (!data.anny_enabled ||
              ["active", "issued"].includes(data.access_status) ||
              data.anny_sync_status === "failed");
        if (!done && tries < 30) timer = setTimeout(check, 2500);
      } catch (e) {
        if (active) {
          setError(
            e instanceof Error ? e.message : "Statusprüfung fehlgeschlagen",
          );
          setLoading(false);
        }
      }
    };
    check();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (mode !== "booking" || step !== 3) return;
    let live = true;
    setSlotLoading(true);
    setTime("");
    fetch(supabaseUrl + "/functions/v1/vp-anny-availability", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabasePublishableKey,
      },
      body: JSON.stringify({ date, hours }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error();
        if (live) setSlots(d || []);
      })
      .catch(() => {
        if (live) setError("Die freien Zeiten konnten nicht geladen werden.");
      })
      .finally(() => {
        if (live) setSlotLoading(false);
      });
    return () => {
      live = false;
    };
  }, [date, hours, mode, step]);
  function clearDiscount() {
    setDiscount(null);
    setDiscountError("");
  }
  function go(next: number) {
    setStep(next);
    setError("");
    requestAnimationFrame(() => scrollTo({ top: 0, behavior: "smooth" }));
  }
  function pick(fn: () => void, next: number) {
    fn();
    setTimeout(() => go(next), 180);
  }
  function changeAddon(id: string, delta: number) {
    clearDiscount();
    setAddonQuantities((current) => ({
      ...current,
      [id]: Math.max(0, Math.min(20, (current[id] || 0) + delta)),
    }));
  }
  async function applyDiscount() {
    if (discount) {
      setDiscount(null);
      setDiscountCode("");
      return;
    }
    if (!discountCode.trim()) {
      setDiscountError("Bitte gib zuerst einen Rabattcode ein.");
      return;
    }
    setDiscountBusy(true);
    setDiscountError("");
    try {
      const r = await fetch(
          supabaseUrl + "/functions/v1/vp-sumup-create-checkout",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: supabasePublishableKey,
            },
            body: JSON.stringify({
              action: "validate_discount",
              code: discountCode,
              subtotal,
            }),
          },
        ),
        d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setDiscount(d);
      setDiscountCode(d.code);
    } catch (e) {
      setDiscountError(
        e instanceof Error ? e.message : "Rabattcode ist nicht gültig",
      );
    } finally {
      setDiscountBusy(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!time) return;
    setLoading(true);
    setError("");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const selectedOrganization = organizations.find(
        (o) => o.id === organizationId,
      );
      const r = await fetch(
          supabaseUrl + "/functions/v1/vp-sumup-create-checkout",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: supabasePublishableKey,
              ...(session
                ? { Authorization: `Bearer ${session.access_token}` }
                : {}),
            },
            body: JSON.stringify({
              date,
              time,
              hours,
              tables,
              people,
              name: (firstName.trim() + " " + lastName.trim()).trim(),
              email,
              phone,
              company: selectedOrganization?.name || company,
              organization_id: organizationId || null,
              notes,
              addons: selectedAddonIds,
              discount_code: discount?.code || "",
              website: "",
            }),
          },
        ),
        d = await r.json();
      if (!r.ok)
        throw new Error(d.error || "Buchung konnte nicht gestartet werden");
      location.assign(d.checkout_url);
    } catch (e) {
      setLoading(false);
      const m = e instanceof Error ? e.message : "Buchung fehlgeschlagen";
      setError(m);
      if (m.includes("vergeben")) go(3);
    }
  }
  async function submitGroup(e: FormEvent) {
    e.preventDefault();
    setGroupBusy(true);
    setError("");
    const { data, error: e2 } = await supabase.rpc("vp_submit_group_inquiry", {
      p_desired_date: groupDate,
      p_preferred_time: groupTime || null,
      p_guest_count: groupGuests,
      p_first_name: firstName,
      p_last_name: lastName,
      p_email: email,
      p_phone: phone,
      p_company: company,
      p_message: groupMessage,
      p_website: "",
    });
    setGroupBusy(false);
    if (e2) {
      setError(e2.message);
      return;
    }
    setGroupReference(data?.[0]?.reference || "");
    scrollTo({ top: 0, behavior: "smooth" });
  }
  if (loading && !addons.length && !confirmation)
    return (
      <main className="simple-booking simple-loading">
        <div className="loader" />
        <p>Volta Pong wird geladen …</p>
      </main>
    );
  const radius =
      config.design.buttonStyle === "pill"
        ? "999px"
        : config.design.buttonStyle === "square"
          ? "4px"
          : Math.min(18, config.design.radius) + "px",
    style = {
      "--blue": config.design.primary,
      "--orange": config.design.accent,
      "--pink": config.design.background,
      "--ink": config.design.text,
      "--studio-surface": config.design.surface,
      "--studio-radius": config.design.radius + "px",
      "--studio-button-radius": radius,
    } as React.CSSProperties,
    anny = confirmation?.anny_enabled ?? config.operations.annyEnabled,
    sumup = confirmation?.sumup_enabled ?? config.operations.sumupEnabled,
    ready = Boolean(
      confirmation &&
        ["paid", "invoice"].includes(confirmation.payment_status) &&
        (!anny ||
          ["active", "issued"].includes(confirmation.access_status) ||
          confirmation.anny_sync_status === "failed"),
    );
  return (
    <main className="simple-booking" style={style}>
      <header className="simple-header">
        <Link href="/buchen" className="booking-brand">
          VOLTA <span>PONG!</span>
        </Link>
        <div className="booking-header-links">
          <span>{config.operations.address}</span>
          <Link href="/konto">Mein Konto</Link>
        </div>
      </header>
      <section className={"simple-shell mode-" + mode}>
        <aside className="simple-rail">
          <div className="rail-intro">
            <p>
              {mode === "group"
                ? "Gruppenanfrage"
                : mode === "welcome"
                  ? "Basel spielt Pong"
                  : "Tisch buchen"}
            </p>
            <h1>
              {mode === "group"
                ? "Euer Event."
                : mode === "welcome"
                  ? "Willkommen bei Volta Pong."
                  : config.content.headline}
            </h1>
          </div>
          {mode === "booking" && step <= 6 && (
            <>
              <div className="booking-progress-summary">
                {step > 1 && (
                  <span>
                    <small>Datum</small>
                    <strong>
                      {new Intl.DateTimeFormat("de-CH", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                      }).format(new Date(date + "T12:00:00"))}
                    </strong>
                  </span>
                )}
                {step > 2 && (
                  <span>
                    <small>Dauer</small>
                    <strong>
                      {hours} Stunde{hours > 1 ? "n" : ""}
                    </strong>
                  </span>
                )}
                {step > 3 && time && (
                  <span>
                    <small>Uhrzeit</small>
                    <strong>
                      {time}–{endTime} Uhr
                    </strong>
                  </span>
                )}
                {step > 4 && (
                  <span>
                    <small>Tische</small>
                    <strong>{tables}</strong>
                  </span>
                )}
                {step > 5 && (
                  <span>
                    <small>Extras</small>
                    <strong>{addonSummary}</strong>
                  </span>
                )}
              </div>
              <ol>
                {progress.map(([l, h], i) => (
                  <li
                    key={l}
                    className={
                      step === i + 1 ? "active" : step > i + 1 ? "done" : ""
                    }
                  >
                    <button
                      type="button"
                      disabled={i + 1 > step}
                      onClick={() => go(i + 1)}
                      aria-label={l + " öffnen"}
                    >
                      <i>{step > i + 1 ? "✓" : i + 1}</i>
                      <span>
                        {l}
                        <small>{h}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
          {mode === "group" && (
            <div className="group-rail-note">
              <strong>Ab 25 Personen</strong>
              <span>
                Teilt uns eure Wünsche mit. Wir melden uns persönlich.
              </span>
            </div>
          )}
          <div className="rail-facts">
            <span>
              Täglich {config.operations.opensAt}–{config.operations.closesAt}
            </span>
            {config.content.benefits.map((x) => (
              <span key={x}>{x}</span>
            ))}
          </div>
        </aside>
        <div className="simple-card">
          {error && <div className="form-error">{error}</div>}
          {mode === "welcome" && (
            <section className="flow-step welcome-step">
              <p className="flow-kicker">Willkommen im Volta Pong</p>
              <h2>Was habt ihr vor?</h2>
              <p className="flow-copy">
                In wenigen Schritten zur passenden Spielzeit.
              </p>
              <div className="entry-options">
                <button
                  onClick={() => {
                    setMode("booking");
                    go(1);
                  }}
                >
                  <i>↗</i>
                  <span>
                    <strong>Tisch buchen</strong>
                    <small>1–8 Tische direkt reservieren und bezahlen</small>
                  </span>
                  <b>Weiter →</b>
                </button>
                <button
                  onClick={() => {
                    setMode("group");
                    setError("");
                  }}
                >
                  <i>25+</i>
                  <span>
                    <strong>Gruppenanfrage</strong>
                    <small>Für Events, Firmen und individuelle Wünsche</small>
                  </span>
                  <b>Anfragen →</b>
                </button>
              </div>
              <p className="entry-note">
                Gruppenanfragen beantworten wir erst ab 25 Personen.
              </p>
            </section>
          )}
          {mode === "group" && !groupReference && (
            <form className="flow-step group-form" onSubmit={submitGroup}>
              <button
                type="button"
                className="flow-back"
                onClick={() => setMode("welcome")}
              >
                ← Zurück
              </button>
              <p className="flow-kicker">Gruppenanfrage · ab 25 Personen</p>
              <h2>Erzählt uns von euch.</h2>
              <p className="flow-copy">
                Wir prüfen eure Wünsche persönlich und melden uns mit einem
                passenden Angebot.
              </p>
              <div className="checkout-grid">
                <label>
                  Wunschdatum
                  <input
                    required
                    type="date"
                    min={isoDate(today)}
                    max={isoDate(lastDate)}
                    value={groupDate}
                    onChange={(e) => setGroupDate(e.target.value)}
                  />
                </label>
                <label>
                  Wunschzeit <small>optional</small>
                  <input
                    type="time"
                    value={groupTime}
                    onChange={(e) => setGroupTime(e.target.value)}
                  />
                </label>
                <label>
                  Personen
                  <input
                    required
                    type="number"
                    min="25"
                    max="1000"
                    value={groupGuests}
                    onChange={(e) => setGroupGuests(Number(e.target.value))}
                  />
                </label>
                <label>
                  Firma / Team <small>optional</small>
                  <input
                    autoComplete="organization"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                  />
                </label>
                <label>
                  Vorname
                  <input
                    required
                    autoComplete="given-name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </label>
                <label>
                  Nachname
                  <input
                    required
                    autoComplete="family-name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </label>
                <label>
                  E-Mail
                  <input
                    required
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label>
                  Telefon
                  <input
                    required
                    type="tel"
                    minLength={7}
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
                <label className="wide">
                  Was habt ihr vor? <small>optional</small>
                  <textarea
                    rows={5}
                    maxLength={2000}
                    placeholder="Anlass, Programm, Essen & Getränke …"
                    value={groupMessage}
                    onChange={(e) => setGroupMessage(e.target.value)}
                  />
                </label>
              </div>
              <button
                className="checkout-button"
                disabled={groupBusy || groupGuests < 25}
              >
                {groupBusy
                  ? "Anfrage wird gesendet …"
                  : "Gruppenanfrage senden"}
              </button>
            </form>
          )}
          {mode === "group" && groupReference && (
            <section className="flow-step flow-confirm">
              <div className="confirm-mark">✓</div>
              <p className="flow-kicker">Anfrage {groupReference}</p>
              <h2>Danke, wir melden uns.</h2>
              <p>Eure Gruppenanfrage ist sicher bei Volta Pong eingegangen.</p>
              <button
                className="checkout-button"
                onClick={() => location.assign("/buchen")}
              >
                Zur Startseite
              </button>
            </section>
          )}
          {mode === "booking" && step === 1 && (
            <section className="flow-step">
              <button className="flow-back" onClick={() => setMode("welcome")}>
                ← Zurück
              </button>
              <p className="flow-kicker">1 von 6 · Datum</p>
              <h2>Wann wollt ihr spielen?</h2>
              <div className="calendar-picker">
                <div className="calendar-head">
                  <button
                    disabled={monthKey(calendarMonth) <= monthKey(today)}
                    onClick={() =>
                      setCalendarMonth(
                        new Date(
                          calendarMonth.getFullYear(),
                          calendarMonth.getMonth() - 1,
                          1,
                        ),
                      )
                    }
                  >
                    ←
                  </button>
                  <strong>
                    {new Intl.DateTimeFormat("de-CH", {
                      month: "long",
                      year: "numeric",
                    }).format(calendarMonth)}
                  </strong>
                  <button
                    disabled={
                      new Date(
                        calendarMonth.getFullYear(),
                        calendarMonth.getMonth() + 1,
                        1,
                      ) > lastDate
                    }
                    onClick={() =>
                      setCalendarMonth(
                        new Date(
                          calendarMonth.getFullYear(),
                          calendarMonth.getMonth() + 1,
                          1,
                        ),
                      )
                    }
                  >
                    →
                  </button>
                </div>
                <div className="calendar-weekdays">
                  {weekdays.map((d) => (
                    <span key={d}>{d}</span>
                  ))}
                </div>
                <div className="calendar-grid">
                  {calendarDays.map((d, i) =>
                    d ? (
                      (() => {
                        const v = isoDate(d),
                          disabled = d < today || d > lastDate;
                        return (
                          <button
                            key={v}
                            disabled={disabled}
                            className={
                              (date === v ? "selected " : "") +
                              (v === isoDate(today) ? "today" : "")
                            }
                            onClick={() =>
                              pick(() => {
                                setDate(v);
                                clearDiscount();
                              }, 2)
                            }
                          >
                            {d.getDate()}
                          </button>
                        );
                      })()
                    ) : (
                      <span className="calendar-empty" key={i} />
                    ),
                  )}
                </div>
              </div>
              <p className="auto-hint">
                Nach der Auswahl geht es automatisch weiter.
              </p>
            </section>
          )}
          {mode === "booking" && step === 2 && (
            <section className="flow-step">
              <button className="flow-back" onClick={() => go(1)}>
                ← Datum ändern
              </button>
              <p className="flow-kicker">2 von 6 · Dauer</p>
              <h2>Wie lange?</h2>
              <p className="flow-copy">
                {dateLabel(date)} · Eine bis sechs Stunden.
              </p>
              <div className="flow-duration duration-six">
                {durations.map((h) => (
                  <button
                    key={h}
                    className={hours === h ? "selected" : ""}
                    onClick={() =>
                      pick(() => {
                        setHours(h);
                        clearDiscount();
                      }, 3)
                    }
                  >
                    <strong>
                      {h} Stunde{h > 1 ? "n" : ""}
                    </strong>
                  </button>
                ))}
              </div>
            </section>
          )}
          {mode === "booking" && step === 3 && (
            <section className="flow-step">
              <button className="flow-back" onClick={() => go(2)}>
                ← Dauer ändern
              </button>
              <p className="flow-kicker">3 von 6 · Startzeit</p>
              <h2>Wann geht’s los?</h2>
              <p className="flow-copy">
                {dateLabel(date)} · {hours} Stunde{hours > 1 ? "n" : ""}
              </p>
              {slotLoading ? (
                <div className="slots-loading">
                  Freie Zeiten werden geprüft …
                </div>
              ) : (
                <div className="flow-times">
                  {slots.map((s) => (
                    <button
                      key={s.start_time}
                      onClick={() =>
                        pick(() => {
                          setTime(s.start_time.slice(0, 5));
                          setTables(1);
                          clearDiscount();
                        }, 4)
                      }
                    >
                      <strong>{s.start_time.slice(0, 5)}</strong>
                      <span>{s.available_tables} Tische frei</span>
                    </button>
                  ))}
                </div>
              )}
              {!slotLoading && !slots.length && (
                <p className="empty-message">
                  Für diese Dauer ist leider nichts mehr frei.
                </p>
              )}
            </section>
          )}
          {mode === "booking" && step === 4 && (
            <section className="flow-step">
              <button className="flow-back" onClick={() => go(3)}>
                ← Startzeit ändern
              </button>
              <p className="flow-kicker">4 von 6 · Tische</p>
              <h2>Wie viele Tische?</h2>
              <p className="flow-copy">
                Wir weisen euch automatisch die nächsten freien Tische zu.
              </p>
              <div className="table-options">
                {Array.from({ length: available }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    className={tables === n ? "selected" : ""}
                    onClick={() => {
                      setTables(n);
                      clearDiscount();
                    }}
                  >
                    <span className="table-number">{n}</span>
                    <span>
                      <strong>{n === 1 ? "1 Tisch" : n + " Tische"}</strong>
                      <small>für bis zu {n * 8} Personen</small>
                    </span>
                    <b>{money(basePrice(time, hours, n, config))}</b>
                  </button>
                ))}
              </div>
              <div className="sticky-next">
                <button className="secondary-back" onClick={() => go(3)}>
                  ← Zurück
                </button>
                <div>
                  <small>
                    {dateLabel(date)} · {time}–{endTime}
                  </small>
                  <strong>
                    {tables} {tables === 1 ? "Tisch" : "Tische"}
                  </strong>
                </div>
                <button onClick={() => go(5)}>Weiter</button>
              </div>
            </section>
          )}
          {mode === "booking" && step === 5 && (
            <section className="flow-step">
              <button className="flow-back" onClick={() => go(4)}>
                ← Tische ändern
              </button>
              <p className="flow-kicker">5 von 6 · Extras</p>
              <h2>Darf’s noch etwas sein?</h2>
              <p className="flow-copy">
                Optional – einfach überspringen ist möglich.
              </p>
              <div className="extras-list extras-shop">
                {addons.map((a) => {
                  const quantity = addonQuantities[a.id] || 0;
                  return (
                    <div key={a.id} className={quantity ? "selected" : ""}>
                      {a.image_url ? (
                        <img src={a.image_url} alt={a.name} />
                      ) : (
                        <div className="extra-image-placeholder">VOLTA</div>
                      )}
                      <span>
                        <strong>{a.name}</strong>
                        <b>
                          {a.price_cents ? money(a.price_cents) : "kostenlos"}
                        </b>
                      </span>
                      <div className="extra-quantity">
                        {quantity > 0 && (
                          <button
                            type="button"
                            onClick={() => changeAddon(a.id, -1)}
                            aria-label={`${a.name} entfernen`}
                          >
                            −
                          </button>
                        )}
                        {quantity > 0 && (
                          <strong aria-live="polite">{quantity}</strong>
                        )}
                        <button
                          type="button"
                          onClick={() => changeAddon(a.id, 1)}
                          disabled={quantity >= 20}
                          aria-label={`${a.name} hinzufügen`}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="sticky-next">
                <button className="secondary-back" onClick={() => go(4)}>
                  ← Zurück
                </button>
                <div>
                  <small>
                    {addonUnits ? addonUnits + " Extras" : "Keine Extras"}
                  </small>
                  <strong>Gesamt {money(subtotal)}</strong>
                </div>
                <button onClick={() => go(6)}>Zum Checkout</button>
              </div>
            </section>
          )}
          {mode === "booking" && step === 6 && (
            <form className="flow-step checkout" onSubmit={submit}>
              <button type="button" className="flow-back" onClick={() => go(5)}>
                ← Extras ändern
              </button>
              <p className="flow-kicker">6 von 6 · Checkout</p>
              <h2>Fast geschafft.</h2>
              <div className="checkout-summary checkout-summary-large">
                <p>Deine Buchung</p>
                <div>
                  <span>Datum</span>
                  <strong>
                    {new Intl.DateTimeFormat("de-CH", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    }).format(new Date(date + "T12:00:00"))}
                  </strong>
                </div>
                <div>
                  <span>Dauer & Uhrzeit</span>
                  <strong>
                    {hours} Stunde{hours > 1 ? "n" : ""} · {time}–{endTime} Uhr
                  </strong>
                </div>
                <div>
                  <span>Tische</span>
                  <strong>{tables}</strong>
                </div>
                <div>
                  <span>Extras</span>
                  <strong>
                    {addonLines.length ? addonSummary : "Keine Extras"}
                  </strong>
                </div>
                <div className="checkout-total">
                  <span>Gesamt</span>
                  <strong>{money(total)}</strong>
                </div>
              </div>
              <div className="discount-entry">
                <div>
                  <label>
                    Rabattcode <small>optional</small>
                    <input
                      value={discountCode}
                      disabled={Boolean(discount)}
                      onChange={(e) =>
                        setDiscountCode(e.target.value.toUpperCase())
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={discountBusy}
                    onClick={applyDiscount}
                  >
                    {discountBusy
                      ? "Prüft …"
                      : discount
                        ? "Entfernen"
                        : "Einlösen"}
                  </button>
                </div>
                {discountError && (
                  <p className="discount-error">{discountError}</p>
                )}
                {discount && (
                  <div className="discount-success">
                    <span>✓ {discount.code}</span>
                    <strong>− {money(discount.discount_cents)}</strong>
                  </div>
                )}
              </div>
              <div className="price-breakdown">
                <span>
                  Zwischensumme inkl. MWST <b>{money(subtotal)}</b>
                </span>
                {discount && (
                  <span>
                    Rabatt <b>− {money(discount.discount_cents)}</b>
                  </span>
                )}
                <strong>
                  Gesamtpreis <b>{money(total)}</b>
                </strong>
                {config.operations.vatEnabled && (
                  <span className="vat-line">
                    Darin MWST ({vatRate} %) <b>{money(vatCents)}</b>
                  </span>
                )}
                <small>
                  Alle Preise in CHF und inklusive gesetzlicher MWST.
                </small>
              </div>
              <div className="checkout-grid">
                <label>
                  Vorname
                  <input
                    required
                    autoComplete="given-name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </label>
                <label>
                  Nachname
                  <input
                    required
                    autoComplete="family-name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </label>
                <label>
                  Personen
                  <input
                    required
                    type="number"
                    min="1"
                    max={tables * 8}
                    value={people}
                    onChange={(e) => setPeople(Number(e.target.value))}
                  />
                </label>
                <label>
                  E-Mail
                  <input
                    required
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label>
                  Telefon
                  <input
                    required
                    type="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
                {organizations.length ? (
                  <label>
                    Abrechnung
                    <select
                      value={organizationId}
                      onChange={(e) => {
                        setOrganizationId(e.target.value);
                        if (e.target.value)
                          setCompany(
                            organizations.find((o) => o.id === e.target.value)
                              ?.name || "",
                          );
                      }}
                    >
                      <option value="">Privat buchen</option>
                      {organizations.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    Firma / Team <small>optional</small>
                    <input
                      autoComplete="organization"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                    />
                  </label>
                )}
                <label className="wide">
                  Notiz <small>optional</small>
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </label>
              </div>
              <label className="flow-check">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>{config.content.termsLabel}</span>
              </label>
              <div className="checkout-actions">
                <button
                  type="button"
                  className="secondary-back"
                  onClick={() => go(5)}
                >
                  ← Zurück
                </button>
                <button
                  className="checkout-button"
                  disabled={!accepted || loading}
                >
                  {loading
                    ? "Wird geöffnet …"
                    : total === 0
                      ? "Kostenlos buchen"
                      : config.operations.sumupEnabled
                        ? money(total) + " · Mit SumUp bezahlen"
                        : money(total) + " · Buchung bestätigen"}
                </button>
              </div>
            </form>
          )}
          {mode === "booking" && step === 7 && (
            <section className="flow-step flow-confirm">
              <div
                className={
                  "confirm-mark " +
                  (confirmation?.anny_sync_status === "failed" ? "failed" : "")
                }
              >
                {ready
                  ? "✓"
                  : confirmation?.anny_sync_status === "failed"
                    ? "!"
                    : "…"}
              </div>
              <p className="flow-kicker">
                {[sumup && "SumUp", anny && "Anny · SALTO KS"]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <h2>{ready ? "Buchung bestätigt." : "Buchung wird geprüft."}</h2>
              <p>
                {anny
                  ? "Deine Buchung und der zeitlich begrenzte Zugang werden verarbeitet."
                  : "Deine Buchung ist lokal bestätigt."}
              </p>
              {confirmation?.access_code && (
                <div className="access-code">
                  <span>Dein Türcode</span>
                  <strong>{confirmation.access_code}</strong>
                </div>
              )}
              {confirmation && (
                <div className="confirm-ticket">
                  <div>
                    <span>Volta-Buchung</span>
                    <strong>{confirmation.reference}</strong>
                  </div>
                  {confirmation.anny_booking_number && (
                    <div>
                      <span>Anny-Buchung</span>
                      <strong>{confirmation.anny_booking_number}</strong>
                    </div>
                  )}
                  <div>
                    <span>Gesamt</span>
                    <strong>{money(confirmation.price_cents)}</strong>
                  </div>
                </div>
              )}
              <button
                className="checkout-button"
                onClick={() =>
                  ready ? location.assign("/buchen") : location.reload()
                }
              >
                {ready ? "Weitere Buchung" : "Status erneut prüfen"}
              </button>
            </section>
          )}
        </div>
      </section>
    </main>
  );
}
