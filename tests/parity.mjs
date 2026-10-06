#!/usr/bin/env node
/* Test pariteta, strana JS-a: app/kviz.js (createKviz) naspram pravog kviz.py + server.py.
 *
 * Jedna komanda (iz korena repozitorijuma; treba samo Node 22 i python3 (3.12+); podrazumevano ~2.5 min, --brzo ~50 s):
 *
 *     node tests/parity.mjs             # pokrene tests/parity.py (očekivane vrednosti), pa poredi
 *     node tests/parity.mjs --brzo      # 4 konfiguracije, manje stanja i zona
 *     NODE_OPTIONS=--max-old-space-size=6000 node tests/parity.mjs --pun   # sve konfiguracije, sva stanja, 5 zona (~15 min)
 *
 * Opcije: fixture.json (već napravljen python3 tests/parity.py --out ...), --tz=UTC,Europe/Belgrade,
 * --samo=tekst (samo konfiguracije/slučajevi čije ime sadrži tekst), --opsirno, --prekini (stani na prvoj razlici),
 * --kviz=putanja (drugi kviz.js, za proveru da test hvata namerne greške).
 *
 * Šta se poredi (Python je izvor istine):
 *  - /api/pocetna: sve tačno osim sansa_prolaz / ocekivano (Monte Karlo: drugi PRNG) i sansa_juce kada je snimak
 *    nastao u istom scenariju. Tolerancija za sansa_prolaz je max(3, 4.5σ+1) (binomni šum dve nezavisne procene),
 *    za ocekivano ±2; uz to se poredi i sa preciznom referencom (više Python procena) i proverava pristrasnost.
 *  - /api/pregled, /api/odgovor, /api/ispit_rezultat: tačno (isti ključevi, tipovi i vrednosti).
 *  - /api/tura: uci / lekcija tačno po id-jevima; greske sa izjednačenjima (tie-aware); ispit: struktura,
 *    kvote po oblasti, 98–99 bodova, različiti id-jevi (nasumično, pa ne po id-jevima). Polja pitanja (tekst, slika,
 *    odgovori...) iz pitanja.json, a ponavljanje/gresaka/kutija iz napretka, za svako vraćeno pitanje.
 *  - Stanja se učitavaju kroz uvezi() (tri najmanja idu direktno u storage), posle svakog scenarija se poredi ceo
 *    napredak.json polje po polje, a izvezi() mora dati isti tekst kao json.dumps(indent=1). Prazni zapisi (kutija 0,
 *    bez istorije) moraju da se ponašaju kao da zapisa nema (isto čitanje ponovljeno sa zapisima za sva pitanja).
 *  - Svaki scenario se radi i posle „zagrevanja“ u drugom danu / sa drugim datumom ispita (rekompjuta po pozivu).
 *  - Pomoćne funkcije (round, //, sum, datumi), kvote/konstante i raspodela uzorka za ispit naspram Pythona.
 *  - Isti scenariji u nekoliko vremenskih zona (process.env.TZ).
 *
 * Prihvaćena i dokumentovana odstupanja (nisu greške u portu):
 *  1. Monte Karlo koristi mulberry32(7), ne random.Random(7): sansa_prolaz/ocekivano se razlikuju u okviru šuma.
 *  2. greske: izjednačenja (kutija, netacno, bodova) JS razrešava rastućim id-jem, Python redosledom ključeva u fajlu.
 *  3. JS ne piše Napredak.md/Greske.md i polje „tura“; uvezi() dopunjuje tura/dnevnik praznim nizovima.
 *  4. JS računa REDOSLED/lekcije/ISPIT po pozivu; Python jednom pri uvozu (isto samo dok se pred_ispit() ne promeni).
 *  5. Loš zahtev (nepoznata lekcija, id, broj): JS odbija Promise sa .status, Python 500/prekid veze; frontend to ne šalje.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const KOREN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (ime, def = null) => { const a = args.find(x => x.startsWith(`--${ime}=`)); return a ? a.slice(ime.length + 3) : def; };
const BRZO = args.includes("--brzo"), PUN = args.includes("--pun"), OPSIRNO = args.includes("--opsirno"), PREKINI = args.includes("--prekini"), SAMO = opt("samo");
const KVIZ_JS = path.resolve(opt("kviz", process.env.KVIZ_JS || path.join(KOREN, "app", "kviz.js")));
const { createKviz } = require(KVIZ_JS);
const POM = createKviz.pomocne || {};
const PITANJA = JSON.parse(fs.readFileSync(path.join(KOREN, "pitanja.json"), "utf8"));
const PO_ID = new Map(PITANJA.map(q => [q.id, q]));
const KLJUC = "kviz.napredak";
const MAX_RAZLIKA = OPSIRNO ? 40 : 6;   // koliko razlika ispisati po slučaju
const N_SIM = 1500;

// ---------- pomoćno ----------

const tip = x => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x);
const kratko = x => { const s = JSON.stringify(x); return s === undefined ? String(x) : (s.length > 90 ? s.slice(0, 87) + "..." : s); };

// Dubinsko poređenje (isti ključevi, tipovi i vrednosti); redosled ključeva se ne poredi
function razlike(exp, act, put, out, limit = 12) {
  if (out.length >= limit) return;
  const te = tip(exp), ta = tip(act);
  if (te !== ta) { out.push(`${put}: tip ${te} != ${ta} (${kratko(exp)} vs ${kratko(act)})`); return; }
  if (te === "array") {
    if (exp.length !== act.length) { out.push(`${put}: dužina ${exp.length} != ${act.length} (${kratko(exp)} vs ${kratko(act)})`); return; }
    exp.forEach((x, i) => razlike(x, act[i], `${put}[${i}]`, out, limit));
  } else if (te === "object") {
    const ke = Object.keys(exp).sort(), ka = Object.keys(act).sort();
    const fale = ke.filter(k => !(k in act)), visak = ka.filter(k => !(k in exp));
    if (fale.length || visak.length) out.push(`${put}: ključevi fale=[${fale}] višak=[${visak}]`);
    for (const k of ke) if (k in act) razlike(exp[k], act[k], `${put}.${k}`, out, limit);
  } else if (exp !== act) out.push(`${put}: ${kratko(exp)} != ${kratko(act)}`);
}
const bezKljuceva = (o, ks) => { const c = { ...o }; for (const k of ks) delete c[k]; return c; };
const normPitanje = p => ({ ...p, odgovori: (p.odgovori || []).slice().sort((a, b) => a.id - b.id) });

function napraviStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
}
// „YYYY-MM-DDTHH:MM:SS“ kao LOKALNO vreme (kao datetime.now() u Pythonu)
function lokalno(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(iso);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
const dan = (iso, n) => POM.dodajDane(iso.slice(0, 10), n);
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const mulberry = POM.mulberry32 || (a => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; });

// Dozvoljena razlika dve procene šanse (u procentnim poenima): max(3, 4.5σ+1), σ binomno za N_SIM simulacija
const sigma = pct => { const p = Math.min(Math.max(pct / 100, 0), 1); return 100 * Math.sqrt(p * (1 - p) / N_SIM); };
const tolSansa = pct => Math.max(3, 4.5 * Math.sqrt(2) * sigma(pct) + 1);

// ---------- poređenja po modovima ----------

function cmpPocetna(e, act, out, stat) {
  const E = e.odgovor, preskoci = ["sansa_prolaz", "ocekivano"];
  if (e.juce_mc) preskoci.push("sansa_juce");
  razlike(bezKljuceva(E, preskoci), bezKljuceva(act, preskoci), "pocetna", out);
  for (const k of ["sansa_prolaz", "ocekivano"]) if (!Number.isInteger(act[k])) out.push(`pocetna.${k}: nije ceo broj (${kratko(act[k])})`);
  const ref = e.ref, sr = ref ? ref.sansa : E.sansa_prolaz;
  const dS = Math.abs(act.sansa_prolaz - E.sansa_prolaz), dO = Math.abs(act.ocekivano - E.ocekivano);
  if (dS > tolSansa(sr)) out.push(`pocetna.sansa_prolaz: JS ${act.sansa_prolaz} vs Python ${E.sansa_prolaz} (dozvoljeno ±${tolSansa(sr).toFixed(1)})`);
  if (dO > 2) out.push(`pocetna.ocekivano: JS ${act.ocekivano} vs Python ${E.ocekivano} (dozvoljeno ±2)`);
  if (ref) {
    const tol = 4.5 * sigma(ref.sansa) * Math.sqrt(1 + 1 / ref.k) + 1;
    if (Math.abs(act.sansa_prolaz - ref.sansa) > tol) out.push(`pocetna.sansa_prolaz: JS ${act.sansa_prolaz} vs referenca ${ref.sansa.toFixed(1)} (±${tol.toFixed(1)})`);
    if (Math.abs(act.ocekivano - ref.ocek) > 1.5) out.push(`pocetna.ocekivano: JS ${act.ocekivano} vs referenca ${ref.ocek.toFixed(1)} (±1.5)`);
  }
  if (e.juce_mc) {
    const a = E.sansa_juce, b = act.sansa_juce;
    if ((a === null) !== (b === null) || (a !== null && Math.abs(a - b) > tolSansa(a))) out.push(`pocetna.sansa_juce: ${kratko(a)} vs ${kratko(b)} (snimak iz Monte Karla)`);
  }
  stat.pocetna.push({ py: E.sansa_prolaz, js: act.sansa_prolaz, ref: ref && ref.sansa, ocPy: E.ocekivano, ocJs: act.ocekivano, ocRef: ref && ref.ocek, spSpec: dS <= 3, ocSpec: dO <= 2 });
}

// Polja koja ne zavise od stanja napretka: moraju biti ista kao u pitanja.json za svako vraćeno pitanje
function proveriStaticka(p, out) {
  const q = PO_ID.get(p.id);
  if (!q) { out.push(`tura: nepoznat id ${p.id}`); return; }
  const sta = { id: q.id, tekst: q.tekst, oblast: q.oblast, lekcija: q.podoblast.replace(/;+$/, ""), bodova: q.bodova, treba: q.treba_zaokruziti, slika: q.slika, oblast_br: q.oblast_br };
  razlike(sta, Object.fromEntries(Object.keys(sta).map(k => [k, p[k]])), `pitanje ${p.id}`, out);
  razlike(q.odgovori.map(o => ({ id: o.id, tekst: o.tekst })).sort((a, b) => a.id - b.id), (p.odgovori || []).map(o => ({ id: o.id, tekst: o.tekst })).sort((a, b) => a.id - b.id), `pitanje ${p.id}.odgovori`, out);
}
// Polja koja zavise od napretka (ponavljanje, gresaka, kutija) za SVA vraćena pitanja, iz stanja u storage-u
function proveriZavisna(p, stanje, out) {
  const s = stanje.pitanja[String(p.id)] || {};
  razlike({ ponavljanje: Boolean(s.istorija && s.istorija.length), gresaka: s.netacno || 0, kutija: s.kutija || 0 },
    { ponavljanje: p.ponavljanje, gresaka: p.gresaka, kutija: p.kutija }, `pitanje ${p.id}`, out);
}
function cmpTuraOpste(e, act, out, stanje) {
  razlike(e.pregled, act.pregled, "tura.pregled", out);
  const sablon = Object.values(e.uzorak)[0], kljucevi = sablon && Object.keys(sablon).sort().join();
  const poId = new Map(act.pitanja.map(p => [p.id, p]));
  for (const [id, ep] of Object.entries(e.uzorak)) {
    const ap = poId.get(Number(id));
    if (ap) razlike(normPitanje(ep), normPitanje(ap), `tura.pitanje ${id}`, out);
    else if (e._tacnoIds) out.push(`tura.pitanje ${id} nedostaje`);
  }
  for (const p of act.pitanja) {
    if (kljucevi && Object.keys(p).sort().join() !== kljucevi) { out.push(`tura.pitanje ${p.id}: ključevi ${Object.keys(p).sort()} != ${kljucevi}`); break; }
    proveriStaticka(p, out);
    proveriZavisna(p, stanje, out);
    if (out.length > 8) break;
  }
}
function cmpTura(e, act, out, stanje) {
  razlike(e.ids, act.pitanja.map(p => p.id), "tura.ids", out);
  cmpTuraOpste({ ...e, _tacnoIds: true }, act, out, stanje);
}
function cmpGreske(e, act, out, stanje) {
  const kand = new Map(e.kandidati.map(([id, k, n, b]) => [id, `${k},${-n},${-b}`]));
  const exp = e.ids, got = act.pitanja.map(p => p.id);
  if (exp.length !== got.length) out.push(`greske: dužina ${exp.length} != ${got.length}`);
  if (new Set(got).size !== got.length) out.push("greske: ponovljeni id-jevi");
  const nepoznat = got.find(i => !kand.has(i));
  if (nepoznat !== undefined) { out.push(`greske: id ${nepoznat} nije kandidat`); return; }
  const kg = got.map(i => kand.get(i)), ke = exp.map(i => kand.get(i));
  const i0 = ke.findIndex((k, i) => kg[i] !== k);
  if (i0 >= 0) out.push(`greske: ključ sortiranja na mestu ${i0}: Python ${ke[i0]} (id ${exp[i0]}) vs JS ${kg[i0]} (id ${got[i0]})`);
  else {
    const grupe = new Map();
    ke.forEach((k, i) => { if (!grupe.has(k)) grupe.set(k, { n: 0, sve: [...kand].filter(([, kk]) => kk === k).map(([id]) => id) }); grupe.get(k).n++; });
    for (const [k, g] of grupe) {
      const uzeti = got.filter(i => kand.get(i) === k);
      if (uzeti.length !== g.n || !uzeti.every(i => g.sve.includes(i))) out.push(`greske: grupa ${k}: JS ${uzeti.length} id-jeva, očekivano ${g.n} iz grupe od ${g.sve.length}`);
      if (uzeti.some((x, i) => i && uzeti[i - 1] > x)) out.push(`greske: izjednačenja nisu po rastućem id-ju u grupi ${k}`);
    }
  }
  cmpTuraOpste({ ...e, _tacnoIds: false }, act, out, stanje);
}
function cmpIspit(e, act, out, stanje) {
  const ids = act.pitanja.map(p => p.id);
  if (ids.length !== e.ids.length) out.push(`ispit: ${ids.length} pitanja, očekivano ${e.ids.length}`);
  if (new Set(ids).size !== ids.length) out.push("ispit: ponovljena pitanja");
  const po = {};
  let bod = 0;
  for (const p of act.pitanja) { po[p.oblast_br] = (po[p.oblast_br] || 0) + 1; bod += p.bodova; }
  razlike(e.po_oblasti, Object.fromEntries(Object.entries(po).map(([k, v]) => [k, v])), "ispit.po_oblasti", out);
  if (bod !== 98 && bod !== 99) out.push(`ispit: ${bod} bodova (mora 98 ili 99)`);
  razlike(e.pregled, act.pregled, "ispit.pregled", out);
  const sablon = Object.values(e.uzorak)[0], kljucevi = Object.keys(sablon).sort().join();
  for (const p of act.pitanja) {
    if (Object.keys(p).sort().join() !== kljucevi) { out.push(`ispit.pitanje ${p.id}: ključevi ${Object.keys(p).sort()}`); break; }
    proveriStaticka(p, out);
    proveriZavisna(p, stanje, out);
    if (out.length > 8) break;
  }
  if (new Set(act.pitanja.map(p => p.lekcija_i)).size < 2) out.push("ispit: lekcija_i se ne razlikuje");
}

// ---------- jedan slučaj ----------

function ocekivanoKraj(stanje, izmene, napisani) {
  const pitanja = { ...stanje.pitanja };
  for (const k of izmene.uklonjena) delete pitanja[k];
  Object.assign(pitanja, izmene.pitanja);
  return srediKraj({ ...stanje, ...izmene.ostalo, pitanja }, napisani);
}
function srediKraj(st, napisani) {
  const c = { ...st };
  if (!Array.isArray(c.tura)) c.tura = [];
  if (!Array.isArray(c.dnevnik)) c.dnevnik = [];
  if (c.spremnost) { c.spremnost = { ...c.spremnost }; for (const d of napisani) delete c.spremnost[d]; }
  return c;
}

async function izvrsiKorak(kviz, k) {
  try { return { ok: await kviz.api(k.url, k.telo) }; } catch (e) { return { greska: e }; }
}

// Metamorfni proba: zapis sa kutija 0 i praznom istorijom mora da se ponaša isto kao da zapisa nema (CLI „daj“ upisuje prazne)
function saPraznim(stanje) {
  const pitanja = { ...stanje.pitanja };
  for (const q of PITANJA) if (!pitanja[String(q.id)]) pitanja[String(q.id)] = { kutija: 0, tacno: 0, netacno: 0, sledece: null, istorija: [] };
  return { ...stanje, pitanja };
}

async function pokreniSlucaj(cfg, slucaj, ctx, prazni = false) {
  const out = [], stat = ctx.stat;
  const storage = napraviStorage();
  let sada = lokalno(cfg.sada);
  const kviz = createKviz({ pitanja: PITANJA, storage, now: () => sada, random: mulberry(ctx.broj++) });
  const stanje0 = cfg.stanja[slucaj.stanje].stanje, stanje = prazni ? saPraznim(stanje0) : stanje0;
  // zagrevanje: drugi dan i suprotno stanje „pred ispit“, pa povratak (REDOSLED/lekcije/ISPIT moraju da se računaju po pozivu)
  sada = new Date(cfg.pred ? lokalno(cfg.sada).getTime() - 3 * 864e5 : lokalno(cfg.sada).getTime());
  kviz.setIspit(cfg.pred ? null : dan(cfg.sada, 1));
  await kviz.api("/api/pregled");
  await kviz.api("/api/tura?rezim=lekcija&l=0&n=2");
  sada = lokalno(cfg.sada);
  if (!kviz.setIspit(cfg.ispit)) out.push(`setIspit(${cfg.ispit}) odbijen`);
  if ((kviz.getIspit() || null) !== cfg.ispit) out.push(`getIspit() = ${kviz.getIspit()}, očekivano ${cfg.ispit}`);
  if (slucaj.ucitaj === "uvezi") {
    const r = kviz.uvezi(JSON.stringify(stanje));
    if (!r.ok) { out.push(`uvezi() odbio stanje: ${r.error}`); return out; }
  } else storage.setItem(KLJUC, JSON.stringify(stanje));
  if (slucaj.ime.endsWith("/citanje") && !prazni) {
    const t = kviz.izvezi();
    if (sha(t) !== cfg.stanja[slucaj.stanje].izvoz_sha) out.push(`izvezi(): tekst se razlikuje od json.dumps(indent=1) (${t.length} znakova)`);
    const tek = JSON.parse(t);
    razlike(srediKraj(stanje, []), srediKraj(tek, []), "izvezi()", out);
  }
  const jsOdg = [], sansaJs = {};
  const koraci = slucaj.koraci;
  for (let i = 0; i < koraci.length;) {
    let j = i + 1;
    if (koraci[i].grupa) while (j < koraci.length && koraci[j].grupa === koraci[i].grupa && !koraci[j].sat) j++;
    if (koraci[i].sat) sada = lokalno(koraci[i].sat);
    const grupa = koraci.slice(i, j);
    // frontend ispaljuje Promise.all više /api/odgovor poziva; obrada je sinhrona, pa idu redom
    const rez = await Promise.all(grupa.map(k => izvrsiKorak(kviz, k)));
    grupa.forEach((k, g) => {
      const mesto = `${slucaj.ime} korak ${i + g} (${k.mod} ${k.url}${k.telo ? " " + kratko(k.telo) : ""})`, d = [];
      if (rez[g].greska) d.push(`izuzetak: ${rez[g].greska.message}`);
      else {
        const a = rez[g].ok;
        if (k.mod === "pocetna") { cmpPocetna(k.ocekivano, a, d, stat); sansaJs[a.danas] = a.sansa_prolaz; jsOdg.push(a); }
        else if (k.mod === "tura") cmpTura(k.ocekivano, a, d, ctx.stanjeZa(stanje, kviz, storage));
        else if (k.mod === "greske") cmpGreske(k.ocekivano, a, d, ctx.stanjeZa(stanje, kviz, storage));
        else if (k.mod === "ispit") cmpIspit(k.ocekivano, a, d, ctx.stanjeZa(stanje, kviz, storage));
        else razlike(k.ocekivano, a, k.mod, d);
      }
      stat.koraka++;
      for (const x of d.slice(0, MAX_RAZLIKA)) out.push(`${mesto}: ${x}`);
    });
    i = j;
  }
  if (jsOdg.length >= 2 && slucaj.ime.endsWith("/citanje")) {   // Monte Karlo mora biti stabilan na istom stanju
    const d = []; razlike(jsOdg[0], jsOdg[jsOdg.length - 1], "pocetna(1) vs pocetna(2)", d);
    out.push(...d.map(x => `${slucaj.ime}: nestabilno: ${x}`));
  }
  if (prazni) return out;
  const sirovo = storage.getItem(KLJUC);
  const kraj = sirovo === null ? null : JSON.parse(sirovo);
  if (!kraj) out.push(`${slucaj.ime}: napredak nije u storage-u na kraju`);
  else {
    const d = [];
    razlike(ocekivanoKraj(stanje, slucaj.izmene, slucaj.napisani), srediKraj(kraj, slucaj.napisani), "napredak", d, MAX_RAZLIKA);
    for (const dd of slucaj.napisani) if ((kraj.spremnost || {})[dd] !== sansaJs[dd]) d.push(`spremnost[${dd}] = ${kraj.spremnost && kraj.spremnost[dd]} != vraćena sansa_prolaz ${sansaJs[dd]}`);
    out.push(...d.map(x => `${slucaj.ime} KRAJ: ${x}`));
    stat.stanja++;
  }
  return out;
}

// ---------- jedinice ----------

async function jediniceTest(fix, ctx) {
  const J = fix.jedinice, out = [];
  const potrebno = ["pyRound", "pyRound1", "pySuma", "podeliGore", "dodajDane", "mulberry32", "uzorak", "promesaj"].filter(k => !POM[k]);
  if (potrebno.length) return [`createKviz.pomocne nema: ${potrebno}`];
  const prvi = (lista, f, ime) => {
    const lose = lista.filter(f);
    if (lose.length) out.push(`${ime}: ${lose.length}/${lista.length} razlika, npr. ${kratko(lose[0])}`);
  };
  prvi(J.zaokruzi, ([x, e]) => POM.pyRound(x) !== e, "round(x)");
  prvi(J.zaokruzi1, ([x, e]) => POM.pyRound1(x) !== e, "round(x, 1)");
  prvi(J.podeli_gore, ([a, b, e]) => POM.podeliGore(a, b) !== e, "-(-a // b)");
  prvi(J.suma, ([s, e]) => (fix.suma_kompenzovana === false ? Math.abs(POM.pySuma(s) - e) > 1e-9 * Math.max(1, Math.abs(e)) : POM.pySuma(s) !== e), "sum(float-ovi)");
  prvi(J.dodaj_dane, ([iso, n, e]) => POM.dodajDane(iso, n) !== e, "datum + timedelta");
  const k = J.konstante;
  if (POM.KVOTA) {
    const kv = Array.isArray(POM.KVOTA) ? POM.KVOTA : [...POM.KVOTA.entries()];
    razlike(k.KVOTA, kv.map(([a, b]) => [Number(a), b]), "KVOTA (redosled kao u Pythonu)", out);
  }
  if (POM.INTERVAL) razlike(k.INTERVAL, Object.fromEntries(Object.entries(POM.INTERVAL).map(([a, b]) => [a, b])), "INTERVAL", out);
  if (POM.P_KUTIJA) razlike(k.P_KUTIJA, Object.fromEntries(Object.entries(POM.P_KUTIJA).map(([a, b]) => [a, b])), "P_KUTIJA", out);
  // seedovani PRNG
  const r = POM.mulberry32(7), niz = Array.from({ length: 100000 }, r), sr = niz.reduce((a, b) => a + b) / niz.length;
  if (niz.some(x => !(x >= 0 && x < 1)) || Math.abs(sr - .5) > .005) out.push(`mulberry32: srednja vrednost ${sr}`);
  const r2 = POM.mulberry32(7); if (r2() !== niz[0]) out.push("mulberry32(7) nije ponovljiv");
  // random.sample / random.shuffle: svojstva i ravnomernost
  const rnd = mulberry(99);
  const uz = Array.from({ length: 4000 }, () => POM.uzorak([...Array(20).keys()], 5, rnd));
  if (uz.some(s => s.length !== 5 || new Set(s).size !== 5 || s.some(x => x < 0 || x > 19))) out.push("uzorak: nije 5 različitih iz 0..19");
  const br = Array(20).fill(0); uz.forEach(s => s.forEach(x => br[x]++));
  if (br.some(c => Math.abs(c - 1000) > 150)) out.push(`uzorak: neravnomerno ${br}`);
  const perm = new Map();
  for (let i = 0; i < 24000; i++) { const a = POM.promesaj([0, 1, 2, 3], rnd); perm.set(a.join(""), (perm.get(a.join("")) || 0) + 1); }
  const chi = [...perm.values()].reduce((s, c) => s + (c - 1000) ** 2 / 1000, 0);
  if (perm.size !== 24 || chi > 60) out.push(`promesaj: ${perm.size} permutacija, χ²=${chi.toFixed(1)}`);
  // ispit: pravila i raspodela naspram Pythona
  return ispitTest(J.ispit, out, ctx);
}
const hiKvantil = (df, z = 3.72) => df * (1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df))) ** 3;   // Wilson–Hilferty, p≈1e-4
async function ispitTest(Pi, out, ctx) {
  const kviz = createKviz({ pitanja: PITANJA, storage: napraviStorage(), now: () => new Date(2026, 9, 6, 9, 0, 0), random: mulberry(2024) });
  const KV = new Map([[6, 18], [8, 13], [10, 2], [5, 2], [11, 1], [4, 1], [12, 1], [9, 1], [1, 1], [2, 1]]);
  const bodovi = { 98: 0, 99: 0 }, brojanje = { 2: {}, 9: {}, 10: {}, 11: {} };
  let grupisanih = 0;
  for (let i = 0; i < Pi.n; i++) {
    const r = await kviz.api("/api/tura?n=41&rezim=ispit"), ps = r.pitanja;
    const po = new Map(); let bod = 0;
    for (const p of ps) { po.set(p.oblast_br, (po.get(p.oblast_br) || 0) + 1); bod += p.bodova; if (brojanje[p.oblast_br]) brojanje[p.oblast_br][p.id] = (brojanje[p.oblast_br][p.id] || 0) + 1; }
    if (ps.length !== 41 || new Set(ps.map(p => p.id)).size !== 41) out.push(`ispit #${i}: ${ps.length} pitanja / nisu različita`);
    for (const [ob, n] of KV) if (po.get(ob) !== n) { out.push(`ispit #${i}: oblast ${ob} ima ${po.get(ob)}, kvota ${n}`); break; }
    if (po.has(14)) out.push(`ispit #${i}: oblast 14 ne sme na ispit`);
    if (bod !== 98 && bod !== 99) out.push(`ispit #${i}: ${bod} bodova`);
    else bodovi[bod]++;
    const sek = ps.map(p => p.oblast_br).filter((x, j, a) => j === 0 || x !== a[j - 1]).length;   // broj uzastopnih blokova oblasti
    if (sek <= 10) grupisanih++;
    if (out.length > 5) break;
  }
  if (grupisanih > 0) out.push(`ispit: ${grupisanih} puta pitanja nisu izmešana (po oblastima)`);
  const py = Pi.bodova, n98 = bodovi[98], pPy = (py["98"] || 0) / Pi.n, pJs = n98 / Pi.n, pp = (pPy + pJs) / 2;
  const z = (pJs - pPy) / Math.sqrt(2 * pp * (1 - pp) / Pi.n);
  if (Math.abs(z) > 4.5) out.push(`ispit: udeo 98 bodova JS ${pJs.toFixed(3)} vs Python ${pPy.toFixed(3)} (z=${z.toFixed(1)})`);
  ctx.ispitInfo = `98 bodova: JS ${(100 * pJs).toFixed(1)}% / Python ${(100 * pPy).toFixed(1)}% (n=${Pi.n})`;
  for (const ob of [2, 9, 10, 11]) {
    const ids = PITANJA.filter(q => q.oblast_br === ob).map(q => q.id);
    let chi = 0;
    for (const id of ids) { const a = brojanje[ob][id] || 0, b = (Pi.brojanje[ob] || {})[id] || 0; if (a + b) chi += (a - b) ** 2 / (a + b); }
    if (chi > hiKvantil(ids.length - 1)) out.push(`ispit: raspodela pitanja oblasti ${ob} se razlikuje od Pythona (χ²=${chi.toFixed(1)}, df=${ids.length - 1})`);
  }
  return out;
}

// ---------- glavni tok ----------

function ucitajFixture() {
  const poz = args.find(a => !a.startsWith("--"));
  if (poz) return JSON.parse(fs.readFileSync(poz, "utf8"));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kviz-parity-")), "fixture.json");
  console.log(`Python: pravim očekivane vrednosti iz pravog kviz.py/server.py (${BRZO ? "brzo" : PUN ? "pun skup" : "podrazumevani skup"}) ...`);
  const t0 = Date.now();
  const p = spawnSync("python3", [path.join(KOREN, "tests", "parity.py"), "--out", f, ...(BRZO ? ["--brzo"] : PUN ? ["--pun"] : [])],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (p.status !== 0) { console.error("tests/parity.py nije uspeo"); process.exit(2); }
  console.log(`Python gotov za ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const fix = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
  return fix;
}

const fix = ucitajFixture();
const ZONE = (opt("tz") || (BRZO ? "Europe/Belgrade,Pacific/Auckland" : PUN ? "Europe/Belgrade,UTC,America/Los_Angeles,Pacific/Auckland,Asia/Kolkata" : "Europe/Belgrade,America/Los_Angeles,Pacific/Auckland")).split(",");
const ZONE_KONFIG = new Set(["bez_ispita", "oko_ponoci", "letnje_vreme", "prelaz_godine"]);
const stat = { koraka: 0, stanja: 0, slucajeva: 0, pocetna: [] };
const ctx = { stat, broj: 1, stanjeZa: (stanje, kviz, storage) => JSON.parse(storage.getItem(KLJUC) || "null") || stanje };
const greske = [];
let ukupnoSlucajeva = 0;

for (const [zi, tz] of ZONE.entries()) {
  process.env.TZ = tz;
  const ocekOffset = { "Europe/Belgrade": -120, UTC: 0, "America/Los_Angeles": 420, "Pacific/Auckland": -720, "Asia/Kolkata": -330 }[tz];
  const offset = new Date(2026, 6, 1, 12).getTimezoneOffset();   // jul: zimsko/letnje računanje vremena po zoni
  if (ocekOffset !== undefined && offset !== ocekOffset) { console.error(`TZ=${tz} nije primenjen (pomak ${offset}, očekivano ${ocekOffset})`); process.exit(2); }
  const t0 = Date.now();
  let n = 0, losih = 0;
  for (const cfg of fix.konfiguracije) {
    // u prvoj zoni sve; u ostalima čitanja + nizovi + jedna šetnja, za konfiguracije gde sat/datum najviše znače (isti kod, različit lokalni sat)
    for (const slucaj of cfg.slucajevi) {
      if (zi > 0 && (!/\/(citanje|niz_na_pitanju|setnja_0)$/.test(slucaj.ime) || !(PUN || ZONE_KONFIG.has(cfg.ime)))) continue;
      if (SAMO && !slucaj.ime.includes(SAMO) && !cfg.ime.includes(SAMO)) continue;
      const d = await pokreniSlucaj(cfg, slucaj, ctx).catch(e => [`${slucaj.ime}: IZUZETAK ${e.stack || e}`]);
      if (zi === 0 && slucaj.ime.endsWith("/citanje")) {
        d.push(...(await pokreniSlucaj(cfg, slucaj, ctx, true).catch(e => [`${slucaj.ime}: IZUZETAK ${e.stack || e}`])).map(x => `[sa praznim zapisima] ${x}`));
      }
      n++; ukupnoSlucajeva++;
      if (d.length) {
        losih++; greske.push(...d.map(x => `[${tz}] [${cfg.ime}] ${x}`));
        if (PREKINI) { console.log("RAZLIKE (prekinuto na prvoj):"); greske.slice(0, 12).forEach(g => console.log("  " + g)); process.exit(1); }
      }
    }
  }
  console.log(`TZ ${tz.padEnd(20)} ${String(n).padStart(5)} slučajeva, ${String(losih).padStart(4)} sa razlikama (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
stat.slucajeva = ukupnoSlucajeva;

process.env.TZ = ZONE[0];
const jed = await jediniceTest(fix, ctx);
for (const z of ZONE) {   // datumska aritmetika u svim zonama
  process.env.TZ = z;
  const lose = fix.jedinice.dodaj_dane.filter(([iso, n, e]) => POM.dodajDane && POM.dodajDane(iso, n) !== e);
  if (lose.length) jed.push(`dodajDane u TZ=${z}: ${lose.length} razlika`);
}
console.log(`Jedinice (round, //, sum, datumi, konstante, PRNG, raspodela ispita): ${jed.length ? jed.length + " RAZLIKA" : "OK"}${ctx.ispitInfo ? " · " + ctx.ispitInfo : ""}`);
greske.push(...jed.map(x => `[jedinice] ${x}`));

// pristrasnost Monte Karla (srednja razlika JS - Python na „srednjim“ stanjima) i koliko je prošlo i strogu tolerancije ±3 / ±2
const sred = stat.pocetna.filter(x => x.ref !== null && x.ref !== undefined);
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const bias = avg(sred.map(x => x.js - x.py)), biasRef = avg(sred.map(x => x.js - x.ref)), biasOc = avg(stat.pocetna.map(x => x.ocJs - x.ocPy));
const strogo = stat.pocetna.filter(x => !x.spSpec).length, strogoO = stat.pocetna.filter(x => !x.ocSpec).length;
console.log(`Monte Karlo: ${stat.pocetna.length} poziva /api/pocetna, ${sred.length} sa srednjom šansom; pristrasnost JS-Python ${bias.toFixed(2)} (JS-referenca ${biasRef.toFixed(2)}), ocekivano ${biasOc.toFixed(2)}; van ±3: ${strogo}, van ±2 (ocekivano): ${strogoO}`);
if (sred.length >= 30 && (Math.abs(bias) > 1.5 || Math.abs(biasRef) > 1.5)) greske.push(`[monte karlo] pristrasnost sansa_prolaz: JS-Python ${bias.toFixed(2)}, JS-referenca ${biasRef.toFixed(2)} (dozvoljeno ±1.5)`);
if (Math.abs(biasOc) > .6) greske.push(`[monte karlo] pristrasnost ocekivano ${biasOc.toFixed(2)}`);

console.log(`Ukupno: ${ukupnoSlucajeva} slučajeva, ${stat.koraka} poređenih poziva, ${stat.stanja} poređenih konačnih stanja, ${fix.konfiguracije.length} konfiguracija (Python ${fix.python})`);
if (greske.length) {
  console.log(`\nRAZLIKE: ${greske.length}`);
  for (const g of greske.slice(0, OPSIRNO ? 400 : 60)) console.log("  " + g);
  if (greske.length > (OPSIRNO ? 400 : 60)) console.log(`  ... još ${greske.length - (OPSIRNO ? 400 : 60)} (--opsirno za više)`);
  process.exit(1);
}
console.log("\nPARITET: SVE ISTO (u okviru dokumentovanih odstupanja)");
