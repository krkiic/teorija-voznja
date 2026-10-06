# Vozački B kviz: teorijski ispit za vozačku (Srbija)

Lokalna aplikacija za učenje teorijskog dela vozačkog ispita. Pamti šta grešiš i to ti vraća dok ne naučiš, a simulacija ispita ide po istim kvotama kao pravi ispit.

Sve radi na tvom računaru: Python bez dodatnih paketa i jedan HTML fajl. Nema naloga ni baze, a napredak se čuva u `napredak.json` pored koda.

> ⚠️ **Nezvanično.** Aplikacija nije povezana sa MUP-om ni sa portalom eUprava. Tačne odgovore uvek proveri na zvaničnom portalu za vežbanje.

## Šta ume

- **Ponavljanje sa razmakom (Leitner kutije 0–5).** Pogrešan odgovor se vraća posle ~10 minuta. Kad ga pogodiš, razmak raste na 1, 2, 4 pa 7 dana. Tačno iz prve ide odmah u kutiju 3.
- **Lekcije redom kao na portalu**, ture od 15 pitanja. Greška se u istoj turi ponavlja dok je ne pogodiš.
- **„Nisam siguran"**: tačan odgovor na koji si pogađao se svejedno vraća sutra.
- **Simulacija ispita:** 41 pitanje, 45 minuta, 98–99 bodova po pravim kvotama po oblastima, prolaz od 85%. Sve greške iz simulacije idu u „Greške".
- **Šansa za prolaz:** Monte Carlo procena na 1500 simuliranih ispita iz tvojih odgovora, plus koliko bodova gubiš po oblasti.
- **Plan po danima** do datuma ispita, dnevni cilj novih pitanja i niz dana.
- Mapa lekcija, tamna tema i prečice na tastaturi (A–F ili 1–8 za odgovor, Enter dalje, Z uvećana slika, F zastavica u simulaciji, M zvuk).

## Pokretanje

Treba ti Python 3.8 ili noviji (na macOS-u i Linuxu je obično već tu).

```bash
python3 server.py
```

Otvoriće se `http://127.0.0.1:8777` u pregledaču. Server sluša samo na tvom računaru. Na macOS-u može i dupli klik na `Kviz.command`.

### Podešavanja

| promenljiva | primer | šta radi |
|---|---|---|
| `KVIZ_ISPIT` | `2026-11-20` | datum ispita: odbrojavanje i plan po danima (bez njega plan traje 14 dana) |
| `KVIZ_PORT` | `8790` | port (podrazumevano 8777) |
| `KVIZ_PODACI` | `~/drugi-skup` | folder sa `pitanja.json` i `slike/` (podrazumevano pored koda) |

```bash
KVIZ_ISPIT=2026-11-20 python3 server.py
```

### Iz terminala

`kviz.py` deli isti napredak sa aplikacijom:

```bash
python3 kviz.py daj 10          # sledećih 10 pitanja (prvo ponavljanja, pa nova)
python3 kviz.py odg "1:A 2:BC"  # odgovori na poslednju turu
python3 kviz.py stanje          # pregled po oblastima (piše i Napredak.md i Greske.md)
python3 kviz.py ispit           # 41 pitanje po kvotama
```

## Sajt (GitHub Pages)

Ista aplikacija radi i kao besplatan statički sajt na GitHub Pages: bez servera, a svu logiku (`app/kviz.js`, JavaScript verzija `kviz.py` i `server.py`) izvršava pregledač. Lokalni režim (`python3 server.py`) ostaje isti i dalje koristi `napredak.json`.

- **Napredak je u pregledaču.** Čuva se u `localStorage` na tom uređaju i nigde se ne šalje. Sajt je javan, ali svako ima svoj napredak. Ako obrišeš podatke sajta ili pređeš na drugi uređaj, napredak nestaje (Safari ga može obrisati i posle 7 dana bez posete sajtu), zato u „Postavke" (ikona na početnoj) postoje izvoz i uvoz `napredak.json`. Format je isti kao u lokalnoj aplikaciji, pa možeš da uvezeš i napredak sa računara. Tu se podešava i datum ispita (umesto `KVIZ_ISPIT`).
- **Uključivanje:** u repozitorijumu otvori Settings → Pages → Source: **GitHub Actions**, pa pushuj na `main` (ili pokreni ručno: Actions → Pages → Run workflow). Workflow `.github/workflows/pages.yml` pokreće `napravi_sajt.sh` i objavljuje sajt na `https://<korisnik>.github.io/<repo>/`.
- **Isprobaj lokalno:** `./napravi_sajt.sh` pravi folder `_site` sa samo `index.html`, `kviz.js`, `pitanja.json` i `slike/` (lični fajlovi kao `napredak.json` nikad ne ulaze), a `python3 -m http.server -d _site -b 127.0.0.1 8000` ga služi na `http://127.0.0.1:8000`.
- **Svoj domen:** Settings → Pages → Custom domain. Kod provajdera domena dodaj četiri A zapisa (`185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`) za koreni domen, ili CNAME na `<korisnik>.github.io` za poddomen (npr. `kviz.primer.rs`). Kad GitHub proveri DNS, uključi **Enforce HTTPS**. Ponude za domen navedene su na [education.github.com/pack](https://education.github.com/pack).
- **Pitanja i licenca:** MIT licenca važi samo za kod. Pitanja, odgovori i slike pripadaju MUP-u RS i na sajtu su samo radi učenja. Sajt je nezvaničan i nije povezan sa MUP-om ni sa eUpravom. Ako nosilac prava traži da se uklone, biće uklonjeni (vidi „Licenca").

## Pitanja

`pitanja.json` (1702 pitanja sa tačnim odgovorima) i `slike/` (828 slika) su zvanična pitanja za kategoriju B. Objavljuje ih MUP RS na portalu [iso.euprava.gov.rs](https://iso.euprava.gov.rs), u modulu za vežbanje kandidata. Preuzeta su septembra 2026. i prebačena u latinicu. Ako se pitanja na portalu promene, ovde mogu biti zastarela.

Novi izvoz sa portala (`pitanja_raw.json`, struktura `cats → subs → qs`) `napravi_pitanja.py` pretvara u format aplikacije:

```bash
python3 napravi_pitanja.py pitanja_raw.json            # pitanja.json + slike/
python3 napravi_pitanja.py pitanja_raw.json --beleske  # + Obsidian beleške po oblastima
```

Izvoz sa portala je vezan za tvoj kandidatski nalog, zato ga ne deli. `.gitignore` ga ne pušta u repo.

### Format `pitanja.json`

```json
[
  {
    "id": 7921,
    "oblast": "Osnove bezbednosti saobraćaja",
    "oblast_br": 1,
    "podoblast": "Osnovne odredbe i osnovna načela bezbednosti saobraćaja na putevima;",
    "tekst": "Tekst pitanja",
    "bodova": 2,
    "treba_zaokruziti": 1,
    "slika": "slike/7921.jpg",
    "odgovori": [
      {"id": 1, "tekst": "Odgovor", "tacno": true},
      {"id": 2, "tekst": "Odgovor", "tacno": false}
    ],
    "objasnjenje": null
  }
]
```

`oblast_br` mora da odgovara brojevima iz `KVOTA` u `kviz.py`. Tamo su kvote po oblastima na ispitu, izmerene na simulacijama sa portala (41 pitanje, 98–99 bodova). Slika nije obavezna (`null`).

## Fajlovi

| fajl | šta je |
|---|---|
| `server.py` | lokalni HTTP server i API (`/api/pocetna`, `/api/tura`, `/api/pregled`, `/api/odgovor`, `/api/ispit_rezultat`) |
| `kviz.py` | Leitner logika, kvote, plan i komande za terminal |
| `app/index.html` | ceo interfejs (vanilla JS/CSS, jedan fajl) |
| `app/kviz.js` | isti kviz u JavaScript-u za sajt bez servera (vidi „Sajt (GitHub Pages)") |
| `napravi_sajt.sh` | pravi `_site/` za GitHub Pages (samo dozvoljeni fajlovi) |
| `.github/workflows/pages.yml` | objavljuje sajt na GitHub Pages pri pushu na `main` |
| `napravi_pitanja.py` | izvoz sa portala → `pitanja.json` + `slike/` |
| `pitanja.json`, `slike/` | pitanja i slike (vidi „Pitanja") |
| `Kviz.command` | pokretač za macOS |

Interfejs učitava font sa Google Fonts (Google tada vidi IP adresu posetioca; na objavljenom sajtu IP adrese beleži i GitHub Pages). Bez interneta koristi sistemski font, a sve ostalo radi.

## Licenca

MIT licenca (`LICENSE`) važi **samo za kod**. Tekst pitanja, odgovori i slike pripadaju njihovom izdavaču (MUP RS) i ovde su samo radi učenja. Ako nosilac prava traži da se uklone, biće uklonjeni.

---

## English

Local study app for the Serbian driving theory exam (category B). It uses spaced repetition (Leitner boxes), goes lesson by lesson like the official portal, runs exam simulations with the real per-area quotas (41 questions, 45 min, 98–99 points, 85% to pass) and gives a Monte Carlo estimate of your chance to pass. It needs only Python 3.8+ with no dependencies: run `python3 server.py` and open `http://127.0.0.1:8777`. Your progress stays in `napredak.json` on your machine. It can also be published as a free static website on GitHub Pages, where progress is kept in the visitor's browser with export/import of `napredak.json` (see "Sajt (GitHub Pages)" above).

The repo includes the 1702 official questions and 828 images, downloaded in September 2026 from the Ministry of Interior's practice portal (iso.euprava.gov.rs) and transliterated to Latin script. The MIT license covers the code only. Questions and images belong to their publisher and will be removed on request. This is an unofficial project, not affiliated with the Ministry or eUprava.
