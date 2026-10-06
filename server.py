#!/usr/bin/env python3
"""Lokalna kviz aplikacija: http://127.0.0.1:8777

Deli napredak.json sa kviz.py — isti napredak se vidi i u aplikaciji i u terminalu.
Pokretanje: dupli klik na „Kviz.command", ili `python3 server.py`. Podešavanja: vidi kviz.py.
"""
import http.server, json, random, sys, threading, urllib.parse, webbrowser
import kviz

PORT = int(__import__("os").environ.get("KVIZ_PORT", 8777))
APP = kviz.KOD / "app"
LOCK = threading.Lock()


# Lekcije redom kao na portalu: [(oblast_br, oblast, lekcija, [id...])]
LEKCIJE = []
for _q in sorted(kviz.Q.values(), key=lambda q: (kviz.REDOSLED.index(q["oblast_br"]), kviz.PORTAL[q["id"]])):
    if not LEKCIJE or LEKCIJE[-1][2] != _q["podoblast"]:
        LEKCIJE.append((_q["oblast_br"], _q["oblast"], _q["podoblast"], []))
    LEKCIJE[-1][3].append(_q["id"])
LEKCIJA_OD = {qid: i for i, l in enumerate(LEKCIJE) for qid in l[3]}
PO_OBL = {}
for _q in kviz.Q.values():
    PO_OBL.setdefault(_q["oblast_br"], []).append(_q["id"])

# Procena verovatnoće tačnog odgovora po kutiji (Leitner); neviđena pitanja = tvoja tačnost iz prve
P_KUTIJA = {5: .97, 4: .94, 3: .88, 2: .78, 1: .45}


def pocetna():
    """Sve za početni ekran: dnevni cilj, niz dana, spremnost za ispit, oblasti, lekcije, istorija."""
    P = kviz.st["pitanja"]
    danas = kviz.DANAS.isoformat()
    vid = {k: v for k, v in P.items() if v["istorija"]}
    prvi = [v["istorija"][0][1] for v in vid.values()]
    p_novo = min(max((prvi.count("T") + 7) / (len(prvi) + 10), .5), .9)
    p = {qid: (P_KUTIJA.get(P[str(qid)]["kutija"], p_novo) if str(qid) in vid else p_novo) for qid in kviz.Q}

    # simulacija ispita po pravim kvotama → šansa za prolaz (≥85% bodova)
    rnd = random.Random(7)
    po_obl = {}
    for q in kviz.Q.values():
        po_obl.setdefault(q["oblast_br"], []).append(q["id"])
    prosao, zbir = 0, 0.0
    N = 1500
    for _ in range(N):
        bod = mx = 0
        for ob, k in kviz.KVOTA.items():
            for qid in rnd.sample(po_obl.get(ob, []), min(k, len(po_obl.get(ob, [])))):
                b = kviz.Q[qid]["bodova"]
                mx += b
                bod += b if rnd.random() < p[qid] else 0
        zbir += bod / mx
        prosao += bod >= -(-85 * mx // 100)
    # niz dana (streak): uzastopni dani sa bar jednim odgovorom; današnji ne prekida niz dok se ne završi
    dani = {h[0] for v in vid.values() for h in v["istorija"]}
    niz, d = 0, kviz.DANAS if danas in dani else kviz.DANAS - kviz.dt.timedelta(days=1)
    while d.isoformat() in dani:
        niz += 1
        d -= kviz.dt.timedelta(days=1)
    # istorija po danu
    ist = {}
    for v in vid.values():
        for j, h in enumerate(v["istorija"]):
            x = ist.setdefault(h[0], {"dan": h[0], "odg": 0, "tacno": 0, "novih": 0})
            x["odg"] += 1
            x["tacno"] += h[1] == "T"
            x["novih"] += j == 0
    oblasti = []
    for ob in kviz.REDOSLED:
        ids = po_obl[ob]
        v_ids = [i for i in ids if str(i) in vid]
        posl = [P[str(i)]["istorija"][-1][1] for i in v_ids]
        oblasti.append({"br": ob, "ime": kviz.Q[ids[0]]["oblast"], "kvota": kviz.KVOTA.get(ob, 0), "ukupno": len(ids),
                        "vidjeno": len(v_ids), "savladano": sum(P[str(i)]["kutija"] >= 3 for i in v_ids),
                        "tacnost": round(100 * posl.count("T") / len(posl)) if posl else None,
                        "spremnost": round(100 * sum(p[i] for i in ids) / len(ids))})
    lekcije, trenutna = [], None
    for i, (ob, oime, ime, ids) in enumerate(LEKCIJE):
        v_ids = [q for q in ids if str(q) in vid]
        if trenutna is None and len(v_ids) < len(ids):
            trenutna = i
        lekcije.append({"i": i, "oblast": oime, "ime": ime.rstrip(";"), "ukupno": len(ids), "vidjeno": len(v_ids),
                        "savladano": sum(P[str(q)]["kutija"] >= 3 for q in v_ids),
                        "greske": sum(P[str(q)]["kutija"] == 1 for q in v_ids)})
    # izgubljeni bodovi po oblasti na ispitu (budžet ~14) = kvota × prosek(bodova × (1−p))
    for o in oblasti:
        ids = po_obl[o["br"]]
        o["gubitak"] = round(o["kvota"] * sum(kviz.Q[i]["bodova"] * (1 - p[i]) for i in ids) / len(ids), 1)
    # dnevni snimak šanse → „+4 od juče"
    sansa = round(100 * prosao / N)
    snim = kviz.st.setdefault("spremnost", {})
    snim[danas] = sansa
    pre = [v for k, v in sorted(snim.items()) if k < danas]
    kviz.sacuvaj()
    # tačke po danu plana: 0 ništa · 1 radio · 2 ispunio cilj (≥ ravnomerni deo); najviše 21 tačka
    od, do = kviz.plan()
    cilj_dan = -(-len(kviz.Q) // max((do - od).days, 1))
    dan = kviz.dt.timedelta(days=1)
    prvi = max(od, min(kviz.DANAS - 10 * dan, do - 20 * dan))
    tacke = []
    for k in range((do - prvi).days + 1):
        dd = (prvi + k * dan).isoformat()
        x = ist.get(dd)
        tacke.append({"dan": dd, "stanje": 0 if not x else (2 if x["novih"] >= cilj_dan or (dd == do.isoformat() and x["odg"] >= 41) else 1)})
    tvrdoglava = sum(1 for v in vid.values() if v["netacno"] >= 3 and v["kutija"] <= 2)
    return {"pregled": kviz.pregled_podaci(), "niz_dana": niz, "sansa_juce": pre[-1] if pre else None,
            "tacke": tacke, "tvrdoglava": tvrdoglava, "ispiti": kviz.st.get("ispiti", [])[-8:],
            "danas": danas, "danas_aktivan": danas in dani,
            "sansa_prolaz": sansa, "ocekivano": round(100 * zbir / N),
            "oblasti": oblasti, "lekcije": lekcije, "trenutna_lekcija": trenutna,
            "istorija": sorted(ist.values(), key=lambda x: x["dan"])[-14:],
            "ispit_datum": kviz.ISPIT and kviz.ISPIT.isoformat(), "dan_pred_ispit": kviz.DANAS == kviz.DAN_PRED_ISPIT}


def pitanje_za_klijent(qid):
    q = kviz.Q[qid]
    s = kviz.st["pitanja"].get(str(qid), {})
    odg = [{"id": o["id"], "tekst": o["tekst"]} for o in q["odgovori"]]
    random.shuffle(odg)
    return {"id": qid, "tekst": q["tekst"], "oblast": q["oblast"], "lekcija": q["podoblast"].rstrip(";"),
            "bodova": q["bodova"], "treba": q["treba_zaokruziti"], "slika": q["slika"], "odgovori": odg,
            "ponavljanje": bool(s.get("istorija")), "gresaka": s.get("netacno", 0),
            "kutija": s.get("kutija", 0), "lekcija_i": LEKCIJA_OD[qid], "oblast_br": q["oblast_br"]}


class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _file(self, path, ctype):
        if not path.is_file():
            return self.send_error(404)
        b = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "max-age=86400" if ctype.startswith("image") else "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            return self._file(APP / "index.html", "text/html; charset=utf-8")
        if u.path.startswith("/slike/"):
            ime = u.path.rsplit("/", 1)[-1]
            if not ime.replace(".", "").isalnum():
                return self.send_error(404)
            return self._file(kviz.V / "slike" / ime, "image/jpeg")
        if u.path == "/api/tura":
            n = int(qs.get("n", ["10"])[0])
            rezim = qs.get("rezim", ["uci"])[0]
            with LOCK:
                kviz.ucitaj()
                if rezim == "ispit":
                    # kao pravi ispit: kvote po oblasti i ukupno 98–99 bodova (izmereno na 30 simulacija sa portala)
                    for _ in range(20000):
                        ids = []
                        for ob, k in kviz.KVOTA.items():
                            ids += random.sample(PO_OBL.get(ob, []), min(k, len(PO_OBL.get(ob, []))))
                        if sum(kviz.Q[i]["bodova"] for i in ids) in (98, 99):
                            break
                    random.shuffle(ids)
                elif rezim == "lekcija":  # vežbanje jedne lekcije: prvo neviđena, pa najslabija
                    l = int(qs.get("l", ["0"])[0])
                    ids = sorted(LEKCIJE[l][3], key=lambda q: (bool(kviz.st["pitanja"].get(str(q), {}).get("istorija")),
                                                                kviz.st["pitanja"].get(str(q), {}).get("kutija", 0)))[:n]
                elif rezim == "greske":
                    ids = sorted((int(k) for k, v in kviz.st["pitanja"].items() if v["istorija"] and v["kutija"] <= 2),
                                 key=lambda q: (kviz.st["pitanja"][str(q)]["kutija"], -kviz.st["pitanja"][str(q)]["netacno"], -kviz.Q[q]["bodova"]))[:n]
                else:
                    ids = kviz.sledeca(n)
                return self._json({"pitanja": [pitanje_za_klijent(i) for i in ids], "pregled": kviz.pregled_podaci()})
        if u.path == "/api/pocetna":
            with LOCK:
                kviz.ucitaj()
                return self._json(pocetna())
        if u.path == "/api/pregled":
            with LOCK:
                kviz.ucitaj()
                return self._json(kviz.pregled_podaci())
        self.send_error(404)

    def do_POST(self):
        d = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/ispit_rezultat":
            with LOCK:
                kviz.ucitaj()
                kviz.st.setdefault("ispiti", []).append({"kad": kviz.dt.datetime.now().isoformat(timespec="minutes"),
                                                          "bod": d["bod"], "max": d["max"], "tacnih": d["tacnih"],
                                                          "gubitak": d.get("gubitak", {}), "pogresna": d.get("pogresna", [])})
                kviz.sacuvaj()
            return self._json({"ok": True})
        if self.path != "/api/odgovor":
            return self.send_error(404)
        qid, izabrani = int(d["id"]), set(map(int, d["izabrani"]))
        q = kviz.Q[qid]
        tacni = [o["id"] for o in q["odgovori"] if o["tacno"]]
        with LOCK:
            kviz.ucitaj()
            ok = izabrani == set(tacni)
            vidjeno = bool(kviz.st["pitanja"].get(str(qid), {}).get("istorija"))
            # beleži: učenje (prvi pokušaj u turi) · ispit samo za već viđena pitanja (ne kvari redosled lekcija)
            # ne beleži: ponovni pokušaj iste greške u istoj turi (bez_zapisa)
            # simulacija pamti sve greške → beleži sve, osim ponovnog pokušaja u istoj turi
            if not d.get("bez_zapisa"):
                zapis = " | ".join(o["tekst"][:40] for o in q["odgovori"] if o["id"] in izabrani)
                kviz.oceni(qid, izabrani, ("ispit: " if d.get("ispit") else "app: ") + zapis, bool(d.get("nesiguran")))
                kviz.sacuvaj()
                kviz.stanje(ispis=False)
            pr = kviz.pregled_podaci()
        self._json({"tacno": ok, "tacni": tacni, "bodova": q["bodova"], "pregled": pr})


if __name__ == "__main__":
    url = f"http://127.0.0.1:{PORT}"
    try:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
    except OSError:  # već radi — samo otvori
        webbrowser.open(url)
        sys.exit(0)
    print(f"Kviz radi na {url}  (zatvori ovaj prozor da ugasiš)")
    if "--bez-browsera" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    srv.serve_forever()
