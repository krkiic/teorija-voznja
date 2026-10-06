// E2E u pravom pregledaču (Playwright + Chromium): statički sajt pod pod-putanjom (kao GitHub Pages) i lokalni režim (server.py).
//
//   Pokretanje (jedna komanda, iz korena repoa):   node tests/e2e.mjs
//   Opciono: KVIZ_E2E_OUT=<folder> za screenshotove (podrazumevano <tmp>/kviz-e2e-out), KVIZ_E2E_HEADED=1
//
// Treba: Node 22, python3, globalni playwright ($(npm root -g)/playwright) i chromium u /opt/pw-browsers (ništa se ne preuzima).
// Sajt se pravi sa napravi_sajt.sh (isto kao u CI-ju) i služi sa python3 -m http.server pod /teorija-voznja/.
// Sve spoljne zahteve (Google Fonts) presreće prazan odgovor; svaki drugi neuspeli zahtev ili greška u konzoli je neuspeh.
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KOREN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.KVIZ_E2E_OUT || path.join(os.tmpdir(), "kviz-e2e-out");
const PODPUTANJA = "/teorija-voznja/";
const LICNI = ["napredak.json", "Napredak.md", "Greske.md", "pitanja_raw.json"];
const DOZVOLJENI_SPOLJNI = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const KVOTA = {6: 18, 8: 13, 10: 2, 5: 2, 11: 1, 4: 1, 12: 1, 9: 1, 1: 1, 2: 1};
const INTERVAL = {1: 0, 2: 1, 3: 2, 4: 4, 5: 7};
const PRVO = [1, 2, 4, 5, 10, 11, 8, 6, 9, 12, 14];

let NPM_ROOT;
try { NPM_ROOT = execFileSync("npm", ["root", "-g"]).toString().trim(); } catch (_) { NPM_ROOT = path.join(path.dirname(process.execPath), "..", "lib", "node_modules"); }
const { chromium } = createRequire(import.meta.url)(path.join(NPM_ROOT, "playwright"));

const pauza = ms => new Promise(r => setTimeout(r, ms));
const dv = n => String(n).padStart(2, "0");
const utc = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
function dodajDane(iso, n) { const d = new Date(utc(iso) + n * 864e5); return `${d.getUTCFullYear()}-${dv(d.getUTCMonth() + 1)}-${dv(d.getUTCDate())}`; }
const sekunde = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), +iso.slice(11, 13), +iso.slice(14, 16), +iso.slice(17, 19)) / 1000;
const naivnoVreme = (iso, sek) => { const t = new Date((sekunde(iso) + sek) * 1000); return `${t.getUTCFullYear()}-${dv(t.getUTCMonth() + 1)}-${dv(t.getUTCDate())}T${dv(t.getUTCHours())}:${dv(t.getUTCMinutes())}:${dv(t.getUTCSeconds())}`; };
const lokalniIso = (d = new Date()) => `${d.getFullYear()}-${dv(d.getMonth() + 1)}-${dv(d.getDate())}`;
const normalizuj = t => String(t ?? "").replace(/\s+/g, " ").trim();
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;   // isto kao pct() u index.html

// ---------- izveštaj ----------

let scen = "-", problemaUScenariju = 0;
const izvestaj = [];
let aktivna = null;   // stranica za screenshot kad scenario pukne
function ok(uslov, poruka, detalj) {
  izvestaj.push({scen, ok: !!uslov, poruka});
  if (!uslov) { problemaUScenariju++; console.log(`   NEUSPEH ${poruka}${detalj !== undefined ? "\n      " + (typeof detalj === "string" ? detalj : JSON.stringify(detalj)).slice(0, 700) : ""}`); }
  return !!uslov;
}
function jednako(dobijeno, ocekivano, poruka) {
  const a = JSON.stringify(dobijeno), b = JSON.stringify(ocekivano);
  return ok(a === b, poruka, a === b ? undefined : `dobijeno ${a} ≠ očekivano ${b}`);
}
async function scenario(naziv, fn) {
  scen = naziv; problemaUScenariju = 0;
  const pre = izvestaj.length, t0 = Date.now();
  console.log(`\n== ${naziv}`);
  try { await fn(); }
  catch (e) {
    ok(false, "izuzetak: " + String(e.message).split("\n")[0], String(e.stack).split("\n").slice(0, 5).join(" | "));
    try { await aktivna?.screenshot({path: path.join(OUT, `pad-${naziv.split(" ")[0]}.png`)}); } catch (_) { /* nema stranice */ }
  }
  const ove = izvestaj.slice(pre);
  console.log(`   ${ove.filter(x => x.ok).length}/${ove.length} provera, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------- podaci (pitanja.json) ----------

const PITANJA = JSON.parse(fs.readFileSync(path.join(KOREN, "pitanja.json"), "utf8"));
const Q = new Map(PITANJA.map(q => [q.id, q]));
const OPT = new Map();   // id odgovora -> pitanje (id-jevi odgovora su jedinstveni)
PITANJA.forEach(q => q.odgovori.forEach(o => OPT.set(o.id, q)));
const OBLASTI = [...new Set(PITANJA.map(q => q.oblast_br))].sort((a, b) => a - b);
const PORTAL = new Map(PITANJA.map((q, i) => [q.id, i]));

function redosled(pred) {
  const r = pred ? PRVO.filter(o => OBLASTI.includes(o)).concat(OBLASTI.filter(o => !PRVO.includes(o))) : OBLASTI;
  return [...PITANJA].sort((a, b) => (r.indexOf(a.oblast_br) - r.indexOf(b.oblast_br)) || (PORTAL.get(a.id) - PORTAL.get(b.id))).map(q => q.id);
}
function lekcije() {
  const out = [];
  for (const id of redosled(false)) {
    const q = Q.get(id), z = out.at(-1);
    if (!z || z.podoblast !== q.podoblast) out.push({podoblast: q.podoblast, ids: []});
    out.at(-1).ids.push(id);
  }
  return out;
}
const LEKCIJE = lekcije();

// ---------- model napretka (nezavisna implementacija Leitner pravila iz kviz.py) ----------

class Model {
  constructor(strogo) { this.p = new Map(); this.strogo = strogo; }
  prim(qid, tacno, nesiguran, zapis, danas, sada) {
    const s = this.p.get(qid) ?? {kutija: 0, tacno: 0, netacno: 0, sledece: null, istorija: []};
    const nova = s.istorija.length === 0;
    s.istorija.push([danas, tacno ? "T" : "N", (nesiguran ? "? " : "") + zapis]);
    if (tacno) { s.tacno++; s.kutija = nesiguran ? 2 : (nova ? 3 : Math.min(5, s.kutija + 1)); }
    else { s.netacno++; s.kutija = 1; }
    s.sledece = dodajDane(danas, INTERVAL[s.kutija]);
    s.zadnje = sada;
    this.p.set(qid, s);
  }
  // pitanja koja bi tura „uči“ vratila (dospela + nova), kao kviz.sledeca(); sada = Date iz stranice
  tura(n, danas, granica, pred) {
    let due = [];
    for (const [id, s] of this.p) {
      if (s.kutija >= 1 && s.kutija <= 4 && s.sledece && s.sledece <= danas && (s.zadnje || "") <= granica) due.push([s.kutija, -Q.get(id).bodova, String(id)]);
    }
    due.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
    let ids = due.map(x => +x[2]);
    if (pred) ids = ids.filter(i => this.p.get(i).kutija <= 2);
    const nove = redosled(pred).filter(id => { const s = this.p.get(id); return !s || (s.kutija === 0 && !s.istorija.length); });
    return ids.concat(nove).slice(0, n);
  }
  greske(n) {
    const k = [...this.p].filter(([, s]) => s.istorija.length && s.kutija <= 2).map(([id, s]) => ({id, kutija: s.kutija, netacno: s.netacno, bodova: Q.get(id).bodova}));
    k.sort((a, b) => (a.kutija - b.kutija) || (b.netacno - a.netacno) || (b.bodova - a.bodova) || (a.id - b.id));
    return k.slice(0, n);
  }
  brojGresaka() { return [...this.p.values()].filter(s => s.kutija === 1).length; }
  dospelo(danas) { return [...this.p.values()].filter(s => s.kutija >= 1 && s.kutija <= 4 && s.sledece && s.sledece <= danas).length; }
  // poredi sa stvarnim stanjem; „zadnje“ se proverava samo po obliku (tačan trenutak se ne zna)
  proveri(st, naziv) {
    const razlike = [];
    for (const [id, s] of this.p) {
      const v = st.pitanja[String(id)];
      if (!v) { razlike.push(`nema zapisa za ${id}`); continue; }
      for (const k of ["kutija", "tacno", "netacno", "sledece"]) if (v[k] !== s[k]) razlike.push(`${id}.${k}: ${v[k]} ≠ ${s[k]}`);
      if (JSON.stringify(v.istorija) !== JSON.stringify(s.istorija)) razlike.push(`${id}.istorija: ${JSON.stringify(v.istorija)} ≠ ${JSON.stringify(s.istorija)}`);
      if (s.zadnje && !(Math.abs(sekunde(v.zadnje) - sekunde(s.zadnje)) <= 5)) razlike.push(`${id}.zadnje: ${v.zadnje} ≠ ~${s.zadnje}`);
    }
    for (const [k, v] of Object.entries(st.pitanja)) {
      const prazan = (v.kutija ?? 0) === 0 && !(v.istorija ?? []).length;
      if (!this.p.has(+k) && (this.strogo || !prazan)) razlike.push(`višak zapisa ${k}`);
    }
    ok(!razlike.length, `${naziv}: napredak odgovara modelu (${this.p.size} pitanja)`, razlike.slice(0, 5).join("; "));
  }
}

function proveriSemu(st) {
  const g = [], jeObj = x => x !== null && typeof x === "object" && !Array.isArray(x), datum = s => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s);
  if (!jeObj(st)) return ["nije objekat"];
  const dozvoljeni = new Set(["pitanja", "tura", "dnevnik", "spremnost", "ispiti"]);
  for (const k of Object.keys(st)) if (!dozvoljeni.has(k)) g.push(`neočekivan ključ ${k}`);
  if (!jeObj(st.pitanja)) g.push("pitanja nije objekat");
  for (const k of ["tura", "dnevnik"]) if (!Array.isArray(st[k])) g.push(`${k} nije niz`);
  if (st.ispiti !== undefined && !Array.isArray(st.ispiti)) g.push("ispiti nije niz");
  if (st.spremnost !== undefined && !jeObj(st.spremnost)) g.push("spremnost nije objekat");
  for (const [id, v] of Object.entries(st.pitanja || {})) {
    if (!Q.has(+id) || !/^\d+$/.test(id)) g.push(`nepoznat id ${id}`);
    if (!jeObj(v)) { g.push(`${id} nije objekat`); continue; }
    for (const k of Object.keys(v)) if (!["kutija", "tacno", "netacno", "sledece", "zadnje", "istorija"].includes(k)) g.push(`${id}: ključ ${k}`);
    if (!(Number.isInteger(v.kutija) && v.kutija >= 0 && v.kutija <= 5)) g.push(`${id}.kutija ${v.kutija}`);
    for (const k of ["tacno", "netacno"]) if (!(Number.isInteger(v[k]) && v[k] >= 0)) g.push(`${id}.${k} ${v[k]}`);
    if (!(v.sledece === null || datum(v.sledece))) g.push(`${id}.sledece ${v.sledece}`);
    if (v.zadnje !== undefined && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(v.zadnje)) g.push(`${id}.zadnje ${v.zadnje}`);
    if (!Array.isArray(v.istorija)) { g.push(`${id}.istorija`); continue; }
    for (const h of v.istorija) if (!(Array.isArray(h) && h.length === 3 && datum(h[0]) && (h[1] === "T" || h[1] === "N") && typeof h[2] === "string")) g.push(`${id}: loša istorija ${JSON.stringify(h)}`);
    if (v.tacno !== v.istorija.filter(h => h[1] === "T").length || v.netacno !== v.istorija.filter(h => h[1] === "N").length) g.push(`${id}: tacno/netacno ne odgovara istoriji`);
  }
  for (const [d, v] of Object.entries(st.spremnost || {})) if (!datum(d) || !(Number.isInteger(v) && v >= 0 && v <= 100)) g.push(`spremnost ${d}=${v}`);
  for (const e of st.ispiti || []) {
    if (!(jeObj(e) && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(e.kad) && Number.isInteger(e.bod) && Number.isInteger(e.max) && Number.isInteger(e.tacnih) && jeObj(e.gubitak) && Array.isArray(e.pogresna) && e.pogresna.every(Number.isInteger))) g.push(`loš ispit ${JSON.stringify(e)}`);
  }
  return g;
}

// ---------- infrastruktura (serveri, pregledač) ----------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kviz-e2e-"));
const SITE = path.join(KOREN, `_e2e_site_${process.pid}`);   // napravi_sajt.sh traži izlaz unutar repoa
const procesi = [];
function ocisti() {
  for (const p of procesi) { try { p.kill("SIGKILL"); } catch (_) { /* već ugašen */ } }
  fs.rmSync(SITE, {recursive: true, force: true});
  fs.rmSync(TMP, {recursive: true, force: true});
}
process.on("exit", ocisti);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

function slobodanPort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function cekajHttp(url, ms = 15000) {
  const kraj = Date.now() + ms;
  while (Date.now() < kraj) { try { const r = await fetch(url); if (r.status < 500) return; } catch (_) { /* još ne radi */ } await pauza(100); }
  throw new Error(`server ne odgovara: ${url}`);
}
function pokreni(cmd, args, opcije) {
  const p = spawn(cmd, args, {stdio: ["ignore", "pipe", "pipe"], ...opcije});
  p.izlaz = ""; p.stdout.on("data", d => { p.izlaz += d; }); p.stderr.on("data", d => { p.izlaz += d; });
  procesi.push(p);
  return p;
}
function nadjiChromium() {
  const baza = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  for (const [prefiks, bin] of [["chromium-", "chrome-linux/chrome"], ["chromium_headless_shell-", "chrome-linux/headless_shell"]]) {
    for (const d of fs.readdirSync(baza).filter(x => x.startsWith(prefiks)).sort().reverse()) {
      const f = path.join(baza, d, bin);
      if (fs.existsSync(f)) return f;
    }
  }
  throw new Error(`nema chromiuma u ${baza}`);
}

// ---------- praćenje stranica ----------

const ZAHTEVI = [];            // svi zahtevi ka lokalnim serverima
const SPOLJNI = new Map();     // host -> broj zahteva koje smo presreli
const SLIKE = new Map();       // url slike -> {status, tip}
const UCITANE_SLIKE = new Set();
let LOKALNI_PORTOVI = new Set();

async function spoljniZahtevi(ctx) {
  await ctx.route(u => (u.protocol === "http:" || u.protocol === "https:") && !(u.hostname === "127.0.0.1" && LOKALNI_PORTOVI.has(+u.port)), route => {
    const h = new URL(route.request().url()).hostname;
    SPOLJNI.set(h, (SPOLJNI.get(h) || 0) + 1);
    route.fulfill({status: 200, contentType: route.request().resourceType() === "stylesheet" ? "text/css" : "application/octet-stream", body: ""});
  });
}
function prati(page, naziv) {
  page.on("request", r => ZAHTEVI.push({scen, naziv, url: r.url(), metod: r.method(), tip: r.resourceType()}));
  page.on("requestfailed", r => {
    const f = r.failure()?.errorText || "";
    if (r.resourceType() === "image" && /ABORTED/.test(f)) return;   // slika prekinuta osvežavanjem stranice
    ok(false, `neuspeo zahtev (${naziv}): ${r.method()} ${r.url()}`, f);
  });
  page.on("response", r => {
    const u = r.url();
    if (u.includes("/slike/")) SLIKE.set(u, {status: r.status(), tip: r.headers()["content-type"]});
    if (r.status() >= 400) ok(false, `HTTP ${r.status()} (${naziv}): ${u}`);
  });
  page.on("console", m => { if (m.type() === "error") ok(false, `greška u konzoli (${naziv}): ${m.text()}`, m.location().url); });
  page.on("pageerror", e => ok(false, `pageerror (${naziv}): ${e.message}`));
  page.on("dialog", d => { ok(false, `neočekivan dijalog (${naziv}): ${d.message()}`); d.dismiss(); });
  page.setDefaultTimeout(15000);
}

// „sat“ stranice se može pomeriti (window.__skew u ms) da bi se probalo pravilo „greška se vraća posle 10 min“
function skewSkripta() {
  const R = Date, sad = () => R.now() + (window.__skew || 0);
  function D(...a) { if (!new.target) return new R(sad()).toString(); return Reflect.construct(R, a.length ? a : [sad()], new.target); }
  D.prototype = R.prototype; Object.setPrototypeOf(D, R); D.now = sad;
  window.Date = D;
}

let browser;
async function noviKontekst(opcije = {}) {
  const ctx = await browser.newContext({reducedMotion: "reduce", viewport: {width: 1100, height: 900}, ...opcije});
  await ctx.addInitScript(skewSkripta);
  await spoljniZahtevi(ctx);
  return ctx;
}
async function otvori(ctx, url, naziv) {
  const page = await ctx.newPage();
  prati(page, naziv); aktivna = page;
  await page.goto(url);
  return page;
}

// ---------- pomoćnici za interfejs ----------

const danasStranice = page => page.evaluate(() => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; });
const sadaStranice = page => page.evaluate(() => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; });
const granicaStranice = async (page, min = 10) => { const s = await sadaStranice(page), t = new Date(utc(s.slice(0, 10)) + (+s.slice(11, 13) * 3600 + +s.slice(14, 16) * 60 + +s.slice(17, 19) - min * 60) * 1000);
  return `${t.getUTCFullYear()}-${dv(t.getUTCMonth() + 1)}-${dv(t.getUTCDate())}T${dv(t.getUTCHours())}:${dv(t.getUTCMinutes())}:${dv(t.getUTCSeconds())}`; };
const pomeriSat = (page, min) => page.evaluate(m => { window.__skew = m * 60e3; }, min);
const citajNapredak = page => page.evaluate(() => { const s = localStorage.getItem("kviz.napredak"); return s === null ? null : JSON.parse(s); });
const sirovNapredak = page => page.evaluate(() => localStorage.getItem("kviz.napredak"));

async function cekajPocetnu(page) { await page.waitForSelector("#nastavi"); await page.waitForFunction(() => !document.querySelector(".skel")); }
async function pocetnaBrojke(page) {
  await cekajPocetnu(page);
  return page.evaluate(() => ({
    naslov: document.querySelector(".home-top h1")?.textContent.trim(),
    novih: document.querySelector(".ringwrap .c b")?.textContent, od: document.querySelector(".ringwrap .c span")?.textContent,
    redovi: Object.fromEntries([...document.querySelectorAll(".hero-stats .row")].map(r => [r.children[0].textContent.trim(), r.children[1].textContent.trim()])),
    nastavi: document.querySelector("#nastavi small")?.textContent.trim(), greske: document.querySelector("#greskebtn .chip")?.textContent ?? null,
    postavke: !!document.querySelector("#postbtn"), plan: [...document.querySelectorAll(".overline")].map(e => e.textContent.trim()),
    tekst: document.body.innerText,
  }));
}

async function citajPitanje(page) {
  await page.waitForSelector("#app .opts .opt");
  const r = await page.evaluate(() => ({
    ids: [...document.querySelectorAll("#app .opts .opt")].map(o => +o.dataset.id),
    opcije: [...document.querySelectorAll("#app .opts .opt")].map(o => { const c = o.querySelector(".tx").cloneNode(true); c.querySelector(".st")?.remove(); return c.textContent; }),
    tekst: document.querySelector(".qtext")?.textContent ?? "",
    chips: [...document.querySelectorAll(".qmeta .chip")].map(c => c.textContent.replace(/\s+/g, " ").trim()),
    slika: document.querySelector("#qimg img")?.getAttribute("src") ?? null,
    lekcija: document.querySelector(".qmeta + .label")?.textContent ?? null,
  }));
  r.q = OPT.get(r.ids[0]);
  if (!r.q) throw new Error("nepoznat id odgovora " + r.ids[0]);
  r.qid = r.q.id;
  return r;
}
function proveriPrikaz(r) {
  const q = r.q;
  const ista = JSON.stringify([...r.ids].sort()) === JSON.stringify(q.odgovori.map(o => o.id).sort());
  ok(ista && normalizuj(r.tekst) === normalizuj(q.tekst) && (r.slika || null) === (q.slika || null), `pitanje ${q.id}: tekst, slika i odgovori se poklapaju sa pitanja.json`, {ids: r.ids, tekst: r.tekst});
  const tekstovi = r.ids.map((id, i) => [id, normalizuj(r.opcije[i])]), ocek = new Map(q.odgovori.map(o => [o.id, normalizuj(o.tekst)]));
  ok(tekstovi.every(([id, t]) => ocek.get(id) === t), `pitanje ${q.id}: tekstovi odgovora se poklapaju`);
}
async function proveriSliku(page, r) {
  if (!r.slika) return;
  const kraj = await page.waitForFunction(() => { const i = document.querySelector("#qimg img"); return i && i.complete && i.naturalWidth > 0 && getComputedStyle(i).opacity === "1" ? i.currentSrc : null; }).then(h => h.jsonValue()).catch(() => null);
  if (ok(kraj, `slika ${r.slika} se učitala (naturalWidth > 0)`)) {
    UCITANE_SLIKE.add(kraj);
    ok(new URL(kraj).pathname === (page.url().includes(PODPUTANJA) ? PODPUTANJA : "/") + r.slika, `slika je pod pravom putanjom: ${new URL(kraj).pathname}`);
  }
}

// koje odgovore označiti: tačne ili „skoro“ tačne (bar jedan pogrešan, ukupno treba)
function izbor(q, akcija) {
  const tacni = q.odgovori.filter(o => o.tacno).map(o => o.id), pogresni = q.odgovori.filter(o => !o.tacno).map(o => o.id), n = q.treba_zaokruziti;
  if (akcija !== "pogresno") return tacni;
  return (q.id % 2 === 0 && pogresni.length >= n) ? pogresni.slice(0, n) : [pogresni[0], ...tacni].slice(0, n);
}
async function oznaci(page, q, ids) {
  const n = q.treba_zaokruziti;
  for (const [k, id] of ids.entries()) {
    await page.click(`.opt[data-id="${id}"]`);
    if (n > 1) {   // višestruki izbor: dugme „Proveri“ čeka da bude označeno tačno `treba` odgovora
      const uk = k + 1, dugme = await page.locator("#proveri").evaluate(b => ({dis: b.disabled, tekst: b.textContent})), need = await page.locator("#need").evaluate(e => ({cls: e.className, tekst: e.textContent.replace(/\s+/g, " ")}));
      if (uk < n) ok(dugme.dis && dugme.tekst.includes("Označi još") && need.cls.includes("left") && need.tekst.includes(`${uk}/${n}`), `višestruki izbor ${q.id}: posle ${uk}/${n} „Proveri“ je isključeno`, {dugme, need});
      else ok(!dugme.dis && need.cls.includes("met"), `višestruki izbor ${q.id}: posle ${uk}/${n} „Proveri“ je uključeno`, {dugme, need});
    }
  }
  const sel = await page.locator(".opt.sel").count();
  ok(sel === ids.length, `označeno ${sel} od ${ids.length} odgovora`);
}
const zapisOdgovora = (q, ids, prefiks) => prefiks + q.odgovori.filter(o => ids.includes(o.id)).map(o => Array.from(o.tekst).slice(0, 40).join("")).join(" | ");

// jedna tura: odgovara se po `politika`, čuva se redosled pojavljivanja i proverava se povratna informacija
// o = {politika({idx, ponovo, ponavljanja, q}) -> "tacno"|"pogresno"|"nesiguran", ocekivano: [id...], model, stanje(): state|null, prefiks}
async function voziTuru(page, o) {
  const log = [], prvi = new Map(), ponavljanja = new Map(), red = o.ocekivano ? o.ocekivano.map(id => ({id, ponovo: false})) : null;
  for (let i = 0; i < 400; i++) {
    await page.waitForSelector("#qwrap .opt, .tiles");
    if (await page.locator(".tiles").count()) break;
    const pr = await citajPitanje(page), q = pr.q, ponovo = pr.chips.some(c => c.includes("još jednom"));
    proveriPrikaz(pr); await proveriSliku(page, pr);
    if (red) {
      const e = red[i];
      ok(e && e.id === q.id && e.ponovo === ponovo, `mesto ${i + 1} u turi: očekivano ${e ? e.id + (e.ponovo ? "↻" : "") : "kraj"}, prikazano ${q.id}${ponovo ? "↻" : ""}`);
    }
    const idx = ponovo ? prvi.get(q.id).idx : prvi.size, brp = ponavljanja.get(q.id) || 0;
    const akcija = o.politika({idx, ponovo, ponavljanja: brp, q}), ids = izbor(q, akcija), nes = akcija === "nesiguran";
    if (!ponovo && !pr.chips.some(c => c.includes("ponavljanje") || c.includes("novo"))) ok(false, `pitanje ${q.id}: nema oznake „novo“/„ponavljanje“`, pr.chips);
    await oznaci(page, q, ids);
    const sada = await sadaStranice(page), danas = sada.slice(0, 10);
    await page.click(nes ? "#nesig" : "#proveri");
    await page.waitForSelector("#sheet.on");
    const sh = await page.evaluate(() => ({cls: document.querySelector("#sheet").className, naslov: document.querySelector("#sht").textContent.trim(), telo: document.querySelector("#sheet .sh-b").innerText,
      stavke: [...document.querySelectorAll("#sheet .sh-b li")].map(l => l.textContent.trim()), dalje: document.querySelector("#dalje").textContent.replace("↵", "").trim()}));
    const tacno = JSON.stringify([...ids].sort()) === JSON.stringify(q.odgovori.filter(x => x.tacno).map(x => x.id).sort());
    if (nes) ok(sh.cls.includes("warn") && sh.naslov === "Tačno, ali pogađao si", `„Nisam siguran“ ${q.id}: žuta povratna informacija`, sh);
    else if (tacno) ok(sh.cls.includes("ok") && /^(Tačno!|Bravo!|Odlično!|Tako je!|Precizno!|Nezaustavljiv!)$/.test(sh.naslov) && /\+\d bod/.test(sh.telo), `tačan odgovor ${q.id}: zelena povratna informacija`, sh);
    else ok(sh.cls.includes("bad") && sh.naslov === "Netačno" && JSON.stringify(sh.stavke.map(normalizuj).sort()) === JSON.stringify(q.odgovori.filter(x => x.tacno).map(x => normalizuj(x.tekst)).sort()), `netačan odgovor ${q.id}: crvena povratna informacija sa tačnim odgovorima`, sh);
    const stanja = await page.evaluate(() => [...document.querySelectorAll("#app .opt")].map(b => ({id: +b.dataset.id, cls: b.className, st: b.querySelector(".st").textContent, dis: b.disabled})));
    const losa = stanja.filter(s => {
      const t = q.odgovori.find(x => x.id === s.id).tacno, i = ids.includes(s.id);
      const [kl, st] = t && i ? ["ok", "Tačno"] : i ? ["bad", "Netačno"] : t ? ["miss", "Tačan odgovor · propušteno"] : ["dim", ""];
      return !(s.cls.split(" ").includes(kl) && s.st === st && s.dis);
    });
    ok(!losa.length, `pitanje ${q.id}: stanje odgovora posle provere (boja + tekst)`, losa);
    // zapis u napretku (samo prvi pokušaj u turi; ponovljeni pokušaj greške se ne beleži)
    if (!ponovo) {
      o.model?.prim(q.id, tacno, nes, zapisOdgovora(q, ids, o.prefiks), danas, sada);
      prvi.set(q.id, {idx, akcija, tacno, nes, ids});
    }
    ponavljanja.set(q.id, brp + 1);
    if (o.stanje) {
      const st = await o.stanje(), v = st?.pitanja?.[String(q.id)], m = o.model?.p.get(q.id);
      if (m) ok(v && v.kutija === m.kutija && v.istorija.length === m.istorija.length && JSON.stringify(v.istorija.at(-1)) === JSON.stringify(m.istorija.at(-1)) && v.sledece === m.sledece && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(v.zadnje || ""), `zapis ${q.id} posle odgovora${ponovo ? " (ponovljen pokušaj se ne beleži)" : ""}`, {v, m});
    }
    log.push({qid: q.id, ponovo, akcija, tacno, nes, naslov: sh.naslov});
    if (!tacno) { if (red) red.splice(Math.min(i + 4, red.length), 0, {id: q.id, ponovo: true}); }
    ok(sh.dalje === (i + 1 >= (red ? red.length : 1e9) ? "Završi turu" : "Dalje") || !red, `dugme „${sh.dalje}“ na mestu ${i + 1}`);
    await page.click("#dalje");
  }
  return {log, prvi};
}

async function proveriRezultatTure(page, prvi) {
  const prve = [...prvi.values()], sve = prve.length, tacno = prve.filter(x => x.tacno).length;
  const bod = [...prvi].filter(([, x]) => x.tacno).reduce((a, [id]) => a + Q.get(id).bodova, 0), maks = [...prvi.keys()].reduce((a, id) => a + Q.get(id).bodova, 0);
  const p = pct(tacno, sve);
  await page.waitForFunction(v => document.querySelector("#brojac")?.textContent === v, p + "%");
  const r = await page.evaluate(() => ({plocice: [...document.querySelectorAll(".tile b")].map(b => b.textContent), chip: document.querySelector(".chip[style]")?.textContent.trim(), nad: document.querySelector(".overline")?.textContent.trim()}));
  jednako(r.plocice, [String(tacno), String(sve - tacno), `${bod}/${maks}`], "rezime ture: pločice tačno/greške/bodovi");
  ok(r.chip === (p >= 92 ? "Spreman nivo" : p >= 85 ? "Prolaz, ali tesno" : "Još malo"), `rezime ture: ocena za ${p}%`, r);
  ok(await page.locator("#kuci").isVisible() && await page.locator("#jos").isVisible(), "rezime ture: dugmad „Početna“ i „Sledeća tura“");
  return {tacno, sve, bod, maks};
}

// ---------- ispit ----------

async function voziIspit(page, o) {
  await page.click("#ispitbtn");
  await page.waitForSelector("#modal.on #mda");
  ok((await page.locator("#modalbox").innerText()).includes("41 pitanje"), "ispit: uvodni dijalog");
  await page.click("#mda");
  await page.waitForSelector(".chip:has-text('Pitanje 1/41')");
  const ids = [], odg = [];   // {q, izabrano:[] }
  let zastavica = null;
  for (let i = 0; i < 41; i++) {
    await page.waitForSelector(`.chip:has-text('Pitanje ${i + 1}/41')`);
    const pr = await citajPitanje(page), q = pr.q;
    proveriPrikaz(pr); await proveriSliku(page, pr);
    ids.push(q.id);
    const akcija = i % 7 === 0 ? "bez" : i % 5 === 1 ? "pogresno" : "tacno", izabrano = akcija === "bez" ? [] : izbor(q, akcija);
    for (const id of izabrano) await page.click(`.opt[data-id="${id}"]`);
    odg.push({q, izabrano});
    if (i === 3) { await page.click("#zast"); zastavica = q.id; ok(await page.locator(".chip.warn:has-text('obeleženo')").count() === 1, "ispit: pitanje je obeleženo zastavicom"); }
    if (i === 11) {   // nazad i napred: odgovor je zapamćen, a ispit ne daje povratnu informaciju
      await page.click("#pret"); await page.waitForSelector(`.chip:has-text('Pitanje 11/41')`);
      const prosli = odg[10], sel = await page.evaluate(() => [...document.querySelectorAll(".opt.sel")].map(b => +b.dataset.id));
      jednako(sel.sort(), [...prosli.izabrano].sort(), "ispit: odgovor na prethodnom pitanju je zapamćen");
      ok(!(await page.locator("#sheet.on").count()), "ispit: nema povratne informacije tokom ispita");
      await page.click("#sled"); await page.waitForSelector(`.chip:has-text('Pitanje 12/41')`);
      const opet = await page.evaluate(() => [...document.querySelectorAll(".opt.sel")].map(b => +b.dataset.id));
      jednako(opet.sort(), [...izabrano].sort(), "ispit: odgovor na trenutnom pitanju je zapamćen posle povratka");
    }
    if (i === 20) {   // pregled pitanja (mreža 41)
      await page.click("#mreza"); await page.waitForSelector("#modal.on .g41");
      const m = await page.evaluate(() => ({uk: document.querySelectorAll("#modal .g41").length, ans: document.querySelectorAll("#modal .g41.ans").length, fl: document.querySelectorAll("#modal .g41.fl").length, cur: document.querySelector("#modal .g41.cur")?.textContent}));
      const odgovorenih = odg.filter(x => x.izabrano.length === x.q.treba_zaokruziti).length;
      jednako(m, {uk: 41, ans: odgovorenih, fl: 1, cur: "21"}, "ispit: mreža pregleda (41, odgovoreno, zastavica, trenutno)");
      await page.click("#mx"); await page.waitForSelector("#modal:not(.on)", {state: "attached"});
    }
    if (i < 40) await page.click("#sled"); else { ok((await page.locator("#sled").textContent()).includes("Predaj ispit"), "ispit: poslednje pitanje nudi „Predaj ispit“"); }
  }
  // kvote: 41 jedinstveno pitanje, 98–99 bodova, po oblastima kao na pravom ispitu
  const poOblasti = {}; ids.forEach(id => { const b = Q.get(id).oblast_br; poOblasti[b] = (poOblasti[b] || 0) + 1; });
  const zbir = ids.reduce((a, id) => a + Q.get(id).bodova, 0);
  ok(new Set(ids).size === 41, "ispit: 41 različito pitanje");
  ok(zbir === 98 || zbir === 99, `ispit: ukupno ${zbir} bodova (98–99)`);
  jednako(Object.fromEntries(Object.entries(poOblasti).sort()), Object.fromEntries(Object.entries(KVOTA).sort()), "ispit: kvote po oblastima");
  await page.click("#sled");
  await page.waitForSelector("#modal.on #mda");
  const bez = odg.filter(x => x.izabrano.length !== x.q.treba_zaokruziti).length;
  const tekst = await page.locator("#modalbox").innerText();
  ok(bez === 0 ? tekst.includes("Sva pitanja su odgovorena") : tekst.includes(`${bez} pitanja`), `ispit: potvrda predaje (${bez} bez odgovora)`, tekst);
  ok(tekst.includes("Obeleženo: 1"), "ispit: potvrda predaje pominje zastavicu");
  const sada = await sadaStranice(page), danas = sada.slice(0, 10);
  await page.click("#mda");
  await page.waitForSelector(".verdict");
  // ocena
  const tacni = odg.map(x => JSON.stringify([...x.izabrano].sort()) === JSON.stringify(x.q.odgovori.filter(a => a.tacno).map(a => a.id).sort()));
  const bod = odg.reduce((a, x, i) => a + (tacni[i] ? x.q.bodova : 0), 0), prag = Math.ceil(.85 * zbir), prosao = bod >= prag;
  const rez = await page.evaluate(() => ({verdikt: document.querySelector(".verdict").textContent.trim(), tekst: document.querySelector(".verdict + p").textContent.replace(/\s+/g, " "),
    ok: document.querySelectorAll(".grid41 .g41.ok").length, bad: document.querySelectorAll(".grid41 .g41.bad").length}));
  await page.waitForFunction(v => document.querySelector("#brojac")?.textContent === String(v), bod);
  ok(rez.verdikt === (prosao ? "✓ POLOŽIO BI" : "✕ NE BI PROŠAO"), `ispit: presuda (${bod}/${zbir}, prag ${prag})`, rez);
  ok(rez.tekst.includes(`prag ${prag} bodova`) && rez.tekst.includes(`${tacni.filter(Boolean).length}/41 tačnih`) && rez.tekst.includes(`${pct(bod, zbir)}%`), "ispit: rezime (procenat, prag, broj tačnih)", rez.tekst);
  jednako([rez.ok, rez.bad], [tacni.filter(Boolean).length, tacni.filter(x => !x).length], "ispit: mreža rezultata (tačno/netačno)");
  // zapisi: svih 41 pitanja se beleži sa prefiksom „ispit: “, tačno kao u server.py
  const gub = {}; odg.forEach((x, i) => { if (!tacni[i]) gub[x.q.oblast] = (gub[x.q.oblast] || 0) + x.q.bodova; });
  odg.forEach((x, i) => o.model?.prim(x.q.id, tacni[i], false, zapisOdgovora(x.q, x.izabrano, "ispit: "), danas, sada));
  return {ids, odg, bod, zbir, prag, tacni, gub, zastavica};
}

async function proveriPoslednjiIspit(st, ex) {
  const e = st.ispiti.at(-1);
  jednako({bod: e.bod, max: e.max, tacnih: e.tacnih, gubitak: e.gubitak, pogresna: [...e.pogresna].sort((a, b) => a - b)},
    {bod: ex.bod, max: ex.zbir, tacnih: ex.tacni.filter(Boolean).length, gubitak: ex.gub, pogresna: ex.ids.filter((id, i) => !ex.tacni[i]).sort((a, b) => a - b)}, "ispit: poslednji zapis u „ispiti“");
  ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(e.kad), "ispit: „kad“ ima oblik YYYY-MM-DDTHH:MM", e.kad);
}

// ---------- raspored (mobilni) ----------

function rasporedUStranici({selektor, mete, kontrast}) {
  const korena = document.querySelector(selektor), vp = innerWidth, issues = [], r0 = korena.getBoundingClientRect();
  if (document.documentElement.scrollWidth > vp + 0.5) issues.push(`horizontalni skrol: ${document.documentElement.scrollWidth} > ${vp}`);
  if (r0.left < -0.5 || r0.right > vp + 0.5) issues.push(`${selektor} van ekrana: ${Math.round(r0.left)}..${Math.round(r0.right)} / ${vp}`);
  if (korena.scrollWidth > korena.clientWidth + 0.5) issues.push(`${selektor} ima unutrašnji horizontalni skrol`);
  for (const e of korena.querySelectorAll("*")) {
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (r.left < r0.left - 0.5 || r.right > r0.right + 0.5) issues.push(`izlazi iz okvira: ${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""} ${Math.round(r.left)}..${Math.round(r.right)} (okvir ${Math.round(r0.left)}..${Math.round(r0.right)})`);
  }
  for (const b of mete ? korena.querySelectorAll("button, input") : []) {
    if (b.type === "hidden" || b.hidden) continue;
    const r = b.getBoundingClientRect(); if (r.width && (r.height < 44 || r.width < 44)) issues.push(`premala meta za dodir: ${b.tagName.toLowerCase()}#${b.id} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // kontrast teksta (WCAG, 4.5:1) prema prvoj nepoluprovidnoj pozadini; isključena dugmad i polja
  const parse = c => { let m = c.match(/rgba?\(([^)]+)\)/); if (m) { const p = m[1].split(/[ ,/]+/).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = c.match(/color\(srgb ([^)]+)\)/); if (m) { const p = m[1].split(/[ /]+/).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; } return null; };
  const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
  const pozadina = e => { for (let x = e; x; x = x.parentElement) { const c = parse(getComputedStyle(x).backgroundColor); if (c && c[3] >= .95) return c; } return [255, 255, 255, 1]; };
  for (const e of kontrast ? korena.querySelectorAll("*") : []) {
    if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (e.closest("button, input, [disabled]")) continue;
    const s = getComputedStyle(e), f = parse(s.color), b = pozadina(e); if (!f || !b) continue;
    const l1 = lum(f), l2 = lum(b), k = (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05);
    if (k < 4.5) issues.push(`slab kontrast ${k.toFixed(2)}: „${e.textContent.trim().slice(0, 30)}“ (${s.color} na rgb(${b.slice(0, 3).map(Math.round)}))`);
  }
  return issues;
}
// u modalu (novi UI) važe i mete za dodir i kontrast; za ostatak stranice samo prelivanje (postojeći dizajn)
async function proveriRaspored(page, selektor, naziv) {
  const modal = selektor === "#modalbox";
  const issues = await page.evaluate(rasporedUStranici, {selektor, mete: modal, kontrast: modal});
  ok(!issues.length, `raspored (${naziv}): bez prelivanja${modal ? ", malih meta i slabog kontrasta" : ""}`, issues.slice(0, 6).join("; "));
}

// ---------- postavke ----------

async function otvoriPostavke(page) { await page.click("#postbtn"); await page.waitForSelector("#modal.on #ispdat"); }
async function uvezi(page, fajl) {
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#uvezi")]);
  await fc.setFiles(fajl);
}
const modalVidljiv = page => page.evaluate(() => document.querySelector("#modal").classList.contains("on"));

// ---------- paritet sa Python serverom ----------

async function paritetSaPythonom(sp, stariFajl, dani) {
  const naziv = dani === null ? "bez datuma ispita" : `ispit za ${dani} d.`;
  const dir = fs.mkdtempSync(path.join(TMP, "podaci-paritet-"));
  fs.symlinkSync(path.join(KOREN, "pitanja.json"), path.join(dir, "pitanja.json")); fs.symlinkSync(path.join(KOREN, "slike"), path.join(dir, "slike"));
  fs.copyFileSync(stariFajl, path.join(dir, "napredak.json"));
  const port = await slobodanPort(); LOKALNI_PORTOVI.add(port);
  const env = {...process.env, KVIZ_PODACI: dir, KVIZ_PORT: String(port), PYTHONDONTWRITEBYTECODE: "1"}; delete env.KVIZ_ISPIT;
  if (dani !== null) env.KVIZ_ISPIT = dodajDane(lokalniIso(), dani);
  const srv = pokreni("python3", ["server.py", "--bez-browsera"], {cwd: KOREN, env}), baza = `http://127.0.0.1:${port}/`;
  await cekajHttp(baza);
  const py = async u => (await fetch(baza + u)).json(), js = u => sp.evaluate(x => KVIZ.api(x), u);
  await sp.evaluate(iso => KVIZ.setIspit(iso), dani === null ? null : env.KVIZ_ISPIT);
  const bez = P => { const c = JSON.parse(JSON.stringify(P)); delete c.sansa_prolaz; delete c.ocekivano; return c; };
  const pP = await py("api/pocetna"), pJ = await js("/api/pocetna"), A = bez(pP), B = bez(pJ), razlike = [];
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) razlike.push(`${k}: ${JSON.stringify(A[k]).slice(0, 150)} ≠ ${JSON.stringify(B[k]).slice(0, 150)}`);
  ok(!razlike.length, `paritet (${naziv}): /api/pocetna iz Pythona i iz kviz.js (osim Monte Karlo)`, razlike.slice(0, 4).join("\n      "));
  ok(Math.abs(pP.sansa_prolaz - pJ.sansa_prolaz) <= 6 && Math.abs(pP.ocekivano - pJ.ocekivano) <= 3, `paritet (${naziv}): šansa/očekivano u toleranciji (Python ${pP.sansa_prolaz}/${pP.ocekivano}, JS ${pJ.sansa_prolaz}/${pJ.ocekivano})`);
  const sazetak = r => ({pregled: r.pregled, pitanja: r.pitanja.map(q => [q.id, q.tekst, q.oblast, q.lekcija, q.bodova, q.treba, q.slika, q.ponavljanje, q.gresaka, q.kutija, q.lekcija_i, q.oblast_br, q.odgovori.map(o => o.id).sort((a, b) => a - b)])});
  const stariSt = JSON.parse(fs.readFileSync(stariFajl, "utf8"));
  const kg = r => r.pitanja.map(q => { const x = stariSt.pitanja[String(q.id)]; return [x.kutija, -x.netacno, -q.bodova].join(","); });
  const uP = await py("api/tura?n=15&rezim=uci"), uJ = await js("/api/tura?n=15&rezim=uci");
  jednako(sazetak(uJ), sazetak(uP), `paritet (${naziv}): „Nastavi učenje“ (pitanja, redosled, polja)`);
  ok(uP.pitanja.filter(q => q.ponavljanje).length >= (dani === 1 || dani === 0 ? 3 : 10), `paritet (${naziv}): u turi „uči“ ima dospelih ponavljanja (${uP.pitanja.filter(q => q.ponavljanje).length})`);
  const gP = await py("api/tura?n=15&rezim=greske"), gJ = await js("/api/tura?n=15&rezim=greske");
  jednako(kg(gJ), kg(gP), `paritet (${naziv}): „Greške“ (redosled ključeva; izjednačenja se razlikuju samo po id-u)`);
  ok(new Set(gJ.pitanja.map(q => q.id)).size === gJ.pitanja.length && gJ.pitanja.length === gP.pitanja.length, `paritet (${naziv}): „Greške“ bez duplikata, isti broj (${gJ.pitanja.length})`);
  for (const l of [0, 5, 12]) {
    const lP = await py(`api/tura?n=15&rezim=lekcija&l=${l}`), lJ = await js(`/api/tura?n=15&rezim=lekcija&l=${l}`);
    jednako(sazetak(lJ), sazetak(lP), `paritet (${naziv}): lekcija ${l}`);
  }
  srv.kill();
  await sp.evaluate(() => KVIZ.setIspit(null));
}

// ---------- main ----------

const korenPre = LICNI.map(f => fs.existsSync(path.join(KOREN, f)));
fs.mkdirSync(OUT, {recursive: true});
for (const d of fs.readdirSync(KOREN).filter(x => /^_e2e_site_\d+$/.test(x))) {   // ostaci prekinutih pokretanja
  const pid = +d.slice(10); let ziv = true; try { process.kill(pid, 0); } catch (_) { ziv = false; }
  if (!ziv) fs.rmSync(path.join(KOREN, d), {recursive: true, force: true});
}

let uspeh = false;
try {
  // --- sajt ---
  let sajtIzlaz;
  try { sajtIzlaz = execFileSync(path.join(KOREN, "napravi_sajt.sh"), [SITE]).toString(); } catch (e) { throw new Error("napravi_sajt.sh nije uspeo: " + e.stderr + e.stdout); }
  const sadrzaj = fs.readdirSync(SITE).sort();
  fs.writeFileSync(path.join(SITE, ".gitignore"), "*\n");   // zaštita da ostatak prekinutog pokretanja ne završi u commit-u
  await scenario("0 izgradnja sajta (napravi_sajt.sh)", async () => {
    jednako(sadrzaj, [".napravi_sajt", "index.html", "kviz.js", "pitanja.json", "slike"], "sajt sadrži samo dozvoljene fajlove");
    ok(LICNI.every(f => !fs.existsSync(path.join(SITE, f)) && !fs.existsSync(path.join(SITE, "slike", f))), "nijedan lični fajl nije u sajtu");
    ok(fs.readdirSync(path.join(SITE, "slike")).length === fs.readdirSync(path.join(KOREN, "slike")).filter(f => f.endsWith(".jpg")).length, "sve slike su u sajtu");
    ok(sajtIzlaz.includes("Sajt je spreman"), "skripta javlja da je sajt spreman");
    const bez = spawnSyncStatus(path.join(KOREN, "napravi_sajt.sh"), [os.tmpdir()]);
    ok(bez !== 0, "napravi_sajt.sh odbija izlaz van repoa");
  });

  const roditelj = path.join(TMP, "sajt-roditelj"); fs.mkdirSync(roditelj);
  fs.symlinkSync(SITE, path.join(roditelj, "teorija-voznja"));
  const portS = await slobodanPort();
  pokreni("python3", ["-m", "http.server", String(portS), "--bind", "127.0.0.1", "--directory", roditelj]);
  const portR = await slobodanPort();   // isti sajt na korenu (kao sa sopstvenim domenom)
  pokreni("python3", ["-m", "http.server", String(portR), "--bind", "127.0.0.1", "--directory", SITE]);
  LOKALNI_PORTOVI = new Set([portS, portR]);
  const URL_S = `http://127.0.0.1:${portS}${PODPUTANJA}`;
  await cekajHttp(URL_S); await cekajHttp(`http://127.0.0.1:${portR}/`);

  browser = await chromium.launch({executablePath: nadjiChromium(), headless: !process.env.KVIZ_E2E_HEADED, args: ["--no-sandbox"]});
  const ctx = await noviKontekst();
  const model = new Model(true);
  const stanje = () => citajNapredak(page);
  let page, danas, ocekivaniIspit;

  // 1 ------------------------------------------------------------------------------------------------
  await scenario("1 početna u statičkom režimu", async () => {
    page = await otvori(ctx, URL_S, "glavna");
    const b = await pocetnaBrojke(page);
    const rezim = await page.evaluate(() => ({mod: window.KVIZ_MODE, kviz: typeof window.KVIZ, mem: window.KVIZ_STORAGE, meta: document.querySelector('meta[name="kviz-backend"]').content}));
    jednako(rezim, {mod: "static", kviz: "object", mem: "local", meta: "static"}, "režim je static, KVIZ postoji, localStorage radi");
    ok(b.naslov === "Vozački B" && b.postavke, "naslov „Vozački B“ i dugme „Postavke“ na početnoj", b);
    ok(await page.locator("#postbtn").getAttribute("aria-label") === "Postavke", "dugme ima aria-label „Postavke“");
    ok(b.novih === "0" && /^od \d+$/.test(b.od) && b.redovi["Ponavljanja"] === "0" && b.nastavi && b.greske === null, "prazna početna: 0 novih, 0 ponavljanja, bez grešaka", b);
    const z = ZAHTEVI.filter(x => x.naziv === "glavna");
    ok(z.some(x => x.url === URL_S + "pitanja.json" && x.metod === "GET"), "pitanja.json se učitava relativno, pod pod-putanjom");
    ok(z.some(x => x.url === URL_S + "kviz.js"), "kviz.js se učitava pod pod-putanjom");
    ok(!z.some(x => x.url.includes("/api/")), "statički režim ne zove /api/*", z.filter(x => x.url.includes("/api/")).map(x => x.url));
    ok(!z.some(x => new URL(x.url).pathname.startsWith("/slike/") || new URL(x.url).pathname === "/pitanja.json"), "nijedan zahtev ne ide na koren domena");
    for (const f of LICNI) { const r = await fetch(URL_S + f); ok(r.status === 404, `sajt ne služi ${f}`); }
    const prazno = await page.evaluate(() => KVIZ.api("/api/pocetna").then(P => ({sansa: P.sansa_prolaz, vid: P.pregled.vidjeno, ukupno: P.pregled.ukupno, lek: P.lekcije.length})));
    jednako([prazno.vid, prazno.ukupno, prazno.lek], [0, PITANJA.length, LEKCIJE.length], "prazan napredak: 0 viđeno, broj pitanja i lekcija iz pitanja.json");
    // prazna „Greške“ pre prvog odgovora
    await page.click("#greskebtn");
    await page.waitForSelector(".empty .t2");
    ok((await page.locator(".empty .t2").textContent()).includes("Nema grešaka"), "režim „Greške“ bez grešaka: poruka „Nema grešaka“");
    await page.click("#nazad"); await cekajPocetnu(page);
  });

  // 2 ------------------------------------------------------------------------------------------------
  await scenario("2 tura učenja, povratna informacija i ponovno učitavanje", async () => {
    const ocekivano = model.tura(15, await danasStranice(page), await granicaStranice(page), false);
    ok(ocekivano.length === 15 && ocekivano[0] === redosled(false)[0], "očekivana prva tura su prvih 15 pitanja po redosledu portala");
    await page.click("#nastavi");
    // 5 grešaka/nesigurnih u 15: pitanje #1 se greši dvaput zaredom, pa pogodi
    const politika = ({idx, ponovo, ponavljanja}) => (idx === 1 ? (ponavljanja < 2 ? "pogresno" : "tacno") : [4, 7].includes(idx) ? (ponovo ? "tacno" : "pogresno") : [2, 9].includes(idx) ? "nesiguran" : "tacno");
    const t = await voziTuru(page, {politika, ocekivano, model, stanje, prefiks: "app: "});
    ok(t.log.length === 15 + 2 + 1 + 1, `tura ima 15 pitanja + 4 ponavljanja grešaka (${t.log.length})`);
    const brGreske = [...t.prvi.values()].filter(x => !x.tacno).length;
    const rez = await proveriRezultatTure(page, t.prvi);
    jednako([rez.sve, rez.tacno, brGreske], [15, 12, 3], "tura: 15 pitanja, 12 tačno iz prve, 3 greške");
    const st = await stanje();
    jednako(proveriSemu(st), [], "napredak u localStorage ima pravu šemu (napredak.json)");
    model.proveri(st, "posle ture");
    jednako(Object.keys(st.pitanja).length, 15, "u napretku je tačno 15 pitanja");
    const e = st.pitanja[String(ocekivano[1])];
    ok(e && e.kutija === 1 && e.netacno === 1 && e.tacno === 0 && e.istorija.length === 1 && e.istorija[0][1] === "N", "pitanje pogrešeno dvaput u turi: samo jedan zapis, kutija 1 (ponovljeni pokušaji se ne beleže)", e);
    const nes = st.pitanja[String(ocekivano[2])];
    ok(nes.kutija === 2 && nes.istorija[0][2].startsWith("? app: ") && nes.sledece === dodajDane(await danasStranice(page), 1), "„nisam siguran“: kutija 2, zapis sa „? “, vraća se sutra", nes);
    ok(st.pitanja[String(ocekivano[0])].kutija === 3 && st.pitanja[String(ocekivano[0])].sledece === dodajDane(await danasStranice(page), 2), "tačno iz prve: kutija 3, vraća se za 2 dana");
    // ponovno učitavanje: napredak preživljava, početna ga prikazuje
    const pre = await sirovNapredak(page);
    await page.reload();
    const b = await pocetnaBrojke(page);
    const posle = await citajNapredak(page);
    jednako(posle.pitanja, JSON.parse(pre).pitanja, "posle osvežavanja napredak je isti (pitanja)");
    ok(proveriSemu(posle).length === 0 && posle.spremnost && Object.keys(posle.spremnost).length === 1, "početna beleži dnevni snimak šanse („spremnost“)");
    ok(b.novih === "15" && b.redovi["Novih pitanja"] === "još " + (+b.od.slice(3) - 15) || b.redovi["Novih pitanja"] === "✓ gotovo", "početna: 15 novih danas", b);
    ok(b.redovi["Ponavljanja"] === String(model.dospelo(await danasStranice(page))) && b.greske === String(model.brojGresaka()), `početna: ${model.dospelo(await danasStranice(page))} ponavljanja i ${model.brojGresaka()} grešaka`, b);
    ok(b.redovi["Tačnost danas"] === pct([...model.p.values()].reduce((a, s) => a + s.istorija.filter(h => h[1] === "T").length, 0), 15) + "%", "početna: tačnost danas", b.redovi);
    // drugi jezičak vidi isti napredak (storage se čita iznova pri svakom pozivu)
    const druga = await ctx.newPage(); prati(druga, "druga kartica"); await druga.goto(URL_S);
    ok((await pocetnaBrojke(druga)).novih === "15", "druga kartica vidi isti napredak");
    await druga.close(); aktivna = page;
    // odmah posle osvežavanja: greške NE ulaze u novu turu (razmak 10 min), nova pitanja idu dalje
    const ocek2 = model.tura(15, await danasStranice(page), await granicaStranice(page), false);
    ok(ocek2.every(id => !model.p.has(id)), "tura 2 (odmah): samo nova pitanja, greške se vraćaju tek posle ~10 min");
    await page.click("#nastavi");
    const t2 = await voziTuru(page, {politika: () => "tacno", ocekivano: ocek2, model, stanje, prefiks: "app: "});
    ok(t2.log.length === 15, "tura 2: 15 pitanja bez ponavljanja");
    await proveriRezultatTure(page, t2.prvi);
    model.proveri(await stanje(), "posle ture 2");
    // posle 11 minuta greške su dospele: idu prve (kutija, -bodova, id kao tekst), sa oznakom „ponavljanje · 1× pogrešeno“
    await page.click("#kuci"); await cekajPocetnu(page);
    await pomeriSat(page, 11);
    const ocek3 = model.tura(15, await danasStranice(page), await granicaStranice(page), false);
    const dosp = ocek3.filter(id => model.p.has(id));
    ok(dosp.length === 3 && dosp.every(id => model.p.get(id).kutija === 1), "tura 3 (+11 min): na početku su 3 dospele greške", dosp);
    await page.click("#nastavi");
    await page.waitForSelector("#qwrap .opt");
    const prvo = await citajPitanje(page);
    ok(prvo.qid === dosp[0] && prvo.chips.some(c => c.includes("ponavljanje") && c.includes("1× pogrešeno")), "tura 3: prvo pitanje je greška sa oznakom „↻ ponavljanje · 1× pogrešeno“", prvo.chips);
    const t3 = await voziTuru(page, {politika: () => "tacno", ocekivano: ocek3, model, stanje, prefiks: "app: "});
    ok(t3.log.length === 15, "tura 3: 15 pitanja");
    for (const id of dosp) { const s = (await stanje()).pitanja[String(id)]; ok(s.kutija === 2 && s.istorija.length === 2, `ispravljena greška ${id}: kutija 1 → 2`, s); }
    model.proveri(await stanje(), "posle ture 3");
    await pomeriSat(page, 0);
    await page.click("#kuci"); await cekajPocetnu(page);
    jednako(await page.locator("#greskebtn .chip").count(), 0, "posle ispravljenih grešaka nema crvene značke na „Greške“");
  });

  // 3 ------------------------------------------------------------------------------------------------
  await scenario("3 režim lekcije i režim „Greške“", async () => {
    // lekcije: lista, broj, ulaz u izabranu lekciju
    await page.click("#svelek");
    await page.waitForSelector(".lrow");
    jednako(await page.locator(".lrow").count(), LEKCIJE.length, "„Sve lekcije“ prikazuje sve lekcije iz pitanja.json");
    const tekstovi = await page.locator(".lrow .tt").allTextContents();
    ok(tekstovi.every((t, i) => normalizuj(t) !== "" && normalizuj(LEKCIJE[i].podoblast.replace(/;+$/, "")).startsWith(normalizuj(t).replace(/…$/, "").slice(0, 20))), "nazivi lekcija odgovaraju redosledu portala");
    const lekSaSlikom = LEKCIJE.findIndex((l, i) => i > 3 && Q.get(l.ids[0]).slika && l.ids.every(id => !model.p.has(id)));
    ok(lekSaSlikom > 0, `izabrana lekcija ${lekSaSlikom} (prva neviđena sa slikom)`);
    // slabija tura pre greške: nova pitanja u lekciji
    await page.click(`.lrow[data-l="${lekSaSlikom}"]`);
    const lek = LEKCIJE[lekSaSlikom], ocek = lek.ids.slice(0, 15);
    const pr = await citajPitanje(page);
    ok(pr.slika && pr.slika === Q.get(pr.qid).slika, "prvo pitanje lekcije ima sliku", pr.slika);
    ok(lek.ids.includes(pr.qid), "pitanje pripada izabranoj lekciji");
    // zoom na sliku: klik otvara uvećanu sliku, Escape zatvara
    await proveriSliku(page, pr);
    await page.click("#qimg");
    await page.waitForSelector("#zoom.on");
    ok(await page.waitForFunction(() => { const z = document.querySelector("#zoom img"); return z.complete && z.naturalWidth > 0 && z.src.endsWith("/" + document.querySelector("#qimg img").getAttribute("src")); }).then(() => true).catch(() => false), "uvećana slika je ista i učitana");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#zoom:not(.on)", {state: "attached"});
    const politika = ({idx, ponovo}) => idx === 3 && !ponovo ? "pogresno" : "tacno";
    const t = await voziTuru(page, {politika, ocekivano: ocek, model, stanje, prefiks: "app: "});
    ok(t.prvi.size === Math.min(15, lek.ids.length), `tura lekcije: ${t.prvi.size} pitanja iz lekcije`);
    ok([...t.prvi.keys()].every(id => lek.ids.includes(id)), "sva pitanja ture pripadaju lekciji");
    await proveriRezultatTure(page, t.prvi);
    model.proveri(await stanje(), "posle lekcije");
    // režim „Greške“: kutija ≤ 2 sa istorijom, sort (kutija, -netačno, -bodova)
    await page.click("#kuci"); await cekajPocetnu(page);
    const ocekG = model.greske(15), brG = model.brojGresaka();
    ok(ocekG.length >= 2, `u modelu ima ${ocekG.length} pitanja za „Greške“`);
    ok((await page.locator("#greskebtn .chip").textContent()) === String(brG), `značka na „Greške“: ${brG}`);
    await page.click("#greskebtn");
    const kljuc = x => [x.kutija, -x.netacno, -x.bodova].join(",");
    const prikazano = [];
    const p2 = async () => { for (let i = 0; i < 60; i++) { await page.waitForSelector("#qwrap .opt, .tiles"); if (await page.locator(".tiles").count()) return; const r = await citajPitanje(page); prikazano.push(r.qid); await oznaci(page, r.q, izbor(r.q, "tacno")); await page.click("#proveri"); await page.waitForSelector("#sheet.on"); await page.click("#dalje"); } };
    // izmeri redosled bez zapisa: samo čita redosled (tačni odgovori; model prima rezultat posle)
    const sadaG = await sadaStranice(page), danasG = sadaG.slice(0, 10);
    await p2();
    jednako(prikazano.length, ocekG.length, "„Greške“ prikazuje sva pitanja sa kutijom ≤ 2 (do 15)");
    jednako(prikazano.map(id => { const s = model.p.get(id); return [s.kutija, -s.netacno, -Q.get(id).bodova].join(","); }), ocekG.map(kljuc), "„Greške“: redosled (kutija, -greške, -bodovi)");
    jednako(new Set(prikazano).size === prikazano.length && prikazano.every(id => model.p.get(id).kutija <= 2), true, "„Greške“: bez duplikata, samo kutije 1–2");
    prikazano.forEach(id => { const q = Q.get(id); model.prim(id, true, false, zapisOdgovora(q, izbor(q, "tacno"), "app: "), danasG, sadaG); });
    model.proveri(await stanje(), "posle „Greške“");
    ok(await page.locator(".misses").count() === 0 && (await page.locator(".t2").last().textContent()).includes("Bez ijedne greške"), "„Greške“ rezime: bez grešaka");
    jednako(proveriSemu(await stanje()), [], "šema posle svih tura");
  });

  // 4 ------------------------------------------------------------------------------------------------
  await scenario("4 simulacija ispita", async () => {
    await page.click("#kuci"); await cekajPocetnu(page);
    const ispitaPre = ((await stanje()).ispiti || []).length;
    const ex = await voziIspit(page, {model});
    await page.waitForFunction(n => JSON.parse(localStorage.getItem("kviz.napredak")).ispiti?.length === n, ispitaPre + 1);
    const st = await stanje();
    jednako(proveriSemu(st), [], "šema posle ispita");
    jednako(st.ispiti.length, ispitaPre + 1, "u „ispiti“ je dodat tačno jedan zapis");
    await proveriPoslednjiIspit(st, ex);
    model.proveri(st, "posle ispita");
    // detalj pitanja iz rezultata (modal), i to jednog sa slikom
    const k = ex.ids.findIndex(id => Q.get(id).slika);
    ok(k >= 0, "u ispitu ima pitanje sa slikom (signalizacija)");
    await page.click(`.grid41 .g41[data-k="${k}"]`);
    await page.waitForSelector("#modal.on .qimg img");
    ok(await page.waitForFunction(() => { const i = document.querySelector("#modal .qimg img"); return i && i.complete && i.naturalWidth > 0; }).then(() => true).catch(() => false), "detalj ispita: slika u modalu se učitala");
    await page.click("#mx");
    // početna posle ispita: grafikon simulacija
    await page.click("#kuci"); await cekajPocetnu(page);
    ok(await page.locator("section:has(.overline:text-is('Simulacije')) .bars .b").count() === ispitaPre + 1, "početna: grafikon „Simulacije“ ima novi stubić");
    // 20 generisanja ispita u pregledaču: kvote i 98–99 bodova
    const gen = await page.evaluate(async () => { const out = []; for (let i = 0; i < 20; i++) { const r = await KVIZ.api("/api/tura?n=41&rezim=ispit"); out.push(r.pitanja.map(p => [p.id, p.bodova, p.oblast_br])); } return out; });
    ok(gen.every(t => { const z = t.reduce((a, p) => a + p[1], 0), po = {}; t.forEach(p => { po[p[2]] = (po[p[2]] || 0) + 1; }); return t.length === 41 && (z === 98 || z === 99) && JSON.stringify(Object.entries(po).sort()) === JSON.stringify(Object.entries(KVOTA).sort()) && new Set(t.map(p => p[0])).size === 41; }), "20 generisanih ispita: 41 pitanje, 98–99 bodova, prave kvote");
  });

  // 5 ------------------------------------------------------------------------------------------------
  await scenario("5 datum ispita preko Postavki", async () => {
    danas = await danasStranice(page);
    await otvoriPostavke(page);
    ok(await page.locator("#ispsnimi").isDisabled(), "bez datuma „Sačuvaj“ je isključeno");
    ok(await page.locator("#ispbrisi").count() === 0, "bez datuma nema „Ukloni“");
    const modalTekst = await page.locator("#modalbox").innerText();
    ok(/samo u ovom pregledaču/i.test(modalTekst) && /MUP/.test(modalTekst) && /nezvanična/i.test(modalTekst), "Postavke: napomena o čuvanju u pregledaču i o MUP-u", modalTekst);
    await page.fill("#ispdat", dodajDane(danas, 9));
    ok(!(await page.locator("#ispsnimi").isDisabled()), "sa datumom „Sačuvaj“ je uključeno");
    await page.click("#ispsnimi");
    await page.waitForFunction(() => !document.querySelector("#modal").classList.contains("on"));
    await cekajPocetnu(page);
    jednako((await pocetnaBrojke(page)).naslov, "Ispit za 9 dana", "početna: „Ispit za 9 dana“");
    ok((await pocetnaBrojke(page)).plan.includes("Plan do ispita"), "početna: „Plan do ispita“");
    jednako(await page.evaluate(() => localStorage.getItem("kviz.ispit")), dodajDane(danas, 9), "datum je u localStorage pod „kviz.ispit“");
    await page.reload();
    jednako((await pocetnaBrojke(page)).naslov, "Ispit za 9 dana", "datum ispita preživljava osvežavanje");
    const P = await page.evaluate(() => KVIZ.api("/api/pocetna"));
    jednako([P.ispit_datum, P.dan_pred_ispit], [dodajDane(danas, 9), false], "API: ispit_datum i dan_pred_ispit");
    // dan pred ispit
    await otvoriPostavke(page);
    ok(await page.locator("#ispbrisi").count() === 1 && await page.inputValue("#ispdat") === dodajDane(danas, 9), "Postavke pamte datum i nude „Ukloni“");
    await page.fill("#ispdat", dodajDane(danas, 1)); await page.click("#ispsnimi"); await cekajPocetnu(page);
    let b = await pocetnaBrojke(page);
    jednako(b.naslov, "Ispit za 1 dan", "početna: „Ispit za 1 dan“ (jednina)");
    ok(b.tekst.toLowerCase().includes("plan za danas · sutra je ispit"), "početna: plan za dan pred ispit", b.plan);
    const ocek = model.tura(15, danas, await granicaStranice(page), true);
    const tura = await page.evaluate(() => KVIZ.api("/api/tura?n=15&rezim=uci").then(r => r.pitanja.map(p => p.id)));
    jednako(tura, ocek, "dan pred ispit: tura po novom redosledu oblasti (Dozvole, Dužnosti, …)");
    await otvoriPostavke(page); await page.fill("#ispdat", danas); await page.click("#ispsnimi"); await cekajPocetnu(page);
    jednako((await pocetnaBrojke(page)).naslov, "Danas je ispit 🍀", "početna: danas je ispit");
    // uklanjanje
    await otvoriPostavke(page); await page.click("#ispbrisi"); await cekajPocetnu(page);
    b = await pocetnaBrojke(page);
    jednako(b.naslov, "Vozački B", "posle „Ukloni“ vraća se naslov „Vozački B“");
    ok(b.plan.includes("Plan učenja") && await page.evaluate(() => localStorage.getItem("kviz.ispit")) === null, "datum je uklonjen iz localStorage, plan je opet „Plan učenja“");
    jednako(await page.evaluate(() => KVIZ.getIspit()), null, "KVIZ.getIspit() posle uklanjanja");
    // Postavke se zatvaraju (Esc, klik na pozadinu, ×)
    await otvoriPostavke(page); await page.keyboard.press("Escape");
    ok(!(await modalVidljiv(page)), "Postavke se zatvaraju tasterom Esc");
    await otvoriPostavke(page); await page.click("#mx");
    ok(!(await modalVidljiv(page)), "Postavke se zatvaraju dugmetom ×");
    await otvoriPostavke(page); await page.mouse.click(5, 5);
    ok(!(await modalVidljiv(page)), "Postavke se zatvaraju klikom na pozadinu");
  });

  // 6 ------------------------------------------------------------------------------------------------
  await scenario("6 izvoz i uvoz napretka", async () => {
    const original = await sirovNapredak(page), originalObj = JSON.parse(original);
    await otvoriPostavke(page);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#izvezi")]);
    ok(dl.suggestedFilename() === "napredak.json", "izvoz: ime fajla je napredak.json");
    const izvozPutanja = path.join(TMP, "izvoz-napredak.json");
    await dl.saveAs(izvozPutanja);
    const tekst = fs.readFileSync(izvozPutanja, "utf8"), izvoz = JSON.parse(tekst);
    jednako(izvoz, originalObj, "izvezeni JSON je isti kao napredak u pregledaču");
    jednako(proveriSemu(izvoz), [], "izvoz ima šemu napredak.json");
    ok(tekst.startsWith('{\n "'), "izvoz je lep JSON sa uvlačenjem 1 (kao Python indent=1)");
    ok((await page.locator("#postmsg.ok").textContent()).includes("napredak.json"), "izvoz: poruka o uspehu");
    // Python (kviz.py) čita izvezeni fajl
    const podaci2 = path.join(TMP, "podaci-izvoz"); fs.mkdirSync(podaci2);
    fs.symlinkSync(path.join(KOREN, "pitanja.json"), path.join(podaci2, "pitanja.json")); fs.symlinkSync(path.join(KOREN, "slike"), path.join(podaci2, "slike"));
    fs.copyFileSync(izvozPutanja, path.join(podaci2, "napredak.json"));
    let py = ""; try { py = execFileSync("python3", [path.join(KOREN, "kviz.py"), "stanje"], {env: {...process.env, KVIZ_PODACI: podaci2, KVIZ_ISPIT: "", PYTHONDONTWRITEBYTECODE: "1"}}).toString(); } catch (e) { py = "GREŠKA " + e.stderr; }
    const vid = Object.values(izvoz.pitanja).filter(v => v.istorija.length).length;
    ok(py.includes(`Viđeno **${vid}/${PITANJA.length}**`), `kviz.py stanje čita izvezeni napredak (viđeno ${vid})`, py.slice(0, 200));
    await page.click("#mx");
    // brisanje podataka sajta pa uvoz iste datoteke
    await page.evaluate(() => localStorage.removeItem("kviz.napredak")); await page.reload();
    const prazno = await pocetnaBrojke(page);
    ok(prazno.novih === "0", "posle brisanja napretka početna je prazna", prazno);
    await otvoriPostavke(page);
    await uvezi(page, izvozPutanja);
    await page.waitForSelector("#mzam");
    ok((await page.locator("#modalbox").innerText()).includes("izvoz-napredak.json"), "uvoz traži potvrdu i pominje ime fajla");
    // „Odustani“ ne menja ništa
    await page.click("#mne"); await page.waitForSelector("#ispdat");
    ok(await sirovNapredak(page) !== original && (await citajNapredak(page)).ispiti === undefined, "„Odustani“ ne uvozi ništa (napredak je i dalje prazan)");
    await uvezi(page, izvozPutanja); await page.waitForSelector("#mzam"); await page.click("#mzam");
    await cekajPocetnu(page);
    const uvezen = await citajNapredak(page);
    jednako(uvezen.pitanja, originalObj.pitanja, "uvoz: pitanja su ista kao pre brisanja");
    jednako([uvezen.ispiti, uvezen.dnevnik], [originalObj.ispiti, originalObj.dnevnik], "uvoz: ispiti i dnevnik su isti");
    model.proveri(uvezen, "posle uvoza");
    ok((await pocetnaBrojke(page)).novih === (await page.evaluate(() => KVIZ.api("/api/pregled").then(p => String(p.danas_novih)))), "početna posle uvoza prikazuje uvezen napredak");
    // smeće se odbija vidljivom porukom i ne uništava napredak
    const smece = {"nije-json.json": "ovo nije json {{{", "prazan.json": "", "objekat.json": "{}", "niz.json": "[1,2,3]", "pitanja-niz.json": '{"pitanja": []}', "los-kljuc.json": '{"pitanja": {"abc": {}}}',
      "kutija.json": '{"pitanja": {"1": {"kutija": 99, "tacno": 0, "netacno": 0, "sledece": null, "istorija": []}}}', "istorija.json": '{"pitanja": {"1": {"kutija": 1, "tacno": 0, "netacno": 1, "sledece": null, "istorija": [["juče", "N", "x"]]}}}', "null.json": "null"};
    const pre = await sirovNapredak(page);
    for (const [ime, sadrzaj2] of Object.entries(smece)) {
      const f = path.join(TMP, ime); fs.writeFileSync(f, sadrzaj2);
      await otvoriPostavke(page); await uvezi(page, f);
      await page.waitForSelector("#mzam, #postmsg.bad");
      if (await page.locator("#mzam").count()) await page.click("#mzam");
      await page.waitForSelector("#postmsg.bad:not(:empty)");
      const poruka = await page.locator("#postmsg").textContent();
      ok(poruka.includes("Uvoz nije uspeo") && await page.locator("#postmsg").isVisible(), `smeće „${ime}“: vidljiva poruka o grešci`, poruka);
      ok(await sirovNapredak(page) === pre, `smeće „${ime}“: napredak je netaknut`);
      await page.click("#mx");
    }
    // napredak stvaran iz Python-a (kviz.oceni + sacuvaj) se uvozi bez izmena šeme
    const pyNapr = path.join(TMP, "py-napredak.json");
    execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(KOREN)})
import kviz
kviz.oceni(${PITANJA[0].id}, {o["id"] for o in kviz.Q[${PITANJA[0].id}]["odgovori"] if o["tacno"]}, "app: x")
kviz.oceni(${PITANJA[1].id}, set(), "app: y")
kviz.stanje(ispis=False)
kviz.sacuvaj()
`], {env: {...process.env, KVIZ_PODACI: podaci2, KVIZ_ISPIT: "", PYTHONDONTWRITEBYTECODE: "1"}});
    fs.copyFileSync(path.join(podaci2, "napredak.json"), pyNapr);
    const pyObj = JSON.parse(fs.readFileSync(pyNapr, "utf8"));
    ok(Object.keys(pyObj.pitanja).length === PITANJA.length, "Python piše prazne zapise za sva pitanja (kao što je očekivano)");
    await otvoriPostavke(page); await uvezi(page, pyNapr); await page.waitForSelector("#mzam"); await page.click("#mzam"); await cekajPocetnu(page);
    const b = await pocetnaBrojke(page);
    const P = await page.evaluate(() => KVIZ.api("/api/pocetna"));
    const pyVid = Object.values(pyObj.pitanja).filter(v => v.istorija.length).length;
    jednako([P.pregled.vidjeno, P.pregled.pogresnih, P.lekcije.reduce((a, l) => a + l.greske, 0)], [pyVid, Object.values(pyObj.pitanja).filter(v => v.kutija === 1).length, Object.values(pyObj.pitanja).filter(v => v.kutija === 1).length], "uvoz napretka iz Pythona (prazni zapisi + prava istorija)");
    ok(b.novih === String(P.pregled.danas_novih), "početna posle uvoza iz Pythona se prikazuje", b);
    const iz = await page.evaluate(() => KVIZ.api("/api/tura?n=3&rezim=uci").then(r => r.pitanja.map(p => p.id)));
    ok(iz.every(id => !pyObj.pitanja[String(id)].istorija.length), "tura posle uvoza iz Pythona: prazni zapisi se tretiraju kao nova pitanja", iz);
    // vrati napredak za ostale scenarije
    await page.evaluate(s => localStorage.setItem("kviz.napredak", s), pre);
    await page.reload(); await cekajPocetnu(page);
  });

  // 7 ------------------------------------------------------------------------------------------------
  await scenario("7 slike pod pod-putanjom", async () => {
    ok(UCITANE_SLIKE.size >= 10, `tokom ispita i lekcija učitano je ${UCITANE_SLIKE.size} različitih slika (naturalWidth > 0)`);
    const sl = [...SLIKE].filter(([u]) => u.startsWith(URL_S));
    ok(sl.length >= 10 && sl.every(([, r]) => r.status === 200 && r.tip === "image/jpeg"), `sve ${sl.length} slike pod ${PODPUTANJA}slike/ vraćaju 200 image/jpeg`);
    ok(![...SLIKE.keys()].some(u => new URL(u).pathname.startsWith("/slike/")), "nijedna slika nije tražena sa korena domena");
    // namerno otvori pitanje sa slikom u novoj lekciji i proveri sam <img>
    const l = LEKCIJE.findIndex(x => Q.get(x.ids[0]).slika && x.ids.some(id => !model.p.has(id)));
    ok(l >= 0, "postoji lekcija sa neviđenim pitanjem sa slikom");
    await page.click(`.cell[data-l="${l}"]`);
    const pr = await citajPitanje(page);
    ok(pr.slika, "otvoreno pitanje ima sliku");
    await proveriSliku(page, pr);
    const img = await page.evaluate(() => { const i = document.querySelector("#qimg img"); return {w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute("src"), abs: i.src, ld: i.classList.contains("ld"), op: getComputedStyle(i).opacity}; });
    ok(img.w > 0 && img.h > 0 && img.src === Q.get(pr.qid).slika && img.abs === URL_S + img.src && img.ld && img.op === "1", "slika je učitana, vidljiva i relativna", img);
    // pripremi sledeću sliku (predUcitaj) takođe pod pod-putanjom
    await page.click("#nazad"); await cekajPocetnu(page);
    ok(![...SLIKE.keys()].some(u => !u.startsWith(URL_S)), "sve tražene slike su pod pod-putanjom sajta");
    // svaka slika koja je tražena tokom pokretanja (i pred-učitane) zaista se učitava u pregledaču
    const trazene = [...SLIKE.keys()].filter(u => u.startsWith(URL_S));
    const sirine = await page.evaluate(urls => Promise.all(urls.map(u => new Promise(res => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = u; }))), trazene);
    ok(trazene.length >= 10 && sirine.every(w => w > 0), `svih ${trazene.length} slika traženih tokom pokretanja se učitava (naturalWidth > 0)`, trazene.filter((_, i) => !sirine[i]));
    // svih 828 slika iz pitanja.json postoji u sajtu pod pod-putanjom (pokriva napravi_sajt.sh)
    const sveSlike = [...new Set(PITANJA.filter(q => q.slika).map(q => q.slika))], losa = [];
    for (let i = 0; i < sveSlike.length; i += 4) {   // python http.server ima mali backlog: paralelnih zahteva malo
      await Promise.all(sveSlike.slice(i, i + 4).map(async sl2 => {
        const r = await fetch(URL_S + sl2, {method: "HEAD"});
        if (r.status !== 200 || r.headers.get("content-type") !== "image/jpeg" || +r.headers.get("content-length") !== fs.statSync(path.join(KOREN, sl2)).size || +r.headers.get("content-length") < 500) losa.push(sl2);
      }));
    }
    ok(sveSlike.length === 828 && !losa.length, `svih ${sveSlike.length} slika iz pitanja.json se služi pod ${PODPUTANJA}`, losa.slice(0, 5));
  });

  // 10 -----------------------------------------------------------------------------------------------
  await scenario("10 isti sajt na korenu domena (sopstveni domen)", async () => {
    const c2 = await noviKontekst();
    const p = await otvori(c2, `http://127.0.0.1:${portR}/`, "koren");
    const b = await pocetnaBrojke(p);
    ok(b.postavke && b.naslov === "Vozački B", "početna radi i na korenu domena");
    const l = LEKCIJE.findIndex(x => Q.get(x.ids[0]).slika);
    await p.click(`.cell[data-l="${l}"]`);
    const pr = await citajPitanje(p);
    await proveriSliku(p, pr);
    ok(ZAHTEVI.some(x => x.naziv === "koren" && x.url === `http://127.0.0.1:${portR}/pitanja.json`), "pitanja.json se učitava sa korena");
    await c2.close(); aktivna = page;
  });

  // 8 ------------------------------------------------------------------------------------------------
  await scenario("8 mobilni prikaz (390x844) i tamna tema", async () => {
    const stanjeSesije = await ctx.storageState();
    for (const sema of ["dark", "light"]) {
      const mc = await noviKontekst({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: sema, storageState: stanjeSesije});
      const p = await otvori(mc, URL_S, "mobilni-" + sema);
      const s = f => path.join(OUT, `mobilni-${sema}-${f}.png`);
      await cekajPocetnu(p);
      ok(await p.evaluate(m => matchMedia(`(prefers-color-scheme: ${m})`).matches, sema), `kontekst koristi ${sema} temu`);
      await p.screenshot({path: s("1-pocetna")});
      const zaglavlje = await p.evaluate(() => { const r = e => { const b = document.querySelector(e).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.width), Math.round(b.height)]; }; return {post: r("#postbtn"), zvuk: r("#zvukbtn"), h1: r(".home-top h1"), vp: innerWidth, skrol: document.documentElement.scrollWidth}; });
      ok(zaglavlje.skrol <= zaglavlje.vp && zaglavlje.post[2] >= 44 && zaglavlje.post[3] >= 44 && zaglavlje.zvuk[0] >= zaglavlje.post[1] && zaglavlje.zvuk[1] <= zaglavlje.vp, "zaglavlje početne: dugmad stanu u 390 px, nema skrola, mete ≥ 44 px", zaglavlje);
      await otvoriPostavke(p);
      await p.screenshot({path: s("2-postavke")});
      await proveriRaspored(p, "#modalbox", `Postavke ${sema}`);
      // sa datumom: tri kontrole u redu (datum, Sačuvaj, Ukloni)
      const danasM = await danasStranice(p);
      await p.fill("#ispdat", dodajDane(danasM, 12)); await p.click("#ispsnimi"); await cekajPocetnu(p);
      jednako((await pocetnaBrojke(p)).naslov, "Ispit za 12 dana", `mobilni ${sema}: „Ispit za 12 dana“`);
      await p.screenshot({path: s("3-pocetna-ispit")});
      await proveriRaspored(p, "#app", `početna ${sema}`);
      await otvoriPostavke(p);
      await p.screenshot({path: s("4-postavke-datum")});
      await proveriRaspored(p, "#modalbox", `Postavke sa datumom ${sema}`);
      // greška pri uvozu
      const smece = path.join(TMP, "mob-smece.json"); fs.writeFileSync(smece, "nije json");
      await uvezi(p, smece); await p.waitForSelector("#mzam");
      await p.screenshot({path: s("5-potvrda-uvoza")});
      await proveriRaspored(p, "#modalbox", `potvrda uvoza ${sema}`);
      await p.click("#mzam"); await p.waitForSelector("#postmsg.bad:not(:empty)");
      await p.screenshot({path: s("6-greska-uvoza")});
      await proveriRaspored(p, "#modalbox", `poruka o grešci ${sema}`);
      await p.click("#mx");
      // vrati ispit da bi se ostalo ponašalo isto
      await otvoriPostavke(p); await p.click("#ispbrisi"); await cekajPocetnu(p);
      if (sema === "dark") {
        // pitanje sa slikom + povratna informacija (netačno) na telefonu u tamnoj temi
        const l = LEKCIJE.findIndex(x => Q.get(x.ids[0]).slika && x.ids.some(id => !model.p.has(id)));
        await p.click(`.cell[data-l="${l}"]`);
        const pr = await citajPitanje(p); await proveriSliku(p, pr);
        await p.screenshot({path: s("7-pitanje")});
        await oznaci(p, pr.q, izbor(pr.q, "pogresno")); await p.click("#proveri"); await p.waitForSelector("#sheet.on");
        await p.screenshot({path: s("8-netacno")});
        const skrol = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
        ok(skrol, "pitanje i povratna informacija na telefonu: bez horizontalnog skrola");
      }
      // 320 px: najuža meta
      await p.setViewportSize({width: 320, height: 640});
      await p.evaluate(() => { document.querySelector("#sheet")?.classList.remove("on"); });
      await p.goto(URL_S); await cekajPocetnu(p);
      await otvoriPostavke(p);
      await p.screenshot({path: s("9-postavke-320")});
      await proveriRaspored(p, "#modalbox", `Postavke 320 px ${sema}`);
      await mc.close();
    }
    aktivna = page;
  });

  // 9 ------------------------------------------------------------------------------------------------
  await scenario("9 lokalni režim (server.py)", async () => {
    const podaci = path.join(TMP, "podaci-lokalno"); fs.mkdirSync(podaci);
    fs.symlinkSync(path.join(KOREN, "pitanja.json"), path.join(podaci, "pitanja.json")); fs.symlinkSync(path.join(KOREN, "slike"), path.join(podaci, "slike"));
    const portL = await slobodanPort(); LOKALNI_PORTOVI.add(portL);
    const env = {...process.env, KVIZ_PODACI: podaci, KVIZ_PORT: String(portL), PYTHONDONTWRITEBYTECODE: "1"}; delete env.KVIZ_ISPIT;
    const srv = pokreni("python3", ["server.py", "--bez-browsera"], {cwd: KOREN, env});
    const URL_L = `http://127.0.0.1:${portL}/`;
    await cekajHttp(URL_L);
    const html = await (await fetch(URL_L)).text();
    ok(html.includes('<meta name="kviz-backend" content="server">') && !html.includes('content="static"'), "server.py služi index.html sa meta kviz-backend=server");
    ok((await fetch(URL_L + "index.html").then(r => r.text())).includes('content="server"'), "i /index.html dobija meta „server“");
    const lctx = await noviKontekst();
    const p = await otvori(lctx, URL_L, "lokalno");
    const b = await pocetnaBrojke(p);
    const rezim = await p.evaluate(() => ({mod: window.KVIZ_MODE, kviz: typeof window.KVIZ, meta: document.querySelector('meta[name="kviz-backend"]').content}));
    jednako(rezim, {mod: "server", kviz: "undefined", meta: "server"}, "lokalni režim: KVIZ_MODE=server, nema KVIZ objekta");
    ok(!b.postavke && b.naslov === "Vozački B", "lokalni režim: nema dugmeta „Postavke“", b);
    const mp = new Model(false);
    const stanjeL = async () => fs.existsSync(path.join(podaci, "napredak.json")) ? JSON.parse(fs.readFileSync(path.join(podaci, "napredak.json"), "utf8")) : {pitanja: {}};
    const ocek = mp.tura(15, await danasStranice(p), await granicaStranice(p), false);
    await p.click("#nastavi");
    const politika = ({idx, ponavljanja}) => idx === 1 ? (ponavljanja < 1 ? "pogresno" : "tacno") : idx === 2 ? "nesiguran" : "tacno";
    const t = await voziTuru(p, {politika, ocekivano: ocek, model: mp, stanje: stanjeL, prefiks: "app: "});
    await proveriRezultatTure(p, t.prvi);
    const st = await stanjeL();
    mp.proveri(st, "napredak.json (server) posle ture");
    jednako(proveriSemu(st), [], "napredak.json koji piše server.py ima istu šemu");
    // ispit u lokalnom režimu
    await p.click("#kuci"); await cekajPocetnu(p);
    const ex = await voziIspit(p, {model: mp});
    await p.waitForFunction(() => document.querySelector("#brojac"));
    for (let i = 0; i < 50 && ((await stanjeL()).ispiti || []).length < 1; i++) await pauza(100);
    const st2 = await stanjeL();
    await proveriPoslednjiIspit(st2, ex); mp.proveri(st2, "napredak.json posle ispita");
    // greške (kutija ≤ 2)
    await p.click("#kuci"); await cekajPocetnu(p);
    await p.click("#greskebtn"); await p.waitForSelector("#qwrap .opt, .empty");
    ok(await p.locator("#qwrap .opt").count() > 0, "lokalni režim: „Greške“ nudi pitanja");
    await p.click("#nazad"); await cekajPocetnu(p);
    // mreža: /api/*, ne koristi pitanja.json niti localStorage „kviz.*“
    const z = ZAHTEVI.filter(x => x.naziv === "lokalno");
    ok(z.some(x => x.url === URL_L + "api/pocetna") && z.some(x => x.url.startsWith(URL_L + "api/tura?")) && z.some(x => x.url === URL_L + "api/odgovor" && x.metod === "POST") && z.some(x => x.url === URL_L + "api/ispit_rezultat" && x.metod === "POST"), "lokalni režim koristi /api/pocetna, /api/tura, POST /api/odgovor i POST /api/ispit_rezultat");
    ok(!z.some(x => x.url.includes("pitanja.json")), "lokalni režim ne učitava pitanja.json");
    const ls = await p.evaluate(() => Object.keys(localStorage));
    ok(!ls.some(k => k.startsWith("kviz.")), "lokalni režim ne piše localStorage „kviz.*“", ls);
    ok(z.some(x => x.url === URL_L + "kviz.js"), "kviz.js se traži i u lokalnom režimu (i server ga služi)");
    const slL = [...SLIKE].filter(([u]) => u.startsWith(URL_L));
    ok(slL.length >= 5 && slL.every(([, r]) => r.status === 200 && r.tip === "image/jpeg"), `lokalni režim: ${slL.length} slika vraća 200 image/jpeg`);
    ok(ex.ids.some(id => Q.get(id).slika), "lokalni ispit je imao pitanja sa slikom (slike su prošle proveru naturalWidth)");
    srv.kill();
    // isti napredak.json iz Pythona, uvezen u statički sajt, daje isti odgovor API-ja kao Python server (osim Monte Karlo polja).
    // Stanje se „ostari“ (zapisi stariji od 2 h, sledece = juče) da bi sva viđena pitanja bila dospela i da se proveri njihov redosled.
    const stObj = JSON.parse(fs.readFileSync(path.join(podaci, "napredak.json"), "utf8")), juce = dodajDane(lokalniIso(), -1);
    for (const v of Object.values(stObj.pitanja)) if (v.istorija.length) { if (v.zadnje) v.zadnje = naivnoVreme(v.zadnje, -2 * 3600); if (v.kutija >= 1 && v.kutija <= 4) v.sledece = juce; }
    const stariFajl = path.join(TMP, "lokalni-napredak-stari.json"); fs.writeFileSync(stariFajl, JSON.stringify(stObj, null, 1));
    const sc = await noviKontekst();
    const sp = await otvori(sc, URL_S, "uvoz-iz-lokalnog"); await cekajPocetnu(sp);
    await otvoriPostavke(sp); await uvezi(sp, stariFajl); await sp.waitForSelector("#mzam"); await sp.click("#mzam"); await cekajPocetnu(sp);
    for (const dani of [null, 9, 1, 0]) await paritetSaPythonom(sp, stariFajl, dani);
    await sc.close(); await lctx.close(); aktivna = page;
    // lokalni režim nije ostavio lične fajlove u repou
    jednako(LICNI.map(f => fs.existsSync(path.join(KOREN, f))), korenPre, "lični fajlovi nisu nastali u repou");
    ok(fs.existsSync(path.join(podaci, "napredak.json")), "napredak.json je nastao u KVIZ_PODACI folderu");
  });

  // 11 -----------------------------------------------------------------------------------------------
  await scenario("11 bez localStorage (privatan prozor)", async () => {
    const c3 = await noviKontekst();
    await c3.addInitScript(() => { Object.defineProperty(window, "localStorage", {get() { throw new DOMException("zabranjeno", "SecurityError"); }}); });
    const p = await otvori(c3, URL_S, "bez-storage-a");
    await cekajPocetnu(p);
    jednako(await p.evaluate(() => window.KVIZ_STORAGE), "memorija", "KVIZ_STORAGE je „memorija“ kad localStorage nije dostupan");
    await p.click("#nastavi");
    const t = await voziTuru(p, {politika: () => "tacno", ocekivano: null, prefiks: "app: "});
    ok(t.log.length === 15, "tura radi i bez localStorage-a");
    await p.click("#kuci"); await cekajPocetnu(p);
    jednako((await pocetnaBrojke(p)).novih, "15", "napredak se drži u memoriji dok je kartica otvorena");
    await otvoriPostavke(p);
    ok((await p.locator("#modalbox").innerText()).includes("ne dozvoljava čuvanje"), "Postavke upozoravaju da se napredak ne čuva");
    await proveriRaspored(p, "#modalbox", "Postavke bez storage-a");
    await c3.close(); aktivna = page;
  });

  // zbirne provere --------------------------------------------------------------------------------------
  await scenario("zbir: mreža i konzola", async () => {
    jednako([...SPOLJNI.keys()].filter(h => !DOZVOLJENI_SPOLJNI.has(h)), [], `spoljni hostovi: samo Google Fonts (${[...SPOLJNI.keys()].join(", ")})`);
    ok(ZAHTEVI.length > 100, `praćeno je ${ZAHTEVI.length} zahteva`);
    ok(!ZAHTEVI.some(x => /napredak\.json|Napredak\.md|Greske\.md|pitanja_raw/.test(x.url) && x.naziv !== "uvoz-iz-lokalnog"), "nijedan zahtev ne traži lične fajlove");
  });
  await browser.close();
  uspeh = true;
} catch (e) {
  console.error("\nFATALNO:", e.stack || e);
  ok(false, "fatalna greška: " + e.message);
  try { await browser?.close(); } catch (_) { /* već zatvoren */ }
}

function spawnSyncStatus(cmd, args) {
  try { execFileSync(cmd, args, {stdio: "pipe"}); return 0; } catch (e) { return e.status ?? 1; }
}

const pali = izvestaj.filter(x => !x.ok);
const poScenariju = new Map();
for (const x of izvestaj) { const s = poScenariju.get(x.scen) || [0, 0]; s[x.ok ? 0 : 1]++; poScenariju.set(x.scen, s); }
console.log("\n==== REZIME ====");
for (const [s, [a, b]] of poScenariju) console.log(`${b ? "NEUSPEH" : "ok     "}  ${s}: ${a} proveri prošlo${b ? `, ${b} palo` : ""}`);
console.log(`Ukupno: ${izvestaj.length - pali.length}/${izvestaj.length} provera prošlo. Screenshotovi: ${OUT}`);
ocisti();
process.exit(pali.length || !uspeh ? 1 : 0);
