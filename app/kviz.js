/* Vozački B kviz bez servera: JS port logike iz kviz.py i server.py (GitHub Pages / statički režim).
 *
 *   createKviz({ pitanja, storage, now, random })
 *     -> { api(url, body), getIspit(), setIspit(iso|null), izvezi(), uvezi(tekst), reset() }
 *
 * api() vraća Promise sa istim JSON-om kao server.py za /api/tura, /api/odgovor, /api/pocetna,
 * /api/pregled i /api/ispit_rezultat (nepoznata putanja ili loš zahtev = odbijeni Promise sa .status).
 * Napredak je u storage-u pod „kviz.napredak“, u istom formatu kao napredak.json (pa se može uvoziti i
 * izvoziti sa Mac aplikacije). Datum ispita je pod „kviz.ispit“ i igra ulogu KVIZ_ISPIT iz kviz.py.
 *
 * Namerna odstupanja od Pythona:
 *  - Monte Carlo (šansa za prolaz) koristi mulberry32(7) umesto random.Random(7): stabilno je između
 *    poziva, ali nije isti niz brojeva, pa se sansa_prolaz i ocekivano mogu razlikovati za poneki procenat.
 *  - Izjednačenja u režimu „greske“ (Python se oslanja na redosled ključeva u rečniku) razrešavaju se
 *    rastućim id-jem pitanja. Ostala sortiranja su ista kao u Pythonu (dospela() poredi ključ kao string).
 *  - Ne piše se Napredak.md / Greske.md (nema fajlova u pregledaču), niti polje „tura“ (ni server ga ne piše).
 *  - Zapisi za nepoznat id pitanja (npr. uvezeno iz druge verzije pitanja.json) se preskaču umesto KeyError.
 *  - Oštećen napredak u storage-u se kopira u „kviz.napredak.ostecen“ pa se kreće iz početka.
 *  - now() se poziva jednom po api() pozivu; DANAS, „zadnje“ i razmak od 10 minuta računaju se iz tog trenutka.
 *
 * U pregledaču (<meta name="kviz-backend" content="static">) na dnu fajla postavlja window.KVIZ_MODE,
 * window.KVIZ_READY (Promise) i window.KVIZ; window.KVIZ_STORAGE je "local" ili "memorija" (privatan prozor).
 */
(function (global) {
"use strict";

const KLJUC = "kviz.napredak", KLJUC_OSTECEN = "kviz.napredak.ostecen", KLJUC_ISPIT = "kviz.ispit";
const INTERVAL = {1: 0, 2: 1, 3: 2, 4: 4, 5: 7};
// Kvote po oblasti na ispitu; niz parova jer bi objekat celobrojne ključeve poređao rastuće (redosled menja slučajne brojeve)
const KVOTA = [[6, 18], [8, 13], [10, 2], [5, 2], [11, 1], [4, 1], [12, 1], [9, 1], [1, 1], [2, 1]];
const KVOTA_OD = new Map(KVOTA);
// Procena verovatnoće tačnog odgovora po kutiji (Leitner); neviđena pitanja = tvoja tačnost iz prve
const P_KUTIJA = {5: .97, 4: .94, 3: .88, 2: .78, 1: .45};
// Dan pred ispit: Dozvole, Dužnosti, Signalizacija, pa ostatak Pravila; Posledice poslednje
const PRVO = [1, 2, 4, 5, 10, 11, 8, 6, 9, 12, 14];
const N_SIM = 1500;
const DAN_MS = 864e5;


// ---------- pomoćne funkcije (Python semantika) ----------

const dv = n => (n < 10 ? "0" : "") + n;

// Lokalni datum/vreme kao date.today() i datetime.now().isoformat(timespec=...); nikad toISOString() (to je UTC)
function isoDatum(d) {
  return String(d.getFullYear()).padStart(4, "0") + "-" + dv(d.getMonth() + 1) + "-" + dv(d.getDate());
}
function isoVreme(d, sekunde) {
  return isoDatum(d) + "T" + dv(d.getHours()) + ":" + dv(d.getMinutes()) + (sekunde ? ":" + dv(d.getSeconds()) : "");
}

// Vreme pre `min` minuta, računato na „zidnom“ satu kao naivni datetime u Pythonu (letnje računanje vremena ne utiče)
function pre(d, min) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() - min, d.getSeconds()));
  return String(t.getUTCFullYear()).padStart(4, "0") + "-" + dv(t.getUTCMonth() + 1) + "-" + dv(t.getUTCDate()) + "T" +
         dv(t.getUTCHours()) + ":" + dv(t.getUTCMinutes()) + ":" + dv(t.getUTCSeconds());
}

// Računanje sa datumima (YYYY-MM-DD) preko UTC ponoći, pa letnje računanje vremena ne utiče
const utc = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
function dodajDane(iso, n) {
  const t = new Date(utc(iso) + n * DAN_MS);
  return String(t.getUTCFullYear()).padStart(4, "0") + "-" + dv(t.getUTCMonth() + 1) + "-" + dv(t.getUTCDate());
}
const razlikaDana = (a, b) => Math.round((utc(b) - utc(a)) / DAN_MS);   // (b - a).days
// Ispravan datum YYYY-MM-DD (kao date.fromisoformat), bez pravljenja Date objekta jer se proverava svaki zapis istorije
function jeDatum(s) {
  const m = typeof s === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const g = +m[1], mes = +m[2], dan = +m[3];
  const prestupna = (g % 4 === 0 && g % 100 !== 0) || g % 400 === 0;
  const max = mes === 2 ? (prestupna ? 29 : 28) : (mes === 4 || mes === 6 || mes === 9 || mes === 11) ? 30 : 31;
  return g >= 1 && mes >= 1 && mes <= 12 && dan >= 1 && dan <= max;
}

// Celobrojno deljenje kao u Pythonu (b > 0): a // b i -(-a // b) = zaokruživanje naviše
const podeliDole = (a, b) => (a - (((a % b) + b) % b)) / b + 0;
const podeliGore = (a, b) => -podeliDole(-a, b) + 0;

// round(x): .5 ide na parni (Math.round ide uvek naviše)
function pyRound(x) {
  const f = Math.floor(x), r = x - f;
  return (r < .5 ? f : r > .5 ? f + 1 : (f % 2 === 0 ? f : f + 1)) + 0;
}
// round(x, 1): toFixed gleda tačnu binarnu vrednost kao Python; tačne polovine (0.25, 0.75...) idu na parnu cifru
function pyRound1(x) {
  const t = x * 4;
  if (Number.isInteger(t) && Math.abs(t) % 2 === 1) return pyRound(x * 10) / 10;
  return Number(x.toFixed(1));
}
// sum() nad float-ovima: Python 3.12+ sabira Neumaier-ovom kompenzacijom
function pySuma(niz) {
  let s = 0, c = 0;
  for (const x of niz) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return s + c;
}
// Istinitost kao u Pythonu: prazan niz i prazan objekat su netačni
function istina(x) {
  if (Array.isArray(x)) return x.length > 0;
  if (x !== null && typeof x === "object") return Object.keys(x).length > 0;
  return !!x;
}
const poredi = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ima = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const jeObjekat = x => x !== null && typeof x === "object" && !Array.isArray(x);

function greska(status, poruka) {
  const e = new Error(poruka);
  e.status = status;
  return e;
}

// Mali seedovani PRNG (random.Random(7) se ne može ponoviti bit po bit)
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// random.shuffle: Fisher–Yates u mestu
function promesaj(niz, rnd) {
  for (let i = niz.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = niz[i]; niz[i] = niz[j]; niz[j] = t;
  }
  return niz;
}
// random.sample: prvih k mesta Fisher–Yates mešanja bez kopiranja niza (zamene čuva u Map-i)
function uzorak(niz, k, rnd) {
  const n = niz.length, zam = new Map(), out = [];
  const at = i => (zam.has(i) ? zam.get(i) : niz[i]);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    const vj = at(j);
    zam.set(j, at(i));
    out.push(vj);
  }
  return out;
}

// Putanja i parametri iz "/api/tura?n=10&rezim=lekcija&l=3"; kao parse_qs prazne vrednosti se preskaču
function razlozi(url) {
  const u = new URL(String(url), "http://kviz.local/");
  return {
    putanja: u.pathname,
    param(ime, def) { const v = u.searchParams.getAll(ime).find(x => x !== ""); return v === undefined ? def : v; },
  };
}
function cele(x, ime) {
  const t = String(x).trim();
  if (typeof x === "number" && Number.isFinite(x)) return Math.trunc(x);
  if (!/^[+-]?\d+$/.test(t)) throw greska(400, `Neispravan broj (${ime}): ${t}`);
  return parseInt(t, 10);
}


// ---------- provera i čišćenje napredak.json ----------

const prazno = () => ({pitanja: {}, tura: [], dnevnik: []});

// Vraća opis greške ili null; dozvoljava sve što kviz.py ume da napiše (polja koja fale se popune posle)
function proveri(st) {
  if (!jeObjekat(st)) return "očekivan je JSON objekat";
  if (!jeObjekat(st.pitanja)) return "nedostaje objekat „pitanja“";
  for (const k of ["tura", "dnevnik", "ispiti"]) if (st[k] !== undefined && !Array.isArray(st[k])) return `„${k}“ mora biti niz`;
  if (st.spremnost !== undefined && !jeObjekat(st.spremnost)) return "„spremnost“ mora biti objekat";
  if (st.spremnost && Object.values(st.spremnost).some(v => typeof v !== "number" || !Number.isFinite(v))) return "„spremnost“ sme da sadrži samo brojeve";
  if (st.ispiti && st.ispiti.some(e => !jeObjekat(e))) return "„ispiti“ mora biti niz objekata";
  for (const [k, v] of Object.entries(st.pitanja)) {
    const gde = `pitanje ${k}`;
    if (!/^\d+$/.test(k) || !jeObjekat(v)) return `neispravan zapis (${gde})`;
    if (v.kutija !== undefined && !(Number.isInteger(v.kutija) && v.kutija >= 0 && v.kutija <= 5)) return `kutija mora biti 0–5 (${gde})`;
    for (const f of ["tacno", "netacno"]) {
      if (v[f] !== undefined && !(Number.isInteger(v[f]) && v[f] >= 0)) return `„${f}“ mora biti ceo broj (${gde})`;
    }
    if (v.sledece !== undefined && v.sledece !== null && typeof v.sledece !== "string") return `neispravno „sledece“ (${gde})`;
    if (v.zadnje !== undefined && typeof v.zadnje !== "string") return `neispravno „zadnje“ (${gde})`;
    if (v.istorija !== undefined) {
      if (!Array.isArray(v.istorija)) return `„istorija“ mora biti niz (${gde})`;
      for (const h of v.istorija) {
        if (!Array.isArray(h) || h.length < 2 || !jeDatum(h[0]) || (h[1] !== "T" && h[1] !== "N")) return `neispravna istorija (${gde})`;
      }
    }
  }
  return null;
}

// Dopuni polja koja fale, kao p() u kviz.py (prazan zapis i nepostojeći zapis ponašaju se isto)
function srediStanje(st) {
  if (!Array.isArray(st.tura)) st.tura = [];
  if (!Array.isArray(st.dnevnik)) st.dnevnik = [];
  for (const v of Object.values(st.pitanja)) {
    if (v.kutija === undefined) v.kutija = 0;
    if (v.tacno === undefined) v.tacno = 0;
    if (v.netacno === undefined) v.netacno = 0;
    if (v.sledece === undefined) v.sledece = null;
    if (v.istorija === undefined) v.istorija = [];
  }
  return st;
}


// ---------- kviz ----------

function createKviz(opcije) {
  const sva = opcije && opcije.pitanja, storage = opcije && opcije.storage;
  const now = opcije.now || (() => new Date()), random = opcije.random || Math.random;
  if (!Array.isArray(sva) || !sva.length) throw new TypeError("createKviz: pitanja moraju biti neprazan niz");
  if (!storage) throw new TypeError("createKviz: nedostaje storage");

  // Q, PORTAL i PO_OBL iz kviz.py / server.py (Map čuva redosled umetanja kao Python rečnik)
  const Q = new Map(), PORTAL = new Map(), PO_OBL = new Map();
  sva.forEach((q, i) => { Q.set(q.id, q); PORTAL.set(q.id, i); });
  for (const q of Q.values()) {
    if (!PO_OBL.has(q.oblast_br)) PO_OBL.set(q.oblast_br, []);
    PO_OBL.get(q.oblast_br).push(q.id);
  }
  const OBLASTI = [...new Set(sva.map(q => q.oblast_br))].sort((a, b) => a - b);

  // REDOSLED, redosled novih pitanja i lekcije zavise samo od toga da li je dan pred ispit: dve varijante
  const varijante = {};
  function varijanta(pred) {
    const kljuc = pred ? "pred" : "obicno";
    if (varijante[kljuc]) return varijante[kljuc];
    const redosled = pred ? PRVO.filter(o => OBLASTI.includes(o)).concat(OBLASTI.filter(o => !PRVO.includes(o))) : OBLASTI;
    const idx = new Map(redosled.map((o, i) => [o, i]));
    const mesto = q => (idx.has(q.oblast_br) ? idx.get(q.oblast_br) : 99);
    // redosled lekcija kao na portalu = redosled u pitanja.json
    const red = [...Q.values()].sort((a, b) => (mesto(a) - mesto(b)) || (PORTAL.get(a.id) - PORTAL.get(b.id))).map(q => q.id);
    const lekcije = [], lekcijaOd = new Map();
    for (const id of red) {
      const q = Q.get(id), z = lekcije[lekcije.length - 1];
      if (!z || z.podoblast !== q.podoblast) lekcije.push({ob: q.oblast_br, oblast: q.oblast, podoblast: q.podoblast, ids: []});
      lekcije[lekcije.length - 1].ids.push(id);
    }
    lekcije.forEach((l, i) => l.ids.forEach(id => lekcijaOd.set(id, i)));
    return (varijante[kljuc] = {redosled, red, lekcije, lekcijaOd});
  }

  // --- storage ---

  function ucitaj() {
    let sirovo = null;
    try { sirovo = storage.getItem(KLJUC); } catch (e) { /* nedostupan storage = prazan napredak */ }
    if (sirovo === null || sirovo === undefined || sirovo === "") return prazno();
    let st = null, g = null;
    try { st = JSON.parse(sirovo); g = proveri(st); } catch (e) { g = "nije JSON"; }
    if (g) {
      try { storage.setItem(KLJUC_OSTECEN, sirovo); } catch (e) { /* nema mesta */ }
      return prazno();
    }
    return srediStanje(st);
  }
  const sacuvaj = st => storage.setItem(KLJUC, JSON.stringify(st));

  function getIspit() {
    let s = null;
    try { s = storage.getItem(KLJUC_ISPIT); } catch (e) { /* bez datuma */ }
    return jeDatum(s) ? s : null;
  }
  // true ako je sačuvano/obrisano, false ako datum nije ispravan (YYYY-MM-DD)
  function setIspit(iso) {
    if (iso === null || iso === undefined || iso === "") { storage.removeItem(KLJUC_ISPIT); return true; }
    if (!jeDatum(iso)) return false;
    storage.setItem(KLJUC_ISPIT, iso);
    return true;
  }

  // Sve što je u Pythonu globalno (st, DANAS, ISPIT, DAN_PRED_ISPIT, pred_ispit()) računa se iznova na svaki poziv
  function kontekst() {
    const sada = new Date(now());
    const danas = isoDatum(sada), ispit = getIspit();
    const danPred = ispit ? dodajDane(ispit, -1) : null;
    const pred = danPred !== null && danas >= danPred;
    return {sada, danas, ispit, danPred, pred, v: varijanta(pred), st: ucitaj()};
  }

  // --- kviz.py ---

  function p(c, id) {
    const k = String(id);
    return c.st.pitanja[k] || (c.st.pitanja[k] = {kutija: 0, tacno: 0, netacno: 0, sledece: null, istorija: []});
  }

  function dospela(c, razmakMin) {
    // greška se vraća tek posle ~10 min (ne odmah u sledećoj turi); poređenje „zadnje“ je tekstualno
    const granica = pre(c.sada, razmakMin === undefined ? 10 : razmakMin);
    const out = [];
    for (const [k, v] of Object.entries(c.st.pitanja)) {
      if (v.kutija >= 1 && v.kutija <= 4 && v.sledece && v.sledece <= c.danas && (v.zadnje || "") <= granica) {
        const q = Q.get(Number(k));
        if (q) out.push([v.kutija, -q.bodova, k]);
      }
    }
    // Python sortira (kutija, -bodova), pa ključ kao STRING
    out.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || poredi(a[2], b[2]));
    return out.map(x => Number(x[2]));
  }

  function nova(c, oblast) {
    return c.v.red.filter(id => {
      const s = c.st.pitanja[String(id)];
      return (!s || (s.kutija === 0 && s.istorija.length === 0)) && (oblast == null || Q.get(id).oblast_br === oblast);
    });
  }

  function oceni(c, qid, izabrani, zapis, nesiguran) {
    // izabrani = Set id-jeva odgovora; nesiguran: tačno ali pogađao -> kutija 2, zapis sa „?“
    const q = Q.get(qid);
    const tacni = new Set(q.odgovori.filter(o => o.tacno).map(o => o.id));
    const ok = izabrani.size === tacni.size && [...izabrani].every(x => tacni.has(x));
    const s = p(c, qid);
    const bilaNova = s.istorija.length === 0;
    s.istorija.push([c.danas, ok ? "T" : "N", (nesiguran ? "? " : "") + zapis]);
    s.zadnje = isoVreme(c.sada, true);
    if (ok) {
      s.tacno += 1;
      s.kutija = nesiguran ? 2 : (bilaNova ? 3 : Math.min(5, s.kutija + 1));
    } else {
      s.netacno += 1;
      s.kutija = 1;
    }
    s.sledece = dodajDane(c.danas, INTERVAL[s.kutija]);
    return ok;
  }

  function sledeca(c, n, oblast, samoNova, samoPon) {
    let ids = samoNova ? [] : dospela(c).filter(i => oblast == null || Q.get(i).oblast_br === oblast);
    if (c.pred && !samoPon) {
      // dan pred ispit: ponavljaj samo slabe (kutija 1–2); dobro naučena ne troše vreme novom gradivu
      ids = ids.filter(i => c.st.pitanja[String(i)].kutija <= 2);
    }
    if (!samoPon) ids = ids.concat(nova(c, oblast));
    return ids.slice(0, n);
  }

  // (početak, kraj) plana učenja: od prvog odgovora do dana pred ispit; bez datuma ispita 14 dana
  function plan(c) {
    let od = null;
    for (const v of Object.values(c.st.pitanja)) {
      if (v.istorija.length && (od === null || v.istorija[0][0] < od)) od = v.istorija[0][0];
    }
    if (od === null) od = c.danas;
    const kraj = c.danPred !== null ? c.danPred : dodajDane(od, 14);
    return [od, kraj > od ? kraj : od];
  }

  function pregledPodaci(c) {
    const d = c.danas, vals = Object.values(c.st.pitanja);
    let preDanas = 0, danasNovih = 0, tacnoDanas = 0, odgDanas = 0, tacnoSve = 0, odgSve = 0, pogresnih = 0;
    for (const v of vals) {
      if (v.istorija.length) {
        const x = v.istorija[0][0];
        if (x < d) preDanas++; else if (x === d) danasNovih++;
      }
      for (const h of v.istorija) {
        odgSve++;
        if (h[1] === "T") tacnoSve++;
        if (h[0] === d) { odgDanas++; if (h[1] === "T") tacnoDanas++; }
      }
      if (v.kutija === 1) pogresnih++;
    }
    // zaostatak se ravnomerno deli na preostale dane plana (ne gomila se sve na danas)
    const daniOstalo = Math.max(razlikaDana(d, plan(c)[1]), 1);
    let ciljDanas = podeliGore(Q.size - preDanas, daniOstalo);
    if (c.pred) {  // realan cilj za poslednji dan: Dozvole + Dužnosti + Signalizacija
      let nevidjenih = 0;
      for (const q of Q.values()) {
        if ((q.oblast_br === 10 || q.oblast_br === 11 || q.oblast_br === 8) && !istina((c.st.pitanja[String(q.id)] || {}).istorija)) nevidjenih++;
      }
      ciljDanas = danasNovih + nevidjenih;
    }
    return {danas_novih: danasNovih, cilj_danas: ciljDanas, ostalo_danas: Math.max(ciljDanas - danasNovih, 0),
            ponavljanja: dospela(c, 0).filter(i => !c.pred || c.st.pitanja[String(i)].kutija <= 2).length,
            vidjeno: preDanas + danasNovih, ukupno: Q.size,
            tacno_danas: tacnoDanas, odg_danas: odgDanas, tacno_sve: tacnoSve, odg_sve: odgSve,
            pogresnih, dana_ostalo: daniOstalo};
  }

  // --- server.py ---

  function pocetna(c) {
    const P = c.st.pitanja, danas = c.danas;
    const vid = new Set(Object.keys(P).filter(k => P[k].istorija.length));
    const prviT = [...vid].filter(k => P[k].istorija[0][1] === "T").length;
    const pNovo = Math.min(Math.max((prviT + 7) / (vid.size + 10), .5), .9);
    const pr = new Map();
    for (const id of Q.keys()) {
      const k = String(id), pk = vid.has(k) ? P_KUTIJA[P[k].kutija] : undefined;
      pr.set(id, pk !== undefined ? pk : pNovo);
    }

    // simulacija ispita po pravim kvotama -> šansa za prolaz (≥85% bodova)
    const rnd = mulberry32(7);
    let prosao = 0, zbir = 0;
    for (let t = 0; t < N_SIM; t++) {
      let bod = 0, mx = 0;
      for (const [ob, k] of KVOTA) {
        const sve = PO_OBL.get(ob) || [];
        for (const qid of uzorak(sve, Math.min(k, sve.length), rnd)) {
          const b = Q.get(qid).bodova;
          mx += b;
          if (rnd() < pr.get(qid)) bod += b;
        }
      }
      zbir += bod / mx;
      if (bod >= podeliGore(85 * mx, 100)) prosao++;
    }

    // istorija po danu
    const ist = new Map();
    for (const k of vid) {
      P[k].istorija.forEach((h, j) => {
        let x = ist.get(h[0]);
        if (!x) ist.set(h[0], x = {dan: h[0], odg: 0, tacno: 0, novih: 0});
        x.odg += 1;
        if (h[1] === "T") x.tacno += 1;
        if (j === 0) x.novih += 1;
      });
    }
    // niz dana (streak): uzastopni dani sa bar jednim odgovorom; današnji ne prekida niz dok se ne završi
    let niz = 0, d = ist.has(danas) ? danas : dodajDane(danas, -1);
    while (ist.has(d)) { niz++; d = dodajDane(d, -1); }

    const oblasti = [];
    for (const ob of c.v.redosled) {
      const ids = PO_OBL.get(ob);
      const vIds = ids.filter(i => vid.has(String(i)));
      const posl = vIds.map(i => { const h = P[String(i)].istorija; return h[h.length - 1][1]; });
      oblasti.push({br: ob, ime: Q.get(ids[0]).oblast, kvota: KVOTA_OD.get(ob) || 0, ukupno: ids.length,
                    vidjeno: vIds.length, savladano: vIds.filter(i => P[String(i)].kutija >= 3).length,
                    tacnost: posl.length ? pyRound(100 * posl.filter(x => x === "T").length / posl.length) : null,
                    spremnost: pyRound(100 * pySuma(ids.map(i => pr.get(i))) / ids.length)});
    }
    const lekcije = [];
    let trenutna = null;
    c.v.lekcije.forEach((l, i) => {
      const vIds = l.ids.filter(q => vid.has(String(q)));
      if (trenutna === null && vIds.length < l.ids.length) trenutna = i;
      lekcije.push({i, oblast: l.oblast, ime: l.podoblast.replace(/;+$/, ""), ukupno: l.ids.length, vidjeno: vIds.length,
                    savladano: vIds.filter(q => P[String(q)].kutija >= 3).length,
                    greske: vIds.filter(q => P[String(q)].kutija === 1).length});
    });
    // izgubljeni bodovi po oblasti na ispitu (budžet ~14) = kvota × prosek(bodova × (1−p))
    for (const o of oblasti) {
      const ids = PO_OBL.get(o.br);
      o.gubitak = pyRound1(o.kvota * pySuma(ids.map(i => Q.get(i).bodova * (1 - pr.get(i)))) / ids.length);
    }
    // dnevni snimak šanse -> „+4 od juče“
    const sansa = pyRound(100 * prosao / N_SIM);
    if (!c.st.spremnost) c.st.spremnost = {};
    c.st.spremnost[danas] = sansa;
    const pre = Object.keys(c.st.spremnost).filter(k => k < danas).sort().map(k => c.st.spremnost[k]);
    sacuvaj(c.st);

    // tačke po danu plana: 0 ništa · 1 radio · 2 ispunio cilj (≥ ravnomerni deo); najviše 21 tačka
    const [od, kraj] = plan(c);
    const ciljDan = podeliGore(Q.size, Math.max(razlikaDana(od, kraj), 1));
    const a = dodajDane(danas, -10), b = dodajDane(kraj, -20);
    const prvi = [od, a < b ? a : b].reduce((x, y) => (x > y ? x : y));
    const tacke = [];
    for (let k = 0, n = razlikaDana(prvi, kraj) + 1; k < n; k++) {
      const dd = dodajDane(prvi, k), x = ist.get(dd);
      tacke.push({dan: dd, stanje: !x ? 0 : ((x.novih >= ciljDan || (dd === kraj && x.odg >= 41)) ? 2 : 1)});
    }
    let tvrdoglava = 0;
    for (const k of vid) if (P[k].netacno >= 3 && P[k].kutija <= 2) tvrdoglava++;
    return {pregled: pregledPodaci(c), niz_dana: niz, sansa_juce: pre.length ? pre[pre.length - 1] : null,
            tacke, tvrdoglava, ispiti: (c.st.ispiti || []).slice(-8),
            danas, danas_aktivan: ist.has(danas),
            sansa_prolaz: sansa, ocekivano: pyRound(100 * zbir / N_SIM),
            oblasti, lekcije, trenutna_lekcija: trenutna,
            istorija: [...ist.values()].sort((x, y) => poredi(x.dan, y.dan)).slice(-14),
            ispit_datum: c.ispit, dan_pred_ispit: c.danas === c.danPred};
  }

  function pitanjeZaKlijent(c, qid) {
    const q = Q.get(qid), s = c.st.pitanja[String(qid)] || {};
    const odg = promesaj(q.odgovori.map(o => ({id: o.id, tekst: o.tekst})), random);
    return {id: qid, tekst: q.tekst, oblast: q.oblast, lekcija: q.podoblast.replace(/;+$/, ""),
            bodova: q.bodova, treba: q.treba_zaokruziti, slika: q.slika, odgovori: odg,
            ponavljanje: istina(s.istorija), gresaka: s.netacno === undefined ? 0 : s.netacno,
            kutija: s.kutija === undefined ? 0 : s.kutija, lekcija_i: c.v.lekcijaOd.get(qid), oblast_br: q.oblast_br};
  }

  function tura(c, zahtev) {
    const n = cele(zahtev.param("n", "10"), "n"), rezim = zahtev.param("rezim", "uci");
    let ids;
    if (rezim === "ispit") {
      // kao pravi ispit: kvote po oblasti i ukupno 98–99 bodova
      for (let t = 0; t < 20000; t++) {
        ids = [];
        for (const [ob, k] of KVOTA) {
          const sve = PO_OBL.get(ob) || [];
          ids = ids.concat(uzorak(sve, Math.min(k, sve.length), random));
        }
        const zbir = ids.reduce((s, i) => s + Q.get(i).bodova, 0);
        if (zbir === 98 || zbir === 99) break;
      }
      promesaj(ids, random);
    } else if (rezim === "lekcija") {  // vežbanje jedne lekcije: prvo neviđena, pa najslabija
      const l = cele(zahtev.param("l", "0"), "l"), lek = c.v.lekcije[l];
      if (!lek) throw greska(404, "Nema lekcije " + l);
      const kljuc = id => { const s = c.st.pitanja[String(id)]; return s ? [s.istorija.length > 0 ? 1 : 0, s.kutija] : [0, 0]; };
      ids = lek.ids.slice().sort((x, y) => { const a = kljuc(x), b = kljuc(y); return (a[0] - b[0]) || (a[1] - b[1]); }).slice(0, n);
    } else if (rezim === "greske") {
      const kand = [];
      for (const [k, v] of Object.entries(c.st.pitanja)) {
        const q = Q.get(Number(k));
        if (q && v.istorija.length && v.kutija <= 2) kand.push({id: Number(k), kutija: v.kutija, netacno: v.netacno, bodova: q.bodova});
      }
      // izjednačenja: rastući id (Python bi uzeo redosled ključeva u rečniku)
      kand.sort((a, b) => (a.kutija - b.kutija) || (b.netacno - a.netacno) || (b.bodova - a.bodova) || (a.id - b.id));
      ids = kand.map(x => x.id).slice(0, n);
    } else {
      ids = sledeca(c, n);
    }
    return {pitanja: ids.map(i => pitanjeZaKlijent(c, i)), pregled: pregledPodaci(c)};
  }

  function odgovor(c, d) {
    if (!jeObjekat(d) || d.id === undefined || !Array.isArray(d.izabrani)) throw greska(400, "Zahtev mora imati id i izabrani");
    const qid = cele(d.id, "id"), izabrani = new Set(d.izabrani.map(x => cele(x, "izabrani")));
    const q = Q.get(qid);
    if (!q) throw greska(404, "Nepoznato pitanje " + qid);
    const tacni = q.odgovori.filter(o => o.tacno).map(o => o.id);
    const ok = izabrani.size === tacni.length && tacni.every(x => izabrani.has(x));
    // beleži: učenje (prvi pokušaj u turi) · ispit samo za već viđena pitanja (ne kvari redosled lekcija)
    // ne beleži: ponovni pokušaj iste greške u istoj turi (bez_zapisa)
    if (!istina(d.bez_zapisa)) {
      const zapis = q.odgovori.filter(o => izabrani.has(o.id)).map(o => Array.from(o.tekst).slice(0, 40).join("")).join(" | ");
      oceni(c, qid, izabrani, (istina(d.ispit) ? "ispit: " : "app: ") + zapis, istina(d.nesiguran));
      sacuvaj(c.st);
    }
    return {tacno: ok, tacni, bodova: q.bodova, pregled: pregledPodaci(c)};
  }

  function ispitRezultat(c, d) {
    if (!jeObjekat(d) || d.bod === undefined || d.max === undefined || d.tacnih === undefined) throw greska(400, "Zahtev mora imati bod, max i tacnih");
    if (!Array.isArray(c.st.ispiti)) c.st.ispiti = [];
    c.st.ispiti.push({kad: isoVreme(c.sada, false), bod: d.bod, max: d.max, tacnih: d.tacnih,
                      gubitak: ima(d, "gubitak") ? d.gubitak : {}, pogresna: ima(d, "pogresna") ? d.pogresna : []});
    sacuvaj(c.st);
    return {ok: true};
  }

  // Obrada je sinhrona (nema await), pa se Promise.all više /api/odgovor poziva izvršava jedan za drugim
  async function api(url, body) {
    const z = razlozi(url);
    if (!body) {
      if (z.putanja === "/api/tura") return tura(kontekst(), z);
      if (z.putanja === "/api/pocetna") return pocetna(kontekst());
      if (z.putanja === "/api/pregled") return pregledPodaci(kontekst());
    } else {
      const d = typeof body === "string" ? JSON.parse(body) : body;
      if (z.putanja === "/api/ispit_rezultat") return ispitRezultat(kontekst(), d);
      if (z.putanja === "/api/odgovor") return odgovor(kontekst(), d);
    }
    throw greska(404, "Nepoznata putanja: " + z.putanja);
  }

  // --- izvoz / uvoz / reset ---

  const izvezi = () => JSON.stringify(ucitaj(), null, 1);   // isti oblik kao napredak.json (indent=1)

  function uvezi(tekst) {
    let st;
    try { st = JSON.parse(String(tekst).replace(/^﻿/, "")); } catch (e) { return {ok: false, error: "Fajl nije ispravan JSON."}; }
    const g = proveri(st);
    if (g) return {ok: false, error: "Ovo nije napredak.json ovog kviza: " + g + "."};
    try { sacuvaj(srediStanje(st)); } catch (e) { return {ok: false, error: "Napredak se ne može sačuvati u pregledaču (nema mesta?)."}; }
    return {ok: true};
  }

  // briše samo napredak; datum ispita je podešavanje i ostaje (briše se sa setIspit(null))
  function reset() {
    storage.removeItem(KLJUC);
    storage.removeItem(KLJUC_OSTECEN);
  }

  return {api, getIspit, setIspit, izvezi, uvezi, reset};
}

// Pomoćno za testove
createKviz.pomocne = {pyRound, pyRound1, pySuma, mulberry32, uzorak, promesaj, dodajDane, podeliGore, KVOTA, INTERVAL, P_KUTIJA};


// ---------- pokretanje u pregledaču ----------

if (typeof window !== "undefined" && global === window) {
  const meta = document.querySelector('meta[name="kviz-backend"]');
  if (meta && meta.getAttribute("content") === "static") {
    global.KVIZ_MODE = "static";
    let storage;
    try {
      storage = global.localStorage;
      storage.setItem("kviz.probe", "1");
      storage.removeItem("kviz.probe");
      global.KVIZ_STORAGE = "local";
    } catch (e) {  // privatan prozor ili blokiran storage: radi, ali se napredak gubi pri zatvaranju
      const m = new Map();
      storage = {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }};
      global.KVIZ_STORAGE = "memorija";
    }
    global.KVIZ_READY = fetch("pitanja.json")
      .then(r => { if (!r.ok) throw new Error("pitanja.json: HTTP " + r.status); return r.json(); })
      .then(pitanja => { global.KVIZ = createKviz({pitanja, storage, now: () => new Date(), random: Math.random}); });
  } else {
    global.KVIZ_MODE = "server";
    global.KVIZ_READY = Promise.resolve();
  }
}
if (typeof module !== "undefined" && module.exports) module.exports = {createKviz};

})(typeof globalThis !== "undefined" ? globalThis : this);
