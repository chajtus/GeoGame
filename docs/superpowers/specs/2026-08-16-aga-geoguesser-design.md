# AGA TIMES GEOGUESSER — Specyfikacja projektu

**Data:** 2026-08-16  
**Okazja:** 30. urodziny Agi  
**Liczba graczy:** ~35 telefonów jednocześnie

---

## 1. Cel i opis gry

Multiplayer GeoGuesser na urodziny Agi. Na projektorze wyświetlane są zdjęcia z życia Agi (z metadanymi GPS). Gracze skanują QR kod telefonem i na mapie stawiają pinezkę — zgadują gdzie było zdjęcie. Im bliżej prawdziwej lokalizacji, tym więcej punktów. Klimat wizualny: fioletowo-różowy dark theme inspirowany "AGA TIMES" — specjalnym magazynem urodzinowym.

---

## 2. Stack technologiczny

| Warstwa | Technologia |
|---|---|
| Frontend (host + gracz) | Vanilla HTML/CSS/JS (statyczny) |
| Hosting frontendu | GitHub Pages |
| Real-time (eventy, timer, sync) | Supabase Realtime (WebSocket broadcast) |
| Baza danych (gracze, wyniki, piny) | Supabase PostgreSQL |
| Przechowywanie zdjęć i video | Supabase Storage |
| Mapa (telefon gracza) | Leaflet.js + Mapbox Dark tiles |
| Mapa (wyniki na projektorze) | Leaflet.js + Mapbox Dark tiles |
| Ekstrakcja GPS ze zdjęć | Lokalny skrypt Node.js (pre-party) |
| Reverse geocoding (nazwa miejsca) | Nominatim API (OpenStreetMap, darmowy) |

---

## 3. Architektura systemu

```
[Skrypt Node.js] → EXIF GPS extract → JSON config + upload do Supabase Storage
                                                        ↓
[GitHub Pages]  ←→  Supabase Realtime  ←→  [Telefony graczy]
  host.html           (broadcast)            player.html
  (projektor)       Supabase DB              (iPhone portrait)
                   (wyniki, piny)
```

### Dwa widoki aplikacji

- **`/host`** — ekran na laptopie/projektorze, kontrolowany przez gospodarza
- **`/player`** — ekran na telefonie, otwierany przez QR kod

### Przepływ danych

1. Host startuje grę → Supabase broadcast `game:start`
2. Gracz stawia pinezkę → zapis do `pins` table w Supabase DB
3. Timer wybucha / host kończy → broadcast `round:end`
4. Host panel pobiera wszystkie piny, renderuje mapę wyników
5. Host klika "Następne" → broadcast `round:next`

---

## 4. Przygotowanie zdjęć (pre-party)

Lokalny skrypt `prepare-photos.js` (Node.js):

1. Skanuje folder `photos/` w poszukiwaniu plików jpg/jpeg/png
2. Wyciąga GPS z metadanych EXIF (`exifr` library)
3. Wywołuje Nominatim reverse geocoding → nazwa miejsca (np. "Fushimi Inari, Kioto, Japonia")
4. Uploaduje zdjęcia do Supabase Storage bucket `photos`
5. Generuje `questions.json` z listą pytań: `{ id, photo_url, lat, lng, location_name }`
6. Plik `questions.json` trafia do repozytorium → deploy na GitHub Pages

Wymaganie: zdjęcia muszą mieć GPS w EXIF (zdjęcia z telefonu standardowo mają).

---

## 5. Baza danych Supabase

### Tabele

```sql
-- Gracze w sesji
players (
  id uuid PRIMARY KEY,
  session_id text,
  name text,
  avatar_data_url text,  -- base64 selfie lub null
  initials text,
  total_score integer DEFAULT 0,
  joined_at timestamp
)

-- Piny stawiane przez graczy
pins (
  id uuid PRIMARY KEY,
  session_id text,
  player_id uuid REFERENCES players(id),
  question_index integer,
  lat float,
  lng float,
  distance_km float,
  points integer,
  submitted_at timestamp
)

-- Stan gry (jedna sesja na raz)
game_state (
  session_id text PRIMARY KEY,
  current_question integer DEFAULT 0,
  total_questions integer,
  phase text,  -- 'lobby' | 'playing' | 'results' | 'leaderboard' | 'finished'
  round_started_at timestamp,
  round_duration_seconds integer DEFAULT 30
)
```

---

## 6. Ekrany — widok hosta (projektor Full HD)

### 6.1 Lobby

- Duży QR kod do zeskanowania przez graczy
- Lista dołączających graczy (avatary + imiona) aktualizowana real-time
- Przycisk "START GRY" (aktywny gdy ≥2 graczy)

### 6.2 Runda — w trakcie

- **Top bar:** logo "AGA TIMES GEOGUESSER", numer rundy, liczba odpowiedzi
- **Centrum:** zdjęcie Agi na pełną szerokość
- **Prawy górny róg:** półprzezroczysty panel TOP 5 (aktualizowany live)
- **Lewy dolny róg:** licznik `X/35 pinezek postawionych`
- **Bottom bar:** timer (duże cyfry, pasek postępu), przyciski: ⏸ PAUZA / +30s / ⏹ ZAKOŃCZ RUNDĘ / ▶ NASTĘPNE

### 6.3 Wyniki rundy

- **Top bar:** "WYNIKI — RUNDA X/Y"
- **Centrum:** mapa Leaflet/Mapbox Dark, pełna szerokość
  - Duża różowa gwiazdka = prawdziwa lokalizacja (z EXIF)
  - Etykieta na górze: "📍 [Nazwa miejsca z reverse geocodingu]"
  - Avatary graczy jako pinezki (kółka z selfie lub inicjałami)
  - Podpis przy każdym: imię + odległość w km
  - Przerywane linie Leaflet polyline łączące każdy pin z prawdziwym miejscem
- **Panel prawy (200px):** punkty za tę rundę z avatarami
- **Bottom bar:** info o pliku + przycisk "▶ NASTĘPNE PYTANIE"

### 6.4 Leaderboard (co 5 pytań)

- **Podium TOP 3:** avatary z koroną (1.), złoto/srebro/brąz, imię, suma punktów, słupki podium
- **Siatka 2-kolumnowa miejsc 4+:** avatar, imię, punkty, ikona ▲▼ zmiany pozycji
- **Bottom bar:** legenda ▲▼ + przycisk "▶ PYTANIE X"

### 6.5 Ekran końcowy

- Leaderboard finalny (jak 6.4)
- Autoplay video Majusi bijącej brawo dla zwycięzcy (plik mp4 w Supabase Storage)
- Konfetti animacja (canvas-confetti library)

---

## 7. Ekrany — widok gracza (iPhone portrait)

### 7.1 Logowanie (po QR)

- Logo "🎂 AGA TIMES GEOGUESSER"
- Obszar avatara:
  - Przycisk "📸 ZRÓB SELFIE" → `getUserMedia({ video: { facingMode: 'user' } })` → canvas capture → base64
  - Przycisk "pomiń →" → avatar z inicjałami (2 litery imienia, losowy kolor tła)
  - Po selfie: podgląd + "📸 zrób ponownie"
- Pole tekstowe: imię gracza
- Losowy "💡 AGA FACT" z puli ~30 faktów z AGA TIMES
- Przycisk "DOŁĄCZ DO GRY 🎮" (aktywny po wpisaniu imienia)

### 7.2 Oczekiwanie

- Animacja ładowania
- "Czekamy na start gry..."
- Wyświetlony avatar i imię gracza (potwierdzenie)

### 7.3 Mapa — w trakcie rundy

- **Top bar:** numer rundy, timer (zsynchronizowany z hostem), imię lidera
- **Centrum (cały ekran):** mapa Leaflet + Mapbox Dark
  - Tap = stawia/przesuwa pinezkę gracza
  - Komunikat "Dotknij aby postawić pinezkę"
- **Bottom:** przycisk "✅ ZATWIERDŹ ODPOWIEDŹ" (po zatwierdzeniu: "Odpowiedź wysłana ✓", przycisk nieaktywny)

### 7.4 Oczekiwanie po odpowiedzi

- "Czekamy na pozostałych graczy..."
- Licznik ilu już odpowiedziało

---

## 8. Logika punktacji

- Maksymalnie **5000 punktów** za pytanie
- Formuła: `points = max(0, 5000 - distance_km * 2)`
  - 0 km = 5000 pkt
  - 2500 km = 0 pkt
  - Powyżej 2500 km = 0 pkt (nie ma punktów ujemnych)

---

## 9. Leaderboard — harmonogram

- Leaderboard wyświetlany **po pytaniu 5, 10, 15, 20, 25...**
- Jeśli liczba pytań jest wielokrotnością 5 (np. 20 pytań) → leaderboard po pytaniu 20 jest leaderboardem finalnym (bez osobnego ekranu końcowego pośredniego)
- Leaderboard finalny zawsze wyświetlany po ostatnim pytaniu niezależnie od liczby

---

## 10. AGA FACTS — pula

~30 losowych faktów z pliku `aga_times_30.md`, np.:
- "Aga grała na skrzypcach i pamięta piosenkę o śmieciarkach Remondis Sanitech."
- "Zaręczyny Agi odbyły się na Etnie."
- "Aga mieszkała na Piątkowie, Morasku i w centrum Poznania."
- "Aga podróżowała do Japonii, Tajlandii, USA i Nowego Jorku."
- itd.

Fakty przechowywane w `src/aga-facts.js` jako tablica stringów.

---

## 11. Materiały do dostarczenia

| Materiał | Format | Uwagi |
|---|---|---|
| Zdjęcia do gry | JPG/JPEG z GPS w EXIF | Zdjęcia z telefonu standardowo mają GPS |
| Zdjęcie Agi na ekran logowania | JPG/PNG | Twarz Agi jako avatar na stronie logowania |
| Video Majusi | MP4 | Krótki klip z Mają bijącą brawo — wyświetlany po wygranej |

---

## 12. Środowisko i deploy

- **Repozytorium:** GitHub (publiczne lub prywatne)
- **Hosting:** GitHub Pages (branch `gh-pages` lub folder `/docs`)
- **Supabase:** darmowy projekt, region EU
- **Mapbox:** darmowe konto, token publiczny (read-only, zakres: `styles:read`, `tiles:read`)
- **Deploy:** `git push` → GitHub Actions automatycznie deployuje na GitHub Pages

---

## 13. Struktura plików projektu

```
GeoGame/
├── src/
│   ├── host.html          # Ekran hosta (projektor)
│   ├── player.html        # Ekran gracza (telefon)
│   ├── host.js            # Logika hosta
│   ├── player.js          # Logika gracza
│   ├── supabase.js        # Klient Supabase + channel setup
│   ├── map.js             # Leaflet/Mapbox helpers (wspólne)
│   ├── scoring.js         # Funkcja obliczania punktów
│   └── aga-facts.js       # Tablica AGA FACTS
├── scripts/
│   └── prepare-photos.js  # Skrypt pre-party (EXIF → JSON + upload)
├── photos/                # Tu wrzucasz zdjęcia przed uruchomieniem skryptu
├── public/
│   └── questions.json     # Wygenerowany przez skrypt, deploy na GH Pages
└── docs/
    └── superpowers/specs/
        └── 2026-08-16-aga-geoguesser-design.md
```
