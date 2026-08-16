# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS/JS (vanilla ES modules), Supabase Realtime + postgres_changes, Leaflet.js maps, GitHub Pages hosting. No build tools, no framework.

## Users

~35 dorosłych gości na urodzinach Agi. Host (Mateusz) prowadzi grę z laptopa podłączonego do TV/projektora. Gracze dołączają przez QR kod na własnych telefonach (Android/iOS Chrome). Gracze nie są techniczni — interface musi być natychmiastowo zrozumiały bez instrukcji.

## Product Purpose

Multiplayer GeoGuesser na imprezę urodzinową Agi. Gracze zgadują gdzie zostały zrobione zdjęcia z życia Agi — pinezka na mapie, im bliżej prawdziwego miejsca tym więcej punktów. Host widzi postęp na dużym ekranie, gracze rywalizują w czasie rzeczywistym.

## Positioning

Spersonalizowana gra towarzyska z prawdziwymi zdjęciami Agi i miejscami z jej życia — nie jest to gotowy produkt ale jednorazowe przeżycie skrojone pod konkretną osobę i konkretne urodziny.

## Operating Context

- Impreza urodzinowa, ~35 osób, głośno, ciemno, alkohol
- Gracze trzymają telefony jedną ręką
- Host prowadzi grę z laptopa przy TV (1080p+)
- Jednorazowe użycie — musi zadziałać za pierwszym razem
- Połączenie: domowe WiFi lub dane mobilne graczy
- Czas trwania: ~10 pytań, ~20-30 minut łącznie

## Capabilities and Constraints

- Pytania: zdjęcia Agi z GPS EXIF → prepare-photos.js generuje questions.json
- Sesja jednorazowa: SESSION_ID generowany przy starcie host.html
- Supabase free tier: 200 concurrent Realtime connections (bezpieczny margines dla 35 osób)
- Brak backendu poza Supabase — wszystko client-side
- GitHub Pages: brak custom headers, cache busting przez ?v=N w script src
- Nie ma logowania, kont, persistencji między sesjami

## Brand Commitments

- Nazwa: **AGA TIMES GEOGUESSER** (niezmienna)
- Kolor przewodni: różowy `#e91e8c` (primary), fioletowy `#9c27b0`
- Tło: ciemne `#0d0d1a` — klimat nocnej imprezy
- Emoji 🎂 w logo — urodzinowy charakter
- Zdjęcia Agi jako content — nie stockowe grafiki
- Polski język interfejsu

## Evidence on Hand

- `photos/` — oryginalne zdjęcia Agi z GPS EXIF
- `questions.json` — wygenerowane pytania z lokalizacjami
- `assets/aga-login.jpg` — zdjęcie Agi na ekranie logowania

## Product Principles

1. **Działa raz, bezbłędnie** — impreza jest jednorazowa, nie ma drugiej szansy na debug na żywo
2. **Telefon jedną ręką** — każda interakcja gracza musi być możliwa kciukiem, bez precyzji
3. **TV wygląda jak show** — ekran hosta to spektakl dla całej sali, nie narzędzie administracyjne
4. **Aga w centrum** — każdy element interfejsu przypomina że to jej impreza i jej życie

## Accessibility & Inclusion

Duże przyciski, wysoki kontrast (ciemne tło + jasny tekst), timer zawsze widoczny. Brak wymagań WCAG — prywatna impreza.
