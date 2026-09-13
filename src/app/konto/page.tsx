"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabasePublishableKey, supabaseUrl } from "@/lib/supabase";
import { Addon, money } from "@/lib/volta";

type AccountBooking = {
  id: string;
  reference: string;
  starts_at: string;
  ends_at: string;
  guest_count: number;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  company: string | null;
  notes: string | null;
  status: string;
  payment_status: string;
  price_cents: number | null;
  addon_ids: string[];
  access_code: string | null;
  access_valid_from: string | null;
  access_valid_until: string | null;
  table_ids: number[];
  organization_id: string | null;
};
type Member = {
  user_id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  active: boolean;
};
type Invitation = { id: string; email: string; role: string; status: string };
type Organization = {
  id: string;
  name: string;
  billing_email: string;
  billing_address: string;
  vat_number: string;
  role: string;
  members: Member[];
  invitations: Invitation[];
};
type Snapshot = {
  profile: {
    user_id: string;
    email: string;
    first_name: string;
    last_name: string;
    phone: string;
  };
  bookings: AccountBooking[];
  organizations: Organization[];
  staff: null | { role: string; members: Member[]; invitations: Invitation[] };
};
const roleName: Record<string, string> = {
  owner: "Eigentümer",
  admin: "Admin",
  member: "Mitarbeitende",
  billing: "Buchhaltung",
  staff: "Mitarbeitende",
  accounting: "Buchhaltung",
};
const bookingStatus: Record<string, string> = {
  request: "Provisorisch",
  confirmed: "Bestätigt",
  checked_in: "Eingecheckt",
  completed: "Abgeschlossen",
  cancelled: "Storniert",
  no_show: "No-show",
  waitlist: "Warteliste",
};
const initialSnapshot: Snapshot = {
  profile: { user_id: "", email: "", first_name: "", last_name: "", phone: "" },
  bookings: [],
  organizations: [],
  staff: null,
};

export default function AccountPage() {
  const [session, setSession] = useState<Session | null>(null),
    [authReady, setAuthReady] = useState(false),
    [email, setEmail] = useState(""),
    [mailSent, setMailSent] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot),
    [addons, setAddons] = useState<Addon[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [tab, setTab] = useState<"bookings" | "profile" | "companies" | "team">(
      "bookings",
    ),
    [expanded, setExpanded] = useState<string | null>(null),
    [showPast, setShowPast] = useState(false);
  const [firstName, setFirstName] = useState(""),
    [lastName, setLastName] = useState(""),
    [phone, setPhone] = useState("");
  const [newCompany, setNewCompany] = useState(""),
    [newCompanyEmail, setNewCompanyEmail] = useState(""),
    [inviteEmail, setInviteEmail] = useState(""),
    [inviteRole, setInviteRole] = useState("member"),
    [selectedOrg, setSelectedOrg] = useState("");
  const [staffPin, setStaffPin] = useState(""),
    [staffEmail, setStaffEmail] = useState(""),
    [staffRole, setStaffRole] = useState("staff");
  const [editGuests, setEditGuests] = useState(1),
    [editPhone, setEditPhone] = useState(""),
    [editNotes, setEditNotes] = useState(""),
    [moveDate, setMoveDate] = useState(""),
    [moveTime, setMoveTime] = useState("");
  const [extraQuantities, setExtraQuantities] = useState<
    Record<string, number>
  >({});

  async function loadAccount(current: Session) {
    setBusy(true);
    setError("");
    const claimed = await supabase.rpc("vp_claim_account");
    if (claimed.error) {
      setError(claimed.error.message);
      setBusy(false);
      return;
    }
    const [{ data: snapshotData, error: snapshotError }, { data: addonData }] =
      await Promise.all([
        supabase.rpc("vp_account_snapshot"),
        supabase
          .from("vp_addons")
          .select("*")
          .eq("active", true)
          .order("sort_order"),
      ]);
    if (snapshotError) {
      setError(snapshotError.message);
      setBusy(false);
      return;
    }
    const next = (snapshotData || initialSnapshot) as Snapshot;
    setSnapshot(next);
    setAddons(addonData || []);
    setFirstName(next.profile.first_name || "");
    setLastName(next.profile.last_name || "");
    setPhone(next.profile.phone || "");
    if (!selectedOrg && next.organizations[0])
      setSelectedOrg(next.organizations[0].id);
    setSession(current);
    setBusy(false);
  }

  // Authentication listeners are installed once; their callbacks always receive the current session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setAuthReady(true);
      if (data.session) void loadAccount(data.session);
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, next) => {
        if (!mounted) return;
        setSession(next);
        if (next) void loadAccount(next);
        else setSnapshot(initialSnapshot);
      },
    );
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);
  // Process a returned SumUp add-on payment whenever a signed-in session becomes available.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!session) return;
    const q = new URLSearchParams(location.search),
      order = q.get("addon_order"),
      token = q.get("addon_token");
    if (!order || !token) return;
    void accountAction(
      { action: "addon_status", order_id: order, status_token: token },
      false,
    ).then((result) => {
      if (result?.status === "paid") {
        setMessage("Die Extras wurden bezahlt und zur Buchung hinzugefügt.");
        history.replaceState({}, "", "/konto");
        void loadAccount(session);
      } else if (result?.status) {
        setMessage("Zahlungsstatus: " + result.status);
      }
    });
  }, [session]);
  const upcoming = useMemo(
      () =>
        snapshot.bookings.filter(
          (b) => new Date(b.ends_at) > new Date() && b.status !== "cancelled",
        ),
      [snapshot.bookings],
    ),
    past = useMemo(
      () =>
        snapshot.bookings.filter(
          (b) => new Date(b.ends_at) <= new Date() || b.status === "cancelled",
        ),
      [snapshot.bookings],
    );

  async function requestLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: e2 } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${location.origin}/konto` },
    });
    setBusy(false);
    if (e2) setError(e2.message);
    else setMailSent(true);
  }
  async function accountAction(
    payload: Record<string, unknown>,
    reload = true,
  ) {
    if (!session) throw new Error("Anmeldung erforderlich");
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${supabaseUrl}/functions/v1/vp-account-booking`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: supabasePublishableKey,
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(payload),
        }),
        data = await r.json();
      if (!r.ok) throw new Error(data.error || "Aktion fehlgeschlagen");
      if (reload) await loadAccount(session);
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Aktion fehlgeschlagen");
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: e2 } = await supabase.rpc("vp_update_my_profile", {
      p_first_name: firstName,
      p_last_name: lastName,
      p_phone: phone,
    });
    if (e2) setError(e2.message);
    else {
      setMessage("Profil gespeichert.");
      if (session) await loadAccount(session);
    }
    setBusy(false);
  }
  async function createCompany(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error: e2 } = await supabase.rpc("vp_create_my_organization", {
      p_name: newCompany,
      p_billing_email: newCompanyEmail,
    });
    if (e2) setError(e2.message);
    else {
      setNewCompany("");
      setNewCompanyEmail("");
      setMessage("Firmenkonto erstellt.");
      if (session) await loadAccount(session);
    }
    setBusy(false);
  }
  async function inviteCompany(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error: e2 } = await supabase.rpc("vp_invite_organization_member", {
      p_organization_id: selectedOrg,
      p_email: inviteEmail,
      p_role: inviteRole,
    });
    if (e2) setError(e2.message);
    else {
      setInviteEmail("");
      setMessage(
        "Einladung gespeichert. Beim ersten Login wird das Firmenkonto automatisch verbunden.",
      );
      if (session) await loadAccount(session);
    }
    setBusy(false);
  }
  async function saveCompany(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!activeOrg) return;
    setBusy(true);
    const values = new FormData(e.currentTarget);
    const { error: e2 } = await supabase.rpc("vp_update_my_organization", {
      p_organization_id: activeOrg.id,
      p_name: String(values.get("name") || ""),
      p_billing_email: String(values.get("billing_email") || ""),
      p_billing_address: String(values.get("billing_address") || ""),
      p_vat_number: String(values.get("vat_number") || ""),
    });
    if (e2) setError(e2.message);
    else {
      setMessage("Firmendaten gespeichert.");
      if (session) await loadAccount(session);
    }
    setBusy(false);
  }
  async function setCompanyMemberRole(member: Member, role: string) {
    if (!activeOrg) return;
    setBusy(true);
    const { error: e2 } = await supabase.rpc(
      "vp_set_organization_member_role",
      {
        p_organization_id: activeOrg.id,
        p_member_user_id: member.user_id,
        p_role: role,
        p_active: true,
      },
    );
    if (e2) setError(e2.message);
    else if (session) await loadAccount(session);
    setBusy(false);
  }
  async function claimStaff(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error: e2 } = await supabase.rpc("vp_claim_staff_access", {
      p_pin: staffPin,
    });
    if (e2) setError(e2.message);
    else {
      setStaffPin("");
      setMessage("Teamzugang aktiviert.");
      if (session) await loadAccount(session);
    }
    setBusy(false);
  }
  async function inviteStaff(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error: e2 } = await supabase.rpc("vp_invite_staff_member", {
      p_email: staffEmail,
      p_role: staffRole,
    });
    if (e2) setError(e2.message);
    else {
      setStaffEmail("");
      setMessage("Teammitglied eingeladen.");
      if (session) await loadAccount(session);
    }
    setBusy(false);
  }
  async function setTeamRole(member: Member, role: string) {
    setBusy(true);
    const { error: e2 } = await supabase.rpc("vp_set_staff_member_role", {
      p_member_user_id: member.user_id,
      p_role: role,
      p_active: true,
    });
    if (e2) setError(e2.message);
    else if (session) await loadAccount(session);
    setBusy(false);
  }
  function openBooking(b: AccountBooking) {
    setExpanded(expanded === b.id ? null : b.id);
    setEditGuests(b.guest_count);
    setEditPhone(b.customer_phone);
    setEditNotes(b.notes || "");
    const d = new Date(b.starts_at);
    setMoveDate(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Zurich",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d),
    );
    setMoveTime(
      new Intl.DateTimeFormat("de-CH", {
        timeZone: "Europe/Zurich",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d),
    );
    setExtraQuantities({});
  }
  function formatDate(value: string) {
    return new Intl.DateTimeFormat("de-CH", {
      weekday: "short",
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Zurich",
    }).format(new Date(value));
  }
  const activeOrg = snapshot.organizations.find((o) => o.id === selectedOrg);

  if (!authReady)
    return (
      <main className="account-page account-center">
        <div className="loader" />
      </main>
    );
  if (!session)
    return (
      <main className="account-page account-center">
        <section className="account-login">
          <Link href="/buchen" className="account-brand">
            VOLTA <span>PONG!</span>
          </Link>
          <p className="eyebrow">MEIN KONTO</p>
          <h1>
            {mailSent
              ? "Schau in dein Postfach."
              : "Deine Buchungen. Ein Login."}
          </h1>
          {mailSent ? (
            <>
              <p>
                Wir haben dir einen sicheren Anmeldelink geschickt. Er ist nur
                einmal verwendbar.
              </p>
              <button
                onClick={() => setMailSent(false)}
                className="account-secondary"
              >
                Andere E-Mail verwenden
              </button>
            </>
          ) : (
            <form onSubmit={requestLogin}>
              <label>
                E-Mail-Adresse
                <input
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="du@beispiel.ch"
                />
              </label>
              <button disabled={busy}>
                {busy ? "Wird gesendet …" : "Login-Link senden"}
              </button>
            </form>
          )}
          {error && <div className="form-error">{error}</div>}
          <Link href="/buchen" className="account-back">
            ← Zur Buchungsseite
          </Link>
        </section>
      </main>
    );

  return (
    <main className="account-page">
      <header className="account-header">
        <Link href="/buchen" className="account-brand">
          VOLTA <span>PONG!</span>
        </Link>
        <div>
          <span>{snapshot.profile.first_name || snapshot.profile.email}</span>
          <button onClick={() => supabase.auth.signOut()}>Abmelden</button>
        </div>
      </header>
      <div className="account-shell">
        <aside className="account-nav">
          <p className="eyebrow">MEIN VOLTA</p>
          <h1>Alles an einem Ort.</h1>
          <nav>
            <button
              className={tab === "bookings" ? "active" : ""}
              onClick={() => setTab("bookings")}
            >
              Buchungen <b>{upcoming.length}</b>
            </button>
            <button
              className={tab === "profile" ? "active" : ""}
              onClick={() => setTab("profile")}
            >
              Profil
            </button>
            <button
              className={tab === "companies" ? "active" : ""}
              onClick={() => setTab("companies")}
            >
              Firmenkonten <b>{snapshot.organizations.length}</b>
            </button>
            <button
              className={tab === "team" ? "active" : ""}
              onClick={() => setTab("team")}
            >
              Volta-Team
            </button>
          </nav>
          <Link href="/buchen" className="account-book">
            + Neuen Tisch buchen
          </Link>
        </aside>
        <section className="account-content">
          {message && (
            <div className="account-success">
              ✓ {message}
              <button onClick={() => setMessage("")}>×</button>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
          {tab === "bookings" && (
            <>
              <div className="account-title">
                <div>
                  <p className="eyebrow">BUCHUNGSVERWALTUNG</p>
                  <h2>Deine Spielzeiten.</h2>
                </div>
                <button
                  className="account-secondary"
                  onClick={() => setShowPast(!showPast)}
                >
                  {showPast ? "Aktuelle zeigen" : "Vergangene zeigen"}
                </button>
              </div>
              <div className="account-bookings">
                {(showPast ? past : upcoming).map((b) => (
                  <article
                    key={b.id}
                    className={expanded === b.id ? "open" : ""}
                  >
                    <button
                      className="booking-row"
                      onClick={() => openBooking(b)}
                    >
                      <time>
                        <strong>
                          {new Intl.DateTimeFormat("de-CH", {
                            day: "2-digit",
                            month: "short",
                            timeZone: "Europe/Zurich",
                          }).format(new Date(b.starts_at))}
                        </strong>
                        <span>
                          {new Intl.DateTimeFormat("de-CH", {
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: "Europe/Zurich",
                          }).format(new Date(b.starts_at))}
                        </span>
                      </time>
                      <span>
                        <b>{b.reference}</b>
                        <small>
                          {b.status === "cancelled"
                            ? "Tisch freigegeben"
                            : `${b.table_ids.length} ${b.table_ids.length === 1 ? "Tisch" : "Tische"}`} ·{" "}
                          {b.guest_count} Personen
                        </small>
                      </span>
                      <em className={`account-status ${b.status}`}>
                        {bookingStatus[b.status] || b.status}
                      </em>
                      <strong>{money(b.price_cents)}</strong>
                      <i>{expanded === b.id ? "−" : "+"}</i>
                    </button>
                    {expanded === b.id && (
                      <div className="booking-manage">
                        <div className="booking-facts-grid">
                          <span>
                            <small>Termin</small>
                            <strong>{formatDate(b.starts_at)}</strong>
                          </span>
                          <span>
                            <small>Tische</small>
                            <strong>
                              {b.table_ids.join(", ") || "wird zugeteilt"}
                            </strong>
                          </span>
                          <span>
                            <small>Zahlung</small>
                            <strong>
                              {b.payment_status === "paid"
                                ? "Bezahlt"
                                : b.payment_status}
                            </strong>
                          </span>
                          <span>
                            <small>Zugang</small>
                            <strong>
                              {b.access_code || "wird bereitgestellt"}
                            </strong>
                          </span>
                        </div>
                        {b.status !== "cancelled" &&
                          new Date(b.starts_at) > new Date() && (
                            <div className="manage-columns">
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  void accountAction({
                                    action: "update",
                                    booking_id: b.id,
                                    guest_count: editGuests,
                                    phone: editPhone,
                                    notes: editNotes,
                                  }).then(
                                    (x) =>
                                      x && setMessage("Buchung aktualisiert."),
                                  );
                                }}
                              >
                                <h3>Details ändern</h3>
                                <label>
                                  Personen
                                  <input
                                    type="number"
                                    min="1"
                                    max={Math.max(1, b.table_ids.length) * 8}
                                    value={editGuests}
                                    onChange={(e) =>
                                      setEditGuests(Number(e.target.value))
                                    }
                                  />
                                </label>
                                <label>
                                  Telefon
                                  <input
                                    value={editPhone}
                                    onChange={(e) =>
                                      setEditPhone(e.target.value)
                                    }
                                  />
                                </label>
                                <label>
                                  Notiz
                                  <textarea
                                    rows={3}
                                    value={editNotes}
                                    onChange={(e) =>
                                      setEditNotes(e.target.value)
                                    }
                                  />
                                </label>
                                <button disabled={busy}>Speichern</button>
                              </form>
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  void accountAction({
                                    action: "reschedule",
                                    booking_id: b.id,
                                    date: moveDate,
                                    time: moveTime,
                                  }).then(
                                    (x) =>
                                      x &&
                                      setMessage(
                                        x.external_synced === false
                                          ? "Lokal umgebucht. Die externe Synchronisierung wird geprüft."
                                          : "Termin umgebucht.",
                                      ),
                                  );
                                }}
                              >
                                <h3>Termin verschieben</h3>
                                <label>
                                  Datum
                                  <input
                                    type="date"
                                    required
                                    value={moveDate}
                                    onChange={(e) =>
                                      setMoveDate(e.target.value)
                                    }
                                  />
                                </label>
                                <label>
                                  Startzeit
                                  <input
                                    type="time"
                                    required
                                    step="3600"
                                    min="09:00"
                                    max="23:00"
                                    value={moveTime}
                                    onChange={(e) =>
                                      setMoveTime(e.target.value)
                                    }
                                  />
                                </label>
                                <small>
                                  Dauer und Tischanzahl bleiben gleich. Der
                                  bereits bezahlte Preis bleibt bestehen.
                                </small>
                                <button disabled={busy}>
                                  Verfügbarkeit prüfen & umbuchen
                                </button>
                              </form>
                              <form
                                className="extras-manage"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  const ids = addons.flatMap((a) =>
                                    Array(extraQuantities[a.id] || 0).fill(
                                      a.id,
                                    ),
                                  );
                                  void accountAction(
                                    {
                                      action: "add_extras",
                                      booking_id: b.id,
                                      addons: ids,
                                    },
                                    false,
                                  ).then((x) => {
                                    if (x?.checkout_url)
                                      location.assign(x.checkout_url);
                                  });
                                }}
                              >
                                <h3>Extras ergänzen</h3>
                                <div>
                                  {addons.map((a) => (
                                    <label key={a.id}>
                                      <span>
                                        {a.name}
                                        <small>{money(a.price_cents)}</small>
                                      </span>
                                      <span>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setExtraQuantities((q) => ({
                                              ...q,
                                              [a.id]: Math.max(
                                                0,
                                                (q[a.id] || 0) - 1,
                                              ),
                                            }))
                                          }
                                        >
                                          −
                                        </button>
                                        <b>{extraQuantities[a.id] || 0}</b>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setExtraQuantities((q) => ({
                                              ...q,
                                              [a.id]: Math.min(
                                                20,
                                                (q[a.id] || 0) + 1,
                                              ),
                                            }))
                                          }
                                        >
                                          +
                                        </button>
                                      </span>
                                    </label>
                                  ))}
                                </div>
                                <button
                                  disabled={
                                    busy ||
                                    !Object.values(extraQuantities).some(
                                      Boolean,
                                    )
                                  }
                                >
                                  Extras hinzufügen & bezahlen
                                </button>
                              </form>
                            </div>
                          )}{" "}
                        {b.status !== "cancelled" &&
                          new Date(b.starts_at) > new Date() && (
                            <button
                              className="cancel-booking"
                              onClick={() => {
                                if (
                                  confirm("Diese Buchung wirklich stornieren?")
                                )
                                  void accountAction({
                                    action: "cancel",
                                    booking_id: b.id,
                                  }).then(
                                    (x) =>
                                      x &&
                                      setMessage(
                                        x.external_synced === false
                                          ? "Storniert. Die externe Synchronisierung wird geprüft."
                                          : "Buchung storniert.",
                                      ),
                                  );
                              }}
                            >
                              Buchung stornieren
                            </button>
                          )}
                      </div>
                    )}
                  </article>
                ))}
                {!(showPast ? past : upcoming).length && (
                  <div className="account-empty">
                    <h3>
                      {showPast
                        ? "Noch keine vergangenen Buchungen."
                        : "Keine kommende Buchung."}
                    </h3>
                    <Link href="/buchen">Tisch buchen →</Link>
                  </div>
                )}
              </div>
            </>
          )}
          {tab === "profile" && (
            <>
              <div className="account-title">
                <div>
                  <p className="eyebrow">PERSÖNLICHE DATEN</p>
                  <h2>Dein Profil.</h2>
                </div>
              </div>
              <form className="account-form" onSubmit={saveProfile}>
                <label>
                  Vorname
                  <input
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </label>
                <label>
                  Nachname
                  <input
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </label>
                <label>
                  E-Mail
                  <input disabled value={snapshot.profile.email} />
                  <small>Deine bestätigte Login-Adresse.</small>
                </label>
                <label>
                  Telefon
                  <input
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
                <button disabled={busy}>Profil speichern</button>
              </form>
            </>
          )}
          {tab === "companies" && (
            <>
              <div className="account-title">
                <div>
                  <p className="eyebrow">FIRMENKONTEN</p>
                  <h2>Gemeinsam buchen.</h2>
                </div>
              </div>
              {snapshot.organizations.length ? (
                <>
                  <div className="org-tabs">
                    {snapshot.organizations.map((o) => (
                      <button
                        key={o.id}
                        className={selectedOrg === o.id ? "active" : ""}
                        onClick={() => setSelectedOrg(o.id)}
                      >
                        {o.name}
                        <small>{roleName[o.role]}</small>
                      </button>
                    ))}
                  </div>
                  {activeOrg && (
                    <section className="org-panel">
                      <header>
                        <div>
                          <h3>{activeOrg.name}</h3>
                          <span>{activeOrg.billing_email}</span>
                        </div>
                        <em>{roleName[activeOrg.role]}</em>
                      </header>
                      {["owner", "admin"].includes(activeOrg.role) && (
                        <>
                          <form className="account-form org-details" onSubmit={saveCompany}>
                            <label>
                              Firmenname
                              <input name="name" required defaultValue={activeOrg.name} />
                            </label>
                            <label>
                              Rechnungs-E-Mail
                              <input name="billing_email" type="email" required defaultValue={activeOrg.billing_email} />
                            </label>
                            <label>
                              Rechnungsadresse
                              <textarea name="billing_address" rows={3} defaultValue={activeOrg.billing_address} />
                            </label>
                            <label>
                              MWST-Nummer <small>optional</small>
                              <input name="vat_number" defaultValue={activeOrg.vat_number} />
                            </label>
                            <button disabled={busy}>Firmendaten speichern</button>
                          </form>
                          <form
                            className="inline-invite"
                            onSubmit={inviteCompany}
                          >
                            <label>
                              E-Mail
                              <input
                                required
                                type="email"
                                value={inviteEmail}
                                onChange={(e) => setInviteEmail(e.target.value)}
                              />
                            </label>
                            <label>
                              Rolle
                              <select
                                value={inviteRole}
                                onChange={(e) => setInviteRole(e.target.value)}
                              >
                                <option value="member">Mitarbeitende</option>
                                <option value="billing">Buchhaltung</option>
                                <option value="admin">Admin</option>
                              </select>
                            </label>
                            <button>Einladen</button>
                          </form>
                          <div className="member-list">
                            {activeOrg.members.map((m) => (
                              <div key={m.user_id}>
                                <span>
                                  <strong>
                                    {m.first_name || m.email} {m.last_name}
                                  </strong>
                                  <small>{m.email}</small>
                                </span>
                                <select
                                  aria-label={`Rolle von ${m.email}`}
                                  value={m.role}
                                  onChange={(e) => void setCompanyMemberRole(m, e.target.value)}
                                >
                                  <option value="owner">Eigentümer</option>
                                  <option value="admin">Admin</option>
                                  <option value="member">Mitarbeitende</option>
                                  <option value="billing">Buchhaltung</option>
                                </select>
                              </div>
                            ))}
                            {activeOrg.invitations.map((i) => (
                              <div key={i.id} className="pending">
                                <span>
                                  <strong>{i.email}</strong>
                                  <small>Einladung ausstehend</small>
                                </span>
                                <em>{roleName[i.role]}</em>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </section>
                  )}
                </>
              ) : (
                <form
                  className="account-form company-create"
                  onSubmit={createCompany}
                >
                  <h3>Erstes Firmenkonto erstellen</h3>
                  <label>
                    Firmenname
                    <input
                      required
                      value={newCompany}
                      onChange={(e) => setNewCompany(e.target.value)}
                    />
                  </label>
                  <label>
                    Rechnungs-E-Mail
                    <input
                      required
                      type="email"
                      value={newCompanyEmail}
                      onChange={(e) => setNewCompanyEmail(e.target.value)}
                    />
                  </label>
                  <button>Firmenkonto erstellen</button>
                </form>
              )}
            </>
          )}
          {tab === "team" && (
            <>
              <div className="account-title">
                <div>
                  <p className="eyebrow">ROLLEN & RECHTE</p>
                  <h2>Volta-Team.</h2>
                </div>
                {snapshot.staff && (
                  <Link href="/" className="account-secondary">
                    Adminbereich öffnen →
                  </Link>
                )}
              </div>
              {!snapshot.staff ? (
                <form
                  className="account-form staff-claim"
                  onSubmit={claimStaff}
                >
                  <h3>Teamzugang aktivieren</h3>
                  <p>
                    Verbinde dein persönliches Konto einmalig mit dem
                    bestehenden Admin-PIN.
                  </p>
                  <label>
                    Admin-PIN
                    <input
                      required
                      inputMode="numeric"
                      maxLength={6}
                      value={staffPin}
                      onChange={(e) =>
                        setStaffPin(e.target.value.replace(/\D/g, ""))
                      }
                    />
                  </label>
                  <button disabled={staffPin.length !== 6}>
                    Teamzugang aktivieren
                  </button>
                </form>
              ) : (
                <section className="org-panel">
                  <header>
                    <div>
                      <h3>Deine Rolle</h3>
                      <span>Zugriff auf den Volta-Betrieb</span>
                    </div>
                    <em>{roleName[snapshot.staff.role]}</em>
                  </header>
                  {["owner", "admin"].includes(snapshot.staff.role) && (
                    <>
                      <form className="inline-invite" onSubmit={inviteStaff}>
                        <label>
                          E-Mail
                          <input
                            required
                            type="email"
                            value={staffEmail}
                            onChange={(e) => setStaffEmail(e.target.value)}
                          />
                        </label>
                        <label>
                          Rolle
                          <select
                            value={staffRole}
                            onChange={(e) => setStaffRole(e.target.value)}
                          >
                            <option value="staff">Mitarbeitende</option>
                            <option value="accounting">Buchhaltung</option>
                            {snapshot.staff.role === "owner" && (
                              <option value="admin">Admin</option>
                            )}
                          </select>
                        </label>
                        <button>Einladen</button>
                      </form>
                      <div className="member-list">
                        {snapshot.staff.members.map((m) => (
                          <div key={m.user_id}>
                            <span>
                              <strong>
                                {m.first_name || m.email} {m.last_name}
                              </strong>
                              <small>{m.email}</small>
                            </span>
                            {snapshot.staff?.role === "owner" ? (
                              <select
                                aria-label={`Rolle von ${m.email}`}
                                value={m.role}
                                onChange={(e) => void setTeamRole(m, e.target.value)}
                              >
                                <option value="owner">Eigentümer</option>
                                <option value="admin">Admin</option>
                                <option value="staff">Mitarbeitende</option>
                                <option value="accounting">Buchhaltung</option>
                              </select>
                            ) : (
                              <em>{roleName[m.role]}</em>
                            )}
                          </div>
                        ))}
                        {snapshot.staff.invitations.map((i) => (
                          <div key={i.id} className="pending">
                            <span>
                              <strong>{i.email}</strong>
                              <small>Einladung ausstehend</small>
                            </span>
                            <em>{roleName[i.role]}</em>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </section>
      </div>
      {busy && <div className="busy-bar">Wird aktualisiert …</div>}
    </main>
  );
}
