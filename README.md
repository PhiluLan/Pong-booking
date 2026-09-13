# Volta Pong Buchungssystem

Gemeinsame Plattform für das öffentliche Volta-Pong-Buchungsportal und die getrennte interne Team-App.

## Bereiche

- `nuknuk.ch`: öffentlicher Buchungseinstieg
- `nuknuk.ch/buchen`: direkter Buchungsflow
- `nuknuk.ch/konto`: Kundenkonto, Buchungen, Pässe und Community
- `app.nuknuk.ch`: interne Betriebs- und Administrationsoberfläche

Die beiden Domains werden aus demselben Repository als getrennte Vercel-Projekte gebaut. Der öffentliche Build verwendet `NEXT_PUBLIC_APP_SURFACE=customer`, die Team-App `NEXT_PUBLIC_APP_SURFACE=team`. Dadurch bleiben Fachlogik und Design gemeinsam, während Domains und Deployments unabhängig sind.

## Funktionen

- geführter Buchungsflow für Tischreservationen
- Gruppenanfragen ab 25 Personen
- dynamische Preise nach Tageszeit und Anzahl Tische
- Extras mit Bildern und Mengen
- SumUp-Checkout
- Anny- und SALTO-KS-Anbindung
- konfigurierbare Integrationen und Buchungsregeln
- Adminbereich für Services, Ressourcen, Extras und Rabattcodes
- Supabase als Datenbank und Backend

## Lokale Entwicklung

Voraussetzung ist Node.js 20.

```bash
npm ci
npm run dev
```

Die Anwendung ist danach unter [http://localhost:3000](http://localhost:3000) erreichbar.

Beide Produktionsoberflächen lassen sich lokal separat prüfen:

```bash
npm run build:customer
npm run build:app
```

## Qualitätsprüfung

```bash
npm run lint
npm run build
```

Dieselben Prüfungen laufen bei jedem Push und Pull Request automatisch über GitHub Actions.

## Deployment

Der `main`-Branch ist die Grundlage für das spätere Vercel-Projekt. Vercel kann direkt mit diesem GitHub-Repository verbunden werden und veröffentlicht danach jeden geprüften Push automatisch. Zugangsdaten für SumUp, Anny oder Supabase-Serverfunktionen gehören ausschliesslich in die jeweiligen geschützten Umgebungsvariablen und niemals in das Repository.
