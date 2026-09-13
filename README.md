# Volta Pong Buchungssystem

Eigenständiges Buchungsportal für Volta Pong mit dynamischer Preisberechnung, acht automatisch zugeteilten Tischen, Extras, Rabattcodes und Adminbereich.

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

## Qualitätsprüfung

```bash
npm run lint
npm run build
```

Dieselben Prüfungen laufen bei jedem Push und Pull Request automatisch über GitHub Actions.

## Deployment

Der `main`-Branch ist die Grundlage für das spätere Vercel-Projekt. Vercel kann direkt mit diesem GitHub-Repository verbunden werden und veröffentlicht danach jeden geprüften Push automatisch. Zugangsdaten für SumUp, Anny oder Supabase-Serverfunktionen gehören ausschliesslich in die jeweiligen geschützten Umgebungsvariablen und niemals in das Repository.
