#!/usr/bin/env python3
"""Test pariteta, strana Pythona: pravi kviz.py + server.py daju očekivane vrednosti za app/kviz.js.

Jedna komanda (iz korena repozitorijuma; treba samo Node 22 i python3):

    node tests/parity.mjs            # pokrene ovaj fajl, pa poredi sa app/kviz.js (~2.5 min)
    node tests/parity.mjs --brzo     # 4 konfiguracije, manje stanja (~50 s)
    NODE_OPTIONS=--max-old-space-size=6000 node tests/parity.mjs --pun   # sve konfiguracije, sva stanja (~15 min)

Samo očekivane vrednosti (pa ih Node poredi posebno; treba Python 3.12+ zbog kompenzovanog sum() nad float-ovima):

    python3 tests/parity.py --out /tmp/f.json && node tests/parity.mjs /tmp/f.json

Kako radi: za svaku kombinaciju (lažni „danas“, KVIZ_ISPIT) pokrene se poseban Python proces. U njemu se
datetime zameni lažnim modulom PRE uvoza kviz.py (pa REDOSLED, ISPIT i LEKCIJE nastaju za taj dan), a
server.py se pokrene za pravo (ThreadingHTTPServer na slobodnom portu) i dobija iste HTTP pozive kao
frontend. Stanja napretka su nasumična (seed iz imena konfiguracije), sintetička kroz pravi oceni()/sledeca()
i „uvezena“ iz pravog toka server + CLI. Sve što Python ispiše upisuje se u privremeni folder
(KVIZ_PODACI, sa symlinkovima na pitanja.json i slike/): u repozitorijum se ništa ne piše.
"""
import argparse, collections, concurrent.futures, contextlib, hashlib, http.client, http.server, io, json, os
import pathlib, random, subprocess, sys, tempfile, threading, types, zlib
import datetime as REAL

REPO = pathlib.Path(__file__).resolve().parent.parent
# (ime, lažni „sada“, KVIZ_ISPIT) — pokrivaju: bez ispita, dalek ispit, 2 dana, dan pred ispit, dan ispita, posle ispita,
# oko ponoći (prozor od 10 min prelazi u prethodni dan), prestupni dan, prelaz godine, prelazi letnjeg računanja vremena
KONFIGURACIJE = [
    ("bez_ispita", "2026-10-06T09:15:30", None),
    ("ispit_daleko", "2026-10-06T09:15:30", "2026-11-20"),
    ("ispit_za_2_dana", "2026-11-18T12:00:00", "2026-11-20"),
    ("dan_pred_ispit", "2026-11-19T21:05:10", "2026-11-20"),
    ("dan_ispita", "2026-11-20T08:00:00", "2026-11-20"),
    ("posle_ispita", "2026-12-01T12:00:00", "2026-11-20"),
    ("oko_ponoci", "2026-10-07T00:04:00", None),
    ("prestupna_godina", "2028-02-29T10:00:00", "2028-03-01"),
    ("prelaz_godine", "2026-12-31T23:58:00", "2027-01-01"),
    ("letnje_vreme", "2026-03-30T10:00:00", None),
]
NIVOI = {"brzo": 1, "srednje": 2, "pun": 3}
BRZO_KONFIG = ("bez_ispita", "dan_pred_ispit", "oko_ponoci", "letnje_vreme")
TEKSTOVI = ["app: odgovor", "app: tačan | drugi", "? app: pogađao", "ispit: đačka čežnja šć", "app: "]


# ---------- lažni sat ----------

class Sat:
    t = None  # trenutni lažni trenutak (naivni datetime, lokalno vreme)


def postavi_sat(t):
    Sat.t = REAL.datetime.fromisoformat(t) if isinstance(t, str) else t


def lazni_datetime():
    """Modul datetime čiji date.today() i datetime.now() vraćaju Sat.t; sve ostalo je pravo."""
    class D(REAL.date):
        @classmethod
        def today(cls):
            return REAL.date(Sat.t.year, Sat.t.month, Sat.t.day)

    class T(REAL.datetime):
        @classmethod
        def now(cls, tz=None):
            return Sat.t

    m = types.ModuleType("datetime")
    m.__dict__.update(vars(REAL))
    m.date, m.datetime = D, T
    return m


class Veza:
    """HTTP klijent ka pravom server.py (bez proxy-ja: direktno na 127.0.0.1)."""
    def __init__(self, port):
        self.port = port

    def __call__(self, url, telo=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        try:
            if telo is None:
                c.request("GET", url)
            else:
                c.request("POST", url, json.dumps(telo), {"Content-Type": "application/json"})
            r = c.getresponse()
            b = r.read()
        finally:
            c.close()
        if r.status != 200:
            raise RuntimeError(f"{url}: HTTP {r.status}")
        return json.loads(b)


# ---------- radnik: jedna konfiguracija ----------

class Radnik:
    def __init__(self, ime, sada, ispit, nivo, tmp):
        self.ime, self.sada, self.ispit, self.nivo, self.tmp = ime, sada, ispit, nivo, tmp
        self.n = NIVOI[nivo]
        self.rng = random.Random(zlib.crc32(ime.encode()))
        random.seed(zlib.crc32(ime.encode()))  # server.py meša odgovore globalnim random-om
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(REPO))
        os.environ["KVIZ_PODACI"] = tmp
        if ispit:
            os.environ["KVIZ_ISPIT"] = ispit
        else:
            os.environ.pop("KVIZ_ISPIT", None)
        postavi_sat(sada)
        sys.modules["datetime"] = lazni_datetime()  # pre uvoza: REDOSLED, ISPIT, DAN_PRED_ISPIT, LEKCIJE
        import kviz, server
        self.K, self.S = kviz, server
        assert kviz.KOD == REPO and kviz.V == pathlib.Path(tmp).resolve(), "kviz.py ne koristi privremeni folder"
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.veza = Veza(self.srv.server_address[1])
        self.ids = [q["id"] for q in kviz._SVA]
        self.po_obl = collections.defaultdict(list)
        for q in kviz._SVA:
            self.po_obl[q["oblast_br"]].append(q["id"])
        d = REAL.date.fromisoformat(sada[:10])
        self.danas = d
        # prelazak ponoći je dozvoljen samo ako se pred_ispit() ne menja (REDOSLED se u Pythonu računa jednom pri uvozu)
        self.cross_ok = all(self.pred(d + REAL.timedelta(days=j)) == self.pred(d) for j in range(1, 6))

    def pred(self, d):
        return bool(self.ispit) and d >= REAL.date.fromisoformat(self.ispit) - REAL.timedelta(days=1)

    # --- fajl napretka ---

    def upisi(self, st):
        self.K.NP.write_text(json.dumps(st, ensure_ascii=False, indent=1))

    def procitaj(self):
        return json.loads(self.K.NP.read_text())

    # --- generatori stanja (rečnik napredak.json) ---

    @staticmethod
    def prazan():
        return {"pitanja": {}, "tura": [], "dnevnik": []}

    @staticmethod
    def zapis0():
        return {"kutija": 0, "tacno": 0, "netacno": 0, "sledece": None, "istorija": []}

    def iso(self, d, n=0):
        return (d + REAL.timedelta(days=n)).isoformat()

    def zadnje_oko(self, rng, p_nema=.25):
        """Vrednost polja „zadnje“ oko granice od 10 min (uključujući tačnu granicu i ±1 s) ili bez polja."""
        if rng.random() < p_nema:
            return None
        sek = rng.choice([-2400, -1200, -601, -600, -600, -599, -300, -30, 0, 45, 3600, -86400, -90000, -400000])
        return (Sat.t + REAL.timedelta(seconds=sek)).isoformat(timespec="seconds")

    def zapis(self, kutija, istorija, sledece, zadnje, tacno=None, netacno=None):
        z = {"kutija": kutija, "tacno": sum(h[1] == "T" for h in istorija) if tacno is None else tacno,
             "netacno": sum(h[1] == "N" for h in istorija) if netacno is None else netacno,
             "sledece": sledece, "istorija": istorija}
        if zadnje:
            z["zadnje"] = zadnje
        return z

    def gen_prazni_zapisi(self):
        return {"pitanja": {str(i): self.zapis0() for i in self.ids}, "tura": [], "dnevnik": []}

    def gen_savladano(self, rng, buduce):
        st = self.prazan()
        for i in self.ids:
            h = [[self.iso(self.danas, -rng.randint(8, 30)), rng.choice("TTTN"), "app: x"],
                 [self.iso(self.danas, -rng.randint(1, 7)), "T", "app: y"]]
            st["pitanja"][str(i)] = self.zapis(5, h, self.iso(self.danas, rng.randint(1, 7) if buduce else -rng.randint(1, 9)),
                                               self.zadnje_oko(rng, .1))
        return st

    def gen_sve_pogresno(self, rng):
        st = self.prazan()
        for i in self.ids:
            n = rng.choice([1, 2, 3])
            h = [[self.iso(self.danas, -rng.randint(0, 5)), "N", "app: " + str(j)] for j in range(n)]
            st["pitanja"][str(i)] = self.zapis(1, h, self.iso(self.danas, -rng.choice([0, 0, 1, 3])), self.zadnje_oko(rng, .3))
        return st

    def gen_mnogo_gresaka(self, rng):
        st = self.prazan()
        ids = self.ids[:]
        rng.shuffle(ids)
        for j, i in enumerate(ids[:1000]):
            if j < 600:  # kutija 1–2 sa mnogo izjednačenja po (kutija, netacno, bodova)
                n = rng.randint(1, 5)
                h = [[self.iso(self.danas, -rng.randint(0, 9)), "N", "app: n"] for _ in range(n)]
                k = rng.choice([1, 1, 2])
            else:
                h = [[self.iso(self.danas, -rng.randint(1, 20)), rng.choice("TN"), "app: t"] for _ in range(rng.randint(1, 3))]
                k = rng.randint(3, 5)
            st["pitanja"][str(i)] = self.zapis(k, h, self.iso(self.danas, rng.randint(-3, 3)), self.zadnje_oko(rng))
        return st

    def gen_izjednacenja(self, rng):
        """Isti (kutija, netacno) za sve, ključevi u opadajućem redosledu: Python bi vezu rešio redosledom ključeva."""
        st = self.prazan()
        for i in sorted(rng.sample(self.ids, 160), reverse=True):
            h = [[self.iso(self.danas, -1), "N", "app: a"], [self.iso(self.danas, -1), "N", "app: b"]]
            st["pitanja"][str(i)] = self.zapis(2, h, self.iso(self.danas, -1), None)
        return st

    def gen_polovine(self, rng):
        """Tačnost po oblasti = 100·T/n sa tačnom polovinom (n=8 ili 40, T neparno): banker-ovo zaokruživanje."""
        st = self.prazan()
        for ob, ids in self.po_obl.items():
            m = 40 if len(ids) > 40 else min(8, len(ids))
            t = rng.choice(range(1, m, 2))
            for j, i in enumerate(rng.sample(ids, m)):
                ishod = "T" if j < t else "N"
                h = [[self.iso(self.danas, -3), rng.choice("TN"), "app: a"], [self.iso(self.danas, -1), ishod, "app: b"]]
                st["pitanja"][str(i)] = self.zapis(3 if ishod == "T" else 1, h, self.iso(self.danas, 5 if ishod == "T" else 0), None)
        return st

    def gen_spremnost_polovina(self, rng, ob):
        """Oblast čija je „spremnost“ 100·Σp/n tačno x.5 (pa Python round() ide na parno, Math.round naviše)."""
        ids = self.po_obl[ob]
        n, P = len(ids), self.S.P_KUTIJA
        while True:
            m = rng.randint(1, n - 1)
            t = rng.randint(0, m)
            pn = min(max((t + 7) / (m + 10), .5), .9)
            kutije = [rng.randint(1, 5) for _ in range(m)]
            x = 100 * sum([P[b] for b in kutije] + [pn] * (n - m)) / n
            if (x * 2) % 2 == 1:
                break
        st = self.prazan()
        for j, i in enumerate(ids[:m]):
            h = [[self.iso(self.danas, -2), "T" if j < t else "N", "app: a"]]
            st["pitanja"][str(i)] = self.zapis(kutije[j], h, self.iso(self.danas, 30), None)
        return st

    def gen_srednja(self, rng, tezine, udeo):
        """Većina pitanja viđena, kutije po zadatim težinama: šansa za prolaz ostaje u sredini (Monte Karlo se vidi, a ne 0 ili 100)."""
        st = self.prazan()
        for i in rng.sample(self.ids, int(len(self.ids) * udeo)):
            k = rng.choices(list(tezine), list(tezine.values()))[0]
            h = [[self.iso(self.danas, -rng.randint(2, 15)), "T" if rng.random() < .85 else "N", "app: x"]]
            st["pitanja"][str(i)] = self.zapis(k, h, self.iso(self.danas, rng.randint(1, 5)), None)
        return st

    def gen_snimci_i_ispiti(self, rng):
        st = self.gen_nasumicno(rng, .15)
        st["spremnost"] = {self.iso(self.danas, n): rng.randint(0, 100) for n in range(-20, 4)}
        st["ispiti"] = [{"kad": f"2026-09-{10 + j:02d}T1{j % 10}:3{j % 6}", "bod": rng.randint(60, 99), "max": 99,
                         "tacnih": rng.randint(25, 41), "gubitak": {"Pravila saobraćaja": rng.randint(0, 9), "Vozač": 3},
                         "pogresna": rng.sample(self.ids, 4)} for j in range(11)]
        st["dnevnik"] = [["2026-09-1%dT10:%02d" % (j, j), 10, 7, 14, 20] for j in range(5)]
        st["tura"] = [{"id": i, "slova": {"A": 1, "B": 2}} for i in rng.sample(self.ids, 3)]
        return st

    def gen_niz(self, rng, do_danas, buduce):
        """Niz uzastopnih dana (do juče ili do danas), pa rupa; opciono i zapisi iz budućnosti."""
        st = self.prazan()
        dani = [-12, -11, -9, -8, -7, -5, -4, -3, -2, -1] + ([0] if do_danas else []) + ([2, 3] if buduce else [])
        for d, i in zip(dani, rng.sample(self.ids, len(dani))):
            ishod = rng.choice("TN")
            st["pitanja"][str(i)] = self.zapis(3 if ishod == "T" else 1, [[self.iso(self.danas, d), ishod, "app: x"]],
                                               self.iso(self.danas, d + 2), None)
        return st

    def gen_samo_buducnost(self, rng):
        """Svi zapisi iz budućnosti (sat unazad): početak plana je posle „danas“, nijedno pitanje nije „pre danas“."""
        st = self.prazan()
        for d, i in zip((2, 3, 3, 5, 9), rng.sample(self.ids, 5)):
            st["pitanja"][str(i)] = self.zapis(3, [[self.iso(self.danas, d), "T", "app: x"]], self.iso(self.danas, d + 2), None)
        return st

    def gen_nasumicno(self, rng, udeo):
        """Nasumična (i nekonzistentna) polja: kutija nezavisna od istorije, sledece/zadnje svašta, ključevi izmešani."""
        st = self.prazan()
        ids = rng.sample(self.ids, int(len(self.ids) * udeo))
        for i in ids:
            if rng.random() < .92:
                h = [[self.iso(self.danas, rng.choice([-1, -1, 0, 0, 1, 3]) if rng.random() < .05 else -rng.randint(0, 40)),
                      "T" if rng.random() < .6 else "N", rng.choice(TEKSTOVI)] for _ in range(rng.choice([1, 1, 1, 2, 2, 3, 4, 6, 9]))]
                h.sort(key=lambda x: x[0])
                k = rng.choice([1, 1, 2, 2, 3, 3, 4, 5, 5, 0])
            else:
                h, k = [], (0 if rng.random() < .9 else rng.randint(1, 5))
            sled = rng.choice([None, "", self.iso(self.danas, -6), self.iso(self.danas, -1), self.iso(self.danas, 0),
                               self.iso(self.danas, 0), self.iso(self.danas, 1), self.iso(self.danas, 9)])
            st["pitanja"][str(i)] = self.zapis(k, h, sled, self.zadnje_oko(rng), rng.randint(0, 6), rng.randint(0, 6))
        if rng.random() < .5:  # izmešan redosled ključeva, kao u fajlu koji je pisao pravi tok
            st["pitanja"] = dict(rng.sample(list(st["pitanja"].items()), len(st["pitanja"])))
        return st

    def gen_sintetika(self, rng, dana, po_danu, tacnost, preskoci, prazni):
        """Pravi Leitner tok: kroz svaki dan sledeca() (dospela + nova) i oceni(), sa lažnim satom tog dana."""
        K = self.K
        st = self.prazan()
        K.st = st
        try:
            for i in range(dana + 1):
                d = self.danas - REAL.timedelta(days=dana - i)
                if i < dana and rng.random() < preskoci:
                    continue
                if i < dana:
                    t = REAL.datetime(d.year, d.month, d.day, rng.randint(8, 21), rng.randint(0, 59), rng.randint(0, 59))
                else:  # poslednji dan: pre „sada“
                    sec = max(int((self.sada_dt() - REAL.datetime(d.year, d.month, d.day)).total_seconds()), 61)
                    t = self.sada_dt() - REAL.timedelta(seconds=rng.randint(60, sec))
                    t = max(t, REAL.datetime(d.year, d.month, d.day))
                postavi_sat(t)
                K.DANAS = d
                for qid in K.sledeca(po_danu if i < dana else rng.randint(0, po_danu)):
                    q = K.Q[qid]
                    tacni = [o["id"] for o in q["odgovori"] if o["tacno"]]
                    ok = rng.random() < tacnost - .08 * (q["bodova"] - 2)
                    izbor = tacni if ok else self.pogresan(q, rng)
                    K.oceni(qid, set(izbor), rng.choice(TEKSTOVI), ok and rng.random() < .08)
                    postavi_sat(Sat.t + REAL.timedelta(seconds=rng.randint(4, 40)))
        finally:
            postavi_sat(self.sada)
            K.DANAS = self.danas
        if not prazni:  # server ne upisuje prazne zapise; CLI (daj) upisuje za sva pitanja
            st["pitanja"] = {k: v for k, v in st["pitanja"].items() if v["istorija"]}
        return json.loads(json.dumps(st))

    def sada_dt(self):
        return REAL.datetime.fromisoformat(self.sada)

    def gen_uvezeno(self, rng, dana, preskoci):
        """Napredak kakav pravi aplikacija: server (tura + odgovor) i CLI (daj + odg) kroz nekoliko dana, pa fajl sa diska."""
        K, v = self.K, self.veza
        self.upisi(self.prazan())
        try:
            for i in range(dana + 1):
                d = self.danas - REAL.timedelta(days=dana - i)
                if i < dana and rng.random() < preskoci:
                    continue
                t = REAL.datetime(d.year, d.month, d.day, rng.randint(7, 20), rng.randint(0, 59), 0)
                postavi_sat(min(t, self.sada_dt()))
                for q in v("/api/tura?n=12&rezim=uci")["pitanja"]:
                    ok = rng.random() < .75
                    tacni = [o["id"] for o in K.Q[q["id"]]["odgovori"] if o["tacno"]]
                    v("/api/odgovor", {"id": q["id"], "izabrani": tacni if ok else self.pogresan(K.Q[q["id"]], rng),
                                       "nesiguran": False, "bez_zapisa": False})
                postavi_sat(Sat.t + REAL.timedelta(minutes=rng.randint(11, 30)))
                with contextlib.redirect_stdout(io.StringIO()):  # CLI: daj + odg (upiše sva prazna pitanja, tura, dnevnik)
                    K.ucitaj()
                    K.daj(5)
                    if len(K.st["tura"]) >= 3:
                        K.odg("1:A 2:B 3:AC")
            return self.procitaj()
        finally:
            postavi_sat(self.sada)

    # --- pomoćne za odgovore ---

    @staticmethod
    def tacni_ids(q):
        return [o["id"] for o in q["odgovori"] if o["tacno"]]

    @staticmethod
    def pogresan(q, rng):
        svi, t = [o["id"] for o in q["odgovori"]], {o["id"] for o in q["odgovori"] if o["tacno"]}
        while True:
            izbor = rng.sample(svi, rng.randint(0, len(svi)))
            if set(izbor) != t:
                return izbor

    # --- slučajevi ---

    def novi_slucaj(self, ime, stanje_ime, stanje, ucitaj="uvezi"):
        return Slucaj(self, ime, stanje_ime, stanje, ucitaj)

    def jedinice(self):
        """Brojevi za pomoćne funkcije (zaokruživanje, deljenje, suma, datumi) i raspodela uzorka za ispit."""
        K, S, rng = self.K, self.S, self.rng
        zaokr = [k + .5 for k in range(-4, 300)] + [-(k + .5) for k in range(5)] + [k + .5 + e for k in (0, 1, 7, 12, 99, 100)
                                                                                    for e in (1e-12, -1e-12, 1e-9)]
        zaokr += [rng.uniform(0, 150) for _ in range(600)] + [float(k) for k in range(12)]
        zaokr1 = [m / 4 for m in range(-8, 400)] + [k / 100 for k in range(0, 600)] + [rng.uniform(0, 40) for _ in range(800)]
        zaokr1 += [round(rng.uniform(0, 30), 2) for _ in range(300)] + [x + .05 for x in (0.1, 1.2, 2.3, 3.4)]
        deljenje = [[a, b] for a in range(0, 130) for b in (100,)] + [[85 * mx, 100] for mx in range(0, 140)]
        deljenje += [[rng.randint(0, 5000), rng.randint(1, 60)] for _ in range(3000)]
        deljenje += [[1702 - j, d] for j in range(0, 1702, 97) for d in (1, 2, 14, 15, 44)] + [[-a, b] for a in (1, 5, 7) for b in (2, 3, 100)]
        pk = [.97, .94, .88, .78, .45]
        sume = [[rng.choice(pk + [.5 + rng.randint(0, 40) / 100]) for _ in range(n)] for n in (1, 2, 15, 22, 35, 109, 633)]
        sume += [[q["bodova"] * (1 - rng.choice(pk)) for q in K._SVA if q["oblast_br"] == ob] for ob in (2, 6, 8)]
        sume += [[rng.uniform(0, 1) for _ in range(500)], [1e16, 1.0, -1e16], [0.1] * 10, [0.1, 0.2, 0.3], []]
        dodaj = []
        for _ in range(1500):
            d = REAL.date(1990, 1, 1) + REAL.timedelta(days=rng.randint(0, 25000))
            n = rng.randint(-400, 400)
            dodaj.append([d.isoformat(), n, (d + REAL.timedelta(days=n)).isoformat()])
        for iso in ("2028-02-28", "2028-02-29", "2026-12-31", "2027-03-01", "2026-03-29", "2026-10-25", "2100-02-28", "2000-02-29"):
            d = REAL.date.fromisoformat(iso)
            dodaj += [[iso, n, (d + REAL.timedelta(days=n)).isoformat()] for n in (-366, -31, -1, 0, 1, 2, 14, 31, 366)]
        # raspodela uzorka za ispit (isti HTTP poziv kao frontend): koliko puta je koje pitanje iz malih oblasti izvučeno
        brojanje = collections.defaultdict(collections.Counter)
        n_ispita = {1: 300, 2: 500, 3: 800}[self.n]
        bodova = collections.Counter()
        for _ in range(n_ispita):
            r = self.veza("/api/tura?n=41&rezim=ispit")["pitanja"]
            bodova[sum(p["bodova"] for p in r)] += 1
            for p in r:
                if p["oblast_br"] in (2, 9, 10, 11):
                    brojanje[p["oblast_br"]][p["id"]] += 1
        return {
            "zaokruzi": [[x, round(x)] for x in zaokr], "zaokruzi1": [[x, round(x, 1)] for x in zaokr1],
            "podeli_gore": [[a, b, -(-a // b)] for a, b in deljenje], "suma": [[s, sum(s)] for s in sume],
            "dodaj_dane": dodaj,
            "konstante": {"KVOTA": [[k, v] for k, v in K.KVOTA.items()], "INTERVAL": {str(k): v for k, v in K.INTERVAL.items()},
                          "P_KUTIJA": {str(k): v for k, v in S.P_KUTIJA.items()}, "dozvoljeni_bodovi": [98, 99]},
            "ispit": {"n": n_ispita, "bodova": {str(k): v for k, v in bodova.items()},
                      "brojanje": {str(ob): {str(i): c for i, c in cnt.items()} for ob, cnt in brojanje.items()}},
        }

    def stanja(self):
        """[(ime, stanje, kako se učitava u JS)] — isti skup za svaku konfiguraciju, nasumična polja iz njenog seed-a."""
        rng = self.rng
        tez = [{3: .7, 2: .1, 4: .2}, {3: .55, 4: .3, 2: .15}, {4: .5, 3: .4, 5: .1}, {3: .6, 4: .2, 2: .2}]
        udeo = [1.0, .95, 1.0, .85]
        sint = [(3, 15, .8, 0, False), (9, 30, .65, .2, True), (20, 40, .9, .3, False), (6, 120, .5, 0, True)]
        # (najmanji nivo, ime, kako se učitava, fabrika): 1 = brzo, 2 = podrazumevano, 3 = pun
        # bez_dnevnika: stari fajl; pravi server na njemu ume samo da čita (stanje() u POST-u traži „dnevnik“), pa su mu samo čitanja
        spec = [(1, "prazno", "storage", self.prazan), (2, "bez_tura", "storage", lambda: {"pitanja": {}, "dnevnik": []}),
                (1, "bez_dnevnika", "storage", lambda: {"pitanja": {}}),
                (2, "prazni_zapisi", "uvezi", self.gen_prazni_zapisi),
                (1, "sve_savladano", "uvezi", lambda: self.gen_savladano(rng, True)),
                (2, "savladano_zaostalo", "uvezi", lambda: self.gen_savladano(rng, False)),
                (1, "sve_pogresno", "uvezi", lambda: self.gen_sve_pogresno(rng)),
                (2, "mnogo_gresaka", "uvezi", lambda: self.gen_mnogo_gresaka(rng)),
                (1, "izjednacenja_kljuceva", "uvezi", lambda: self.gen_izjednacenja(rng)),
                (1, "tacnost_polovine", "uvezi", lambda: self.gen_polovine(rng)),
                (1, "spremnost_polovina_11", "uvezi", lambda: self.gen_spremnost_polovina(rng, 11)),
                (3, "spremnost_polovina_2", "uvezi", lambda: self.gen_spremnost_polovina(rng, 2)),
                (2, "snimci_i_ispiti", "uvezi", lambda: self.gen_snimci_i_ispiti(rng)),
                (2, "niz_do_juce", "uvezi", lambda: self.gen_niz(rng, False, False)),
                (2, "samo_buducnost", "uvezi", lambda: self.gen_samo_buducnost(rng)),
                (1, "niz_do_danas_buducnost", "uvezi", lambda: self.gen_niz(rng, True, True))]
        for j in range(4):
            spec.append((1 if j == 0 else 2 if j == 1 else 3, f"srednja_sansa_{j}", "uvezi", lambda j=j: self.gen_srednja(rng, tez[j], udeo[j])))
            spec.append((1 if j == 0 else 2 if j == 1 else 3, f"nasumicno_{j}", "uvezi",
                         lambda: self.gen_nasumicno(rng, rng.choice([.03, .1, .35, .7, .95]))))
            spec.append((1 if j == 0 else 2 if j == 1 else 3, f"sintetika_{j}", "uvezi", lambda j=j: self.gen_sintetika(rng, *sint[j])))
        spec += [(1, "uvezeno_server_cli_a", "uvezi", lambda: self.gen_uvezeno(rng, 3, 0)),
                 (3, "uvezeno_server_cli_b", "uvezi", lambda: self.gen_uvezeno(rng, 7, .3))]
        # podrazumevani nivo: teška stanja (oko 1700 zapisa) se vrte po konfiguracijama, svako u trećini njih
        tezka = ["prazni_zapisi", "sve_savladano", "savladano_zaostalo", "sve_pogresno", "mnogo_gresaka", "srednja_sansa_1",
                 "nasumicno_1", "sintetika_1", "uvezeno_server_cli_a"]
        idx = [k[0] for k in KONFIGURACIJE].index(self.ime) if self.ime in [k[0] for k in KONFIGURACIJE] else 0
        uzmi = lambda nivo, ime: nivo <= self.n and (self.n != 2 or ime not in tezka or (tezka.index(ime) + idx) % 3 == 0)
        return [(ime, f(), kako) for nivo, ime, kako, f in spec if uzmi(nivo, ime)]

    def slucajevi_za(self, ime, st, kako):
        rng = self.rng
        P = st["pitanja"]
        sl = self.novi_slucaj(f"{ime}/citanje", ime, st, kako)
        sl.citanje()
        yield sl.zavrsi()
        if "dnevnik" not in st:
            return
        vidjena = [int(k) for k, v in P.items() if v.get("istorija")]
        nova = [i for i in self.ids if not (P.get(str(i)) or {}).get("istorija")]
        po_k = {b: [i for i in vidjena if P[str(i)]["kutija"] == b] for b in range(6)}
        K = self.K
        dugacak = max(self.ids, key=lambda i: max(len(o["tekst"]) for o in K.Q[i]["odgovori"]))
        visestruko = [i for i in self.ids if K.Q[i]["treba_zaokruziti"] > 1]
        varijante = []  # (ime, qid, izbor, zastavice, kasnije u istom danu)
        if nova:
            n = rng.choice(nova)
            varijante += [("nova_tacno", n, "t", {}), ("nova_netacno", rng.choice(nova), "n", {}),
                          ("nova_nesiguran", rng.choice(nova), "t", {"nesiguran": True}),
                          ("nova_netacno_nesiguran", rng.choice(nova), "n", {"nesiguran": True}),
                          ("nova_ispit_tacno", rng.choice(nova), "t", {"ispit": True}),
                          ("nova_ispit_netacno", rng.choice(nova), "n", {"ispit": True}),
                          ("nova_bez_zapisa", rng.choice(nova), "t", {"bez_zapisa": True}),
                          ("nova_prazan_izbor", rng.choice(nova), "0", {}),
                          ]
        varijante += [("dugacak_tekst_tacno", dugacak, "t", {}), ("dugacak_tekst_netacno", dugacak, "n", {})]
        for b in range(1, 6):
            if po_k[b]:
                varijante.append((f"kutija{b}_tacno", rng.choice(po_k[b]), "t", {}))
        for b in rng.sample([b for b in range(1, 6) if po_k[b]], min(2, sum(1 for b in range(1, 6) if po_k[b]))):
            varijante += [(f"kutija{b}_netacno", rng.choice(po_k[b]), "n", {}),
                          (f"kutija{b}_nesiguran", rng.choice(po_k[b]), "t", {"nesiguran": True}),
                          (f"kutija{b}_ispit_netacno", rng.choice(po_k[b]), "n", {"ispit": True}),
                          (f"kutija{b}_bez_zapisa", rng.choice(po_k[b]), "n", {"bez_zapisa": True, "nesiguran": True})]
        if visestruko:
            varijante += [("visestruko_podskup", rng.choice(visestruko), "podskup", {}),
                          ("visestruko_nadskup", rng.choice(visestruko), "nadskup", {})]
        if self.n < 3:
            varijante = rng.sample(varijante, min(len(varijante), 4 if self.n == 1 else 6))
        for j, (vime, qid, vrsta, zast) in enumerate(varijante):
            sl = self.novi_slucaj(f"{ime}/odg/{vime}", ime, st, kako)
            sl.odgovor(qid, vrsta, zast)
            sl.korak("tocno", "/api/pregled")
            sl.korak("tura", "/api/tura?n=12&rezim=uci")
            if j % 3 == 0 and self.n == 3 or j == 0:
                sl.korak("pocetna", "/api/pocetna")
            yield sl.zavrsi()
        # niz odgovora na istom pitanju kroz dane (nova → 3 → ...), pa nazad u 1
        izvor = nova or vidjena
        sl = self.novi_slucaj(f"{ime}/niz_na_pitanju", ime, st, kako)
        qid = rng.choice(izvor)
        for r in range(8):
            if r:
                sl.sat(self.sledeci_sat(rng))
            sl.odgovor(qid, "n" if r == 4 else "t", {"nesiguran": True} if r == 2 else {})
            if r % 2:
                sl.korak("greske", "/api/tura?n=7&rezim=greske")
            else:
                sl.korak("tocno", "/api/pregled")
        yield sl.zavrsi()
        for j in range(2 if self.n == 3 else 1):
            sl = self.novi_slucaj(f"{ime}/setnja_{j}", ime, st, kako)
            sl.setnja(rng)
            yield sl.zavrsi()

    def sledeci_sat(self, rng):
        t = Sat.t
        minuta = rng.choice([3, 12, 45, 200, 600] + ([1500, 2900, 4400, 7000] if self.cross_ok else []))
        n = t + REAL.timedelta(minutes=minuta)
        if n.date() != t.date() and not self.cross_ok:
            n = t.replace(hour=23, minute=59, second=59)
        return n

    def referenca(self, k=4):
        """Dodatne nezavisne procene (isti server.pocetna() sa drugim seed-ovima) za visoku preciznost Monte Karla."""
        S, K = self.S, self.K
        tekst = K.NP.read_text()
        sansa, ocek = [], []

        class Zamena:
            def __init__(s, seed):
                s.seed = seed

            def Random(s, _):
                return random.Random(s.seed)

            def __getattr__(s, ime):
                return getattr(random, ime)

        orig = S.random
        try:
            for seed in range(101, 101 + k):
                S.random = Zamena(seed)
                K.ucitaj()
                r = S.pocetna()
                sansa.append(r["sansa_prolaz"])
                ocek.append(r["ocekivano"])
        finally:
            S.random = orig
            K.NP.write_text(tekst)
            K.ucitaj()
        return {"sansa": sum(sansa) / k, "ocek": sum(ocek) / k, "k": k}

    def izvoz_sha(self, st):
        """Tekst koji bi izvezi() morao da vrati za ovo stanje (pitanja rastuće, tura/dnevnik dopunjeni) — samo sažetak."""
        canon = {"pitanja": {k: st["pitanja"][k] for k in sorted(st["pitanja"], key=int)}}
        for k, v in st.items():
            if k != "pitanja":
                canon[k] = v
        canon.setdefault("tura", [])
        canon.setdefault("dnevnik", [])
        return hashlib.sha256(json.dumps(canon, ensure_ascii=False, indent=1).encode()).hexdigest()


class Slucaj:
    """Jedan scenario: početno stanje + redom HTTP pozivi, svaki sa očekivanim odgovorom pravog servera."""
    def __init__(self, r, ime, stanje_ime, stanje, ucitaj):
        self.r, self.ime, self.stanje_ime, self.stanje, self.ucitaj = r, ime, stanje_ime, stanje, ucitaj
        self.koraci, self.napisani, self.sat_sledeci, self.grupa = [], set(), None, None
        postavi_sat(r.sada)
        r.upisi(stanje)
        r.K.ucitaj()

    def sat(self, t):
        postavi_sat(t)
        self.sat_sledeci = Sat.t.isoformat(timespec="seconds")

    def korak(self, mod, url, telo=None, grupa=None):
        r, k = self.r, {"mod": mod, "url": url}
        if telo is not None:
            k["telo"] = telo
        if self.sat_sledeci:
            k["sat"], self.sat_sledeci = self.sat_sledeci, None
        if grupa is not None:
            k["grupa"] = grupa
        odg = r.veza(url, telo)
        k["ocekivano"] = self.obradi(mod, url, odg)
        self.koraci.append(k)
        return odg

    def obradi(self, mod, url, odg):
        r = self.r
        if mod == "pocetna":
            danas = Sat.t.date().isoformat()
            snim = r.procitaj()["spremnost"]
            assert snim[danas] == odg["sansa_prolaz"]
            prethodni = max((k for k in snim if k < danas), default=None)
            juce_mc = prethodni in self.napisani
            self.napisani.add(danas)
            ref = r.referenca() if 3 <= odg["sansa_prolaz"] <= 97 and (r.n == 3 or self.ime.endswith("/citanje")) else None
            return {"odgovor": odg, "juce_mc": juce_mc, "ref": ref}
        if mod in ("tura", "greske", "ispit"):
            ids = [p["id"] for p in odg["pitanja"]]
            uz = ids if len(ids) <= 12 else ids[:4] + ids[-4:] + r.rng.sample(ids, 4)
            e = {"ids": ids, "pregled": odg["pregled"], "uzorak": {str(p["id"]): p for p in odg["pitanja"] if p["id"] in uz}}
            if mod == "ispit":
                e["po_oblasti"] = dict(collections.Counter(str(p["oblast_br"]) for p in odg["pitanja"]))
                e["bodova"] = sum(p["bodova"] for p in odg["pitanja"])
            if mod == "greske":  # cela lista kandidata sa ključem sortiranja, za poređenje sa izjednačenjima
                sve = r.veza("/api/tura?n=1000000&rezim=greske")["pitanja"]
                P = r.procitaj()["pitanja"]
                e["kandidati"] = [[p["id"], P[str(p["id"])]["kutija"], P[str(p["id"])]["netacno"], r.K.Q[p["id"]]["bodova"]] for p in sve]
            return e
        return odg

    def odgovor(self, qid, vrsta, zast, grupa=None):
        r = self.r
        q = r.K.Q[qid]
        tacni = r.tacni_ids(q)
        svi = [o["id"] for o in q["odgovori"]]
        if vrsta == "t":
            izbor = r.rng.sample(tacni, len(tacni))
        elif vrsta == "n":
            izbor = r.pogresan(q, r.rng)
        elif vrsta == "0":
            izbor = []
        elif vrsta == "podskup":
            izbor = tacni[:-1]
        else:  # nadskup
            izbor = tacni + [i for i in svi if i not in tacni][:1]
        telo = {"id": qid, "izabrani": izbor}
        telo.update(zast)
        return self.korak("tocno", "/api/odgovor", telo, grupa)

    def citanje(self):
        r = self.r
        nl = len(r.S.LEKCIJE)
        velika = max(range(nl), key=lambda i: len(r.S.LEKCIJE[i][3]))   # lekcija sa više od 10 pitanja: podrazumevano n se vidi
        for ime, mod, url in [("pocetna", "pocetna", "/api/pocetna"), ("pregled", "tocno", "/api/pregled"),
                              ("uci10", "tura", "/api/tura?n=10"), ("uci0", "tura", "/api/tura?n=0&rezim=uci"),
                              ("uci_minus2", "tura", "/api/tura?n=-2&rezim=uci"), ("uci41", "tura", "/api/tura?n=41&rezim=uci"),
                              ("uci_sve", "tura", "/api/tura?n=5000&rezim=uci"), ("nepoznat_rezim", "tura", "/api/tura?n=6&rezim=nesto"),
                              ("uci_bez_n", "tura", "/api/tura?rezim=uci"), ("lekcija_najveca_bez_n", "tura", f"/api/tura?rezim=lekcija&l={velika}"),
                              ("lekcija0", "tura", "/api/tura?rezim=lekcija&l=0"), ("lekcija_sredina", "tura", f"/api/tura?n=3&rezim=lekcija&l={nl // 2}"),
                              ("lekcija_poslednja", "tura", f"/api/tura?n=50&rezim=lekcija&l={nl - 1}"),
                              ("greske5", "greske", "/api/tura?n=5&rezim=greske"), ("greske_sve", "greske", "/api/tura?n=9999&rezim=greske"),
                              ("ispit", "ispit", "/api/tura?n=41&rezim=ispit"), ("pocetna_opet", "pocetna", "/api/pocetna")]:
            self.korak(mod, url)

    def setnja(self, rng):
        """Tri kruga kao pravi tok: tura → odgovori (redom ili odjednom, sa ponovnim pokušajem) → pregled; sat se pomera."""
        r = self.r
        nl = len(r.S.LEKCIJE)
        for krug in range(3):
            if krug:
                self.sat(r.sledeci_sat(rng))
            vrsta = rng.choice(["uci", "uci", "greske", "lekcija", "ispit"])
            if vrsta == "uci":
                odg = self.korak("tura", f"/api/tura?n={rng.choice([3, 8, 15])}&rezim=uci")
            elif vrsta == "greske":
                odg = self.korak("greske", "/api/tura?n=6&rezim=greske")
            elif vrsta == "lekcija":
                odg = self.korak("tura", f"/api/tura?n=6&rezim=lekcija&l={rng.randrange(nl)}")
            else:
                odg = self.korak("ispit", "/api/tura?n=41&rezim=ispit")
            qs = [p["id"] for p in odg["pitanja"]]
            grupa = f"g{krug}" if rng.random() < .5 or vrsta == "ispit" else None
            pogresna, bod, mx, gub = [], 0, 0, {}
            for qid in qs:
                q = r.K.Q[qid]
                ok = rng.random() < .75
                zast = {"ispit": True} if vrsta == "ispit" else {"nesiguran": rng.random() < .15 and ok, "bez_zapisa": False}
                self.odgovor(qid, "t" if ok else "n", zast, grupa)
                mx += q["bodova"]
                if ok:
                    bod += q["bodova"]
                else:
                    pogresna.append(qid)
                    gub[q["oblast"]] = gub.get(q["oblast"], 0) + q["bodova"]
            if vrsta != "ispit":  # ponovni pokušaj greške u istoj turi: bez_zapisa
                for qid in pogresna[:3]:
                    self.odgovor(qid, "t", {"nesiguran": False, "bez_zapisa": True})
            else:
                self.korak("tocno", "/api/ispit_rezultat", {"bod": bod, "max": mx, "tacnih": len(qs) - len(pogresna), "gubitak": gub, "pogresna": pogresna})
                # bez gubitak/pogresna (podrazumevano {} i []) i sa izričitim null (Python čuva null, ne podrazumevanu vrednost)
                self.korak("tocno", "/api/ispit_rezultat", {"bod": bod - 1, "max": mx, "tacnih": 0})
                self.korak("tocno", "/api/ispit_rezultat", {"bod": 0, "max": mx, "tacnih": 0, "gubitak": None, "pogresna": None})
            self.korak("tocno", "/api/pregled")
        self.korak("pocetna", "/api/pocetna")

    def zavrsi(self):
        r = self.r
        kraj, pre = r.procitaj(), self.stanje
        izmene = {"pitanja": {k: v for k, v in kraj["pitanja"].items() if pre["pitanja"].get(k) != v},
                  "uklonjena": [k for k in pre["pitanja"] if k not in kraj["pitanja"]],
                  "ostalo": {k: v for k, v in kraj.items() if k != "pitanja"}}
        return {"ime": self.ime, "stanje": self.stanje_ime, "ucitaj": self.ucitaj, "koraci": self.koraci,
                "izmene": izmene, "napisani": sorted(self.napisani)}


def licni_fajlovi():
    """Postojanje/veličina/vreme ličnih fajlova u korenu repozitorijuma: radnik ih ne sme ni da stvori ni da izmeni."""
    out = {}
    for f in ("napredak.json", "Napredak.md", "Greske.md", "pitanja_raw.json"):
        p = REPO / f
        out[f] = (p.stat().st_size, p.stat().st_mtime_ns) if p.exists() else None
    return out


def radnik(a):
    ime = a.radnik
    pre_fajlova = licni_fajlovi()
    sa_ispitom = {k[0]: k for k in KONFIGURACIJE}
    with tempfile.TemporaryDirectory(prefix="kviz-parity-") as tmp:
        for f in ("pitanja.json", "slike"):
            os.symlink(REPO / f, pathlib.Path(tmp) / f)
        cfg = sa_ispitom.get(ime, ("jedinice", "2026-10-06T09:15:30", None))
        r = Radnik(cfg[0], cfg[1], cfg[2], a.nivo, tmp)
        if ime == "jedinice":
            izlaz = r.jedinice()
        else:
            stanja, slucajevi = {}, []
            for sime, st, kako in r.stanja():
                stanja[sime] = {"stanje": st, "izvoz_sha": r.izvoz_sha(st)}
                for sl in r.slucajevi_za(sime, st, kako):
                    slucajevi.append(sl)
                postavi_sat(r.sada)
            izlaz = {"ime": ime, "sada": cfg[1], "ispit": cfg[2], "pred": r.pred(r.danas), "cross_ok": r.cross_ok,
                     "lekcija_n": len(r.S.LEKCIJE), "stanja": stanja, "slucajevi": slucajevi}
        assert licni_fajlovi() == pre_fajlova, "radnik je dirao lične fajlove u repozitorijumu"
    pathlib.Path(a.izlaz).write_text(json.dumps(izlaz, ensure_ascii=False, separators=(",", ":")))


# ---------- glavni proces ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", help="gde upisati fixture (podrazumevano: privremeni folder)")
    ap.add_argument("--brzo", dest="nivo", action="store_const", const="brzo", help="4 konfiguracije, manje stanja (~40 s)")
    ap.add_argument("--pun", dest="nivo", action="store_const", const="pun", help="sve konfiguracije, sva stanja i varijante (~10 min)")
    ap.set_defaults(nivo="srednje")
    ap.add_argument("--radnik", help=argparse.SUPPRESS)
    ap.add_argument("--izlaz", help=argparse.SUPPRESS)
    ap.add_argument("--samo", help="samo konfiguracije čije ime sadrži ovaj tekst")
    ap.add_argument("--poslova", type=int, default=min(4, os.cpu_count() or 1))
    a = ap.parse_args()
    if a.radnik:
        return radnik(a)
    imena = ["jedinice"] + [k[0] for k in KONFIGURACIJE if (a.samo in k[0] if a.samo else a.nivo != "brzo" or k[0] in BRZO_KONFIG)]
    out = pathlib.Path(a.out or pathlib.Path(tempfile.gettempdir()) / "kviz-parity-fixture.json")
    with tempfile.TemporaryDirectory(prefix="kviz-parity-izlaz-") as tmp:
        def pokreni(ime):
            f = pathlib.Path(tmp) / (ime + ".json")
            cmd = [sys.executable, "-B", __file__, "--radnik", ime, "--izlaz", str(f)] + (["--" + a.nivo] if a.nivo != "srednje" else [])
            p = subprocess.run(cmd, capture_output=True, text=True)
            if p.returncode:
                sys.exit(f"radnik {ime} nije uspeo:\n{p.stderr[-3000:]}")
            print(f"  gotovo: {ime}", file=sys.stderr, flush=True)
            return ime, json.loads(f.read_text())
        with concurrent.futures.ThreadPoolExecutor(a.poslova) as ex:
            rez = dict(ex.map(pokreni, imena))
    if sys.version_info < (3, 12):
        print("upozorenje: Python < 3.12 ne sabira float-ove kompenzovano kao JS pySuma; poslednja cifra suma sme da se razlikuje", file=sys.stderr)
    fix = {"verzija": 1, "python": sys.version.split()[0], "suma_kompenzovana": sys.version_info >= (3, 12), "nivo": a.nivo, "jedinice": rez.pop("jedinice"),
           "konfiguracije": [rez[k[0]] for k in KONFIGURACIJE if k[0] in rez]}
    out.write_text(json.dumps(fix, ensure_ascii=False, separators=(",", ":")))
    n = sum(len(c["slucajevi"]) for c in fix["konfiguracije"])
    print(f"fixture: {out} ({out.stat().st_size / 1e6:.1f} MB, {len(fix['konfiguracije'])} konfiguracija, {n} slučajeva)", file=sys.stderr)


if __name__ == "__main__":
    main()
